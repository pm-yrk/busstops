import { chromium } from "playwright";
const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone", width: 390, height: 844 },
];
const dir = "/tmp/claude-0/-home-user-busstops/dc8316c7-cd3c-5f4c-b66d-588029191eb7/scratchpad";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const size of sizes) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.goto("http://localhost:8899/", { waitUntil: "networkidle" });
  // Let a bus get well into the street rather than catching it at the edge.
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${dir}/hero-${size.name}.png` });
  await page.close();
}
await browser.close();
console.log("done");
