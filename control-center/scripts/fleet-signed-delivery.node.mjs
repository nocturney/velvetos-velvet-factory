// Synthetic-only tests for the source-only signed Fleet delivery adapter. Keys are generated
// in memory per run; the persist callback is an in-memory array, so nothing touches disk,
// network, environment or real storage.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeSnapshotPublisher } from "../fleet-signed-publisher.mjs";
import { makeSnapshotDeliveryAdapter } from "../fleet-signed-delivery.mjs";
import { verifySignedFleetSnapshot } from "../fleet-signed-snapshot.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyId = "synthetic_key_1";
const keys = crypto.generateKeyPairSync("ed25519");
const T0 = Date.parse("2026-10-21T10:00:00.000Z");
const clock = (ms = T0) => { let t = ms; return { now: () => t, set: (v) => { t = v; } }; };
const machine = (id = "windows-synthetic") => ({
  id, name: id, platform: "windows", status: "online", freshness: "live",
  collectedAt: "2026-10-21T09:59:50.000Z", lastSeen: "2026-10-21T09:59:59.000Z",
  os: { name: "Test Windows", version: "11" },
  hardware: { cpu: "Synthetic CPU", cpuCores: 12, memoryTotalBytes: 2048, memoryFreeBytes: 1024 },
});
// Persist stub: records every call, behaviour may throw synchronously or return a promise.
const store = (behaviour = () => {}) => {
  const writes = [];
  const persistSnapshot = (entry) => { writes.push(entry); return behaviour(entry); };
  return { writes, persistSnapshot };
};
const adapterFor = (c, { publish, persistSnapshot, ...extra } = {}) => makeSnapshotDeliveryAdapter({
  publishSnapshot: publish ?? makeSnapshotPublisher({ privateKey: keys.privateKey, keyId, now: c.now }),
  persistSnapshot: persistSnapshot ?? store().persistSnapshot,
  publicKey: keys.publicKey, keyId, now: c.now, ...extra,
});

test("delivers the exact bytes the reader verifies, with a strictly increasing sequence", async () => {
  const c = clock();
  const { writes, persistSnapshot } = store();
  const deliver = adapterFor(c, { persistSnapshot });
  const a = await deliver([machine()]);
  const b = await deliver([machine()]);
  assert.equal(writes.length, 2);
  assert(b.sequence > a.sequence, "second delivery advances the sequence");
  assert.equal(a.expiresAt, JSON.parse(writes[0].bytes.toString("utf8")).expiresAt);
  for (const w of writes) {
    assert(Buffer.isBuffer(w.bytes));
    const reread = verifySignedFleetSnapshot(JSON.parse(w.bytes.toString("utf8")),
      { publicKey: keys.publicKey, keyId, now: T0 });
    assert.equal(reread.transport, "signed_snapshot");
    assert.equal(reread.machines[0].id, "windows-synthetic");
  }
  assert.deepEqual(writes.map(w => w.sequence), [a.sequence, b.sequence]);
  console.log("FLEET_DELIVERY_PASS exact_bytes_verify_and_sequence_advances");
});

test("a failed write is not counted as delivered and the next attempt still succeeds", async () => {
  const c = clock();
  let fail = true;
  const { writes, persistSnapshot } = store(() => { if (fail) throw new Error("disk_full_synthetic"); });
  const deliver = adapterFor(c, { persistSnapshot });
  await assert.rejects(deliver([machine()]), (err) =>
    err.message === "snapshot_delivery_persist_failed" && err.cause.message === "disk_full_synthetic");
  fail = false;
  const ok = await deliver([machine()]);
  assert.equal(writes.length, 2, "the failed attempt was still tried once");
  assert.equal(writes[1].sequence, ok.sequence);
  assert(ok.sequence > writes[0].sequence, "sequence keeps moving past the failed attempt");
  console.log("FLEET_DELIVERY_PASS failed_write_not_counted_next_succeeds");
});

test("a durable floor from a previous run blocks equal or lower sequences before any write", async () => {
  const c = clock();
  const { writes, persistSnapshot } = store();
  const floor = T0 + 1_000; // what a durable store reports as the last delivered sequence
  const deliver = adapterFor(c, { persistSnapshot, lastDeliveredSequence: floor });
  await assert.rejects(deliver([machine()]), /snapshot_sequence_not_advancing/);
  assert.equal(writes.length, 0, "nothing is persisted at or below the durable floor");
  console.log("FLEET_DELIVERY_PASS durable_floor_blocks_before_write");
});

