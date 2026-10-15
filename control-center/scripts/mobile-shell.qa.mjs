// Run only after build. Browser QA uses static, uncredentialed local preview on a random loopback port.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
listener.close();
await once(listener, "close");
const origin = "http://127.0.0.1:" + port;
const child = spawn(process.execPath, [vite, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root,
  env: { ...process.env, VELVETOS_CONTROL_API_URL: "", VELVETOS_CONTROL_API_TOKEN: "" },
  stdio: "ignore",
});
let browser;
try {
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error("preview_exited_early");
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(400) })).ok) { started = true; break; }
    } catch { /* bounded startup */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert(started, "preview_start_timeout");
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
  });
  for (const width of [320, 390, 768, 820, 1024, 1179, 1366]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.route("**/api/control/**", (route) => route.fulfill({
      status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture_disconnected" }),
    }));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.locator(".module").filter({ hasText: "Integration Registry" }).waitFor();
    await page.locator(".module").filter({ hasText: "Tool & Capability Matrix" }).waitFor();
    await page.getByRole("button", { name: "System", exact: true }).click();
    await page.locator(".module").filter({ hasText: "Canonical Sources" }).waitFor();
    const measured = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      navScroll: document.querySelector("nav")?.scrollWidth || 0,
    }));
    assert(measured.content <= width + 2, "horizontal overflow at " + width + ": " + JSON.stringify(measured));
    assert.equal(errors.length, 0, "uncaught browser errors: " + errors.join(","));
    console.log("PORTAL_RESPONSIVE_PASS width=" + width + " viewport=" + measured.viewport + " document=" + measured.content);
    await page.close();
  }
} finally {
  if (browser) await browser.close();
  child.kill();
}
