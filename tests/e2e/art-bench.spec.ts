import { test } from "@playwright/test";
import { mockApi, STOP_ID } from "./fixtures.js";

/**
 * Not an assertion: a bench that renders the surfaces carrying pixel artwork so they can be
 * looked at. The art acceptance test is whether the screenshots look right, and that cannot be
 * asserted — so this produces them and a person (or the model that drew them) judges.
 */
test("art bench", async ({ page }, testInfo) => {
  await mockApi(page);
  const shots: Array<[string, string]> = [
    ["stop", `/stops/${STOP_ID}`],
    ["live", "/live"],
    ["journey", "/journey"],
    ["disruptions", "/disruptions"],
    ["notfound", "/no-such-page"],
    ["search", "/search"],
    ["saved", "/saved"],
    ["pro", "/pro"],
  ];
  for (const [name, path] of shots) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `art-preview/${testInfo.project.name}-${name}.png` });
  }
});
