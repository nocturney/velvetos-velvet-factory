import { chromium } from "playwright-core";

const executablePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const base = process.env.CONTROL_CENTER_URL || "http://127.0.0.1:8090";
const browser = await chromium.launch({ executablePath, headless: true });

try {
  for (const [name, width, height] of [
    ["qa-desktop-live.png", 1600, 1000],
    ["qa-wide-live.png", 1920, 1080],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base, { waitUntil: "networkidle" });
    await page.screenshot({ path: name, fullPage: true });
    const live = await page.locator(".live-dot.online").count();
    const ready = await page.locator(".state-ready").count();
    const unknown = await page.locator(".state-unknown").count();
    console.log(`${name}: live=${live} ready=${ready} unknown=${unknown} errors=${errors.length}`);
    if (!live || ready < 5 || unknown) throw new Error(`visual QA state failed for ${name}`);
    if (errors.length) throw new Error(errors.join("\n"));
    await page.close();
  }
} finally {
  await browser.close();
}
