// Fail-closed browser status QA using only a disposable, unauthenticated loopback preview and synthetic snapshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const app = fileURLToPath(new URL("..", import.meta.url));
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const free = net.createServer().listen(0, "127.0.0.1");
await once(free, "listening");
const port = free.address().port;
free.close();
await once(free, "close");
const origin = "http://127.0.0.1:" + port;
const child = spawn(process.execPath, [vite, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: app, env: { ...process.env, VELVETOS_CONTROL_API_URL: "", VELVETOS_CONTROL_API_TOKEN: "" }, stdio: "ignore",
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error("preview_exited");
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(300) })).ok) { ready = true; break; } }
    catch { /* bounded retry */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  assert(ready, "preview_timeout");
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
  });
  const now = Date.now();
  const iso = (ageMs) => new Date(now - ageMs).toISOString();
  const base = (state = "live", ageMs = 0) => ({
    schema: "velvetos.control.v1", connection: "connected", generatedAt: iso(0),
    freshness: { state, verifiedAt: iso(ageMs) }, flags: { velvetosHealth: "ready" },
    collections: { jobs: { state: "unavailable", items: null, count: null } },
  });
  const cases = [
    { label: "live", reply: { status: 200, data: base() }, expected: "LIVE VERIFIED", online: true },
    { label: "fresh", reply: { status: 200, data: base("fresh") }, expected: "FRESH SNAPSHOT", online: true },
    { label: "old", reply: { status: 200, data: base("live", 180_000) }, expected: "STALE SNAPSHOT", online: false },
    { label: "source-unknown", reply: { status: 200, data: base("unknown") }, expected: "UNKNOWN", online: false },
    { label: "denied", reply: { status: 503, data: { error: "offline_fixture" } }, expected: "DISCONNECTED", online: false },
    { label: "invalid-schema", reply: { status: 200, data: { schema: "bad.schema" } }, expected: "DISCONNECTED", online: false },
  ];
  for (const entry of cases) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/control/v1/snapshot", (route) => route.fulfill({
      status: entry.reply.status, contentType: "application/json", body: JSON.stringify(entry.reply.data),
    }));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((expected) => document.querySelector(".top-actions small")?.textContent === expected, entry.expected);
    const className = await page.locator(".live-dot").getAttribute("class") || "";
    assert.equal(className.includes("online"), entry.online, entry.label + " incorrectly displayed green indicator");
    assert.equal(errors.length, 0, entry.label + " browser errors: " + errors.join(","));
    console.log("PORTAL_TRUTH_PASS case=" + entry.label + " status=" + entry.expected);
    await page.close();
  }

  const page = await browser.newPage();
  await page.clock.install();
  let calls = 0;
  await page.route("**/api/control/v1/snapshot", (route) => {
    calls++;
    return route.fulfill({
      status: calls === 1 ? 200 : 503, contentType: "application/json",
      body: JSON.stringify(calls === 1 ? base() : { error: "refresh_failed" }),
    });
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector(".top-actions small")?.textContent === "LIVE VERIFIED");
  await page.clock.fastForward(31_000);
  await page.waitForFunction(() => document.querySelector(".top-actions small")?.textContent === "DISCONNECTED");
  assert(calls >= 2, "refresh_not_called");
  console.log("PORTAL_TRUTH_PASS case=failed_refresh_clears_live");
  await page.close();
} finally {
  if (browser) await browser.close();
  child.kill();
}
