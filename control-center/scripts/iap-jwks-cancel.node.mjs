/** Offline JWKS cancellation regression. Synthetic keys only; no network requests. */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createIapGuard, createIapJwksCache, JWKS_STALE_GRACE_MS } from "../iap-jwt.mjs";

const audience = "/projects/123456789/locations/me-west1/services/fixture";
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "fixture", alg: "ES256" };
const good = () => new Response(JSON.stringify({ keys: [jwk] }), {
  headers: { "content-type": "application/json" },
});
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const data = [
    { alg: "ES256", kid: "fixture" },
    { iss: "https://cloud.google.com/iap", aud: audience, sub: "fixture:owner",
      iat: now - 10, exp: now + 300 },
  ].map(x => Buffer.from(JSON.stringify(x)).toString("base64url")).join(".");
  return data + "." + sign("sha256", Buffer.from(data),
    { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}
function oversized(mode, stats) {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() {
      stats.cancels++;
      if (mode === "never") return new Promise(() => {});
      if (mode === "reject") return Promise.reject(new Error("synthetic_cancel_reject"));
      return Promise.resolve();
    },
  }), { headers: { "content-type": "application/json" } });
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ kind: "ok", value }), error => ({ kind: "error", error: String(error) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: "timeout" }), 350); }),
    ]);
  } finally { clearTimeout(timer); }
}

test("valid synthetic ES256 proof still verifies", async () => {
  const guard = createIapGuard({ VELVETOS_REQUIRE_IAP: "1", VELVETOS_IAP_AUDIENCE: audience },
    { fetchImpl: async () => good() });
  assert.equal(await guard.verify({ "x-goog-iap-jwt-assertion": jwt() }), true);
});
test("oversized JWKS rejects concurrent assertions even when cancel stalls or rejects", async () => {
  for (const mode of ["never", "reject", "resolve"]) {
    const stats = { cancels: 0, fetches: 0 };
    const guard = createIapGuard({ VELVETOS_REQUIRE_IAP: "1", VELVETOS_IAP_AUDIENCE: audience },
      { fetchImpl: async () => { stats.fetches++; return oversized(mode, stats); } });
    const token = jwt();
    const outcomes = await Promise.all([0, 1].map(() =>
      bounded(guard.verify({ "x-goog-iap-jwt-assertion": token }))));
    assert.deepEqual(outcomes, [{ kind: "ok", value: false }, { kind: "ok", value: false }], mode);
    assert.equal(stats.fetches, 1, mode);
    assert.equal(stats.cancels, 1, mode);
  }
});
test("oversized fetch respects stale-key expiry and fails closed", async () => {
  const first = 10_000_000;
  let now = first;
  let mode = "good";
  const stats = { cancels: 0 };
  const cache = createIapJwksCache({ nowMillis: () => now, warn: () => {},
    fetchImpl: async () => mode === "good" ? good() : oversized("never", stats) });
  assert.ok(await cache.getKey("fixture"));
  mode = "bad"; now = first + 6 * 60_000;
  const stale = await bounded(cache.getKey("fixture"));
  assert.equal(stale.kind, "ok");
  assert.ok(stale.value);
  now = first + JWKS_STALE_GRACE_MS + 1000;
  const expired = await bounded(cache.getKey("fixture"));
  assert.notEqual(expired.kind, "timeout");
  assert.equal(expired.kind === "error" || (expired.kind === "ok" && expired.value === null), true);
});
