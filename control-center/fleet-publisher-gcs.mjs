import { gcsFleetObjectUrl } from "./fleet-snapshot-source.mjs";
import { MAX_ENVELOPE_BYTES } from "./fleet-signed-snapshot.mjs";

const GENERATION = /^(0|[1-9][0-9]{0,24})$/;
const BASE = "https://storage.googleapis.com";
const META_TIMEOUT_MS = 5_000;
const UPLOAD_TIMEOUT_MS = 10_000;
const MAX_META_BYTES = 4096;

async function tokenFrom(provider) {
  const token = await provider();
  if (typeof token !== "string" || token.length < 24 || token.length > 8192 ||
      /[\r\n]/.test(token)) throw new Error("scoped_gcs_token_unavailable");
  return token;
}

async function readSmallJson(response, max) {
  const type = response.headers.get("content-type") || "";
  if (!/^application\/(json|[a-z0-9.+-]+\+json)(;|$)/i.test(type))
    throw new Error("gcs_metadata_not_json");
  if (Number(response.headers.get("content-length") || 0) > max)
    throw new Error("gcs_response_too_large");
  if (!response.body) throw new Error("gcs_response_empty");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel("oversized");
        throw new Error("gcs_response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw new Error("gcs_metadata_malformed"); }
}

function checkedGeneration(value, allowEmpty = false) {
  if (typeof value !== "string" || !GENERATION.test(value) ||
      (!allowEmpty && value === "0")) throw new Error("gcs_generation_invalid");
  return value;
}

export function gcsPublisherUris(bucket, objectName) {
  // Reuse the reader's exact strict bucket + object allowlist.
  const uri = gcsFleetObjectUrl(bucket, objectName);
  const prefix = BASE + "/download/storage/v1/b/";
  if (!uri.startsWith(prefix)) throw new Error("unexpected_gcs_origin");
  const encodedBucket = encodeURIComponent(bucket);
  const encodedObject = encodeURIComponent(objectName);
  return {
    metadata: BASE + "/storage/v1/b/" + encodedBucket + "/o/" +
      encodedObject + "?fields=generation",
    upload: BASE + "/upload/storage/v1/b/" + encodedBucket + "/o?uploadType=media&name=" +
      encodedObject,
  };
}

export function makeGcsPublisherTransport({
  bucket, objectName, getAccessToken,
  fetchImpl = fetch,
}) {
  if (typeof getAccessToken !== "function" || typeof fetchImpl !== "function")
    throw new Error("gcs_writer_identity_provider_required");
  const uris = gcsPublisherUris(bucket, objectName);
  return {
    bucket, objectName,
    async inspect() {
      const token = await tokenFrom(getAccessToken);
      const response = await fetchImpl(uris.metadata, {
        method: "GET",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      if (response.status === 404) return "0";
      if (!response.ok) throw new Error("gcs_metadata_denied");
      const body = await readSmallJson(response, MAX_META_BYTES);
      return checkedGeneration(body.generation);
    },
    async uploadIfGeneration(body, expectedGeneration) {
      checkedGeneration(expectedGeneration, true);
      if (typeof body !== "string" ||
          Buffer.byteLength(body) > MAX_ENVELOPE_BYTES ||
          Buffer.byteLength(body) < 100) throw new Error("invalid_signed_upload_body");
      const token = await tokenFrom(getAccessToken);
      const response = await fetchImpl(uris.upload +
        "&ifGenerationMatch=" + encodeURIComponent(expectedGeneration), {
        method: "POST", redirect: "error",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(body)),
        },
        body,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (response.status === 412) throw new Error("gcs_generation_precondition_failed");
      if (!response.ok) throw new Error("gcs_private_upload_denied");
      const result = await readSmallJson(response, MAX_META_BYTES);
      const generation = checkedGeneration(result.generation);
      if (result.name !== objectName || result.bucket !== bucket ||
          generation === expectedGeneration) {
        throw new Error("gcs_upload_receipt_identity_mismatch");
      }
      return generation;
    },
  };
}
