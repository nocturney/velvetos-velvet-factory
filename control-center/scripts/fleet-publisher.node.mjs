import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { publishFleetSnapshotOnce, readCanonicalFleetViewer } from "../fleet-publisher.mjs";
import { makeGcsPublisherTransport, gcsPublisherUris } from "../fleet-publisher-gcs.mjs";
import { verifySignedFleetSnapshot } from "../fleet-signed-snapshot.mjs";

const kp = crypto.generateKeyPairSync("ed25519");
const identity = { bucket: "vf-synthetic-private", objectName: "portal/fleet/status.json",
  keyId: "fleet_2026_10" };
const viewer = "SYNTHETIC_VIEWER_CREDENTIAL_NEVER_LIVE";
const admin = "SYNTHETIC_ADMIN_CREDENTIAL_NEVER_LIVE";
let clock = Date.parse("2026-10-15T08:00:00.000Z");
const rows = [{
  id:"windows-fixture",name:"Synthetic Windows",platform:"windows",
  status:"online",freshness:"live",
  collectedAt:"2026-10-15T07:59:00.000Z",
  lastSeen:"2026-10-15T07:59:20.000Z",
  hardware:{cpu:"Fixture CPU",memory:{totalBytes:8*2**30,freeBytes:3*2**30},
    diskSecrets:"EXCLUDE_HARDWARE_SECRET"},
  os:{name:"Synthetic OS",version:"11"},
  network:{ip:"192.0.2.123"},adminSecret:"EXCLUDE_SOURCE_SECRET",
}];

function mkTransport(opts = {}) {
  const obj = { remote: "0", uploaded: [], uploadedRaw: [], failMode: null };
  const client = {
    bucket:identity.bucket, objectName:identity.objectName,
    async inspect() {
      if (obj.failMode === "inspect_denied") throw Error("synthetic_denied");
      if (obj.failMode === "readback_drift" && obj.uploaded.length > 0)
        return String(Number(obj.remote) + 1);
      return obj.remote;
    },
    async readSignedAtGeneration(generation) {
      if (obj.failMode === "readback_denied") throw Error("synthetic_readback_denied");
      if (generation !== obj.remote || obj.uploadedRaw.length === 0)
        throw Error("synthetic_generation_not_found");
      const raw = obj.uploadedRaw.at(-1);
      const signed = JSON.parse(raw);
      if (obj.failMode === "readback_bad_signature")
        signed.signature = "A".repeat(86);
      return {
        signed,
        sha256: obj.failMode === "readback_bad_digest" ?
          "0".repeat(64) : crypto.createHash("sha256").update(raw).digest("hex"),
      };
    },
    async uploadIfGeneration(body, generation) {
      if (obj.failMode === "upload_denied") throw Error("synthetic_upload_denied");
      if (generation !== obj.remote) throw Error("gcs_generation_precondition_failed");
      obj.remote = String(Number(obj.remote) + 1);
      obj.uploadedRaw.push(body);
      obj.uploaded.push(JSON.parse(body));
      if (obj.failMode === "commit_unknown") throw Error("synthetic_network_after_commit");
      return obj.remote;
    },
  };
  return {client,obj};
}

async function withTemp(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vf-publisher-test-"));
  try { return await action(path.join(root,"publisher-state.json"),root); }
  finally { await fs.rm(root,{recursive:true,force:true}); }
}
function opts(file, transport, extra = {}) {
  return {
    stateFile:file, identity, transport,
    getViewerToken:async()=>viewer,
    getSigningKey:async()=>kp.privateKey,
    fetchFleet:async()=>rows,
    now:()=>clock,
    allowInitialize:true,
    ...extra,
  };
}

