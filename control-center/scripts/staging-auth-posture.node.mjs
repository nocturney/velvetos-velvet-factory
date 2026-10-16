import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectAnonymousBoundary, validateServiceOrigin, SCHEMA } from "./staging-auth-posture.mjs";

const SITE = "https://velvetos-control-center-staging-3sz7smh74a-zf.a.run.app";
const API = "https://velvetos-control-api-3sz7smh74a-zf.a.run.app";

function fake({ site = 302, login = "https://accounts.google.com/signin",
  health = 200, snapshot = 401, network = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.deepEqual(Object.keys(options.headers), ["Accept"]);
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.signal.aborted, false);
    calls.push(url);
    if (network) throw new Error("synthetic_network_down");
    if (url === SITE + "/" || url === SITE + "/health")
      return new Response(null, { status: site, headers: { Location: login } });
    if (url === API + "/health") return new Response(null, {status: health});
    if (url === API + "/v1/snapshot") return new Response(null, {status: snapshot});
    throw new Error("unexpected_target");
  };
  return { calls, fetchImpl };
}
async function check(mock = fake()) {
  return inspectAnonymousBoundary({stagingUrl:SITE,apiUrl:API,fetchImpl:mock.fetchImpl});
}

test("accept only the two exact pinned Cloud Run HTTPS origins, never a lookalike service", () => {
  assert.equal(validateServiceOrigin(SITE, "staging"), SITE);
  assert.equal(validateServiceOrigin(API, "api"), API);
  for (const bad of [
    SITE.replace("https:", "http:"), SITE + "/health", SITE + "?redirect=evil",
    "https://evil.example/", "https://velvetos-control-center-staging-attacker.example/",
    SITE.replace("3sz7smh74a-zf", "different-zf"),
    "https://bad@velvetos-control-center-staging-3sz7smh74a-zf.a.run.app/",
    "https://velvetos-control-center-staging-3sz7smh74a-zf.a.run.app:8443/",
    API, "", "not-a-url",
  ]) assert.throws(() => validateServiceOrigin(bad, "staging"));
  assert.throws(() => validateServiceOrigin(SITE, "api"));
  assert.throws(() => validateServiceOrigin(API.replace("3sz7smh74a-zf", "different-zf"), "api"));
  assert.throws(() => validateServiceOrigin(API, "unknown"));
});

test("real-shaped anonymous Google login plus token-denied API is green ONLY for anonymous posture", async () => {
  const mock = fake();
  const proof = await check(mock);
  assert.equal(proof.schema, SCHEMA);
  assert.equal(proof.status, "PASS_ANONYMOUS_DENIAL_ONLY");
  assert.equal(proof.releaseGate, "BLOCKED_OWNER_SAFARI_AND_PRIVATE_BACKHAUL_UNVERIFIED");
  assert.equal(proof.credentialsSent, false);
  assert.equal(proof.redirectsFollowed, false);
  assert.equal(proof.actualOwnerSafariSessionVerified, false);
  assert.equal(proof.privateFleetTransportVerified, false);
  assert.equal(mock.calls.length, 4);
  assert.deepEqual(mock.calls.sort(), [SITE+"/", SITE+"/health", API+"/health", API+"/v1/snapshot"].sort());
});

test("non-Google redirects, anonymous site success or public snapshot remain blocked", async () => {
  for (const cfg of [
    {site:200}, {site:500}, {login:"https://malicious.example/"}, {login:"http://accounts.google.com/"},
    {login:"https://accounts.google.com.evil.example/"}, {health:404}, {snapshot:200},
    {snapshot:302}, {snapshot:503},
  ]) {
    const result=await check(fake(cfg));
    assert.equal(result.status, "FAIL_CLOSED_AUTH_BOUNDARY_UNVERIFIED");
    assert.match(result.releaseGate, /^BLOCKED_/);
    assert.equal(result.credentialsSent, false);
  }
});

test("network or TLS failure cannot be treated as security success", async () => {
  const proof=await check(fake({network:true}));
  assert.equal(proof.status,"INDETERMINATE");
  assert.equal(proof.releaseGate,"BLOCKED");
  assert.equal(proof.credentialsSent,false);
});

test("non-browser site 401/403 are also anonymous denial but never owner proof", async () => {
  for (const site of [401, 403]) {
    const proof = await check(fake({site}));
    assert.equal(proof.status, "PASS_ANONYMOUS_DENIAL_ONLY");
    assert.equal(proof.staging.anonymousRequestDenied, true);
    assert.equal(proof.staging.redirectToGoogleLogin, false);
    assert.equal(proof.releaseGate, "BLOCKED_OWNER_SAFARI_AND_PRIVATE_BACKHAUL_UNVERIFIED");
    assert.equal(proof.actualOwnerSafariSessionVerified, false);
  }
});

test("a public staging homepage cannot pass because /health is protected", async () => {
  const mock = fake();
  const proof = await inspectAnonymousBoundary({
    stagingUrl: SITE, apiUrl: API,
    fetchImpl: (url, options) => {
      if (url === SITE + "/") {
        assert.equal(options.redirect, "manual");
        assert.equal(options.headers.Authorization, undefined);
        return new Response("<html>PUBLIC</html>", {status: 200});
      }
      return mock.fetchImpl(url, options);
    },
  });
  assert.equal(proof.status, "FAIL_CLOSED_AUTH_BOUNDARY_UNVERIFIED");
  assert.equal(proof.releaseGate, "BLOCKED_OWNER_SAFARI_AND_PRIVATE_BACKHAUL_UNVERIFIED");
  assert.equal(proof.credentialsSent, false);
});

test("denied API can return 403 instead of 401 without claiming owner login", async () => {
  const p=await check(fake({snapshot:403}));
  assert.equal(p.status,"PASS_ANONYMOUS_DENIAL_ONLY");
  assert.equal(p.actualOwnerSafariSessionVerified,false);
});
