import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { projectFleetMachines } from "../fleet-projection.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testToken = "LOCAL_TEST_VIEWER_ONLY";
const machine = (props = {}) => ({
  id: "test-windows", name: "Test Windows", status: "online", freshness: "live",
  platform: "windows", collectedAt: "2026-10-14T18:00:00Z",
  lastSeen: "2026-10-14T18:01:00Z", os: { name: "Windows", version: "11", hidden: "SECRET" },
  hardware: { cpu: "Example CPU", memory: { totalBytes: 17179869184, freeBytes: 123 },
    password: "SHOULD_NOT_LEAK" },
  network: { ip: "192.0.2.42" }, ...props,
});
let mode = "good", upstream, endpoint, requests = 0, children = [], overflowChunksSent = 0;
async function freePort() {
  const s = net.createServer().listen(0, "127.0.0.1");
  await once(s, "listening"); const port = s.address().port; s.close();
  await once(s, "close"); return port;
}
async function portal(override = {}, nodeArgs = []) {
  const port = await freePort();
  const child = spawn(process.execPath, [...nodeArgs, "server.mjs"], {
    cwd: project, stdio: "ignore",
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1",
      VELVETOS_CONTROL_API_URL: "", VELVETOS_CONTROL_API_TOKEN: "",
      VELVETOS_FLEET_API_URL: endpoint,
      VELVETOS_FLEET_READONLY_TOKEN: testToken,
      VELVETOS_FLEET_LOCAL_READONLY: "1", ...override },
  });
  children.push(child);
  const base = "http://127.0.0.1:" + port;
  for (let n = 0; n < 70; n++) {
    if (child.exitCode !== null) throw Error("portal_exited");
    try { if ((await fetch(base + "/health", { signal: AbortSignal.timeout(250) })).ok) return base; }
    catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  throw Error("portal_timeout");
}
before(async () => {
  upstream = http.createServer((req, res) => {
    requests++;
    if (req.url !== "/api/machines" || req.method !== "GET" ||
        req.headers.authorization !== "Bearer " + testToken) {
      res.writeHead(403).end("forbidden"); return;
    }
    if (mode === "badjson") { res.writeHead(200).end("{broken"); return; }
    if (mode === "wrong-type") {
      res.writeHead(200, { "content-type": "text/html" }).end(JSON.stringify([machine()]));
      return;
    }
    if (mode === "chunked-overflow") {
      // No Content-Length. A bounded proxy must abort before all chunks arrive.
      overflowChunksSent = 0;
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(32 * 1024);
      function send() {
        if (res.destroyed) return;
        overflowChunksSent++;
        res.write(chunk);
        if (overflowChunksSent >= 220) res.end();
        else setTimeout(send, 2);
      }
      send();
      return;
    }
    const response = mode === "duplicate" ? [machine(), machine()]
      : mode === "empty" ? [] : [machine(),
        machine({ id: "test-mac", name: "Test Mac", platform: "macos",
          status: "offline", freshness: "unknown", collectedAt: null, lastSeen: null,
          hardware: {}, os: {} })];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  endpoint = "http://127.0.0.1:" + upstream.address().port;
});
after(async () => {
  for (const child of children) child.kill();
  upstream.close();
  await once(upstream, "close");
});
test("verified projection preserves source freshness and strips secrets", () => {
  const p = projectFleetMachines([machine(), machine({ id: "stale", name: "Mac",
    freshness: "unknown", hardware: {}, collectedAt: null })]);
  assert.equal(p.count, 2);
  assert.equal(p.machines[1].freshness, "unknown");
  assert.equal(p.machines[1].collectedAt, null);
  assert.equal(p.machines[1].hardware.memoryTotalBytes, null);
  for (const item of ["SECRET", "password", "192.0.2.42", "SHOULD_NOT_LEAK"])
    assert.ok(!JSON.stringify(p).includes(item));
});
test("Fleet memory bytes reject fractional and unsafe integers", () => {
  const invalid = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN, "123", null];
  for (const value of invalid) {
    const projected = projectFleetMachines([machine({
      hardware: { memory: { totalBytes: value, freeBytes: value } },
    })]).machines[0].hardware;
    assert.equal(projected.memoryTotalBytes, null, "totalBytes " + String(value));
    assert.equal(projected.memoryFreeBytes, null, "freeBytes " + String(value));
  }
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const projected = projectFleetMachines([machine({
      hardware: { memory: { totalBytes: value, freeBytes: value } },
    })]).machines[0].hardware;
    assert.equal(projected.memoryTotalBytes, value);
    assert.equal(projected.memoryFreeBytes, value);
  }
});

