import { readFile, stat } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import os from "node:os";
import {
  MAX_ENVELOPE_BYTES, makeSnapshotSequenceGuard,
  verifySignedFleetSnapshot, spkiPublicKeyFromBase64,
} from "./fleet-signed-snapshot.mjs";

// Read-only source for the signed Fleet snapshot. Performs exactly one GET of one
// private object per call and never writes, uploads or signs anything.
const SNAPSHOT_TIMEOUT_MS = 5_000;
const GCS_TOKEN_TIMEOUT_MS = 2_500;
const GCS_ENDPOINT = "https://storage.googleapis.com";
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/=]{40,400}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const OBJECT_RE = /^portal\/fleet\/[a-z0-9_-]{1,48}\.json$/;

export function gcsFleetObjectUrl(bucket, objectName) {
  if (!BUCKET_RE.test(bucket || "") || !OBJECT_RE.test(objectName || ""))
    throw new Error("invalid_private_fleet_object_locator");
  // GCS JSON API has a dedicated media endpoint, without a response redirect.
  return GCS_ENDPOINT + "/download/storage/v1/b/" + encodeURIComponent(bucket) +
    "/o/" + encodeURIComponent(objectName) + "?alt=media";
}

async function strictJsonResponse(response) {
  if (!response.ok) throw new Error("fleet_source_denied");
  if (!/^(application\/json|application\/[a-z0-9.+-]+\+json)(;|$)/i.test(
    response.headers.get("content-type") || "")) throw new Error("fleet_source_not_json");
  const len = Number(response.headers.get("content-length") || 0);
  if (!Number.isFinite(len) || len < 0 || len > MAX_ENVELOPE_BYTES)
    throw new Error("fleet_source_oversized");
  if (!response.body) throw new Error("fleet_source_empty");
  const r = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await r.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ENVELOPE_BYTES) {
        // A peer-controlled stream may never settle cancellation; deny immediately.
        void r.cancel("oversized").catch(() => {});
        throw new Error("fleet_source_oversized");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    r.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

// Cloud Run service identity token for the single GCS read; no credential is ever
// accepted from the browser, the environment or a client-supplied URL.
async function metadataAccessToken(fetchImpl) {
  const response = await fetchImpl(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: { "Metadata-Flavor": "Google" },
      method: "GET", redirect: "error",
      signal: AbortSignal.timeout(GCS_TOKEN_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error("gcp_metadata_unavailable");
  const token = await response.json();
  if (typeof token?.access_token !== "string" || !token.access_token ||
      token.access_token.length > 8192)
    throw new Error("gcp_access_token_unavailable");
  return token.access_token;
}

export function makeSignedFleetSource(env, {
  bindHost = "0.0.0.0", fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const mode = env.VELVETOS_FLEET_SNAPSHOT_MODE || "";
  if (!mode) return null;
  if (!["gcs", "test-fixture"].includes(mode))
    throw new Error("invalid_fleet_snapshot_mode");
  const keyId = env.VELVETOS_FLEET_SNAPSHOT_KEY_ID || "";
  const pubkey = env.VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64 || "";
  if (!/^[a-z0-9_-]{3,64}$/.test(keyId) || !PUBLIC_KEY_RE.test(pubkey))
    throw new Error("fleet_snapshot_verify_key_missing");
  const publicKey = spkiPublicKeyFromBase64(pubkey);
  const sequenceGuard = makeSnapshotSequenceGuard();

  let objectUrl = "", fixtureFile = "";
  if (mode === "gcs") {
    // Cloud service identity must have ONLY storage.objects.get on this object.
    // Never accept arbitrary URL or browser-supplied path/credentials.
    objectUrl = gcsFleetObjectUrl(
      env.VELVETOS_FLEET_SNAPSHOT_BUCKET,
      env.VELVETOS_FLEET_SNAPSHOT_OBJECT,
    );
  } else {
    // Strict synthetic-only loopback fixture. This branch can never be used in
    // the Cloud Run production image with NODE_ENV=production.
    fixtureFile = env.VELVETOS_FLEET_SNAPSHOT_TEST_FILE || "";
    const relativePath = relative(os.tmpdir(), fixtureFile);
    if (env.NODE_ENV !== "test" ||
        env.VELVETOS_FLEET_SNAPSHOT_TEST_ALLOW !== "1" ||
        bindHost !== "127.0.0.1" ||
        !isAbsolute(fixtureFile) || !relativePath ||
        relativePath.startsWith("..") || isAbsolute(relativePath) ||
        !fixtureFile.endsWith(".json")) {
      throw new Error("fleet_snapshot_test_fixture_forbidden");
    }
  }

  return async function readSnapshot() {
    let signed;
    if (mode === "test-fixture") {
      if ((await stat(fixtureFile)).size > MAX_ENVELOPE_BYTES)
        throw new Error("fleet_snapshot_test_too_large");
      signed = JSON.parse(await readFile(fixtureFile, "utf8"));
    } else {
      const token = await metadataAccessToken(fetchImpl);
      const response = await fetchImpl(objectUrl, {
        method: "GET",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      });
      signed = await strictJsonResponse(response);
    }
    const parsed = verifySignedFleetSnapshot(signed, { publicKey, keyId, now: now() });
    sequenceGuard(signed);
    return parsed;
  };
}
