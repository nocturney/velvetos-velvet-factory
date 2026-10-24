// Dev/preview proxy boundary: a real Vite dev server, a mock Control API, a synthetic bearer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CANARY = "dev-proxy-canary-not-a-secret";
const app = fileURLToPath(new URL("..", import.meta.url));
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const ALLOWLISTED_UPSTREAM = /^\/v1\/(snapshot|capabilities|search\?q=[^&]+)$/;

async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

test("Vite dev proxy forwards only same-origin allowlisted GET", { timeout: 60_000 }, async () => {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || "",
    });
    const body = JSON.stringify({ schema: "velvetos.control.v1", ok: true });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamOrigin = "http://127.0.0.1:" + upstream.address().port;
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  let stderr = "";
  const child = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: app,
    env: {
      ...process.env,
      VELVETOS_CONTROL_API_URL: upstreamOrigin,
      VELVETOS_CONTROL_API_TOKEN: CANARY,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000).replaceAll(CANARY, "[canary]");
  });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error("vite_exited\n" + stderr);
      try {
        if ((await fetch(origin + "/", { signal: AbortSignal.timeout(300) })).ok) {
          ready = true;
          break;
        }
      } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "vite_start_timeout\n" + stderr);

    async function call(path, options = {}) {
      const before = seen.length;
      const response = await fetch(origin + path, options);
      const text = await response.text();
      assert.equal(text.includes(CANARY), false, path + " leaked the bearer");
      return { status: response.status, text, forwarded: seen.length - before, last: seen.at(-1) };
    }

    const snapshot = await call("/api/control/v1/snapshot", {
      headers: { Authorization: "Bearer client-must-not-pass", "X-VelvetOS-Token": "client-must-not-pass" },
    });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.forwarded, 1);
    assert.equal(snapshot.last.method, "GET");
    assert.equal(snapshot.last.url, "/v1/snapshot");
    assert.equal(snapshot.last.authorization, "Bearer " + CANARY);
    assert.equal(JSON.parse(snapshot.text).schema, "velvetos.control.v1");

    const sameOrigin = await call("/api/control/v1/capabilities", {
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.forwarded, 1);
    assert.equal(sameOrigin.last.url, "/v1/capabilities");
    assert.equal(sameOrigin.last.authorization, "Bearer " + CANARY);

    const search = await call("/api/control/v1/search?q=office");
    assert.equal(search.status, 200);
    assert.equal(search.last.url, "/v1/search?q=office");

    const post = await call("/api/control/v1/actions", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(post.status, 405);
    assert.equal(post.forwarded, 0);
    assert.equal(JSON.parse(post.text).error, "method_not_allowed");

    const unknown = await call("/api/control/v1/actions");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.forwarded, 0);

    const extraQuery = await call("/api/control/v1/snapshot?expand=secrets");
    assert.equal(extraQuery.status, 400);
    assert.equal(extraQuery.forwarded, 0);

    const evil = await call("/api/control/v1/snapshot", { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal(evil.forwarded, 0);
    assert.equal(JSON.parse(evil.text).error, "cross_origin_rejected");

    const crossSite = await call("/api/control/v1/snapshot", { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.forwarded, 0);

    const otherPort = await call("/api/control/v1/snapshot", {
      headers: { Origin: "http://127.0.0.1:9", "Sec-Fetch-Site": "same-site" },
    });
    assert.equal(otherPort.status, 403);
    assert.equal(otherPort.forwarded, 0);
    assert.equal(seen.length, 3);
  } finally {
    child.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

// Raw HTTP/1.1 so the request target reaches Vite unnormalized (fetch() would clean up ../).
function rawGet(port, method, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    const lines = [`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close"];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    socket.setTimeout(5000, () => socket.destroy(new Error("raw_timeout " + target)));
    socket.on("data", (chunk) => { data += chunk.toString("utf8"); });
    socket.on("end", () => resolve({ status: Number(data.split(" ")[1]), text: data }));
    socket.on("error", reject);
  });
}

function respondOk(req, res) {
  const body = JSON.stringify({ schema: "velvetos.control.v1", ok: true });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function withViteProxy(mode, fn, respond = respondOk) {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || "" });
    respond(req, res);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = await freePort();
  const outDir = mkdtempSync(join(tmpdir(), "velvetos-preview-"));
  writeFileSync(join(outDir, "index.html"), "<!doctype html><title>preview</title>");
  const args = mode === "preview"
    ? [vite, "preview", "--outDir", outDir, "--host", "127.0.0.1", "--port", String(port), "--strictPort"]
    : [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
  let stderr = "";
  const child = spawn(process.execPath, args, {
    cwd: app,
    env: {
      ...process.env,
      VELVETOS_CONTROL_API_URL: "http://127.0.0.1:" + upstream.address().port,
      VELVETOS_CONTROL_API_TOKEN: CANARY,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000).replaceAll(CANARY, "[canary]");
  });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(mode + "_exited\n" + stderr);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) })).ok) {
          ready = true;
          break;
        }
      } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, mode + "_start_timeout\n" + stderr);
    await fn({ port, seen });
    for (const hit of seen) {
      assert.match(hit.url, ALLOWLISTED_UPSTREAM, mode + " forwarded a non-allowlisted path: " + hit.url);
      assert.equal(hit.method, "GET");
    }
  } finally {
    child.kill();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(outDir, { recursive: true, force: true });
  }
}

const NON_CANONICAL = [
  "/api/control/../control/v1/snapshot",
  "/api/control/%2e%2e/control/v1/search?q=x",
  "/api/control/%2E%2E/control/v1/capabilities",
  "/api/control/v1/actions/../snapshot",
  "/api/control/v1/actions/%2e%2e/snapshot",
  "/api/control/v1/actions/.%2e/snapshot",
  "/api/control/v1/x/./../snapshot",
  "/api/control/v1/%2e/snapshot",
  "/api/control/./v1/snapshot",
  "/api/control/v1\\snapshot",
  "/api/control/v1/actions\\..\\snapshot",
  "/api/control/v1/%73napshot",
];

for (const mode of ["dev", "preview"]) {
  test(`${mode}: traversal, encoding, backslash and HEAD never reach a non-allowlisted upstream path`, { timeout: 60_000 }, async () => {
    await withViteProxy(mode, async ({ port, seen }) => {
      const ok = await rawGet(port, "GET", "/api/control/v1/snapshot");
      assert.equal(ok.status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, "/v1/snapshot");
      assert.equal(seen[0].authorization, "Bearer " + CANARY);

      const search = await rawGet(port, "GET", "/api/control/v1/search?q=office");
      assert.equal(search.status, 200);
      assert.equal(seen.at(-1).url, "/v1/search?q=office");

      for (const target of NON_CANONICAL) {
        const before = seen.length;
        const response = await rawGet(port, "GET", target);
        assert.ok(response.status >= 400 && response.status < 500, `${mode} ${target} -> ${response.status}`);
        assert.equal(seen.length, before, `${mode} ${target} was forwarded`);
        assert.equal(response.text.includes(CANARY), false, `${mode} ${target} leaked the bearer`);
      }

      for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
        const before = seen.length;
        const response = await rawGet(port, method, "/api/control/v1/snapshot");
        assert.equal(response.status, 405, `${mode} ${method}`);
        assert.equal(seen.length, before, `${mode} ${method} was forwarded`);
      }
      assert.equal(seen.length, 2);
    });
  });
}

// Upstream 200 JSON that reflects the server-held canary must never reach the browser.
// Variants cover plain value, JSON-escaped characters, duplicate keys and a canary-named key.
const REFLECTIONS = {
  plain: `{"schema":"velvetos.control.v1","debug":"${CANARY}"}`,
  escaped: `{"schema":"velvetos.control.v1","debug":"dev-proxy-canary-not-a-\\u0073ecret"}`,
  duplicateKey: `{"schema":"velvetos.control.v1","debug":"ok","debug":"${CANARY}"}`,
  keyName: `{"schema":"velvetos.control.v1","${CANARY}":true}`,
};

for (const mode of ["dev", "preview"]) {
  for (const [name, raw] of Object.entries(REFLECTIONS)) {
    test(`${mode}: upstream JSON reflecting the server token (${name}) becomes a sanitized 502`, { timeout: 60_000 }, async () => {
      await withViteProxy(mode, async ({ port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/control/v1/snapshot`, {
          headers: { Accept: "application/json" },
        });
        const text = await response.text();
        assert.equal(response.status, 502, `${mode} ${name} status`);
        assert.deepEqual(JSON.parse(text), { error: "control_api_credential_reflection" }, `${mode} ${name} body`);
        assert.equal(text.includes(CANARY), false, `${mode} ${name} leaked the token`);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      }, (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(raw);
      });
    });
  }

  test(`${mode}: upstream error and non-JSON bodies that echo the token are never forwarded`, { timeout: 60_000 }, async () => {
    const replies = [
      { status: 500, type: "application/json", body: `{"detail":"${CANARY}"}`, expect: [502, "upstream_unavailable"] },
      { status: 401, type: "application/json", body: `{"detail":"${CANARY}"}`, expect: [401, "control_api_denied"] },
      { status: 200, type: "text/html", body: `<p>${CANARY}</p>`, expect: [502, "invalid_upstream_content_type"] },
    ];
    const queue = [...replies];
    await withViteProxy(mode, async ({ port }) => {
      for (const reply of replies) {
        const response = await fetch(`http://127.0.0.1:${port}/api/control/v1/capabilities`);
        const text = await response.text();
        assert.equal(response.status, reply.expect[0], `${mode} ${reply.status} ${reply.type} status`);
        assert.deepEqual(JSON.parse(text), { error: reply.expect[1] }, `${mode} ${reply.status} body`);
        assert.equal(text.includes(CANARY), false, `${mode} ${reply.status} leaked the token`);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
    }, (req, res) => {
      const reply = queue.shift();
      res.writeHead(reply.status, { "Content-Type": reply.type });
      res.end(reply.body);
    });
  });
}
