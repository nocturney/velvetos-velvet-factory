// Dev/preview proxy boundary: a real Vite dev server, a mock Control API, a synthetic bearer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CANARY = "dev-proxy-canary-not-a-secret";
const app = fileURLToPath(new URL("..", import.meta.url));
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

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
