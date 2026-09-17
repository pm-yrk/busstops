import { expect, test } from "@playwright/test";

/**
 * The hero's buses must cross the street a person can see, not the canvas they cannot.
 *
 * The lanes used to live inside `.street-scene__street`, which is exactly as wide as the artwork
 * and clips what leaves it. The composition is 320 art pixels; a desktop window is wider than that
 * at any whole-number scale, and the rest of the street is painted by a repeating edge tile. A bus
 * therefore drove roughly two thirds of the way across the page and vanished at a boundary with
 * nothing visible at it.
 *
 * This samples a real animation rather than reading the stylesheet, because the bug was a cascade
 * one — the upright traffic layer's `display: none` was written *after* the media query that
 * turns it on, so at equal specificity the later rule won and a phone had a street with no buses
 * on it at all. Only watching it move catches that.
 */
test("a hero bus crosses the whole visible street", async ({ page }, testInfo) => {
  test.slow();
  await page.goto("/");
  await page.waitForTimeout(500);

  const travel = await page.evaluate(async () => {
    const layer = [...document.querySelectorAll(".street-scene__traffic")].find(
      (node) => getComputedStyle(node).display !== "none",
    );
    const vehicle = layer?.querySelector(".street-scene__lane--near .street-scene__vehicle");
    const scene = document.querySelector(".street-scene");
    if (!vehicle || !scene) return null;

    const box = scene.getBoundingClientRect();
    let leftmost = Infinity;
    let rightmost = -Infinity;
    // A near-lane cycle is 21 seconds; sampling across one guarantees both ends are seen.
    for (let i = 0; i < 46; i++) {
      const rect = vehicle.getBoundingClientRect();
      leftmost = Math.min(leftmost, rect.left);
      rightmost = Math.max(rightmost, rect.right);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { leftmost, rightmost, sceneLeft: box.left, sceneRight: box.right };
  });

  expect(travel, "the active traffic layer has a near-lane vehicle in it").not.toBeNull();
  const seen = travel!;

  // Enters from beyond one edge and leaves beyond the other, rather than appearing and
  // disappearing somewhere inside the picture.
  expect(seen.leftmost, `${testInfo.project.name}: enters from off-screen`).toBeLessThan(
    seen.sceneLeft,
  );
  expect(seen.rightmost, `${testInfo.project.name}: leaves off-screen`).toBeGreaterThan(
    seen.sceneRight,
  );
});
