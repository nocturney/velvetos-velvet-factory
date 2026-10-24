import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectPublisherReconciliation } from "../fleet-publisher-reconcile.mjs";
import { PUBLISHER_STATE_SCHEMA } from "../fleet-publisher-state.mjs";
import { ENVELOPE_SCHEMA, signedBytes } from "../fleet-signed-snapshot.mjs";
import { projectFleetMachines } from "../fleet-projection.mjs";

// Test-only fixture signer over main's shared canonical bytes, so fixtures can pin an
// exact sequence. Production signing goes through makeSnapshotPublisher.
function createSignedFleetSnapshot({machines,keyId,sequence,issuedAt,privateKey,ttlMs}){
  const v={schema:ENVELOPE_SCHEMA,keyId,sequence,issuedAt,
    expiresAt:new Date(Date.parse(issuedAt)+ttlMs).toISOString(),
    payload:projectFleetMachines(machines,issuedAt)};
  return {...v,signature:crypto.sign(null,signedBytes(v),privateKey).toString("base64url")};
}
import { makeGcsPublisherTransport } from "../fleet-publisher-gcs.mjs";

const keys = crypto.generateKeyPairSync("ed25519");
const identity = {bucket: "test-private-fleet", objectName:"portal/fleet/status.json", keyId:"test_fleet_key"};
const issuedAt = "2026-10-15T08:00:00.000Z";
const earlier = "2026-10-15T07:59:00.000Z";
const state = (pending = true, expectedSha256 = null) => ({
  schema:PUBLISHER_STATE_SCHEMA, ...identity, generation:pending?"0":"1",
  lastSequence:1, lastIssuedAt:issuedAt, lastCommittedAt:pending?null:issuedAt,
  pending:pending?{expectedGeneration:"0",sequence:1,
    ...(expectedSha256 === null ? {} : {sha256:expectedSha256})}:null,
});
const signed = (sequence=1, time=issuedAt) => createSignedFleetSnapshot({
  machines:[{id:"fixture-mac",name:"Synthetic Mac",platform:"macos",status:"online",
    freshness:"live",collectedAt:earlier,lastSeen:earlier,hardware:{},
    network:{ip:"192.0.2.8",secret:"DO_NOT_EXPORT"}}],
  keyId:identity.keyId,sequence,issuedAt:time,privateKey:keys.privateKey,ttlMs:60_000,
});
const now = () => Date.parse("2026-10-15T09:00:00.000Z");
const mkRemote = (generation="1", value=signed()) => ({
  bucket:identity.bucket, objectName:identity.objectName,
  async inspect(){return generation;},
  async readSignedAtGeneration(requested){
    assert.equal(requested,generation);
    return { signed:value,
      sha256:crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  },
});
async function temp(action) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"vf-reconcile-"));
  const stateFile = path.join(dir,"publisher-state.json");
  try {return await action(stateFile);}
  finally {await fs.rm(dir,{recursive:true,force:true});}
}
function audit(stateFile, transport, options={}) {
  return inspectPublisherReconciliation({
    stateFile, identity, transport, publicKey:keys.publicKey, now,...options,
  });
}

test("clean replica matches; inspection never uploads or edits local state", async()=>{
  await temp(async file=>{
    await fs.writeFile(file,JSON.stringify(state(false)));
    const before=await fs.readFile(file,"utf8");
    const transport=mkRemote();
    transport.uploadIfGeneration=()=>{throw Error("must_not_upload");};
    const r=await audit(file,transport);
    assert.equal(r.status,"CLEAN_MATCH");
    assert.equal(r.manualReviewRequired,false);
    assert.equal(await fs.readFile(file,"utf8"),before);
    assert(!JSON.stringify(r).includes("Synthetic Mac"));
  });
});

test("unknown pending result and unchanged remote remain blocked",async()=>{
  await temp(async file=>{
    await fs.writeFile(file,JSON.stringify(state()));
    const r=await audit(file,mkRemote("0"));
    assert.equal(r.status,"PENDING_REMOTE_UNCHANGED");
    assert.equal(r.manualReviewRequired,true);
    assert.equal(r.pendingSequence,1);
  });
});

