// Production read-only UI acceptance against only synthetic canonical Control API fixtures.
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
    catch { /* bounded startup */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  assert(ready, "preview_timeout");
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  const readySnapshot = {
    schema: "velvetos.control.v1", connection: "connected",
    collections: {
      production: {
        state: "ready", count: 2, printerCount: 1, eventCount: 1, maintenanceCount: 0,
        items: [
          { kind: "printer", id: "p1", brand: "FixtureMaker", model: "Printer A", status: "unverified_source" },
          { kind: "print_event", id: "event-1", productName: "Fixture Print", status: "recorded" },
        ],
      },
      models: {
        state: "ready", maxSlots: 10, occupiedCount: 1, readyCount: 1, count: 1,
        items: [{ id: "slot-1", name: "Fixture Model", status: "ready", licenseChecked: true, material: "PLA" }],
      },
    },
  };
  const cases = [
    { name: "verified", status: 200, response: readySnapshot, printer: "FixtureMaker", model: "Fixture Model" },
    { name: "unavailable", status: 200, response: { schema: "velvetos.control.v1", collections: { production: { state: "unavailable", items: null, count: null, reason: "no fleet" }, models: { state: "needs_sync", items: null, count: null } } }, printer: "UNAVAILABLE", model: "NEEDS SYNC" },
    { name: "denied", status: 503, response: { error: "offline" }, printer: "UNKNOWN", model: "UNKNOWN" },
  ];
  for (const row of cases) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.route("**/api/control/v1/snapshot", (route) => route.fulfill({ status: row.status, contentType: "application/json", body: JSON.stringify(row.response) }));
    const exceptions = [];
    page.on("pageerror", (e) => exceptions.push(e.message));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Production", exact: true }).click();
    const printers = page.locator(".module").filter({ hasText: "Printers & Recorded Print Events" });
    const models = page.locator(".module").filter({ hasText: "Model Shelf" });
    await printers.waitFor();
    await models.waitFor();
    await page.waitForTimeout(150);
    const p = await printers.innerText();
    const m = await models.innerText();
    assert(p.includes(row.printer), row.name + " printer source mismatch");
    assert(m.includes(row.model), row.name + " model source mismatch");
    if (row.name !== "verified") {
      assert(!p.includes("FixtureMaker"), "unavailable printer leaked");
      assert(!m.includes("Fixture Model"), "unavailable model leaked");
    }
    assert.equal(exceptions.length, 0, exceptions.join(","));
    console.log("PORTAL_PRODUCTION_PASS case=" + row.name);
    await page.close();
  }
} finally {
  if (browser) await browser.close();
  child.kill();
}
