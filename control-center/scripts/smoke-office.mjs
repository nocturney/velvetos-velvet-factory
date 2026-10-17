// Office read-only UI smoke: local Vite preview, synthetic Control API only, no cloud auth.
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
    catch { /* start retry */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  assert(ready, "preview_timeout");
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  const verified = {
    schema: "velvetos.control.v1", connection: "connected",
    flags: { system: { state: "ready", provenance: { source: "office/control-plane.json" } }, policyPresent: true, dontBotherChristian: true, locks: ["checked"], sourcesOfTruthCount: 3, attentionCollection: { state: "ready", count: 1 } },
    attention: [{ id: "approval-1", title: "Verified owner review", waitingFor: "owner" }],
    collections: { agents: { state: "ready", count: 1, seatCount: 1, items: [{ id: "specialist-1", job: "Read-only QA", seat: "office-seat" }], provenance: { source: "instance:toolDesk" } } },
  };
  const cases = [
    { name: "verified", status: 200, response: verified, agent: "specialist-1", approval: "Verified owner review", policy: "Present" },
    { name: "missing-source", status: 200, response: { ...verified, flags: { system: { state: "unavailable" } }, attention: [], collections: { agents: { state: "unavailable", items: null, count: null, reason: "desk unavailable" } } }, agent: "UNAVAILABLE", approval: "UNKNOWN", policy: "UNKNOWN" },
    { name: "http-denied", status: 503, response: { error: "offline" }, agent: "UNKNOWN", approval: "UNKNOWN", policy: "UNKNOWN" },
  ];
  for (const row of cases) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.route("**/api/control/v1/snapshot", (route) => route.fulfill({ status: row.status, contentType: "application/json", body: JSON.stringify(row.response) }));
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Office", exact: true }).click();
    const desk = page.locator(".module").filter({ hasText: "Office Specialist Roster" });
    const policy = page.locator(".module").filter({ hasText: "Office Policy & Source Map" });
    const attention = page.locator(".module").filter({ hasText: "Owner Attention" });
    await desk.waitFor();
    await policy.waitFor();
    await attention.waitFor();
    await page.waitForTimeout(150);
    const deskText = await desk.innerText();
    const policyText = await policy.innerText();
    const attentionText = await attention.innerText();
    assert(deskText.includes(row.agent), row.name + " desk mismatch");
    assert(policyText.includes(row.policy), row.name + " policy mismatch");
    assert(attentionText.includes(row.approval), row.name + " attention mismatch");
    if (row.name !== "verified") {
      assert(!deskText.includes("specialist-1"), "stale roster leaked");
      assert(!policyText.includes("Present"), "missing policy was mislabeled present");
      assert(!attentionText.includes("Verified owner review"), "unverified attention leaked");
    }
    assert.equal(errors.length, 0, errors.join(","));
    console.log("PORTAL_OFFICE_PASS case=" + row.name);
    await page.close();
  }
} finally {
  if (browser) await browser.close();
  child.kill();
}
