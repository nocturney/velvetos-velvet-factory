// Synthetic-only tests for the source-only signed Fleet publisher. Keys are generated
// in memory per run and nothing is written, uploaded, fetched or read from the environment.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeSnapshotPublisher, DEFAULT_SNAPSHOT_TTL_MS } from "../fleet-signed-publisher.mjs";
import {
  ENVELOPE_SCHEMA, MAX_SNAPSHOT_AGE_MS, makeSnapshotSequenceGuard,
  verifySignedFleetSnapshot,
} from "../fleet-signed-snapshot.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyId = "synthetic_key_1";
const keys = crypto.generateKeyPairSync("ed25519");
const otherKeys = crypto.generateKeyPairSync("ed25519");
const T0 = Date.parse("2026-10-21T10:00:00.000Z");
const clock = (ms = T0) => { let t = ms; return { now: () => t, set: (v) => { t = v; } }; };
const machine = (id = "windows-synthetic", extra = {}) => ({
  id, name: id, platform: "windows", status: "online", freshness: "live",
  collectedAt: "2026-10-21T09:59:50.000Z", lastSeen: "2026-10-21T09:59:59.000Z",
  os: { name: "Test Windows", version: "11", deviceSecret: "REMOVE_ME" },
  hardware: {
    cpu: "Synthetic CPU", cpuCores: 12,
    memory: { totalBytes: 24 * 1024 ** 3, freeBytes: 12 * 1024 ** 3, password: "REMOVE_ME" },
  },
  network: { ip: "192.0.2.99" }, accessToken: "REMOVE_ME",
  ...extra,
});
const publisherFor = (c, extra = {}) => makeSnapshotPublisher({
  privateKey: keys.privateKey, keyId, now: c.now, ...extra,
});
const verify = (value, at = T0, pub = keys.publicKey) =>
  verifySignedFleetSnapshot(value, { publicKey: pub, keyId, now: at });

test("publisher output is exactly the reader envelope and verifies with the reader", () => {
  const c = clock();
  const env = publisherFor(c)([machine()]);
  assert.deepEqual(Object.keys(env).sort(),
    ["expiresAt", "issuedAt", "keyId", "payload", "schema", "sequence", "signature"]);
  assert.equal(env.schema, ENVELOPE_SCHEMA);
  assert.equal(env.keyId, keyId);
  assert.equal(env.issuedAt, "2026-10-21T10:00:00.000Z");
  assert.equal(env.expiresAt, new Date(T0 + DEFAULT_SNAPSHOT_TTL_MS).toISOString());
  assert.equal(env.payload.fetchedAt, env.issuedAt);
  assert.equal(env.sequence, T0, "sequence is the issuance ms when no floor is set");
  const data = verify(env);
  assert.equal(data.transport, "signed_snapshot");
  assert.equal(data.validUntil, env.expiresAt);
  assert.equal(data.count, 1);
  assert.equal(data.machines[0].os.name, "Test Windows");
  console.log("FLEET_PUBLISHER_PASS reader_exact_envelope_roundtrip");
});

test("only the allowlisted projection leaves the publisher", () => {
  const env = publisherFor(clock())([machine("windows-synthetic", { lastSeenIp: "10.0.0.7" })]);
  const json = JSON.stringify(env);
  for (const secret of ["REMOVE_ME", "accessToken", "192.0.2.99", "deviceSecret", "password",
    "network", "lastSeenIp", "10.0.0.7"]) {
    assert(!json.includes(secret), "private source field escaped: " + secret);
  }
  console.log("FLEET_PUBLISHER_PASS allowlisted_projection_only");
});

test("sequence is strictly increasing across calls, same-ms calls and clock regressions", () => {
  const c = clock();
  const publish = publisherFor(c);
  const a = publish([machine()]);
  const b = publish([machine()]);
  assert.equal(b.sequence, a.sequence + 1, "same-millisecond calls still advance by one");
  c.set(T0 - 60_000);
  const backwards = publish([machine()]);
  assert(backwards.sequence > b.sequence, "clock regression must not lower the sequence");
  // The reader's replay guard accepts the publisher's order and rejects a rollback.
  const guard = makeSnapshotSequenceGuard();
  guard(a); guard(b); guard(backwards);
  assert.throws(() => guard(a), /fleet_snapshot_replay/);
  console.log("FLEET_PUBLISHER_PASS sequence_monotonic_replay_guard_agrees");
});

test("a restarted publisher with a sequence floor still outranks the last snapshot", () => {
  const c = clock();
  const previous = publisherFor(c)([machine()]);
  const floored = publisherFor(c, { startAfterSequence: previous.sequence + 500 })([machine()]);
  assert.equal(floored.sequence, previous.sequence + 501);
  assert.throws(() => publisherFor(c, { startAfterSequence: -1 }), /invalid_snapshot_sequence_floor/);
  console.log("FLEET_PUBLISHER_PASS restart_sequence_floor");
});