test("stale or future-issued envelopes are rejected at delivery time and never persisted", async () => {
  const c = clock();
  const publish = makeSnapshotPublisher({ privateKey: keys.privateKey, keyId, now: c.now, ttlMs: 30_000 });
  const { writes, persistSnapshot } = store();
  const deliver = adapterFor(c, { publish, persistSnapshot });
  await deliver([machine()]); // fine at issuance
  // Same envelope would expire before a slow write: the delivery clock is what decides.
  const late = adapterFor(clock(T0 + 30_000), {
    publish: () => publish([machine()]), persistSnapshot,
  });
  await assert.rejects(late([machine()]), /expired_or_future_fleet_envelope/);
  const early = adapterFor(clock(T0 - 10_000), {
    publish: () => publish([machine()]), persistSnapshot,
  });
  await assert.rejects(early([machine()]), /expired_or_future_fleet_envelope/);
  assert.equal(writes.length, 1, "only the in-window delivery was persisted");
  console.log("FLEET_DELIVERY_PASS stale_and_future_rejected_before_write");
});

test("tampered, wrong-key or wrong-keyId envelopes from the publisher are refused before write", async () => {
  const c = clock();
  const publish = makeSnapshotPublisher({ privateKey: keys.privateKey, keyId, now: c.now });
  const { writes, persistSnapshot } = store();
  const tampering = adapterFor(c, {
    persistSnapshot,
    publish: (raw) => {
      const env = publish(raw);
      env.payload.machines[0].status = "offline"; // altered after signing
      return env;
    },
  });
  await assert.rejects(tampering([machine()]), /unverified_fleet_signature/);
  const otherKeyId = adapterFor(c, { persistSnapshot, keyId: "other_key_2" });
  await assert.rejects(otherKeyId([machine()]), /invalid_signed_fleet_envelope/);
  const otherKey = crypto.generateKeyPairSync("ed25519");
  const wrongPub = makeSnapshotDeliveryAdapter({
    publishSnapshot: publish, persistSnapshot, publicKey: otherKey.publicKey, keyId, now: c.now,
  });
  await assert.rejects(wrongPub([machine()]), /unverified_fleet_signature/);
  assert.equal(writes.length, 0);
  console.log("FLEET_DELIVERY_PASS tampered_wrong_key_refused_before_write");
});

test("null publisher output never advances the delivered floor", async () => {
  const c = clock();
  const { writes, persistSnapshot } = store();
  let bad = true;
  const publish = () => (bad ? null : makeSnapshotPublisher({ privateKey: keys.privateKey, keyId, now: c.now })([machine()]));
  const deliver = adapterFor(c, { publish, persistSnapshot });
  await assert.rejects(deliver([machine()]), /snapshot_sequence_not_advancing/);
  bad = false;
  await deliver([machine()]);
  assert.equal(writes.length, 1);
  console.log("FLEET_DELIVERY_PASS null_publisher_output_fails_closed");
});

test("interface arguments fail closed before any delivery", () => {
  const c = clock();
  const publish = makeSnapshotPublisher({ privateKey: keys.privateKey, keyId, now: c.now });
  const base = { publishSnapshot: publish, persistSnapshot: () => {}, publicKey: keys.publicKey, keyId, now: c.now };
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => makeSnapshotDeliveryAdapter({ ...base, publishSnapshot: undefined }), /invalid_snapshot_publisher/);
  assert.throws(() => makeSnapshotDeliveryAdapter({ ...base, persistSnapshot: "path/to/file" }), /invalid_snapshot_persist/);
  assert.throws(() => makeSnapshotDeliveryAdapter({ ...base, publicKey: keys.privateKey }), /snapshot_public_key_not_ed25519/);
  assert.throws(() => makeSnapshotDeliveryAdapter({ ...base, publicKey: rsa.publicKey }), /snapshot_public_key_not_ed25519/);
  assert.throws(() => makeSnapshotDeliveryAdapter({ ...base, publicKey: undefined }), /snapshot_public_key_not_ed25519/);
  for (const floor of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "7"]) {
    assert.throws(() => makeSnapshotDeliveryAdapter({ ...base, lastDeliveredSequence: floor }), /invalid_snapshot_sequence_floor/);
  }
  assert.equal(typeof makeSnapshotDeliveryAdapter(base), "function");
  console.log("FLEET_DELIVERY_PASS fail_closed_interface");
});

test("an async writer that resolves is awaited and counts as delivered", async () => {
  const c = clock();
  const { writes, persistSnapshot } = store(() => Promise.resolve("stored_synthetic"));
  const deliver = adapterFor(c, { persistSnapshot });
  const result = deliver([machine()]);
  assert(result instanceof Promise, "deliverSnapshot returns a promise");
  const ok = await result;
  assert.equal(writes.length, 1);
  assert.equal(ok.sequence, writes[0].sequence);
  const next = await deliver([machine()]);
  assert(next.sequence > ok.sequence, "the resolved write moved the delivered floor");
  console.log("FLEET_DELIVERY_PASS async_writer_resolves_then_counts_delivered");
});

