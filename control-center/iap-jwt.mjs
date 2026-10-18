/** Optional fail-closed verification for Google's signed IAP assertion header.
 * The trusted JWKS URL cannot be overridden by an environment variable.
 * No browser/HTTP client ever receives a server-side bearer credential.
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";

const IAP_ISSUER = "https://cloud.google.com/iap";
const IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";
const MAX_JWT_LENGTH = 8192;
const MAX_JWKS_BYTES = 64 * 1024;
const JWKS_CACHE_MS = 5 * 60 * 1000;
const ALLOWED_AUDIENCE = /^\/projects\/[0-9]+\/(?:locations\/[a-z0-9-]+\/services\/[a-z][a-z0-9-]*|global\/backendServices\/[0-9]+)$/;

function decodedSegment(segment, maximum = 6144) {
  if (typeof segment !== "string" || !segment || segment.length > maximum ||
      !/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("invalid_jwt_encoding");
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) throw new Error("noncanonical_jwt_encoding");
  const data = JSON.parse(bytes.toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("invalid_jwt_json");
  return data;
}

async function boundedJwks(response) {
  if (!response.ok || !/\bapplication\/json\b/i.test(response.headers.get("content-type") || ""))
    throw new Error("iap_jwks_unavailable");
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_JWKS_BYTES))
    throw new Error("iap_jwks_too_large");
  if (!response.body) throw new Error("iap_jwks_empty");
  const reader = response.body.getReader();
  const buffers = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JWKS_BYTES) {
        await reader.cancel("iap_jwks_too_large");
        throw new Error("iap_jwks_too_large");
      }
      buffers.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const data = JSON.parse(Buffer.concat(buffers, bytes).toString("utf8"));
  if (!data || !Array.isArray(data.keys) || data.keys.length === 0 || data.keys.length > 16)
    throw new Error("iap_jwks_invalid");
  const keys = new Map();
  for (const jwk of data.keys) {
    if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" ||
        typeof jwk.kid !== "string" || !jwk.kid || jwk.kid.length > 128 ||
        (jwk.alg && jwk.alg !== "ES256") || (jwk.use && jwk.use !== "sig") ||
        !/^[A-Za-z0-9_-]+$/.test(jwk.x || "") ||
        !/^[A-Za-z0-9_-]+$/.test(jwk.y || "") ||
        Buffer.from(jwk.x, "base64url").length !== 32 ||
        Buffer.from(jwk.y, "base64url").length !== 32 || keys.has(jwk.kid))
      throw new Error("iap_jwks_invalid_key");
    // Only public JWK fields; never accept a private `d` value from a response.
    keys.set(jwk.kid, createPublicKey({
      key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk",
    }));
  }
  return keys;
}

export function createIapJwksCache({ fetchImpl = fetch, nowMillis = Date.now } = {}) {
  let keys = new Map();
  let expiresAt = 0;
  let lastAttempt = -Infinity;
  let inFlight = null;
  async function refresh() {
    if (inFlight) return inFlight;
    if (nowMillis() - lastAttempt < 5000) throw new Error("iap_jwks_retry_cooldown");
    lastAttempt = nowMillis();
    inFlight = (async () => {
      const response = await fetchImpl(IAP_JWKS_URL, {
        method: "GET", headers: { Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(3000),
      });
      const next = await boundedJwks(response);
      keys = next;
      expiresAt = nowMillis() + JWKS_CACHE_MS;
    })();
    try { await inFlight; } finally { inFlight = null; }
  }
  return {
    async getKey(kid) {
      if (nowMillis() >= expiresAt) await refresh();
      if (!keys.has(kid) && nowMillis() - lastAttempt >= 30000) await refresh();
      return keys.get(kid) || null;
    },
  };
}

export async function verifyIapAssertion(token, { audience, allowedEmails = [], getKey,
  nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof token !== "string" || !token || token.length > MAX_JWT_LENGTH) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = decodedSegment(parts[0], 1024);
    const payload = decodedSegment(parts[1], 6144);
    if (header.alg !== "ES256" || typeof header.kid !== "string" ||
        !header.kid || header.kid.length > 128) return false;
    if (payload.iss !== IAP_ISSUER || payload.aud !== audience ||
        typeof payload.sub !== "string" || !payload.sub ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
        payload.iat > nowSeconds + 30 || payload.exp <= nowSeconds ||
        payload.exp - payload.iat > 660 ||
        (payload.nbf !== undefined &&
          (!Number.isSafeInteger(payload.nbf) || payload.nbf > nowSeconds + 30))) return false;
    if (allowedEmails.length && (typeof payload.email !== "string" ||
        !allowedEmails.includes(payload.email.toLowerCase()))) return false;
    if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
    const signature = Buffer.from(parts[2], "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== parts[2]) return false;
    const key = await getKey(header.kid);
    if (!key) return false;
    return verifySignature("sha256", Buffer.from(parts[0] + "." + parts[1]),
      { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    // Never echo tokens, public-key responses or internal errors to callers.
    return false;
  }
}

export function createIapGuard(env = process.env, options = {}) {
  const setting = env.VELVETOS_REQUIRE_IAP ?? "0";
  if (setting !== "0" && setting !== "1") throw new Error("invalid_iap_requirement_setting");
  if (setting === "0") return { enabled: false, verify: async () => true };
  const audience = env.VELVETOS_IAP_AUDIENCE || "";
  if (!ALLOWED_AUDIENCE.test(audience)) throw new Error("missing_or_invalid_iap_audience");
  const configured = env.VELVETOS_IAP_ALLOWED_EMAILS || "";
  const allowedEmails = configured ? configured.split(",").map((e) => e.trim().toLowerCase()) : [];
  if (allowedEmails.some((e) => !/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(e)))
    throw new Error("invalid_iap_email_allowlist");
  const jwks = createIapJwksCache(options);
  return {
    enabled: true,
    async verify(headers) {
      const jwt = headers["x-goog-iap-jwt-assertion"];
      if (typeof jwt !== "string") return false;
      return verifyIapAssertion(jwt, { audience, allowedEmails, getKey: jwks.getKey });
    },
  };
}
