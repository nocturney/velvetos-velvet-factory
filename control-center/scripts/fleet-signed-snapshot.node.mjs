import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  createSignedFleetSnapshot, verifySignedFleetSnapshot,
  makeSnapshotSequenceGuard, spkiPublicKeyFromBase64,
} from "../fleet-signed-snapshot.mjs";
import { makeSignedFleetSource, gcsFleetObjectUrl } from "../fleet-snapshot-source.mjs";

const keys = crypto.generateKeyPairSync("ed25519");
const otherKeys = crypto.generateKeyPairSync("ed25519");
const publicB64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const signerId = "synthetic_key_1";
const now = () => Date.now();
const machine = (id = "windows-synthetic") => ({
  id, name: id, platform: "windows", status: "online", freshness: "live",
  collectedAt: "2026-10-15T07:00:00.000Z",
  lastSeen: "2026-10-15T07:00:02.000Z",
  os: { name: "Test Windows", version: "11", deviceSecret: "REMOVE_ME" },
  hardware: {
    cpu: "Synthetic CPU", cpuCores: 12,
    memory: { totalBytes: 24 * 1024 ** 3, freeBytes: 12 * 1024 ** 3 },
    password: "REMOVE_ME",
  },
  network: { ip: "192.0.2.99" }, accessToken: "REMOVE_ME",
});
function envelope(seq = 1, issuedAt = new Date(now()).toISOString(), ttlMs = 60_000) {
  return createSignedFleetSnapshot({
    machines: [machine()], privateKey: keys.privateKey, keyId: signerId,
    sequence: seq, issuedAt, ttlMs,
  });
}
function verify(value, at = now()) {
  return verifySignedFleetSnapshot(value, { publicKey: keys.publicKey, keyId: signerId, now: at });
}
async function freePort() {
  const s = net.createServer().listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = s.address().port;
  s.close();
  await once(s, "close");
  return port;
}
async function bootFixture(file) {
  const p = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env, PORT: String(p), HOST: "127.0.0.1", NODE_ENV: "test",
      VELVETOS_FLEET_SNAPSHOT_MODE: "test-fixture",
      VELVETOS_FLEET_SNAPSHOT_TEST_ALLOW: "1",
      VELVETOS_FLEET_SNAPSHOT_TEST_FILE: file,
      VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64: publicB64,
      VELVETOS_FLEET_SNAPSHOT_KEY_ID: signerId,
      // Ensure the fixture cannot fall back to the legacy local viewer bridge.
      VELVETOS_FLEET_LOCAL_READONLY: "1",
      VELVETOS_FLEET_READONLY_TOKEN: "synthetic-token",
      VELVETOS_FLEET_API_URL: "http://127.0.0.1:1",
      VELVETOS_CONTROL_API_TOKEN: "",
      VELVETOS_CONTROL_API_URL: "",
    },
    stdio: "ignore",
  });
  const origin = "http://127.0.0.1:" + p;
  for (let i=0; i<120; i++) {
    if (child.exitCode !== null) throw Error("fixture_portal_exited");
    try {
      if ((await fetch(origin + "/health", {signal:AbortSignal.timeout(300)})).ok)
        return {origin, child};
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  throw Error("fixture_portal_not_ready");
}

test("signed snapshot keeps only allowed fields, checks source, and refuses tampering", () => {
  const one = envelope();
  const json = JSON.stringify(one);
  for (const secret of ["REMOVE_ME", "accessToken", "192.0.2.99", "deviceSecret", "password"])
    assert(!json.includes(secret), "private source field escaped: " + secret);
  const data = verify(one);
  assert.equal(data.transport, "signed_snapshot");
  assert.equal(data.count, 1);
  assert.equal(data.machines[0].os.name, "Test Windows");
  assert.equal(data.machines[0].hardware.memoryTotalBytes, 24 * 1024 ** 3);
  for (const manipulate of [
    (v) => { v.payload.machines[0].status = "offline"; },
    (v) => { v.sequence += 1; },
    (v) => { v.payload.machines[0].os.name = "Imposter"; },
    (v) => { v.payload.machines[0].network = { ip: "10.0.0.1" }; },
    (v) => { v.payload.machines.push(v.payload.machines[0]); v.payload.count++; },
    (v) => { v.keyId = "other_key_id"; },
    (v) => { v.signature = crypto.randomBytes(64).toString("base64url"); },
  ]) {
    const altered = structuredClone(one);
    manipulate(altered);
    assert.throws(() => verify(altered));
  }
  assert.throws(() => verifySignedFleetSnapshot(one, {
    publicKey: otherKeys.publicKey, keyId: signerId, now: now(),
  }), /unverified_fleet_signature/);
  console.log("FLEET_SIGNED_PASS minimal_projection_signature_tamper_unknown_fields");
});

test("expiry, publisher clock, 90-second ceiling and rollback/replay reject invalid sources", () => {
  const at = now();
  assert.throws(() => envelope(1, new Date(at).toISOString(), 120_000), /invalid_snapshot_issuance/);
  const old = envelope(2, new Date(at - 91_000).toISOString(), 60_000);
  assert.throws(() => verify(old, at), /expired_or_future/);
  const future = envelope(3, new Date(at + 10_000).toISOString());
  assert.throws(() => verify(future, at), /expired_or_future/);
  const guard = makeSnapshotSequenceGuard();
  const first = envelope(10);
  const next = envelope(11);
  guard(first);
  guard(first);
  guard(next);
  assert.throws(() => guard(first), /fleet_snapshot_replay/);
  const sameSequenceDifferentContent = envelope(11,
    new Date(Date.parse(next.issuedAt) + 1_000).toISOString());
  assert.notEqual(sameSequenceDifferentContent.signature, next.signature);
  assert.throws(() => guard(sameSequenceDifferentContent), /fleet_snapshot_replay/);
  assert.equal(spkiPublicKeyFromBase64(publicB64).asymmetricKeyType, "ed25519");
  console.log("FLEET_SIGNED_PASS time_window_sequence_and_key_pin");
});

test("private GCS reader uses only metadata token and fixed HTTPS GCS object URI", async () => {
  const object = envelope(4);
  let tokenCalls = 0, objectCalls = 0, mode = "ok";
  const expected = gcsFleetObjectUrl("vf-private-example", "portal/fleet/status.json");
  assert.equal(expected,
    "https://storage.googleapis.com/download/storage/v1/b/vf-private-example/o/portal%2Ffleet%2Fstatus.json?alt=media");
  for (const [bucket, objectName] of [
    ["https://attacker.example", "portal/fleet/status.json"],
    ["vf-private-example", "../secrets"],
    ["vf-private-example", "https://attacker"],
  ]) assert.throws(() => gcsFleetObjectUrl(bucket, objectName));

  const mocked = async (u, opts) => {
    if (u === "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token") {
      tokenCalls++;
      assert.equal(opts.headers["Metadata-Flavor"], "Google");
      assert.equal(opts.redirect, "error");
      return new Response(JSON.stringify({access_token:"SYNTHETIC_METADATA_ACCESS_TOKEN"}), {
        status:200, headers:{"content-type":"application/json"},
      });
    }
    assert.equal(u, expected, "server attempted untrusted remote fetch");
    assert.equal(opts.headers.Authorization, "Bearer SYNTHETIC_METADATA_ACCESS_TOKEN");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.method, "GET");
    objectCalls++;
    if (mode === "denied") return new Response("error",{status:403});
    if (mode === "invalid_type") return new Response("<html/>", {
      status:200,headers:{"content-type":"text/html"},
    });
    if (mode === "oversize") return new Response("x".repeat(512 * 1024 + 5), {
      status:200,headers:{"content-type":"application/json"},
    });
    if (mode === "tampered") return new Response(
      JSON.stringify({...object, sequence:99}),{status:200,headers:{"content-type":"application/json"}});
    return new Response(JSON.stringify(object), {
      status:200,headers:{"content-type":"application/json"},
    });
  };

  const read = makeSignedFleetSource({
    VELVETOS_FLEET_SNAPSHOT_MODE: "gcs",
    VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64: publicB64,
    VELVETOS_FLEET_SNAPSHOT_KEY_ID: signerId,
    VELVETOS_FLEET_SNAPSHOT_BUCKET: "vf-private-example",
    VELVETOS_FLEET_SNAPSHOT_OBJECT: "portal/fleet/status.json",
  }, {fetchImpl:mocked});
  assert.equal((await read()).count, 1);
  assert.equal(tokenCalls, 1);
  assert.equal(objectCalls, 1);
  for (const failure of ["denied", "invalid_type", "oversize", "tampered"]) {
    mode = failure;
    await assert.rejects(read());
  }
  mode = "ok";
  assert.equal((await read()).count, 1);
  const expiredRead = makeSignedFleetSource({
    VELVETOS_FLEET_SNAPSHOT_MODE: "gcs",
    VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64: publicB64,
    VELVETOS_FLEET_SNAPSHOT_KEY_ID: signerId,
    VELVETOS_FLEET_SNAPSHOT_BUCKET: "vf-private-example",
    VELVETOS_FLEET_SNAPSHOT_OBJECT: "portal/fleet/status.json",
  }, {fetchImpl: mocked, now:()=>Date.parse(object.expiresAt)+1});
  await assert.rejects(expiredRead());
  console.log("FLEET_SIGNED_PASS GCS_metadata_only_https_origin_no_fallback");
});

