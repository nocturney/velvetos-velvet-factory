// Synthetic-only tests for the reader-only signed Fleet snapshot. No real Google,
// GCS, metadata or Fleet endpoint is ever contacted: the metadata/GCS source is
// driven by a mocked fetch, and the IAP JWKS fetch is answered by a preload that
// refuses every other non-loopback request.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { projectFleetMachines } from "../fleet-projection.mjs";
import {
  ENVELOPE_SCHEMA, MAX_SNAPSHOT_AGE_MS, makeSnapshotSequenceGuard,
  spkiPublicKeyFromBase64, verifySignedFleetSnapshot,
} from "../fleet-signed-snapshot.mjs";
import { gcsFleetObjectUrl, makeSignedFleetSource } from "../fleet-snapshot-source.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readerFiles = ["fleet-signed-snapshot.mjs", "fleet-snapshot-source.mjs"];
const keys = crypto.generateKeyPairSync("ed25519");
const otherKeys = crypto.generateKeyPairSync("ed25519");
const publicB64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const signerId = "synthetic_key_1";
const now = () => Date.now();
const machine = (id = "windows-synthetic") => ({
  id, name: id, platform: "windows", status: "online", freshness: "live",
  collectedAt: "2026-10-15T07:00:00.000Z", lastSeen: "2026-10-15T07:00:02.000Z",
  os: { name: "Test Windows", version: "11", deviceSecret: "REMOVE_ME" },
  hardware: {
    cpu: "Synthetic CPU", cpuCores: 12,
    memory: { totalBytes: 24 * 1024 ** 3, freeBytes: 12 * 1024 ** 3 },
    password: "REMOVE_ME",
  },
  network: { ip: "192.0.2.99" }, accessToken: "REMOVE_ME",
});

// Test-only signer. It mirrors the published envelope format so the tests can
// produce valid, tampered and malformed envelopes. Production code never signs.
function signedBytes(v) {
  return Buffer.from("VELVETOS/FLEET/SIGNED-SNAPSHOT/v1\n" + JSON.stringify({
    schema: v.schema, keyId: v.keyId, sequence: v.sequence,
    issuedAt: v.issuedAt, expiresAt: v.expiresAt, payload: v.payload,
  }), "utf8");
}
function resign(value, privateKey = keys.privateKey) {
  value.signature = crypto.sign(null, signedBytes(value), privateKey).toString("base64url");
  return value;
}
function envelope(seq = 1, issuedAt = new Date(now()).toISOString(), ttlMs = 60_000, machines = [machine()]) {
  return resign({
    schema: ENVELOPE_SCHEMA, keyId: signerId, sequence: seq, issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
    payload: projectFleetMachines(machines, issuedAt),
  });
}
function verify(value, at = now()) {
  return verifySignedFleetSnapshot(value, { publicKey: keys.publicKey, keyId: signerId, now: at });
}

test("signed envelope carries only the allowlisted projection and verifies", () => {
  const one = envelope();
  const json = JSON.stringify(one);
  for (const secret of ["REMOVE_ME", "accessToken", "192.0.2.99", "deviceSecret", "password"])
    assert(!json.includes(secret), "private source field escaped: " + secret);
  const data = verify(one);
  assert.equal(data.transport, "signed_snapshot");
  assert.equal(data.signatureKeyId, signerId);
  assert.equal(data.validUntil, one.expiresAt);
  assert.equal(data.count, 1);
  assert.equal(data.machines[0].os.name, "Test Windows");
  assert.equal(data.machines[0].hardware.memoryTotalBytes, 24 * 1024 ** 3);
  assert.equal(spkiPublicKeyFromBase64(publicB64).asymmetricKeyType, "ed25519");
  console.log("FLEET_SIGNED_PASS minimal_projection_verified");
});

