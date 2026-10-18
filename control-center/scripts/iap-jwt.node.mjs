/** Synthetic-only IAP assertion tests: no Google tokens, cloud writes or paid APIs. */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createIapGuard } from "../iap-jwt.mjs";

const audience = "/projects/123456789/locations/me-west1/services/vf-fixture";
const issuer = "https://cloud.google.com/iap";
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "ES256", use: "sig" };
const fixedTime = Math.floor(Date.now() / 1000);
const claims = {
  iss: issuer, aud: audience, iat: fixedTime - 10, exp: fixedTime + 300,
  sub: "accounts.google.com:synthetic-user", email: "owner@example.test",
};
function jwt(payload = claims, header = { alg: "ES256", kid: "synthetic-key" }) {
  const data = [header, payload].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  return data + "." + sign("sha256", Buffer.from(data),
    { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}
const fakeJwks = (keys = [publicJwk]) => new Response(JSON.stringify({ keys }), {
  headers: { "Content-Type": "application/json" },
});

 test("IAP JWT valid ES256 and cache, deny missing/bad-aud/expired/tampered", async () => {
  let fetches = 0;
  const guard = createIapGuard({
    VELVETOS_REQUIRE_IAP: "1", VELVETOS_IAP_AUDIENCE: audience,
    VELVETOS_IAP_ALLOWED_EMAILS: "OWNER@EXAMPLE.TEST",
  }, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://www.gstatic.com/iap/verify/public_key-jwk");
    assert.equal(options.redirect, "error");
    fetches++;
    return fakeJwks();
  } });
  const check = (value) => guard.verify({ "x-goog-iap-jwt-assertion": value });
  assert.equal(guard.enabled, true);
  assert.equal(await guard.verify({}), false, "no JWT must fail closed");
  assert.equal(await check(jwt()), true, "valid signed IAP proof rejected");
  assert.equal(await check(jwt()), true, "cached signed proof rejected");
  assert.equal(fetches, 1, "valid repeated assertion fetched keys twice");
  assert.equal(await check(jwt({ ...claims, aud: "/projects/9/locations/us-central1/services/evil" })), false);
  assert.equal(await check(jwt({ ...claims, exp: fixedTime - 1 })), false);
  assert.equal(await check(jwt({ ...claims, iat: fixedTime + 500 })), false);
  assert.equal(await check(jwt({ ...claims, iss: "https://evil.example" })), false);
  assert.equal(await check(jwt({ ...claims, email: "other@example.test" })), false);
  assert.equal(await check(jwt(claims, { alg: "none", kid: "synthetic-key" })), false);
  assert.equal(await check(jwt(claims, { alg: "ES256", kid: "not-a-real-key" })), false);
  assert.equal(await check(jwt().replace(/.$/, (s) => s === "A" ? "B" : "A")), false);
  assert.equal(await check("not-a-jwt"), false);
  console.log("IAP_GUARD_PASS valid_signed_cache_bad_aud_expiry_signature_and_claims");
});

test("IAP configuration and JWKS failures always fail closed", async () => {
  const off = createIapGuard({});
  assert.equal(off.enabled, false);
  assert.equal(await off.verify({}), true, "default staging behavior changed");
  assert.throws(() => createIapGuard({ VELVETOS_REQUIRE_IAP: "true" }), /invalid_iap_requirement/);
  assert.throws(() => createIapGuard({ VELVETOS_REQUIRE_IAP: "1" }), /iap_audience/);
  assert.throws(() => createIapGuard({ VELVETOS_REQUIRE_IAP: "1",
    VELVETOS_IAP_AUDIENCE: "https://untrusted.example/" }), /iap_audience/);
  assert.throws(() => createIapGuard({ VELVETOS_REQUIRE_IAP: "1",
    VELVETOS_IAP_AUDIENCE: audience, VELVETOS_IAP_ALLOWED_EMAILS: "garbage" }), /invalid_iap_email/);
  const env = { VELVETOS_REQUIRE_IAP: "1", VELVETOS_IAP_AUDIENCE: audience };
  const unavailable = createIapGuard(env, { fetchImpl: async () => { throw Error("offline"); } });
  assert.equal(await unavailable.verify({ "x-goog-iap-jwt-assertion": jwt() }), false);
  const malformed = createIapGuard(env, { fetchImpl: async () => new Response("x", {
    headers: { "Content-Type": "application/json" },
  }) });
  assert.equal(await malformed.verify({ "x-goog-iap-jwt-assertion": jwt() }), false);
  const tooLarge = createIapGuard(env, { fetchImpl: async () => new Response("{" + " ".repeat(70_000), {
    headers: { "Content-Type": "application/json" },
  }) });
  assert.equal(await tooLarge.verify({ "x-goog-iap-jwt-assertion": jwt() }), false);
  console.log("IAP_GUARD_PASS disabled_compatibility_startup_fail_closed_and_unavailable_jwks");
});

test("enabled IAP denies every HTTP route before upstream credentials or static files", async () => {
  let upstreamCalls = 0;
  const upstream = createServer((_req, res) => {
    upstreamCalls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"schema":"velvetos.control.v1"}');
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      PATH: process.env.PATH || "", HOST: "127.0.0.1", PORT: String(port),
      VELVETOS_REQUIRE_IAP: "1", VELVETOS_IAP_AUDIENCE: audience,
      VELVETOS_CONTROL_API_URL: "http://127.0.0.1:" + upstream.address().port,
      VELVETOS_CONTROL_API_TOKEN: "synthetic-not-a-secret",
      VELVETOS_USE_GCP_IDENTITY: "0",
    }, stdio: "ignore",
  });
  const origin = "http://127.0.0.1:" + port;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error("IAP guard portal child exited");
      try {
        const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(400) });
        if (response.status === 401) { ready = true; break; }
      } catch { /* short bounded startup retry */ }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert(ready, "IAP guard HTTP startup timed out");
    for (const path of ["/", "/health", "/assets/app.js", "/api/control/v1/snapshot",
      "/api/fleet/v1/machines"]) {
      const res = await fetch(origin + path);
      assert.equal(res.status, 401, path + " did not deny anonymous access");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal((await res.json()).error, "unauthorized");
    }
    assert.equal(upstreamCalls, 0, "denied requests reached credentialed upstream");
    console.log("IAP_GUARD_PASS whole_portal_unauthenticated_no_upstream_calls");
  } finally {
    child.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("IAP enabled without audience refuses to start a listener", () => {
  const child = spawnSync(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH || "", VELVETOS_REQUIRE_IAP: "1",
      HOST: "127.0.0.1", PORT: "0" }, encoding: "utf8", timeout: 3000,
  });
  assert.notEqual(child.status, 0, "misconfigured IAP guard started");
  console.log("IAP_GUARD_PASS_missing_audience_prevented_listener");
});
