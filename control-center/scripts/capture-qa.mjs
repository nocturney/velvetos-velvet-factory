import { chromium } from "playwright-core";

const executablePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const base = process.env.CONTROL_CENTER_URL || "http://127.0.0.1:8090";
const browser = await chromium.launch({ executablePath, headless: true });
const views = ["Overview", "Studio", "Sales", "Media", "Tools", "System"];

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(base, { waitUntil: "networkidle" });
  const live = await page.locator(".live-dot.online").count();
  if (!live) throw new Error("snapshot did not connect");

  for (const view of views) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await page.waitForTimeout(80);
    const modules = await page.locator(".module").count();
    if (!modules) throw new Error(`${view}: no modules rendered`);
    await page.screenshot({ path: `qa-${view.toLowerCase()}-live.png`, fullPage: true });

    if (view === "Tools") {
      const integrations = await page.locator(".integration-card").count();
      const tools = await page.locator(".tool-row").count();
      if (integrations < 10) throw new Error(`Tools: expected integration registry, got ${integrations}`);
      if (tools < 20) throw new Error(`Tools: expected canonical capability catalog, got ${tools}`);
    }
    if (view === "System") {
      const sources = await page.locator(".source-card").count();
      const runtime = await page.locator(".runtime-row").count();
      if (sources < 6 || runtime < 3) throw new Error(`System: incomplete sources/runtime map (${sources}/${runtime})`);
    }
    console.log(`${view}: modules=${modules}`);
  }

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("OK visual QA: all Control Center views render from live snapshot");
} finally {
  await browser.close();
}