test("bad duplicate ID or missing identity fails closed", () => {
  assert.throws(() => projectFleetMachines([machine(), machine()]), /duplicate_fleet_machine/);
  assert.throws(() => projectFleetMachines([machine({ id: null })]), /invalid_fleet_identity/);
});
test("portal serves a projected, authenticated-only, one-origin fleet view", async () => {
  mode = "good"; requests = 0; const base = await portal();
  const response = await fetch(base + "/api/fleet/v1/machines");
  assert.equal(response.status, 200);
  const json = await response.text();
  const p = JSON.parse(json);
  assert.equal(p.schema, "velvetos.portal.fleet-machines.v1");
  assert.equal(p.count, 2);
  assert.equal(p.machines[1].freshness, "unknown");
  assert.equal(requests, 1);
  for (const s of [testToken, "SHOULD_NOT_LEAK", "192.0.2.42"])
    assert.ok(!json.includes(s));
  for (const [method, path, code] of [
    ["POST", "/api/fleet/v1/machines", 405],
    ["DELETE", "/api/fleet/v1/machines", 405],
    ["GET", "/api/fleet/v1/settings", 404],
    ["GET", "/api/fleet/v1/deployments", 404],
    ["GET", "/api/fleet/v1/actions", 404],
  ]) {
    const r = await fetch(base + path, { method });
    assert.equal(r.status, code, method + " " + path);
  }
  assert.equal(requests, 1, "unexpected Fleet backend invocation");
});
test("disabled/misconfigured local gateway is fail-closed", async () => {
  for (const env of [
    { VELVETOS_FLEET_LOCAL_READONLY: "" },
    { VELVETOS_FLEET_READONLY_TOKEN: "" },
    { HOST: "0.0.0.0" },
    { VELVETOS_FLEET_API_URL: "https://example.com" },
    { VELVETOS_FLEET_API_URL: "http://127.0.0.1:4173/private" },
  ]) {
    const base = await portal(env);
    assert.equal((await fetch(base + "/api/fleet/v1/machines")).status, 503);
  }
});
test("local Fleet gateway rejects wrong content type and aborts oversized chunked streams", async () => {
  const base = await portal();
  try {
    mode = "wrong-type";
    assert.equal((await fetch(base + "/api/fleet/v1/machines")).status, 502,
      "non-JSON upstream content type cannot be projected as trusted data");
    mode = "chunked-overflow";
    assert.equal((await fetch(base + "/api/fleet/v1/machines")).status, 502);
    assert(overflowChunksSent < 220,
      "gateway buffered an entire >7 MiB chunked response before rejecting it");
  } finally { mode = "good"; }
});

test("Fleet oversized local stream denies even when cancel never settles", async () => {
  // Preload in the child only: inject a hostile response at the real server
  // module's fetch boundary. No live Fleet or cloud services are contacted.
  const preload = [
    "const nativeFetch = globalThis.fetch;",
    "globalThis.fetch = async (target, options) => {",
    "  if (!String(target).endsWith('/api/machines')) return nativeFetch(target, options);",
    "  if (options?.method !== 'GET') throw new Error('unexpected_upstream_method');",
    "  return new Response(new ReadableStream({",
    "    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },",
    "    cancel() { return new Promise(() => {}); },",
    "  }), { status: 200, headers: { 'content-type': 'application/json' } });",
    "};",
  ].join("\n");
  const base = await portal({}, ["--import", "data:text/javascript," + encodeURIComponent(preload)]);
  // Before the fix the request hangs until this deadline. The fixed gateway
  // rejects immediately with a safe 502 and does not wait for cleanup.
  const response = await fetch(base + "/api/fleet/v1/machines", {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream_unavailable" });
});

test("malformed or ambiguous Fleet data never gives success", async () => {
  const base = await portal();
  for (const fault of ["badjson", "duplicate"]) {
    mode = fault;
    assert.equal((await fetch(base + "/api/fleet/v1/machines")).status, 502);
  }
  mode = "empty";
  const empty = await fetch(base + "/api/fleet/v1/machines");
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).count, 0);
  mode = "good";
});