test("fixture adapter runs only under explicit temp/loopback test-only gates", () => {
  const fixture = path.join(os.tmpdir(), "vf-synthetic-snapshot.json");
  const config = {
    NODE_ENV:"production",
    VELVETOS_FLEET_SNAPSHOT_MODE:"test-fixture",
    VELVETOS_FLEET_SNAPSHOT_TEST_FILE:fixture,
    VELVETOS_FLEET_SNAPSHOT_TEST_ALLOW:"1",
    VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64:publicB64,
    VELVETOS_FLEET_SNAPSHOT_KEY_ID:signerId,
  };
  assert.throws(() => makeSignedFleetSource(config, {bindHost:"127.0.0.1"}));
  assert.throws(() => makeSignedFleetSource({...config,NODE_ENV:"test"}, {bindHost:"0.0.0.0"}));
  assert.throws(() => makeSignedFleetSource({...config,NODE_ENV:"test",
    VELVETOS_FLEET_SNAPSHOT_TEST_FILE:"/etc/passwd"}, {bindHost:"127.0.0.1"}));
  assert.throws(() => makeSignedFleetSource({...config,NODE_ENV:"test",
    VELVETOS_FLEET_SNAPSHOT_TEST_ALLOW:""}, {bindHost:"127.0.0.1"}));
  console.log("FLEET_SIGNED_PASS no_production_fixture_or_arbitrary_file");
});

