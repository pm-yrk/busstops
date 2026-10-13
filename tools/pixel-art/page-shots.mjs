import { chromium } from "playwright";

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone", width: 390, height: 844 },
];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const s of sizes) {
  const page = await browser.newPage({ viewport: { width: s.width, height: s.height } });
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `art-preview/home-${s.name}.png` });
  // Which composition the browser chose, and at what whole-number scale it drew it.
  const box = await page.evaluate(() =>
    [...document.querySelectorAll(".street-scene__street")]
      .filter((n) => getComputedStyle(n).display !== "none")
      .map((n) => {
        const r = n.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), cls: n.className };
      }),
  );
  console.log(s.name, JSON.stringify(box));
  await page.close();
}
await browser.close();
