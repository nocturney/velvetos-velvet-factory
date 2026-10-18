import "./iap-jwt.node.mjs"; // Included in existing npm test and build smoke:security
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

const TOKEN = "fixture-private-token-not-a-real-secret";
async function serve(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}
async function waitPortal(origin, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error("portal_process_exited");
    try {
      const r = await fetch(origin + "/health", { signal: AbortSignal.timeout(400) });
      if (r.ok) return;
    } catch { /* bounded start retry */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw Error("portal_start_timeout");
}
async function openPortal(env, basePort) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(basePort), HOST: "127.0.0.1", ...env,
      VELVETOS_USE_GCP_IDENTITY: "0" },
    stdio: "ignore",
  });
  const origin = "http://127.0.0.1:" + basePort;
  await waitPortal(origin, child);
  return { origin, child };
}
async function pickFreePort() {
  const server = createServer();
  const origin = await serve(server);
  await new Promise((resolve) => server.close(resolve));
  return Number(new URL(origin).port);
}
function response(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

test("M2 gateway read boundary against untrusted synthetic upstream", async () => {
  let upstreamCalls = 0, redirectHits = 0, requestedAuth = null, mode = "normal";
  const redirectTarget = createServer((_, res) => {
    redirectHits++;
    response(res, 200, '{"ok":true}');
  });
  const redirectOrigin = await serve(redirectTarget);
  const upstream = createServer((req, res) => {
    upstreamCalls++;
    requestedAuth = req.headers.authorization || null;
    if (mode === "redirect") {
      res.writeHead(302, { Location: redirectOrigin + "/should-never-receive-token" });
      res.end();
      return;
    }
    if (mode === "oversize") {
      // Chunked body, intentionally without Content-Length.
      response(res, 200, JSON.stringify({ payload: "x".repeat(2 * 1024 * 1024 + 100) }));
      return;
    }
    if (mode === "invalid-json") { response(res, 200, "{not-json"); return; }
    if (mode === "html") { response(res, 200, "<html>not-json</html>", "text/html"); return; }
    if (mode === "denied") { response(res, 401, '{"error":"private backend secret must not be echoed"}'); return; }
    if (req.url.startsWith("/v1/search?")) {
      response(res, 200, JSON.stringify({ schema: "velvetos.control.v1.search", results: [], query: new URL(req.url, "http://localhost").searchParams.get("q") }));
      return;
    }
    if (req.url === "/v1/capabilities") { response(res, 200, '{"schema":"velvetos.control.v1","capabilities":[]}'); return; }
    if (req.url === "/v1/snapshot") { response(res, 200, '{"schema":"velvetos.control.v1","connection":"connected"}'); return; }
    response(res, 404, '{"error":"unknown"}');
  });
  const upstreamOrigin = await serve(upstream);
  const port = await pickFreePort();
  let portal;
  try {
    portal = await openPortal({
      VELVETOS_CONTROL_API_URL: upstreamOrigin,
      VELVETOS_CONTROL_API_TOKEN: TOKEN,
    }, port);
    const origin = portal.origin;
    async function check(path, expected, opts) {
      const r = await fetch(origin + path, opts);
      assert.equal(r.status, expected, path + " status mismatch");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", path + " missing content hardening");
      assert.equal(r.headers.get("cache-control"), "no-store", path + " can be cached");
      const txt = await r.text();
      assert(!txt.includes(TOKEN), path + " exposed the upstream token");
      return { r, txt };
    }
    await check("/health", 200);
    const snap = await check("/api/control/v1/snapshot", 200);
    assert.equal(JSON.parse(snap.txt).schema, "velvetos.control.v1");
    assert.equal(requestedAuth, "Bearer " + TOKEN);
    console.log("PORTAL_SECURITY_PASS allowlisted_read_auth_and_nostore");
    await check("/api/control/v1/capabilities", 200);
    const search = await check("/api/control/v1/search?q=office", 200);
    assert.equal(JSON.parse(search.txt).query, "office");
    console.log("PORTAL_SECURITY_PASS bounded_search");
    const callsBeforeDenied = upstreamCalls;
    await check("/api/control/v1/actions", 404);
    await check("/api/control/v1/snapshot?expand=secrets", 400);
    await check("/api/control/v1/search?q=x&q=y", 400);
    await check("/api/control/v1/search?q=", 400);
    await check("/api/control/v1/search?q=" + "x".repeat(201), 400);
    await check("/api/control/v1/snapshot", 405, { method: "POST" });
    assert.equal(upstreamCalls, callsBeforeDenied, "denied routes leaked to upstream");
    console.log("PORTAL_SECURITY_PASS unknown_routes_queries_mutations_rejected");
    mode = "redirect";
    const redirected = await check("/api/control/v1/snapshot", 502);
    assert.equal(redirectHits, 0, "redirected request reached attacker origin");
    assert(!redirected.txt.includes("should-never-receive-token"));
    console.log("PORTAL_SECURITY_PASS upstream_redirect_blocked");
    mode = "oversize";
    await check("/api/control/v1/snapshot", 502);
    console.log("PORTAL_SECURITY_PASS chunked_oversize_blocked");
    mode = "html";
    await check("/api/control/v1/snapshot", 502);
    mode = "invalid-json";
    await check("/api/control/v1/snapshot", 502);
    mode = "denied";
    const denied = await check("/api/control/v1/snapshot", 401);
    assert(!denied.txt.includes("private backend secret"));
    console.log("PORTAL_SECURITY_PASS nonjson_badjson_and_denied_redacted");
    const dotfile = await check("/.env", 404);
    assert(!dotfile.txt.includes("private"));
    await check("/%2eenv", 404);
    await check("/assets/missing.css", 404);
    console.log("PORTAL_SECURITY_PASS dotfiles_and_unbundled_assets_rejected");
    const staticRes = await fetch(origin + "/");
    if (staticRes.status === 200) {
      assert((staticRes.headers.get("content-security-policy") || "").includes("script-src 'self'"), "missing CSP");
      assert.equal(staticRes.headers.get("x-frame-options"), "DENY");
      console.log("PORTAL_SECURITY_PASS static_csp_and_clickjacking");
      for (const [path, type] of [["/favicon.ico", "image/x-icon"], ["/favicon.svg", "image/svg+xml"]]) {
        const icon = await fetch(origin + path);
        assert.equal(icon.status, 200, path + " not served");
        assert.equal(icon.headers.get("content-type"), type, path + " wrong type");
        assert.equal(icon.headers.get("cache-control"), "no-cache", path + " unhashed file cached immutable");
        assert((await icon.arrayBuffer()).byteLength > 0, path + " empty");
      }
      console.log("PORTAL_SECURITY_PASS favicon_served");
    } else {
      // Built assets may be absent when npm test runs before npm run build.
      assert([404, 502].includes(staticRes.status), "built assets absent should not be served");
    }
  } finally {
    portal?.child.kill();
    await new Promise((r) => upstream.close(r));
    await new Promise((r) => redirectTarget.close(r));
  }
});