test("historically valid but expired signature is only a candidate for HUMAN review",async()=>{
  await temp(async file=>{
    await fs.writeFile(file,JSON.stringify(state()));
    const before=await fs.readFile(file,"utf8");
    const r=await audit(file,mkRemote("1",signed()));
    assert.equal(r.status,"PENDING_SIGNED_CANDIDATE");
    assert.equal(r.remoteExpired,true);
    assert.equal(r.remoteSignedSequence,1);
    assert.equal(r.manualReviewRequired,true);
    assert.equal(await fs.readFile(file,"utf8"),before);
    assert(!JSON.stringify(r).includes("DO_NOT_EXPORT"));
    assert(!JSON.stringify(r).includes("Synthetic Mac"));
  });
});

test("tampered signature, mismatched sequence and issuance fail closed",async()=>{
  await temp(async file=>{
    await fs.writeFile(file,JSON.stringify(state()));
    const forged=signed();
    forged.signature="A".repeat(86);
    assert.equal((await audit(file,mkRemote("1",forged))).status,"PENDING_REMOTE_UNVERIFIED");
    assert.equal((await audit(file,mkRemote("1",signed(2)))).status,"PENDING_REMOTE_MISMATCH");
    assert.equal((await audit(file,mkRemote("1",signed(1,earlier)))).status,"PENDING_REMOTE_MISMATCH");
  });
});

test("remote deletion, generation race, denial and missing media remain safe",async()=>{
  await temp(async file=>{
    await fs.writeFile(file,JSON.stringify(state()));
    assert.equal((await audit(file,mkRemote("0"))).status,"PENDING_REMOTE_UNCHANGED");
    let inspectCalls=0;
    const race={...mkRemote(),async inspect(){return ++inspectCalls===1?"1":"2";}};
    assert.equal((await audit(file,race)).status,"REMOTE_GENERATION_RACE");
    const denied={...mkRemote(),async inspect(){throw Error("private token leaked?");}};
    assert.equal((await audit(file,denied)).status,"REMOTE_UNAVAILABLE");
    const noMedia={bucket:identity.bucket,objectName:identity.objectName,inspect:async()=>"1"};
    assert.equal((await audit(file,noMedia)).status,"PENDING_REMOTE_UNVERIFIED");
  });
});

test("detects local state modification during an advisory inspection",async()=>{
  await temp(async file=>{
    await fs.writeFile(file,JSON.stringify(state()));
    const changing={...mkRemote(),async inspect(){
      const s=JSON.parse(await fs.readFile(file,"utf8"));
      s.lastCommittedAt=issuedAt;
      await fs.writeFile(file,JSON.stringify(s));
      return "1";
    }};
    assert.equal((await audit(file,changing)).status,"LOCAL_STATE_RACE");
  });
});

test("rejects wrong identity and untrusted state before reading storage",async()=>{
  await temp(async file=>{
    await fs.writeFile(file,JSON.stringify({...state(),keyId:"wrong"}));
    let invoked=false;
    const obj={...mkRemote(),async inspect(){invoked=true;return "1";}};
    await assert.rejects(audit(file,obj),/invalid_or_mismatched_publisher_state/);
    assert.equal(invoked,false);
  });
});

test("GCS forensic media GET pins generation; invalid responses reject",async()=>{
  let answer="good", reads=0;
  const transport=makeGcsPublisherTransport({
    bucket:identity.bucket,objectName:identity.objectName,
    getAccessToken:async()=>"SYNTHETIC_GCS_TOKEN_NEVER_LIVE",
    fetchImpl:async(url,options)=>{
      reads++;
      assert.equal(options.method,"GET");
      assert.equal(options.redirect,"error");
      assert(url.includes("ifGenerationMatch=4"));
      assert(!url.includes("SYNTHETIC_GCS_TOKEN"));
      if(answer==="precondition")return new Response("",{status:412});
      if(answer==="html")return new Response("<html/>",{
        status:200,headers:{"content-type":"text/html"}});
      if(answer==="mismatch")return new Response(JSON.stringify(signed()),{
        status:200,headers:{"content-type":"application/json","x-goog-generation":"5"}});
      return new Response(JSON.stringify(signed()),{
        status:200,headers:{"content-type":"application/json","x-goog-generation":"4"}});
    },
  });
  const signedRead = await transport.readSignedAtGeneration("4");
  assert.equal(signedRead.signed.sequence,1);
  assert.equal(signedRead.sha256,crypto.createHash("sha256")
    .update(JSON.stringify(signed())).digest("hex"));
  for(const [kind,reason] of [
    ["precondition",/gcs_read_generation_changed/],
    ["html",/gcs_metadata_not_json/],
    ["mismatch",/gcs_read_generation_mismatch/],
  ]){
    answer=kind;
    await assert.rejects(transport.readSignedAtGeneration("4"),reason);
  }
  await assert.rejects(transport.readSignedAtGeneration("0"),/gcs_generation_invalid/);
  assert.equal(reads,4);
});


