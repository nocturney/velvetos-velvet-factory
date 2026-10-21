import crypto from "node:crypto";
import { projectFleetMachines } from "./fleet-projection.mjs";
import {
  ENVELOPE_SCHEMA, MAX_SNAPSHOT_AGE_MS, signedBytes, verifySignedFleetSnapshot,
} from "./fleet-signed-snapshot.mjs";

// Source-only publisher for the signed Fleet snapshot. It is NOT imported by the
// server or the reader, is NOT in the release image, and performs no I/O: it turns
// an already-collected machine list into the exact envelope the reader accepts.
// Delivery to any storage or serving location is the caller's job and is not implemented here.
export const DEFAULT_SNAPSHOT_TTL_MS = 60_000;
const KEY_ID_RE = /^[a-z0-9_-]{3,64}$/;

// The caller supplies an in-memory Ed25519 private KeyObject. This module never reads
// keys from disk, the environment or a string, so there is no key-loading surface here.
export function makeSnapshotPublisher({
  privateKey, keyId, ttlMs = DEFAULT_SNAPSHOT_TTL_MS,
  now = () => Date.now(), startAfterSequence = 0,
} = {}) {
  if (!(privateKey instanceof crypto.KeyObject) || privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("snapshot_signing_key_not_ed25519_private");
  }
  if (!KEY_ID_RE.test(keyId || "")) throw new Error("invalid_snapshot_key_id");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SNAPSHOT_AGE_MS) {
    throw new Error("invalid_snapshot_ttl");
  }
  if (!Number.isSafeInteger(startAfterSequence) || startAfterSequence < 0) {
    throw new Error("invalid_snapshot_sequence_floor");
  }
  const publicKey = crypto.createPublicKey(privateKey);
  let lastSequence = startAfterSequence;

  return function publishSnapshot(rawMachines) {
    const issuedMs = now();
    if (!Number.isSafeInteger(issuedMs) || issuedMs <= 0) throw new Error("invalid_snapshot_clock");
    const issuedAt = new Date(issuedMs).toISOString();
    // Strictly increasing, and never below the issuance time in ms: a restarted publisher
    // whose clock has not gone backwards still outranks what a reader saw earlier.
    const sequence = Math.max(lastSequence + 1, issuedMs);
    const unsigned = {
      schema: ENVELOPE_SCHEMA, keyId, sequence, issuedAt,
      expiresAt: new Date(issuedMs + ttlMs).toISOString(),
      // Allowlisted projection: any extra field on a source machine is dropped here.
      payload: projectFleetMachines(rawMachines, issuedAt),
    };
    const envelope = {
      ...unsigned,
      signature: crypto.sign(null, signedBytes(unsigned), privateKey).toString("base64url"),
    };
    // Fail closed: nothing leaves this function unless the reader's own verifier accepts it.
    verifySignedFleetSnapshot(envelope, { publicKey, keyId, now: issuedMs });
    lastSequence = sequence;
    return envelope;
  };
}