test("tampered, unsigned, wrong-key, extra-field, duplicate and malformed envelopes fail closed", () => {
  const base = envelope();
  // Tampering without re-signing: the signature no longer covers the content.
  const tampered = [
    (v) => { v.payload.machines[0].status = "offline"; },
    (v) => { v.sequence += 1; },
    (v) => { v.payload.machines[0].os.name = "Imposter"; },
    (v) => { v.payload.machines[0].network = { ip: "10.0.0.1" }; },
    (v) => { v.payload.machines.push(v.payload.machines[0]); v.payload.count++; },
    (v) => { v.keyId = "other_key_id"; },
    (v) => { v.signature = crypto.randomBytes(64).toString("base64url"); },
    (v) => { delete v.signature; },
    (v) => { v.signature = "A".repeat(85); },
  ];
  for (const manipulate of tampered) {
    const altered = structuredClone(base);
    manipulate(altered);
    assert.throws(() => verify(altered));
  }
  assert.throws(() => verifySignedFleetSnapshot(base, {
    publicKey: otherKeys.publicKey, keyId: signerId, now: now(),
  }), /unverified_fleet_signature/);

  // Malformed content that is correctly signed: only the schema check can reject it.
  const malformed = [
    (v) => { v.command = "restart"; },
    (v) => { v.payload.machines[0].id = "Bad Id"; },
    (v) => { v.payload.machines[0].name = "bad\u0007name"; },
    (v) => { v.payload.machines[0].hardware.cpuCores = 1.5; },
    (v) => { v.payload.machines[0].hardware.memoryTotalBytes = "1024"; },
    (v) => { v.payload.machines[0].hardware.memoryFreeBytes = Number.MAX_SAFE_INTEGER + 1; },
    (v) => { v.payload.machines[0].platform = "amiga"; },
    (v) => { v.payload.machines[0].status = "ONLINE"; },
    (v) => { v.payload.machines[0].lastSeen = "yesterday"; },
    (v) => { v.payload.source = "Other Console"; },
    (v) => { v.payload.schema = "velvetos.portal.fleet-machines.v0"; },
    (v) => { v.payload.count = 2; },
    (v) => { v.payload.fetchedAt = "2026-10-15T07:00:00.000Z"; },
    (v) => { v.issuedAt = "2026-10-15T07:00:00Z"; },
  ];
  for (const manipulate of malformed) {
    const altered = resign(structuredClone(base));
    manipulate(altered);
    resign(altered);
    assert.throws(() => verify(altered), /invalid_signed_fleet_envelope/);
  }
  // A duplicate machine id, with count kept consistent and correctly signed.
  const duplicated = structuredClone(base);
  duplicated.payload.machines.push(structuredClone(duplicated.payload.machines[0]));
  duplicated.payload.count = 2;
  assert.throws(() => verify(resign(duplicated)), /invalid_signed_fleet_envelope/);
  const extraEnvelopeKey = { ...structuredClone(base), debug: true };
  assert.throws(() => verify(resign(extraEnvelopeKey)), /invalid_signed_fleet_envelope/);
  console.log("FLEET_SIGNED_PASS tamper_unsigned_extra_duplicate_malformed_fail_closed");
});

test("expiry, future issuance, 90-second ceiling, rollback and replay reject", () => {
  const at = now();
  assert.equal(MAX_SNAPSHOT_AGE_MS, 90_000);
  // Correctly signed but over-long window: the reader itself enforces the ceiling.
  assert.throws(() => verify(envelope(1, new Date(at).toISOString(), 91_000), at), /expired_or_future/);
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
  console.log("FLEET_SIGNED_PASS time_window_sequence_replay");
});

test("a signed copy never invents online: status needs live freshness and lastSeen", () => {
  const data = verify(envelope(20, undefined, 60_000, [
    { ...machine("stale-claims-online"), freshness: "stale" },
    { ...machine("no-lastseen-claims-online"), lastSeen: null },
    machine("live-online"),
  ]));
  assert.deepEqual(data.machines.map(m => [m.id, m.status, m.freshness]), [
    ["stale-claims-online", "unknown", "stale"],
    ["no-lastseen-claims-online", "unknown", "live"],
    ["live-online", "online", "live"],
  ]);
  console.log("FLEET_SIGNED_PASS no_invented_online");
});

