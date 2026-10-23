/** Synthetic-only IAP assertion tests: no Google tokens, cloud writes or paid APIs. */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import { createIapGuard, createIapJwksCache, verifyIapAssertion, JWKS_STALE_GRACE_MS } from "../iap-jwt.mjs";

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
  for (const missing of [undefined, "", " ", "\t"]) {
    assert.throws(() => createIapGuard({ VELVETOS_REQUIRE_IAP: "1",
      VELVETOS_IAP_AUDIENCE: audience, VELVETOS_IAP_ALLOWED_EMAILS: missing }),
      /missing_iap_owner_email_allowlist/, "enabled IAP without owner allowlist must refuse");
  }
  assert.throws(() => createIapGuard({ VELVETOS_REQUIRE_IAP: "1",
    VELVETOS_IAP_AUDIENCE: audience, VELVETOS_IAP_ALLOWED_EMAILS: "owner@example.test," }),
    /invalid_iap_email_allowlist/, "empty allowlist entry must refuse");
  const env = { VELVETOS_REQUIRE_IAP: "1", VELVETOS_IAP_AUDIENCE: audience,
    VELVETOS_IAP_ALLOWED_EMAILS: "owner@example.test" };
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
      VELVETOS_IAP_ALLOWED_EMAILS: "owner@example.test",
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
    for (const path of ["/", "/health", "/assets/app.js", "/favicon.ico", "/favicon.svg",
      "/api/control/v1/snapshot", "/api/fleet/v1/machines"]) {
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
  const noOwner = spawnSync(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH || "", VELVETOS_REQUIRE_IAP: "1",
      VELVETOS_IAP_AUDIENCE: audience, HOST: "127.0.0.1", PORT: "0" },
    encoding: "utf8", timeout: 3000,
  });
  assert.notEqual(noOwner.status, 0, "enabled IAP without owner allowlist started a listener");
  assert.equal(noOwner.stdout.includes("listening"), false);
  console.log("IAP_GUARD_PASS_missing_audience_prevented_listener");
});

test("IAP rejects any crit header even with a valid ES256 signature", async () => {
  const getKey = async (kid) => (kid === "synthetic-key" ? publicKey : null);
  const ok = await verifyIapAssertion(jwt(), { audience, getKey });
  assert.equal(ok, true);
  for (const crit of [["b64"], [], "exp"]) {
    assert.equal(await verifyIapAssertion(jwt(claims, { alg: "ES256", kid: "synthetic-key", crit }),
      { audience, getKey }), false, "crit " + JSON.stringify(crit) + " accepted");
  }
  console.log("IAP_GUARD_PASS crit_header_rejected");
});

test("IAP JWKS: last validated keys reused only within a bounded grace, then fail closed", async () => {
  let t = 10_000_000;
  let mode = "ok";
  let fetches = 0;
  const warnings = [];
  const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
  const cache = createIapJwksCache({
    nowMillis: () => t,
    warn: (m) => warnings.push(m),
    fetchImpl: async () => {
      fetches++;
      if (mode === "down") throw new Error("offline");
      if (mode === "html") return new Response("<html>", { headers: { "Content-Type": "text/html" } });
      if (mode === "rotated") return fakeJwks([{ ...otherKey.export({ format: "jwk" }), kid: "rotated", alg: "ES256" }]);
      return fakeJwks();
    },
  });
  const check = () => verifyIapAssertion(jwt(), { audience, getKey: cache.getKey });
  assert.equal(await check(), true);
  assert.equal(fetches, 1);

  mode = "down";
  t += 6 * 60_000; // cache expired, refresh fails, inside grace
  assert.equal(await check(), true, "validated key not reused inside grace");
  assert.deepEqual(warnings, ["iap_jwks_refresh_failed_using_last_validated_keys"]);
  mode = "html"; // an invalid response never replaces validated keys
  t += 10_000;
  assert.equal(await check(), true);
  assert.equal(warnings.length, 1, "stale warning should be logged once per stale period");
  assert.equal(await verifyIapAssertion(jwt(claims, { alg: "ES256", kid: "unknown" }),
    { audience, getKey: cache.getKey }), false, "unknown kid accepted during stale period");

  mode = "down";
  t = 10_000_000 + JWKS_STALE_GRACE_MS - 1000; // still inside the 1h grace
  assert.equal(await check(), true);
  t = 10_000_000 + JWKS_STALE_GRACE_MS + 1000; // past the grace: fail closed
  assert.equal(await check(), false, "stale key used after grace");
  t += 10_000;
  assert.equal(await check(), false, "stale key resurrected after grace");

  mode = "ok"; // recovery
  t += 10_000;
  assert.equal(await check(), true, "did not recover after JWKS came back");

  mode = "rotated"; // a successful refresh fully replaces the key set
  t += 6 * 60_000;
  assert.equal(await check(), false, "key removed by a validated refresh still accepted");
  assert.ok(JWKS_STALE_GRACE_MS <= 60 * 60 * 1000, "grace must be at most 1h");
  console.log("IAP_GUARD_PASS bounded_stale_jwks_grace_then_fail_closed");
});

