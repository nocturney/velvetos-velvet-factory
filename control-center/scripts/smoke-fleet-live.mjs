// Optional bounded smoke against the owner's existing Velvet Fleet Console.
// Run only on the same Windows control host; do not print ID/token/materialized
// machine JSON. Does not leave any server running or perform mutations.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";

const file = process.env.FLEET_VIEWER_TOKEN_FILE || "";
const endpoint = process.env.FLEET_EXISTING_LOCAL_URL || "http://127.0.0.1:4173";
if (!file) throw Error("FLEET_VIEWER_TOKEN_FILE_required");
const token = readFileSync(file, "utf8").trim();
if (!token) throw Error("fleet_viewer_token_empty");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint))
  throw Error("fleet_origin_must_be_numeric_loopback");

const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
listener.close();
await once(listener, "close");

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env, HOST: "127.0.0.1", PORT: String(port),
    VELVETOS_CONTROL_API_URL: "", VELVETOS_CONTROL_API_TOKEN: "",
    VELVETOS_FLEET_API_URL: endpoint,
    VELVETOS_FLEET_LOCAL_READONLY: "1",
    VELVETOS_FLEET_READONLY_TOKEN: token,
  },
  stdio: "ignore",
});
try {
  const origin = "http://127.0.0.1:" + port;
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw Error("portal_exited_early");
    try {
      if ((await fetch(origin + "/health", { signal: AbortSignal.timeout(300) })).ok) {
        ready = true; break;
      }
    } catch { /* startup */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  if (!ready) throw Error("portal_start_timeout");
  const response = await fetch(origin + "/api/fleet/v1/machines", { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error("fleet_proxy_status_" + response.status);
  const text = await response.text();
  const data = JSON.parse(text);
  if (data.schema !== "velvetos.portal.fleet-machines.v1" ||
      !Array.isArray(data.machines) || data.count !== data.machines.length)
    throw Error("invalid_fleet_projection");
  if (text.includes(token) || text.includes("remote-access-token.txt"))
    throw Error("auth_material_exposed");
  if (!data.machines.every(m => m.name && m.id && ["live","stale","unknown"].includes(m.freshness)))
    throw Error("invalid_fleet_device_truth");
  for (const path of ["/api/fleet/v1/actions", "/api/fleet/v1/deployments"]) {
    if ((await fetch(origin + path)).status !== 404) throw Error("write_surface_exposed");
  }
  const denied = await fetch(origin + "/api/fleet/v1/machines", { method: "POST" });
  if (denied.status !== 405) throw Error("mutation_not_denied");

  if (process.env.FLEET_BROWSER_SMOKE === "1") {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      headless: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Fleet", exact: true }).click();
      await page.locator(".module").filter({ hasText: "Fleet Machines" }).waitFor({ timeout: 10000 });
      await page.waitForFunction((count) =>
        document.querySelectorAll(".module .row-rich").length === count, data.count,
        { timeout: 10000 });
      const text = await page.locator(".module").innerText();
      for (const machine of data.machines)
        if (!text.includes(machine.name)) throw Error("browser_missing_machine");
      // Mainline regression: adding Fleet must preserve the existing Tools view.
      await page.getByRole("button", { name: "Tools", exact: true }).click();
      await page.locator(".module").filter({ hasText: "Integration Registry" }).waitFor({ timeout: 10000 });
      await page.locator(".module").filter({ hasText: "Tool & Capability Matrix" }).waitFor({ timeout: 10000 });
      console.log("TOOLS_REGRESSION_PASS preserved_mainline_modules=true");
      await page.getByRole("button", { name: "Fleet", exact: true }).click();
      await page.locator(".module").filter({ hasText: "Fleet Machines" }).waitFor({ timeout: 10000 });
      console.log("FLEET_BROWSER_PASS same_origin=true machine_rows=" + data.count);
      await page.close();
    } finally {
      await browser.close();
    }
  }
  const counts = { live: 0, stale: 0, unknown: 0 };
  for (const machine of data.machines) counts[machine.freshness]++;
  console.log("LIVE_FLEET_PORTAL_PASS source=existing_v0.8.x nodes=" +
    data.count + " live=" + counts.live +
    " stale=" + counts.stale + " unknown=" + counts.unknown +
    " writes=denied token=server_only");
} finally {
  child.kill();
}
