import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({
  viewport: { width: 1280, height: 2400 },
  deviceScaleFactor: 1,
});
await page.goto("http://localhost:8899/_sheet.html", { waitUntil: "networkidle" });
await page.screenshot({ path: process.argv[2], fullPage: true });
await browser.close();