test("VELVETOS_REQUIRE_IAP empty: disabled with a warning unless IAP settings show intent", () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const empty = createIapGuard({ VELVETOS_REQUIRE_IAP: "" }, { warn });
  assert.equal(empty.enabled, false);
  assert.match(warnings[0], /set but empty/);
  assert.throws(() => createIapGuard({ VELVETOS_REQUIRE_IAP: "", VELVETOS_IAP_AUDIENCE: audience }, { warn }),
    /empty_iap_requirement_with_iap_settings/);
  assert.throws(() => createIapGuard({ VELVETOS_REQUIRE_IAP: "", VELVETOS_IAP_ALLOWED_EMAILS: "a@b.example" }, { warn }),
    /empty_iap_requirement_with_iap_settings/);
  const zero = createIapGuard({ VELVETOS_REQUIRE_IAP: "0", VELVETOS_IAP_AUDIENCE: audience }, { warn });
  assert.equal(zero.enabled, false);
  assert.match(warnings[1], /REQUIRE_IAP=0 while IAP audience/);
  const unset = createIapGuard({}, { warn });
  assert.equal(unset.enabled, false);
  assert.equal(warnings.length, 2, "plain unset config must not warn");
  for (const bad of [" ", "true", "yes", "1 ", "01"]) {
    assert.throws(() => createIapGuard({ VELVETOS_REQUIRE_IAP: bad, VELVETOS_IAP_AUDIENCE: audience }, { warn }),
      /invalid_iap_requirement/, JSON.stringify(bad));
  }
  console.log("IAP_GUARD_PASS empty_setting_policy");
});

async function startPortal(env) {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let stderr = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH || "", HOST: "127.0.0.1", PORT: String(port), VELVETOS_USE_GCP_IDENTITY: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  for (let i = 0; i < 100 && !stdout.includes("listening") && child.exitCode === null; i++)
    await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(stdout.includes("listening"), "portal did not start\n" + stderr);
  return { origin: "http://127.0.0.1:" + port, child, stderr: () => stderr };
}

function rawRequest(origin, method, target) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    let data = "";
    socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`);
    socket.on("data", (c) => { data += c; });
    socket.on("end", () => resolve({ status: Number(data.split(" ")[1]), body: data.split("\r\n\r\n").slice(1).join("") }));
    socket.on("error", reject);
  });
}

test("liveness is exempt only as exact GET /liveness with a constant body; /health stays guarded", async () => {
  let upstreamCalls = 0;
  const upstream = createServer((_req, res) => { upstreamCalls++; res.end("{}"); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const portal = await startPortal({
    VELVETOS_REQUIRE_IAP: "1", VELVETOS_IAP_AUDIENCE: audience,
    VELVETOS_IAP_ALLOWED_EMAILS: "owner@example.test",
    VELVETOS_CONTROL_API_URL: "http://127.0.0.1:" + upstream.address().port,
    VELVETOS_CONTROL_API_TOKEN: "synthetic-not-a-secret",
  });
  try {
    const live = await fetch(portal.origin + "/liveness");
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("cache-control"), "no-store");
    assert.equal(await live.text(), '{"ok":true}');
    for (const [method, target] of [["GET", "/health"], ["GET", "/liveness?x=1"], ["GET", "/liveness/"],
      ["GET", "/%6civeness"], ["GET", "/Liveness"], ["GET", "//liveness"], ["GET", "/liveness/../health"],
      ["GET", "/x/../liveness"], ["HEAD", "/liveness"], ["POST", "/liveness"], ["GET", "/"],
      ["GET", "/api/control/v1/snapshot"]]) {
      const r = await rawRequest(portal.origin, method, target);
      assert.equal(r.status, 401, method + " " + target + " was not guarded");
    }
    assert.equal(upstreamCalls, 0, "guarded or liveness requests reached the upstream");
  } finally {
    portal.child.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
  const off = await startPortal({});
  try {
    assert.equal((await fetch(off.origin + "/liveness")).status, 200);
    assert.equal((await fetch(off.origin + "/health")).status, 200, "disabled guard changed /health");
  } finally {
    off.child.kill();
  }
  console.log("IAP_GUARD_PASS liveness_exempt_exact_constant_health_guarded");
});

test("server: empty VELVETOS_REQUIRE_IAP starts unguarded with a warning; with an audience it refuses to start", async () => {
  const portal = await startPortal({ VELVETOS_REQUIRE_IAP: "" });
  try {
    assert.equal((await fetch(portal.origin + "/health")).status, 200);
    assert.match(portal.stderr(), /iap_guard_disabled: VELVETOS_REQUIRE_IAP is set but empty/);
  } finally {
    portal.child.kill();
  }
  const refused = spawnSync(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH || "", VELVETOS_REQUIRE_IAP: "", VELVETOS_IAP_AUDIENCE: audience,
      HOST: "127.0.0.1", PORT: "0" }, encoding: "utf8", timeout: 3000,
  });
  assert.notEqual(refused.status, 0, "empty setting with an IAP audience started unguarded");
  assert.equal(refused.stdout.includes("listening"), false);
  console.log("IAP_GUARD_PASS server_empty_setting_policy");
});
