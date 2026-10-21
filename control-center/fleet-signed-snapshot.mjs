import crypto from "node:crypto";
import { SCHEMA as FLEET_SCHEMA } from "./fleet-projection.mjs";

// Reader-only verification of a short-lived, signed derived view of Velvet Fleet.
// Verify-only: this module never signs, uploads, or issues anything. Signature
// covers the entire allowlisted projection and its issuance/expiry window.
// Deliberately NOT a command/remote-control transport.
export const ENVELOPE_SCHEMA = "velvetos.portal.fleet-signed-envelope.v1";
export const MAX_SNAPSHOT_AGE_MS = 90_000;
export const MAX_ENVELOPE_BYTES = 512 * 1024;
const MAX_CLOCK_SKEW_MS = 5_000;
const MACHINE_KEYS = ["collectedAt", "freshness", "hardware", "id", "lastSeen", "name", "os", "platform", "status"];
const HW_KEYS = ["cpu", "cpuCores", "memoryFreeBytes", "memoryTotalBytes"];
const OS_KEYS = ["name", "version"];
const FLEET_KEYS = ["count", "fetchedAt", "machines", "schema", "source"];
const ENVELOPE_KEYS = ["expiresAt", "issuedAt", "keyId", "payload", "schema", "sequence", "signature"];

const exactKeys = (object, expected) =>
  object && typeof object === "object" && !Array.isArray(object) &&
  JSON.stringify(Object.keys(object).sort()) === JSON.stringify(expected);

const isTimestamp = (value) =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

const optionalTimestamp = value => value === null ||
  (typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)));
const optionalText = (x, limit) => x === null ||
  (typeof x === "string" && x.length > 0 && x.length <= limit && !/[\x00-\x1f\x7f]/.test(x));
const bytes = x => x === null ||
  (typeof x === "number" && Number.isSafeInteger(x) && x >= 0);

function validFleetProjection(snapshot) {
  if (!exactKeys(snapshot, FLEET_KEYS) ||
      snapshot.schema !== FLEET_SCHEMA ||
      snapshot.source !== "Velvet Fleet Console" ||
      !isTimestamp(snapshot.fetchedAt) ||
      !Array.isArray(snapshot.machines) ||
      snapshot.machines.length > 300 ||
      snapshot.count !== snapshot.machines.length) return false;

  const ids = new Set();
  for (const m of snapshot.machines) {
    if (!exactKeys(m, MACHINE_KEYS) ||
        typeof m.id !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(m.id) ||
        typeof m.name !== "string" || m.name.length > 120 ||
        m.name.length === 0 || /[\x00-\x1f\x7f]/.test(m.name) ||
        !["windows", "macos", "linux", "unknown"].includes(m.platform) ||
        !["online", "offline", "unknown"].includes(m.status) ||
        !["live", "stale", "unknown"].includes(m.freshness) ||
        !optionalTimestamp(m.collectedAt) || !optionalTimestamp(m.lastSeen) ||
        !exactKeys(m.os, OS_KEYS) ||
        !optionalText(m.os.name, 180) || !optionalText(m.os.version, 90) ||
        !exactKeys(m.hardware, HW_KEYS) ||
        !optionalText(m.hardware.cpu, 160) ||
        !(m.hardware.cpuCores === null ||
          (Number.isInteger(m.hardware.cpuCores) && m.hardware.cpuCores >= 0 && m.hardware.cpuCores <= 4096)) ||
        !bytes(m.hardware.memoryFreeBytes) || !bytes(m.hardware.memoryTotalBytes) ||
        ids.has(m.id)) return false;
    ids.add(m.id);
  }
  return true;
}

// Same rule as the browser: "online" is only reported with a live observation.
// A signed copy may be older than its own status claims, so never invent online.
function withoutInventedOnline(payload) {
  return {
    ...payload,
    machines: payload.machines.map(m => m.status === "online" && (m.freshness !== "live" || !m.lastSeen)
      ? { ...m, status: "unknown" } : m),
  };
}

// Pure serializer shared with the source-only publisher; it signs nothing itself.
export function signedBytes(v) {
  return Buffer.from("VELVETOS/FLEET/SIGNED-SNAPSHOT/v1\n" + JSON.stringify({
    schema: v.schema, keyId: v.keyId, sequence: v.sequence,
    issuedAt: v.issuedAt, expiresAt: v.expiresAt, payload: v.payload,
  }), "utf8");
}

export function verifySignedFleetSnapshot(value, {
  publicKey, keyId, now = Date.now(),
} = {}) {
  if (!exactKeys(value, ENVELOPE_KEYS) ||
      value.schema !== ENVELOPE_SCHEMA ||
      value.keyId !== keyId ||
      !/^[a-z0-9_-]{3,64}$/.test(value.keyId) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !isTimestamp(value.issuedAt) || !isTimestamp(value.expiresAt) ||
      !validFleetProjection(value.payload) ||
      value.payload.fetchedAt !== value.issuedAt ||
      typeof value.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(value.signature) ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_ENVELOPE_BYTES) {
    throw new Error("invalid_signed_fleet_envelope");
  }
  const from = Date.parse(value.issuedAt), until = Date.parse(value.expiresAt);
  if (until <= from || until - from > MAX_SNAPSHOT_AGE_MS ||
      from > now + MAX_CLOCK_SKEW_MS || until <= now) {
    throw new Error("expired_or_future_fleet_envelope");
  }
  const sig = Buffer.from(value.signature, "base64url");
  if (sig.length !== 64 ||
      !crypto.verify(null, signedBytes(value), publicKey, sig)) {
    throw new Error("unverified_fleet_signature");
  }
  return {
    ...withoutInventedOnline(value.payload),
    transport: "signed_snapshot",
    validUntil: value.expiresAt,
    signatureKeyId: value.keyId,
  };
}

export function makeSnapshotSequenceGuard() {
  let lastSequence = 0, lastSignature = null;
  return (value) => {
    if (value.sequence < lastSequence ||
        (value.sequence === lastSequence && lastSignature !== value.signature))
      throw new Error("fleet_snapshot_replay");
    lastSequence = value.sequence;
    lastSignature = value.signature;
    return true;
  };
}

export function spkiPublicKeyFromBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/=]{40,400}$/.test(value))
    throw new Error("invalid_snapshot_public_key");
  const key = crypto.createPublicKey({
    key: Buffer.from(value, "base64"), format: "der", type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("snapshot_key_not_ed25519");
  return key;
}
