import crypto from "node:crypto";
import {
  createSignedFleetSnapshot, verifySignedFleetSnapshot, MAX_ENVELOPE_BYTES,
} from "./fleet-signed-snapshot.mjs";
import { withPublisherStateLock } from "./fleet-publisher-state.mjs";

const SOURCE_URL = "http://127.0.0.1:4173/api/machines";
const MAX_FLEET_RESPONSE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

async function readBoundedJson(response) {
  if (!response.ok) throw new Error("canonical_fleet_unavailable");
  if (!/^application\/(json|[a-z0-9.+-]+\+json)(;|$)/i.test(
    response.headers.get("content-type") || ""))
    throw new Error("canonical_fleet_not_json");
  const len = Number(response.headers.get("content-length") || 0);
  if (!Number.isFinite(len) || len < 0 || len > MAX_FLEET_RESPONSE_BYTES)
    throw new Error("canonical_fleet_response_oversized");
  if (!response.body) throw new Error("canonical_fleet_response_empty");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FLEET_RESPONSE_BYTES) {
        // The oversize denial must not wait for an uncooperative stream's cancel().
        // Initiate teardown, but preserve the bounded failure even if it never settles.
        try { void Promise.resolve(reader.cancel("oversized")).catch(() => {}); }
        catch { /* best-effort cancellation may throw synchronously */ }
        throw new Error("canonical_fleet_response_oversized");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
  catch { throw new Error("canonical_fleet_invalid_json"); }
}

export async function readCanonicalFleetViewer({ viewerToken, fetchImpl = fetch }) {
  if (typeof viewerToken !== "string" || viewerToken.length < 24 ||
      viewerToken.length > 8192 || /[\r\n]/.test(viewerToken))
    throw new Error("fleet_viewer_credential_missing");
  const headers = {
    Authorization: "Bearer " + viewerToken, Accept: "application/json",
  };
  // The existing Fleet endpoint identifies the caller's actual access role.
  // A copied admin credential must never be used by this publisher.
  const roleResponse = await fetchImpl("http://127.0.0.1:4173/api/settings", {
    method: "GET", redirect: "error", headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const settings = await readBoundedJson(roleResponse);
  if (!settings || typeof settings !== "object" ||
      settings.accessRole !== "viewer") {
    throw new Error("publisher_requires_verified_viewer_role");
  }
  const response = await fetchImpl(SOURCE_URL, {
    method: "GET", redirect: "error", headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const rows = await readBoundedJson(response);
  if (!Array.isArray(rows) || rows.length > 300)
    throw new Error("invalid_canonical_fleet_rows");
  return rows;
}

export async function publishFleetSnapshotOnce({
  stateFile, identity, transport, getViewerToken,
  getSigningKey, fetchFleet = readCanonicalFleetViewer,
  now = () => Date.now(), allowInitialize = false,
}) {
  if (!identity || !transport || typeof transport.inspect !== "function" ||
      typeof transport.uploadIfGeneration !== "function" ||
      typeof transport.readSignedAtGeneration !== "function" ||
      transport.bucket !== identity.bucket ||
      transport.objectName !== identity.objectName ||
      typeof getViewerToken !== "function" ||
      typeof getSigningKey !== "function" ||
      typeof fetchFleet !== "function") {
    throw new Error("publisher_dependencies_not_approved");
  }
  return withPublisherStateLock({ stateFile, identity, allowInitialize },
    async ({ state, save, initializing }) => {
      if (state.pending) throw new Error("publisher_pending_requires_manual_reconcile");
      if (state.lastSequence >= Number.MAX_SAFE_INTEGER)
        throw new Error("publisher_sequence_exhausted");

      const actualGeneration = await transport.inspect();
      if (actualGeneration !== state.generation)
        throw new Error("publisher_remote_generation_drift");
      if (initializing && actualGeneration !== "0")
        throw new Error("publisher_initial_object_must_be_empty");
      // Durable state exists before any irreversible object upload.
      if (initializing) await save(state);

      const viewerToken = await getViewerToken();
      const rawRows = await fetchFleet({ viewerToken });

      const signer = await getSigningKey();
      if (signer?.type !== "private" || signer.asymmetricKeyType !== "ed25519")
        throw new Error("publisher_signing_key_not_ed25519");

      const time = now();
      if (!Number.isSafeInteger(time) || time < 0)
        throw new Error("invalid_publisher_clock");
      if (state.lastIssuedAt && time <= Date.parse(state.lastIssuedAt))
        throw new Error("publisher_local_clock_rolled_back");

      const issuedAt = new Date(time).toISOString();
      const sequence = state.lastSequence + 1;
      const signed = createSignedFleetSnapshot({
        machines: rawRows,
        keyId: identity.keyId, privateKey: signer, sequence, issuedAt,
        ttlMs: 60_000,
      });
      const serialized = JSON.stringify(signed);
      if (Buffer.byteLength(serialized) > MAX_ENVELOPE_BYTES)
        throw new Error("publisher_body_oversized");

      // Reserve sequence DURABLY before remote POST. After an uncertain upload,
      // pending state blocks automatic retry until a human checks GCS generation.
      const bodySha256 = crypto.createHash("sha256").update(serialized).digest("hex");
      const reserved = {
        ...state, lastSequence: sequence, lastIssuedAt: issuedAt,
        pending: { expectedGeneration: state.generation, sequence, sha256: bodySha256 },
      };
      await save(reserved);
      const generation = await transport.uploadIfGeneration(serialized, state.generation);
      if (typeof generation !== "string" || !/^[1-9][0-9]{0,24}$/.test(generation) ||
          generation === state.generation) throw new Error("publisher_invalid_upload_receipt");
      // A successful POST acknowledgement is not enough: retrieve the exact
      // new generation and verify the original signed bytes before committing.
      // On ANY readback error, the durable pending record stays in place.
      const readback = await transport.readSignedAtGeneration(generation);
      if (readback?.sha256 !== bodySha256)
        throw new Error("publisher_signed_readback_digest_mismatch");
      try {
        verifySignedFleetSnapshot(readback.signed, {
          publicKey: crypto.createPublicKey(signer),
          keyId: identity.keyId, now: now(),
        });
        if (readback.signed.sequence !== sequence ||
            readback.signed.issuedAt !== issuedAt)
          throw new Error("readback_claim_mismatch");
      } catch {
        throw new Error("publisher_signed_readback_unverified");
      }
      if (await transport.inspect() !== generation)
        throw new Error("publisher_signed_readback_generation_drift");
      await save({
        ...reserved, generation, pending: null, lastCommittedAt: issuedAt,
      });
      return {
        schema: "velvetos.portal.fleet-publication-receipt.v1",
        sequence, generation, count: signed.payload.count,
        issuedAt, expiresAt: signed.expiresAt,
        sha256: bodySha256,
        // Deliberately never return raw machines, token or signing private key.
      };
    });
}