test("freshness: the signed copy expires at issuance plus ttl and the reader rejects it after", () => {
  const c = clock();
  const env = publisherFor(c, { ttlMs: 30_000 })([machine()]);
  assert.equal(Date.parse(env.expiresAt) - Date.parse(env.issuedAt), 30_000);
  verify(env, T0 + 29_999);
  assert.throws(() => verify(env, T0 + 30_000), /expired_or_future/);
  assert.throws(() => verify(env, T0 - 10_000), /expired_or_future/, "future-issued rejected");
  const max = publisherFor(c, { ttlMs: MAX_SNAPSHOT_AGE_MS })([machine()]);
  assert.equal(Date.parse(max.expiresAt) - Date.parse(max.issuedAt), MAX_SNAPSHOT_AGE_MS);
  console.log("FLEET_PUBLISHER_PASS deterministic_window_expiry");
});

test("a publisher never invents online: the signed copy keeps the reader's rule", () => {
  const env = publisherFor(clock())([
    { ...machine("stale-claims-online"), freshness: "stale" },
    { ...machine("no-lastseen"), lastSeen: null },
    machine("live-online"),
  ]);
  const data = verify(env);
  assert.deepEqual(data.machines.map(m => [m.id, m.status]), [
    ["stale-claims-online", "unknown"], ["no-lastseen", "unknown"], ["live-online", "online"],
  ]);
  console.log("FLEET_PUBLISHER_PASS no_invented_online");
});

test("empty fleet is a valid signed snapshot", () => {
  const data = verify(publisherFor(clock())([]));
  assert.equal(data.count, 0);
  assert.deepEqual(data.machines, []);
  console.log("FLEET_PUBLISHER_PASS empty_fleet");
});

test("invalid signing keys and interface arguments fail closed before any signing", () => {
  const c = clock();
  const ok = { privateKey: keys.privateKey, keyId, now: c.now };
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.throws(() => makeSnapshotPublisher({ ...ok, privateKey: rsa.privateKey }), /not_ed25519_private/);
  assert.throws(() => makeSnapshotPublisher({ ...ok, privateKey: ec.privateKey }), /not_ed25519_private/);
  assert.throws(() => makeSnapshotPublisher({ ...ok, privateKey: keys.publicKey }), /not_ed25519_private/);
  assert.throws(() => makeSnapshotPublisher({ ...ok, privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }) }),
    /not_ed25519_private/, "string key material is refused");
  assert.throws(() => makeSnapshotPublisher({ ...ok, privateKey: undefined }), /not_ed25519_private/);
  for (const badId of ["", "A", "bad id", "x".repeat(65), "../etc", undefined]) {
    assert.throws(() => makeSnapshotPublisher({ ...ok, keyId: badId }), /invalid_snapshot_key_id/);
  }
  for (const ttl of [0, -1, 1.5, MAX_SNAPSHOT_AGE_MS + 1, Number.NaN]) {
    assert.throws(() => makeSnapshotPublisher({ ...ok, ttlMs: ttl }), /invalid_snapshot_ttl/);
  }
  const publish = makeSnapshotPublisher(ok);
  for (const bad of [undefined, null, {}, "machines", [null], [machine("Bad Id")],
    [machine("dup"), machine("dup")], [{ ...machine(), name: "bad\u0007name" }]]) {
    assert.throws(() => publish(bad));
  }
  const badClock = makeSnapshotPublisher({ ...ok, now: () => Number.NaN });
  assert.throws(() => badClock([machine()]), /invalid_snapshot_clock/);
  console.log("FLEET_PUBLISHER_PASS fail_closed_keys_args_input");
});

test("signature is bound to the signing key and tamper is caught by the reader", () => {
  const env = publisherFor(clock())([machine()]);
  assert.throws(() => verify(env, T0, otherKeys.publicKey), /unverified_fleet_signature/);
  const tampered = structuredClone(env);
  tampered.payload.machines[0].status = "offline";
  assert.throws(() => verify(tampered), /unverified_fleet_signature/);
  console.log("FLEET_PUBLISHER_PASS signature_bound_to_key");
});

test("publisher is source-only: no I/O, network, env, or key-loading surface, and reader never imports it", () => {
  const code = fs.readFileSync(path.join(projectRoot, "fleet-signed-publisher.mjs"), "utf8");
  for (const forbidden of [/\bfetch\(/, /process\.env/, /node:fs/, /node:net/, /node:http/,
    /readFile|writeFile|createPrivateKey|createPublicKey\(\s*\{/, /upload/i, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/]) {
    assert(!forbidden.test(code), "publisher has a forbidden surface: " + forbidden);
  }
  for (const file of ["fleet-signed-snapshot.mjs", "fleet-snapshot-source.mjs", "server.mjs"]) {
    const src = fs.readFileSync(path.join(projectRoot, file), "utf8");
    assert(!/fleet-signed-publisher/.test(src), file + " must not import the publisher");
  }
  console.log("FLEET_PUBLISHER_PASS source_only_not_wired_into_reader");
});
