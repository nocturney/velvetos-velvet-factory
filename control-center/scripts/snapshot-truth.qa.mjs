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

  // A previously accepted signed Fleet copy must disappear at expiresAt even
  // while the next 30-second GET has not happened. This exercises the real React
  // component under hosted Chromium, not just a parser helper.
  const fleetPage = await browser.newPage();
  await fleetPage.clock.install();
  let fleetReads = 0;
  const expiry = new Date(Date.now() + 10_000).toISOString();
  const fleetBody = {
    schema: "velvetos.portal.fleet-machines.v1",
    source: "Velvet Fleet Console",
    fetchedAt: new Date().toISOString(),
    count: 1,
    transport: "signed_snapshot",
    validUntil: expiry,
    machines: [{
      id: "signed-expiry-fixture", name: "Expiry Probe", platform: "macos",
      status: "online", freshness: "live",
      collectedAt: new Date().toISOString(), lastSeen: new Date().toISOString(),
      os: { name: "macOS", version: "fixture" },
      hardware: { cpu: "Fixture CPU", cpuCores: 4, memory: { totalBytes: 1024, freeBytes: 512 } },
    }],
  };
  await fleetPage.route("**/api/fleet/v1/machines", (route) => {
    fleetReads++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fleetBody) });
  });
  try {
    await fleetPage.goto(origin, { waitUntil: "domcontentloaded" });
    await fleetPage.getByRole("button", { name: "Fleet", exact: true }).click();
    const card = fleetPage.locator(".module").filter({ hasText: "Fleet Machines" });
    await card.locator(".state-ready").waitFor();
    assert((await card.innerText()).includes("Expiry Probe"), "signed machine absent before TTL");
    await fleetPage.clock.fastForward(12_000);
    await card.locator(".state-unavailable").waitFor({ timeout: 5_000 });
    const textAfter = await card.innerText();
    assert(!textAfter.includes("Expiry Probe"), "expired signed machine remains visible");
    assert(textAfter.includes("פג תוקף"), "expired data lacks explicit denial");
    assert.equal(fleetReads, 1, "expiry assertion must precede the next network refresh");
    console.log("PORTAL_TRUTH_PASS case=signed_fleet_expiry_clears_rows_before_refresh");
  } finally {
    await fleetPage.close();
  }

  // An owner changing the client clock backwards must never resurrect or
  // prolong an already accepted signed snapshot (real React + Chromium).
  const rollbackPage = await browser.newPage();
  await rollbackPage.clock.install();
  let rollbackReads = 0;
  const rollbackBody = {
    ...fleetBody,
    validUntil: new Date(Date.now() + 20_000).toISOString(),
  };
  await rollbackPage.route("**/api/fleet/v1/machines", (route) => {
    rollbackReads++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rollbackBody) });
  });
  try {
    await rollbackPage.goto(origin, { waitUntil: "domcontentloaded" });
    await rollbackPage.getByRole("button", { name: "Fleet", exact: true }).click();
    const rollbackCard = rollbackPage.locator(".module").filter({ hasText: "Fleet Machines" });
    await rollbackCard.locator(".state-ready").waitFor();
    assert((await rollbackCard.innerText()).includes("Expiry Probe"), "rollback fixture did not load");
    await rollbackPage.clock.setSystemTime(new Date(Date.now() - 120_000));
    await rollbackPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await rollbackCard.locator(".state-unavailable").waitFor({ timeout: 5_000 });
    assert(!(await rollbackCard.innerText()).includes("Expiry Probe"), "rollback kept signed online row visible");
    assert.equal(rollbackReads, 1, "rollback must fail closed before another Fleet GET");
    console.log("PORTAL_TRUTH_PASS case=signed_fleet_clock_rollback_fails_closed");
  } finally {
    await rollbackPage.close();
  }
} finally {
  if (browser) await browser.close();
  child.kill();
}