test("an envelope that expires while the write is pending is not reported as delivered", async () => {
  const c = clock();
  let expireFirstWrite = true;
  const { writes, persistSnapshot } = store(() => {
    if (expireFirstWrite) {
      expireFirstWrite = false;
      c.set(T0 + 60_000); // only the first slow write completes at expiry
    }
    return Promise.resolve("stored_synthetic");
  });
  const deliver = adapterFor(c, { persistSnapshot });
  await assert.rejects(deliver([machine()]), /snapshot_expired_before_durable_completion/);
  assert.equal(writes.length, 1, "the write was attempted while the envelope was still valid");
  c.set(T0);
  const next = await deliver([machine()]);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].sequence, next.sequence);
  assert(next.sequence > writes[0].sequence, "the expired write was not treated as delivered");
  console.log("FLEET_DELIVERY_PASS expired_during_write_not_reported_delivered");
});

test("an async writer rejection is not counted as delivered and a later retry succeeds", async () => {
  const c = clock();
  let fail = true;
  const { writes, persistSnapshot } = store(() => (fail
    ? Promise.reject(new Error("gcs_unavailable_synthetic"))
    : Promise.resolve("stored_synthetic")));
  const deliver = adapterFor(c, { persistSnapshot });
  await assert.rejects(deliver([machine()]), (err) =>
    err.message === "snapshot_delivery_persist_failed" && err.cause.message === "gcs_unavailable_synthetic");
  fail = false;
  const ok = await deliver([machine()]);
  assert.equal(writes.length, 2, "the rejected attempt was tried once, then the retry was written");
  assert.equal(writes[1].sequence, ok.sequence);
  assert(ok.sequence > writes[0].sequence, "the rejected sequence was not treated as delivered");
  console.log("FLEET_DELIVERY_PASS async_rejection_not_delivered_retry_succeeds");
});

test("a second in-flight delivery is refused before the publisher or writer runs, and retry works after", async () => {
  const c = clock();
  let publishCalls = 0;
  const signer = makeSnapshotPublisher({ privateKey: keys.privateKey, keyId, now: c.now });
  const publish = (raw) => {
    publishCalls += 1;
    return signer(raw);
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { writes, persistSnapshot } = store(() => gate.then(() => "stored_synthetic"));
  const deliver = adapterFor(c, { publish, persistSnapshot });
  const first = deliver([machine()]);
  await assert.rejects(deliver([machine()]), /snapshot_delivery_in_flight/);
  assert.equal(publishCalls, 1, "the refused call never reached the publisher");
  assert.equal(writes.length, 1, "the refused call never reached the writer");
  release();
  const firstOk = await first;
  const after = await deliver([machine()]);
  assert.equal(publishCalls, 2, "the guard cleared once the first delivery settled");
  assert(after.sequence > firstOk.sequence);
  assert.equal(writes.length, 2);
  console.log("FLEET_DELIVERY_PASS concurrent_in_flight_denied_then_retry_succeeds");
});

test("the in-flight guard clears when the in-flight write rejects, so a later call can deliver", async () => {
  const c = clock();
  let publishCalls = 0;
  const signer = makeSnapshotPublisher({ privateKey: keys.privateKey, keyId, now: c.now });
  const publish = (raw) => {
    publishCalls += 1;
    return signer(raw);
  };
  let reject;
  const gate = new Promise((_, rej) => { reject = rej; });
  const { writes, persistSnapshot } = store((entry) => (writes.length === 1
    ? gate
    : Promise.resolve("stored_synthetic")));
  const deliver = adapterFor(c, { publish, persistSnapshot });
  const first = deliver([machine()]);
  await assert.rejects(deliver([machine()]), /snapshot_delivery_in_flight/);
  reject(new Error("write_failed_synthetic"));
  await assert.rejects(first, /snapshot_delivery_persist_failed/);
  const retry = await deliver([machine()]);
  assert.equal(publishCalls, 2, "the refused call did not invoke the publisher");
  assert.equal(writes.length, 2);
  assert.equal(writes[1].sequence, retry.sequence);
  console.log("FLEET_DELIVERY_PASS in_flight_guard_clears_on_rejection");
});

test("delivery adapter is source-only: no I/O surface, and the reader never imports it", () => {
  const code = fs.readFileSync(path.join(projectRoot, "fleet-signed-delivery.mjs"), "utf8");
  for (const forbidden of [/\bfetch\(/, /process\.env/, /node:fs/, /node:net/, /node:http/, /node:child_process/,
    /readFile|writeFile|appendFile|createPrivateKey|createPublicKey\(\s*\{/,
    /method:\s*["'](POST|PUT|PATCH|DELETE)["']/, /\bgs:\/\//i, /storage\.googleapis/i]) {
    assert(!forbidden.test(code), "delivery adapter has a forbidden surface: " + forbidden);
  }
  for (const file of ["fleet-signed-snapshot.mjs", "fleet-snapshot-source.mjs", "fleet-projection.mjs", "server.mjs"]) {
    const src = fs.readFileSync(path.join(projectRoot, file), "utf8");
    assert(!/fleet-signed-delivery/.test(src), file + " must not import the delivery adapter");
  }
  console.log("FLEET_DELIVERY_PASS source_only_not_wired_into_reader");
});
