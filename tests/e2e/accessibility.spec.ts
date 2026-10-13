import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { MAP_WITH_TRAFFIC, STOP_ID, mockApi } from "./fixtures.js";

/**
 * Automated accessibility (docs/15_TESTING.md "UI quality"), targeting WCAG 2.2 AA.
 *
 * Automated checks catch perhaps a third of real barriers, so these are a floor rather than a
 * pass mark — keyboard and screen-reader spot checks below cover what axe cannot see. But a
 * violation here is always a genuine defect, so none is tolerated.
 */

const PAGES = [
  { path: "/", name: "home" },
  { path: `/stops/${STOP_ID}`, name: "stop" },
  { path: "/search", name: "search" },
  { path: "/journey", name: "journey planner" },
  { path: "/saved", name: "saved" },
  { path: "/methodology", name: "methodology" },
  /*
   * The two passenger surfaces this list had been missing.
   *
   * "Accessibility regressions" is asked of every surface, and the live map and the disruptions
   * board were the two a passenger is most likely to be sent to and the two with the most
   * conditional rendering — a map with a list equivalent beside it, and a board with two layers
   * that must not be mistaken for each other.
   */
  /*
   * With stops and buses on it, not the empty map.
   *
   * `mockApi`'s default `/v1/map` is `EMPTY_MAP`, so this page scanned clean because there was
   * nothing on it to scan — and the deployed sweep then found `target-size` on the stop links at
   * phone width, which this could never have caught. An accessibility pass over an empty list is
   * not an accessibility pass.
   */
  { path: "/live", name: "live map", overrides: { "/v1/map": MAP_WITH_TRAFFIC } },
  { path: "/disruptions", name: "disruptions" },
  { path: "/pro", name: "Pro control tower" },
  /* And the Pro sections that were left out: each reads different artifacts and draws differently. */
  { path: "/pro/live", name: "Pro live operations" },
  { path: "/pro/routes", name: "Pro routes" },
  { path: "/pro/operators", name: "Pro operators" },
  { path: "/pro/congestion", name: "Pro congestion" },
  { path: "/pro/analytics", name: "Pro analytics" },
  { path: "/pro/reports", name: "Pro reports" },
  { path: "/pro/disruptions", name: "Pro disruptions" },
  { path: "/pro/settings", name: "Pro settings" },
];

for (const { path, name, overrides } of PAGES) {
  test(`${name} has no automatically detectable accessibility violations`, async ({ page }) => {
    await mockApi(page, overrides ?? {});
    await page.goto(path);
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();

    // The failure message names the rule and the element, so a break is actionable.
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => node.target.join(" ")),
      })),
    ).toEqual([]);
  });
}

test("every page is reachable and operable from the keyboard alone", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  // Tab into the document and confirm focus lands somewhere real and visible.
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return null;
    return { tag: element.tagName, text: element.textContent?.trim().slice(0, 40) ?? "" };
  });
  expect(focused).not.toBeNull();

  // And the focused element must be visibly focused, not silently outlined away.
  const outlineRemoved = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element) return true;
    const style = globalThis.getComputedStyle(element);
    return style.outlineStyle === "none" && style.boxShadow === "none";
  });
  expect(outlineRemoved).toBe(false);
});

test("the live map is not the only way to read what is there", async ({ page }) => {
  await mockApi(page);
  await page.goto("/live");
  await page.waitForLoadState("networkidle");

  // Something readable without the map must exist: a list, or a statement that there is nothing.
  const alternative = page
    .getByRole("list")
    .or(page.getByRole("table"))
    .or(page.getByText(/no (stops|vehicles|buses)/i));
  await expect(alternative.first()).toBeVisible();
});

test("headings form a sensible outline rather than being chosen for size", async ({ page }) => {
  await mockApi(page);
  await page.goto("/pro");
  await page.waitForLoadState("networkidle");

  const levels = await page.evaluate(() =>
    [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((element) =>
      Number(element.tagName.slice(1)),
    ),
  );

  expect(levels[0]).toBe(1);
  for (let index = 1; index < levels.length; index += 1) {
    // A heading may go one level deeper at a time, or back out any number of levels.
    expect(levels[index]! - levels[index - 1]!).toBeLessThanOrEqual(1);
  }
});

test("respects a reduced-motion preference", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockApi(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const animating = await page.evaluate(() => {
    return [...document.querySelectorAll("*")].filter((element) => {
      const style = globalThis.getComputedStyle(element);
      const duration = parseFloat(style.animationDuration) || 0;
      const transition = parseFloat(style.transitionDuration) || 0;
      return duration > 0.1 || transition > 0.5;
    }).length;
  });

  expect(animating).toBe(0);
});

test("remains usable at 200% zoom", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 640, height: 512 });
  await page.goto("/pro");
  await page.waitForLoadState("networkidle");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
});