test("publisher reserves durable sequence then CAS uploads, strips private fields", async () => {
  await withTemp(async(stateFile)=>{
    const {client,obj}=mkTransport();
    const receipt1=await publishFleetSnapshotOnce(opts(stateFile,client));
    assert.equal(receipt1.sequence,1);
    assert.equal(receipt1.generation,"1");
    assert.equal(receipt1.count,1);
    assert.equal(typeof receipt1.sha256,"string");
    assert(!JSON.stringify(receipt1).includes("Synthetic Windows"));
    const signed=obj.uploaded.at(-1);
    const serialized=JSON.stringify(signed);
    for(const s of ["192.0.2.123","EXCLUDE_SOURCE_SECRET","EXCLUDE_HARDWARE_SECRET",viewer,admin])
      assert(!serialized.includes(s));
    assert.equal(verifySignedFleetSnapshot(signed, {
      publicKey:kp.publicKey,keyId:identity.keyId,now:clock,
    }).count,1);
    const state1=JSON.parse(await fs.readFile(stateFile,"utf8"));
    assert.equal(state1.lastSequence,1);
    assert.equal(state1.generation,"1");
    assert.equal(state1.pending,null);
    assert(!JSON.stringify(state1).includes(viewer));
    assert(!JSON.stringify(state1).includes(admin));

    clock += 30_000;
    const receipt2=await publishFleetSnapshotOnce(opts(stateFile,client,{allowInitialize:false}));
    assert.equal(receipt2.sequence,2);
    assert.equal(receipt2.generation,"2");
    assert.equal(obj.uploaded.length,2);
    assert.equal(JSON.parse(await fs.readFile(stateFile,"utf8")).lastSequence,2);
    assert(!JSON.stringify(obj.uploaded.at(-1)).includes("EXCLUDE_SOURCE_SECRET"));
    console.log("FLEET_PUBLISHER_PASS sequence_persists_across_calls_signed_payload_no_secrets");
  });
});

test("publisher refuses invalid viewer credential, stale clock and state tamper without upload", async () => {
  await withTemp(async(file)=>{
    const {client,obj}=mkTransport();
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client,{
      getViewerToken:async()=>"short",
      fetchFleet: async ({viewerToken}) => {
        if (viewerToken.length < 24) throw new Error("fleet_viewer_credential_missing");
        return rows;
      },
    })),/fleet_viewer_credential_missing/);
    assert.equal(obj.uploaded.length,0);
    await publishFleetSnapshotOnce(opts(file,client));
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client,{allowInitialize:false})),
      /publisher_local_clock_rolled_back/);
    assert.equal(obj.uploaded.length,1);

    const state=JSON.parse(await fs.readFile(file,"utf8"));
    state.objectName="portal/fleet/other.json";
    await fs.writeFile(file,JSON.stringify(state));
    clock+=1_000;
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client,{allowInitialize:false})),
      /invalid_or_mismatched_publisher_state/);
    assert.equal(obj.uploaded.length,1);
    console.log("FLEET_PUBLISHER_PASS invalid_viewer_and_clock_fail_closed");
  });
});

test("new publisher refuses pre-existing cloud object, missing state or remote drift", async()=>{
  await withTemp(async(file)=>{
    const {client,obj}=mkTransport();
    obj.remote="3";
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client)),
      /publisher_remote_generation_drift/);
    assert.equal(obj.uploaded.length,0);
    obj.remote="0";
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client,{allowInitialize:false})),
      /publisher_state_missing_requires_initialization/);
    await publishFleetSnapshotOnce(opts(file,client));
    obj.remote="10";
    clock+=2_000;
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client,{allowInitialize:false})),
      /publisher_remote_generation_drift/);
    assert.equal(obj.uploaded.length,1);
    console.log("FLEET_PUBLISHER_PASS first_generation_and_remote_drift_guard");
  });
});

test("unknown upload outcome and optimistic CAS conflict block retries until manual receipt", async()=>{
  await withTemp(async(file)=>{
    const {client,obj}=mkTransport();
    obj.failMode="commit_unknown";
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client)),
      /synthetic_network_after_commit/);
    assert.equal(obj.remote,"1");
    const state=JSON.parse(await fs.readFile(file,"utf8"));
    assert.equal(state.lastSequence,1);
    assert.equal(state.generation,"0");
    assert.equal(state.pending.expectedGeneration,"0");
    assert.equal(state.pending.sequence,1);
    assert.match(state.pending.sha256,/^[a-f0-9]{64}$/);
    assert.equal(state.pending.sha256,crypto.createHash("sha256")
      .update(JSON.stringify(obj.uploaded[0])).digest("hex"));
    obj.failMode=null;
    clock+=2_000;
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client)),
      /publisher_pending_requires_manual_reconcile/);
    assert.equal(obj.uploaded.length,1);
    console.log("FLEET_PUBLISHER_PASS write_ahead_unknown_commit_blocks_replay");
  });
  await withTemp(async(file)=>{
    const {client,obj}=mkTransport();
    obj.failMode="upload_denied";
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client)),
      /synthetic_upload_denied/);
    assert.equal(obj.uploaded.length,0);
    const state=JSON.parse(await fs.readFile(file,"utf8"));
    assert.equal(state.pending.sequence,1);
    console.log("FLEET_PUBLISHER_PASS network_denial_blocks_retry_without_reconciliation");
  });
});