test("Portal read-only API serves only signed fresh fixture and fails closed on faults", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vf-fleet-snapshot-browser-"));
  const fixture = path.join(tmp, "snapshot.json");
  fs.writeFileSync(fixture, JSON.stringify(envelope(15)));
  let portal;
  try {
    portal = await bootFixture(fixture);
    const api = "/api/fleet/v1/machines";
    const okay = await fetch(portal.origin + api);
    assert.equal(okay.status, 200);
    assert.equal(okay.headers.get("cache-control"), "no-store");
    assert.equal(okay.headers.get("x-content-type-options"), "nosniff");
    const contents = await okay.json();
    assert.equal(contents.transport, "signed_snapshot");
    assert.equal(contents.count, 1);
    assert.equal(contents.machines[0].name, "windows-synthetic");
    assert(!JSON.stringify(contents).includes("REMOVE_ME"));
    for (const [method, suffix, status] of [
      ["POST", api, 405], ["GET", api + "?expand=secrets", 400],
      ["GET", "/api/fleet/v1/actions", 404],
    ]) {
      const r = await fetch(portal.origin + suffix, {method});
      assert.equal(r.status, status);
    }
    fs.writeFileSync(fixture, JSON.stringify({...envelope(16),signature:"A".repeat(86)}));
    const bad = await fetch(portal.origin + api);
    assert.equal(bad.status,503);
    assert.deepEqual(await bad.json(),{error:"fleet_snapshot_unavailable"});
    fs.writeFileSync(fixture, JSON.stringify(envelope(16, new Date(now()-92_000).toISOString(),60_000)));
    assert.equal((await fetch(portal.origin+api)).status,503);
    fs.writeFileSync(fixture, JSON.stringify(envelope(14)));
    assert.equal((await fetch(portal.origin+api)).status,503);
    fs.writeFileSync(fixture, JSON.stringify(envelope(17)));
    const restored=await fetch(portal.origin+api);
    assert.equal(restored.status,200);
    console.log("FLEET_SIGNED_PASS Portal_503_on_tamper_expiry_replay_no_local_fallback");
  } finally {
    portal?.child.kill();
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