test("private GCS reader is a single metadata-token GET of a fixed HTTPS object", async () => {
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

  const seen = [];
  const mocked = async (u, opts) => {
    seen.push([opts.method, u]);
    if (u === "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token") {
      tokenCalls++;
      assert.equal(opts.headers["Metadata-Flavor"], "Google");
      assert.equal(opts.redirect, "error");
      return new Response(JSON.stringify({ access_token: "SYNTHETIC_METADATA_ACCESS_TOKEN" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    assert.equal(u, expected, "server attempted untrusted remote fetch");
    assert.equal(opts.headers.Authorization, "Bearer SYNTHETIC_METADATA_ACCESS_TOKEN");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.method, "GET");
    objectCalls++;
    if (mode === "denied") return new Response("error", { status: 403 });
    if (mode === "invalid_type") return new Response("<html/>", {
      status: 200, headers: { "content-type": "text/html" },
    });
    if (mode === "oversize") return new Response("x".repeat(512 * 1024 + 5), {
      status: 200, headers: { "content-type": "application/json" },
    });
    if (mode === "tampered") return new Response(
      JSON.stringify({ ...object, sequence: 99 }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(object), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const env = {
    VELVETOS_FLEET_SNAPSHOT_MODE: "gcs",
    VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64: publicB64,
    VELVETOS_FLEET_SNAPSHOT_KEY_ID: signerId,
    VELVETOS_FLEET_SNAPSHOT_BUCKET: "vf-private-example",
    VELVETOS_FLEET_SNAPSHOT_OBJECT: "portal/fleet/status.json",
  };
  const read = makeSignedFleetSource(env, { fetchImpl: mocked });
  assert.equal((await read()).count, 1);
  assert.equal(tokenCalls, 1);
  assert.equal(objectCalls, 1);
  for (const failure of ["denied", "invalid_type", "oversize", "tampered"]) {
    mode = failure;
    await assert.rejects(read());
  }
  mode = "ok";
  assert.equal((await read()).count, 1);
  const expiredRead = makeSignedFleetSource(env, {
    fetchImpl: mocked, now: () => Date.parse(object.expiresAt) + 1,
  });
  await assert.rejects(expiredRead());
  for (const [method, url] of seen) {
    assert.equal(method, "GET", "reader issued a non-GET request: " + url);
    assert(!/upload|\/o\?uploadType/.test(url), "reader reached an upload endpoint");
  }
  console.log("FLEET_SIGNED_PASS GCS_metadata_only_GET_https_origin_no_fallback");
});

test("oversized GCS stream fails promptly even if peer cancel never settles", async () => {
  let cancelCalls = 0;
  const env = {
    VELVETOS_FLEET_SNAPSHOT_MODE: "gcs",
    VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64: publicB64,
    VELVETOS_FLEET_SNAPSHOT_KEY_ID: signerId,
    VELVETOS_FLEET_SNAPSHOT_BUCKET: "vf-private-example",
    VELVETOS_FLEET_SNAPSHOT_OBJECT: "portal/fleet/status.json",
  };
  const fetchImpl = async (url) => {
    if (String(url).startsWith("http://metadata.google.internal/")) {
      return new Response(JSON.stringify({ access_token: "SYNTHETIC_ACCESS" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelCalls++; return new Promise(() => {}); },
    }), { headers: { "content-type": "application/json" } });
  };
  const read = makeSignedFleetSource(env, { fetchImpl });
  const result = await Promise.race([
    read().then(() => "ACCEPTED", error =>
      error?.message === "fleet_source_oversized" ? "REJECTED_OVERSIZED" : "REJECTED_OTHER"),
    new Promise(resolve => setTimeout(() => resolve("HUNG"), 500)),
  ]);
  assert.equal(cancelCalls, 1, "oversized stream was not cancelled");
  assert.equal(result, "REJECTED_OVERSIZED", "oversize denial hung or rejected for the wrong reason");
});

test("fixture adapter runs only under explicit temp/loopback test-only gates", () => {
  const fixture = path.join(os.tmpdir(), "vf-synthetic-snapshot.json");
  const config = {
    NODE_ENV: "production",
    VELVETOS_FLEET_SNAPSHOT_MODE: "test-fixture",
    VELVETOS_FLEET_SNAPSHOT_TEST_FILE: fixture,
    VELVETOS_FLEET_SNAPSHOT_TEST_ALLOW: "1",
    VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64: publicB64,
    VELVETOS_FLEET_SNAPSHOT_KEY_ID: signerId,
  };
  assert.throws(() => makeSignedFleetSource(config, { bindHost: "127.0.0.1" }));
  assert.throws(() => makeSignedFleetSource({ ...config, NODE_ENV: "test" }, { bindHost: "0.0.0.0" }));
  assert.throws(() => makeSignedFleetSource({ ...config, NODE_ENV: "test",
    VELVETOS_FLEET_SNAPSHOT_TEST_FILE: "/etc/passwd" }, { bindHost: "127.0.0.1" }));
  assert.throws(() => makeSignedFleetSource({ ...config, NODE_ENV: "test",
    VELVETOS_FLEET_SNAPSHOT_TEST_ALLOW: "" }, { bindHost: "127.0.0.1" }));
  assert.equal(makeSignedFleetSource({}, {}), null, "no mode means no signed source at all");
  console.log("FLEET_SIGNED_PASS no_production_fixture_or_arbitrary_file");
});

test("reader modules contain no write, upload, signing or key-store surface", () => {
  for (const file of readerFiles) {
    const code = fs.readFileSync(path.join(projectRoot, file), "utf8");
    assert(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(code), file + " has a write method");
    assert(!/uploadType|\/upload\//.test(code), file + " has an upload endpoint");
    assert(!/crypto\.sign\(|createSignedFleetSnapshot|createPrivateKey|DPAPI|ConvertTo-|\.ps1/.test(code),
      file + " has a signing or key-store surface");
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map(m => m[1]);
    for (const spec of imports) {
      assert(spec.startsWith("node:") || /^\.\/fleet-(projection|signed-snapshot|snapshot-source)\.mjs$/.test(spec),
        file + " imports unexpected module " + spec);
    }
  }
  console.log("FLEET_SIGNED_PASS reader_only_no_writer_surface");
});

// ---- Portal HTTP boundary, IAP-first ---------------------------------------
const iapAudience = "/projects/123456789012/locations/me-west1/services/velvetos-control-center-staging";
const iapKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const iapJwk = { ...iapKeys.publicKey.export({ format: "jwk" }), kid: "synthetic-iap", alg: "ES256", use: "sig" };
const wrongIapKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
function iapJwt(payload = {}, privateKey = iapKeys.privateKey) {
  const now2 = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "synthetic-iap" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    iss: "https://cloud.google.com/iap", aud: iapAudience, sub: "synthetic-subject",
    iat: now2, exp: now2 + 300, ...payload,
  })).toString("base64url");
  const data = header + "." + body;
  return data + "." + crypto.sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}
async function freePort() {
  const s = net.createServer().listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = s.address().port;
  s.close();
  await once(s, "close");
  return port;
}
// Test-only preload: answers the fixed Google IAP JWKS URL with the synthetic key
// and refuses every other non-loopback request, so no real Google call can happen.
function writeIapStub(dir) {
  const file = path.join(dir, "iap-jwks-stub.mjs");
  fs.writeFileSync(file, `
const jwks = process.env.VF_TEST_IAP_JWKS;
const real = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === "https://www.gstatic.com/iap/verify/public_key-jwk")
    return new Response(jwks, { status: 200, headers: { "content-type": "application/json" } });
  if (u.startsWith("http://127.0.0.1:")) return real(url, opts);
  throw new Error("synthetic_test_network_blocked");
};
`);
  return pathToFileURL(file).href;
}
function bootPortal({ fixture, iap = true, dir, extra = {} }) {
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: process.env.TMPDIR,
    NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", VF_TEST_IAP_JWKS: JSON.stringify({ keys: [iapJwk] }),
    VELVETOS_FLEET_SNAPSHOT_MODE: "test-fixture",
    VELVETOS_FLEET_SNAPSHOT_TEST_ALLOW: "1",
    VELVETOS_FLEET_SNAPSHOT_TEST_FILE: fixture,
    VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64: publicB64,
    VELVETOS_FLEET_SNAPSHOT_KEY_ID: signerId,
    VELVETOS_CONTROL_API_URL: "", VELVETOS_CONTROL_API_TOKEN: "",
    ...extra,
  };
  if (iap) { env.VELVETOS_REQUIRE_IAP = "1"; env.VELVETOS_IAP_AUDIENCE = iapAudience; }
  return { env, stub: writeIapStub(dir) };
}
async function startPortal(config) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", config.stub, "server.mjs"], {
    cwd: projectRoot, env: { ...config.env, PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", d => { stderr += d; });
  const origin = "http://127.0.0.1:" + port;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) return { child, exited: true, stderr };
    try {
      if ((await fetch(origin + "/liveness", { signal: AbortSignal.timeout(300) })).ok)
        return { child, origin, exited: false };
    } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  throw Error("fixture_portal_not_ready");
}

test("signed Fleet route is denied by IAP before any source is read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-fleet-signed-iap-"));
  const fixture = path.join(dir, "snapshot.json");
  let portal;
  try {
    fs.writeFileSync(fixture, JSON.stringify(envelope(30)));
    portal = await startPortal(bootPortal({ fixture, dir }));
    assert.equal(portal.exited, false, portal.stderr);
    const api = portal.origin + "/api/fleet/v1/machines";
    // No JWT: 401 while the source is valid.
    assert.equal((await fetch(api)).status, 401);
    // Forged JWT (wrong key), then a valid-looking but wrong-audience JWT: still 401.
    assert.equal((await fetch(api, { headers: { "x-goog-iap-jwt-assertion": iapJwt({}, wrongIapKeys.privateKey) } })).status, 401);
    assert.equal((await fetch(api, { headers: { "x-goog-iap-jwt-assertion": iapJwt({ aud: "/projects/1/x" }) } })).status, 401);
    // Source removed: if the guard were skipped the answer would be 503, not 401.
    fs.rmSync(fixture);
    assert.equal((await fetch(api)).status, 401, "IAP guard must run before the signed source");
    console.log("FLEET_SIGNED_PASS IAP_denies_before_source");
  } finally {
    portal?.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("IAP-verified signed route serves only a fresh verified copy and fails closed to 503", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-fleet-signed-http-"));
  const fixture = path.join(dir, "snapshot.json");
  let portal;
  try {
    fs.writeFileSync(fixture, JSON.stringify(envelope(15)));
    portal = await startPortal(bootPortal({ fixture, dir }));
    assert.equal(portal.exited, false, portal.stderr);
    const api = portal.origin + "/api/fleet/v1/machines";
    const auth = { "x-goog-iap-jwt-assertion": iapJwt() };
    const okay = await fetch(api, { headers: auth });
    assert.equal(okay.status, 200);
    assert.equal(okay.headers.get("cache-control"), "no-store");
    assert.equal(okay.headers.get("x-content-type-options"), "nosniff");
    const contents = await okay.json();
    assert.equal(contents.transport, "signed_snapshot");
    assert.equal(contents.count, 1);
    assert(!JSON.stringify(contents).includes("REMOVE_ME"));
    for (const [method, suffix, status] of [
      ["POST", "/api/fleet/v1/machines", 405],
      ["GET", "/api/fleet/v1/machines?expand=secrets", 400],
      ["GET", "/api/fleet/v1/actions", 404],
    ]) {
      assert.equal((await fetch(portal.origin + suffix, { method, headers: auth })).status, status, method + " " + suffix);
    }
    // Tampered, expired, and replayed sources all produce the same closed 503.
    const denied = async () => {
      const r = await fetch(api, { headers: auth });
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: "fleet_snapshot_unavailable" });
    };
    fs.writeFileSync(fixture, JSON.stringify({ ...envelope(16), signature: "A".repeat(86) }));
    await denied();
    fs.writeFileSync(fixture, JSON.stringify(envelope(16, new Date(now() - 92_000).toISOString(), 60_000)));
    await denied();
    fs.writeFileSync(fixture, JSON.stringify(envelope(14)));
    await denied();
    fs.writeFileSync(fixture, JSON.stringify(envelope(17)));
    assert.equal((await fetch(api, { headers: auth })).status, 200);
    console.log("FLEET_SIGNED_PASS IAP_route_200_then_503_on_tamper_expiry_replay");
  } finally {
    portal?.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signed Fleet mode refuses to start unless IAP is enforced", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-fleet-signed-noiap-"));
  const fixture = path.join(dir, "snapshot.json");
  try {
    fs.writeFileSync(fixture, JSON.stringify(envelope(40)));
    const portal = await startPortal(bootPortal({ fixture, dir, iap: false }));
    assert.equal(portal.exited, true, "server must not listen for signed Fleet without IAP");
    assert.match(portal.stderr, /signed_fleet_requires_iap/);
    console.log("FLEET_SIGNED_PASS startup_fails_closed_without_IAP");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