test("exclusive lock rejects concurrent publisher even if another worker stalls", async()=>{
  await withTemp(async(file)=>{
    const {client,obj}=mkTransport();
    const lock=file+".lock";
    await fs.writeFile(lock,"synthetic other worker",{flag:"wx"});
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client)),
      /publisher_already_running_or_stale_lock/);
    assert.equal(obj.uploaded.length,0);
    await fs.unlink(lock);
    assert.equal((await publishFleetSnapshotOnce(opts(file,client))).sequence,1);
    console.log("FLEET_PUBLISHER_PASS exclusive_process_lock");
  });
});

test("canonical Fleet source validates viewer role and fixed local origin", async()=>{
  let calls=0, role="viewer";
  const mocked=async(url,opts)=>{
    calls++;
    assert(["http://127.0.0.1:4173/api/settings",
      "http://127.0.0.1:4173/api/machines"].includes(url));
    assert.equal(opts.headers.Authorization,"Bearer "+viewer);
    assert.equal(opts.method,"GET");
    assert.equal(opts.redirect,"error");
    if(url.endsWith("/settings"))
      return new Response(JSON.stringify({accessRole:role}),{
        status:200,headers:{"content-type":"application/json"}});
    return new Response(JSON.stringify(rows),{
      status:200,headers:{"content-type":"application/json"}});
  };
  const good=await readCanonicalFleetViewer({viewerToken:viewer,fetchImpl:mocked});
  assert.equal(calls,2);
  assert.equal(good[0].id,"windows-fixture");
  role="admin";
  await assert.rejects(readCanonicalFleetViewer({viewerToken:viewer,fetchImpl:mocked}),
    /publisher_requires_verified_viewer_role/);
  role="viewer";
  await assert.rejects(readCanonicalFleetViewer({viewerToken:"short",fetchImpl:async()=>{
    throw Error("must_not_fetch");
  }}),/fleet_viewer_credential_missing/);
  await assert.rejects(readCanonicalFleetViewer({viewerToken:viewer,fetchImpl:async(url)=>{
    if(url.endsWith("/settings"))
      return new Response(JSON.stringify({accessRole:"viewer"}),{
        status:200,headers:{"content-type":"application/json"}});
    return new Response("<html/>",{status:200,headers:{"content-type":"text/html"}});
  }}),/canonical_fleet_not_json/);
  await assert.rejects(readCanonicalFleetViewer({viewerToken:viewer,fetchImpl:async(url)=>{
    if(url.endsWith("/settings"))
      return new Response(JSON.stringify({accessRole:"viewer"}),{
        status:200,headers:{"content-type":"application/json"}});
    return new Response("x".repeat(2*1024*1024+1),{
      status:200,headers:{"content-type":"application/json"}});
  }}),/canonical_fleet_response_oversized/);
  console.log("FLEET_PUBLISHER_PASS verified_viewer_role_no_admin_fixed_local_origin");
});