test("new pending record binds EXACT remote body digest, still needs human review",async()=>{
  await temp(async file=>{
    const value=signed();
    const hash=crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await fs.writeFile(file,JSON.stringify(state(true,hash)));
    const before=await fs.readFile(file,"utf8");
    const remote=mkRemote("1",value);
    remote.uploadIfGeneration=()=>{throw Error("auditor must not write");};
    const result=await audit(file,remote);
    assert.equal(result.status,"PENDING_DIGEST_VERIFIED_CANDIDATE");
    assert.equal(result.pendingDigestMatched,true);
    assert.equal(result.manualReviewRequired,true);
    assert.equal(result.remoteExpired,true);
    assert.equal(await fs.readFile(file,"utf8"),before);
    assert(!JSON.stringify(result).includes(hash));
  });
});

test("authentic signature with DIFFERENT bytes cannot match a reserved pending body",async()=>{
  await temp(async file=>{
    await fs.writeFile(file,JSON.stringify(state(true,"0".repeat(64))));
    const result=await audit(file,mkRemote("1",signed()));
    assert.equal(result.status,"PENDING_REMOTE_DIGEST_MISMATCH");
    assert.equal(result.pendingDigestMatched,false);
    assert.equal(result.manualReviewRequired,true);
  });
});

test("missing raw-byte digest cannot claim a v1 pending digest match",async()=>{
  await temp(async file=>{
    const value=signed();
    const hash=crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await fs.writeFile(file,JSON.stringify(state(true,hash)));
    const remote={...mkRemote("1",value),readSignedAtGeneration:async()=>({signed:value})};
    const r=await audit(file,remote);
    assert.equal(r.status,"PENDING_REMOTE_UNVERIFIED");
    assert.equal(r.pendingDigestMatched,null);
    assert.equal(r.manualReviewRequired,true);
  });
});

test("bad pending hash rejected before remote access",async()=>{
  await temp(async file=>{
    await fs.writeFile(file,JSON.stringify(state(true,"not-a-sha256")));
    let called=false;
    const remote={...mkRemote(),inspect:async()=>{called=true;return "1";}};
    await assert.rejects(audit(file,remote),/invalid_or_mismatched_publisher_state/);
    assert.equal(called,false);
  });
});

test("GCS forensics hashes raw media bytes, not re-serialized parsed JSON",async()=>{
  const payload=" \n"+JSON.stringify(signed(),null,2)+"\n";
  const transport=makeGcsPublisherTransport({
    bucket:identity.bucket,objectName:identity.objectName,
    getAccessToken:async()=>"SYNTHETIC_GCS_TOKEN_NEVER_LIVE",
    fetchImpl:async(url,opts)=>{
      assert(url.includes("ifGenerationMatch=77"));
      assert.equal(opts.method,"GET");
      return new Response(payload,{status:200,headers:{
        "content-type":"application/json","x-goog-generation":"77",
      }});
    },
  });
  const r=await transport.readSignedAtGeneration("77");
  assert.equal(r.signed.sequence,1);
  assert.equal(r.sha256,crypto.createHash("sha256").update(payload).digest("hex"));
  assert.notEqual(r.sha256,crypto.createHash("sha256")
    .update(JSON.stringify(r.signed)).digest("hex"));
});

test("numeric publisher generations fail closed before remote inspection", async()=>{
  await temp(async file=>{
    const badCommitted={...state(false),generation:1};
    const badPending={...state(true),generation:0,
      pending:{expectedGeneration:0,sequence:1}};
    let remoteCalls=0;
    const remote={...mkRemote(),async inspect(){remoteCalls++;return "1";}};
    for(const malformed of [badCommitted,badPending]){
      await fs.writeFile(file,JSON.stringify(malformed));
      await assert.rejects(audit(file,remote),/invalid_or_mismatched_publisher_state/);
    }
    assert.equal(remoteCalls,0);
  });
});
