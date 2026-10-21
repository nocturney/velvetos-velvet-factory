import crypto from "node:crypto";
import { MAX_ENVELOPE_BYTES, verifySignedFleetSnapshot } from "./fleet-signed-snapshot.mjs";

// Source-only delivery adapter for an already signed Fleet snapshot. It performs NO I/O:
// the caller injects `persistSnapshot`, which must return only after a durable write
// (or resolve a promise after that write), rejecting/throwing on any failure. Only bytes that the reader's own verifier accepts after a JSON round
// trip (the form that will be stored, not the in-memory object) are handed over, and only with a
// sequence strictly above the last one already delivered. Only one delivery may be in flight at a
// time. NOT imported by the server or reader.
export function makeSnapshotDeliveryAdapter({
  publishSnapshot, persistSnapshot, publicKey, keyId,
  now = () => Date.now(), lastDeliveredSequence = 0,
} = {}) {
  if (typeof publishSnapshot !== "function") throw new Error("invalid_snapshot_publisher");
  if (typeof persistSnapshot !== "function") throw new Error("invalid_snapshot_persist");
  if (!(publicKey instanceof crypto.KeyObject) || publicKey.type !== "public" ||
      publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("snapshot_public_key_not_ed25519");
  }
  if (!Number.isSafeInteger(lastDeliveredSequence) || lastDeliveredSequence < 0) {
    throw new Error("invalid_snapshot_sequence_floor");
  }
  // Advances only after persistSnapshot resolved, so a failed write never counts as delivered
  // and the next attempt is not blocked by it.
  let delivered = lastDeliveredSequence;
  // Set before any publisher or writer call and cleared in finally, so a second concurrent call
  // is refused without touching either.
  let inFlight = false;

  return async function deliverSnapshot(rawMachines) {
    if (inFlight) throw new Error("snapshot_delivery_in_flight");
    inFlight = true;
    try {
      const envelope = publishSnapshot(rawMachines);
      if (!Number.isSafeInteger(envelope?.sequence) || envelope.sequence <= delivered) {
        throw new Error("snapshot_sequence_not_advancing");
      }
      const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
      if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error("invalid_signed_fleet_envelope");
      // Verify what will be stored, with the reader's own rules and the delivery-time clock.
      verifySignedFleetSnapshot(JSON.parse(bytes.toString("utf8")), { publicKey, keyId, now: now() });

      try {
        await persistSnapshot({ sequence: envelope.sequence, bytes });
      } catch (cause) {
        throw new Error("snapshot_delivery_persist_failed", { cause });
      }
      // The write may outlive the validity window. The reader refuses an envelope once
      // expiresAt <= now, so a durable write that completed after expiry is not a delivery.
      if (Date.parse(envelope.expiresAt) <= now()) throw new Error("snapshot_expired_before_durable_completion");
      delivered = envelope.sequence;
      return { sequence: envelope.sequence, expiresAt: envelope.expiresAt };
    } finally {
      inFlight = false;
    }
  };
}