test("GCS publisher uses fixed metadata+media endpoints and ifGenerationMatch", async()=>{
  const urls=gcsPublisherUris(identity.bucket,identity.objectName);
  assert(urls.metadata.startsWith("https://storage.googleapis.com/storage/v1/b/"));
  assert(urls.upload.startsWith("https://storage.googleapis.com/upload/storage/v1/b/"));
  assert.throws(()=>gcsPublisherUris("https://evil.test",identity.objectName));
  assert.throws(()=>gcsPublisherUris(identity.bucket,"../../other"));

  let remote="0",requests=0,tokens=0,deny=null;
  const fetchImpl=async(url,opts)=>{
    requests++;
    assert.equal(opts.redirect,"error");
    assert.equal(opts.headers.Authorization,"Bearer SYNTHETIC_ACCESS_TOKEN_FOR_GCS");
    assert(url===urls.metadata||url.startsWith(urls.upload+"&ifGenerationMatch="));
    if(deny==="denied")return new Response("no",{status:403});
    if(deny==="html")return new Response("<html/>",{status:200,headers:{"content-type":"text/html"}});
    if(url===urls.metadata){
      assert.equal(opts.method,"GET");
      if(remote==="0")return new Response("not found",{status:404});
      return new Response(JSON.stringify({generation:remote}),{
        status:200,headers:{"content-type":"application/json"},
      });
    }
    assert.equal(opts.method,"POST");
    assert.equal(opts.headers["Content-Type"],"application/json; charset=utf-8");
    assert.equal(opts.headers["Content-Length"],String(Buffer.byteLength(opts.body)));
    const precondition=new URL(url).searchParams.get("ifGenerationMatch");
    if(remote!==precondition)return new Response("precondition",{status:412});
    assert(!url.includes("SYNTHETIC_ACCESS_TOKEN_FOR_GCS"));
    remote=String(Number(remote)+1);
    return new Response(JSON.stringify({
      bucket:identity.bucket,name:identity.objectName,generation:remote,
    }),{status:200,headers:{"content-type":"application/json"}});
  };
  const transport=makeGcsPublisherTransport({
    bucket:identity.bucket,objectName:identity.objectName,
    getAccessToken:async()=>{tokens++;return "SYNTHETIC_ACCESS_TOKEN_FOR_GCS";},
    fetchImpl,
  });
  assert.equal(await transport.inspect(),"0");
  assert.equal(await transport.uploadIfGeneration(JSON.stringify({synthetic:true,safe:"x".repeat(200)}),"0"),"1");
  assert.equal(await transport.inspect(),"1");
  await assert.rejects(transport.uploadIfGeneration(JSON.stringify({safe:"x".repeat(200)}),"0"),
    /gcs_generation_precondition_failed/);
  deny="denied";
  await assert.rejects(transport.inspect(),/gcs_metadata_denied/);
  deny="html";
  await assert.rejects(transport.inspect(),/gcs_metadata_not_json/);
  assert(requests>=5&&tokens===requests);
  console.log("FLEET_PUBLISHER_PASS GCS_media_CAS_412_no_token_in_URL");
});


test("publisher commits only after signed exact-generation readback; failures leave pending",async()=>{
  const modes=[
    ["readback_denied",/synthetic_readback_denied/],
    ["readback_bad_digest",/publisher_signed_readback_digest_mismatch/],
    ["readback_bad_signature",/publisher_signed_readback_unverified/],
    ["readback_drift",/publisher_signed_readback_generation_drift/],
  ];
  for(const [mode,expected] of modes){
    await withTemp(async(file)=>{
      const {client,obj}=mkTransport();
      obj.failMode=mode;
      await assert.rejects(publishFleetSnapshotOnce(opts(file,client)),expected);
      const state=JSON.parse(await fs.readFile(file,"utf8"));
      assert.equal(state.generation,"0");
      assert.equal(state.pending.sequence,1);
      assert.match(state.pending.sha256,/^[a-f0-9]{64}$/);
      assert.equal(obj.remote,"1");
      assert.equal(obj.uploaded.length,1);
      obj.failMode=null;
      clock+=1_000;
      await assert.rejects(publishFleetSnapshotOnce(opts(file,client)),
        /publisher_pending_requires_manual_reconcile/);
      assert.equal(obj.uploaded.length,1);
    });
  }
  console.log("FLEET_PUBLISHER_PASS readback_failure_never_commits_or_retries");
});

test("publisher requires generation-pinned readback transport before any upload",async()=>{
  await withTemp(async(file)=>{
    const {client,obj}=mkTransport();
    const withoutReadback={...client,readSignedAtGeneration:undefined};
    await assert.rejects(publishFleetSnapshotOnce(opts(file,withoutReadback)),
      /publisher_dependencies_not_approved/);
    assert.equal(obj.uploaded.length,0);
    await assert.rejects(fs.stat(file),{code:"ENOENT"});
  });
});

test("publisher rejects a readback that arrives after snapshot expiration",async()=>{
  await withTemp(async(file)=>{
    const {client,obj}=mkTransport();
    let calls=0;
    const optsClock=()=>clock+(calls++===0?0:70_000);
    await assert.rejects(publishFleetSnapshotOnce(opts(file,client,{now:optsClock})),
      /publisher_signed_readback_unverified/);
    assert.equal(obj.uploaded.length,1);
    const state=JSON.parse(await fs.readFile(file,"utf8"));
    assert.equal(state.pending.sequence,1);
    assert.equal(state.generation,"0");
    assert.equal(state.lastCommittedAt,null);
    console.log("FLEET_PUBLISHER_PASS readback_expiry_pending_fail_closed");
  });
});
