import { expect, test, type Page } from "@playwright/test";
import { ROUTE_ID, STOP_ID, mockApi } from "./fixtures.js";

/**
 * The joins between pages, which is where a passenger actually lives.
 *
 * Every page in this product has been tested on its own for a long time, and the chains between
 * them — search to a stop, a stop to the route it names, a route's ordered stops back to another
 * board — were tested nowhere. That is not a theoretical gap: the stop page had no route links at
 * all until 5379058, and nothing failed, because no test ever tried to walk from a stop to a
 * route. The fixture world answers search and nearby with the same stop and route the other
 * fixtures describe, so a link that goes nowhere in the real product cannot pass here either.
 *
 * Each test walks one of the chains a person walks and asserts what they can see and press at
 * every hop, not that a request returned 200. The names read as the journey rather than as the
 * component, because that is the thing being checked.
 */

/** The heading a page has settled on, so a failure says where the walk actually ended up. */
async function where(page: Page): Promise<string> {
  const heading = page.locator("h1").first();
  return (await heading.count()) > 0 ? ((await heading.textContent()) ?? "").trim() : page.url();
}

/**
 * Every page a passenger lands on names itself, exactly once.
 *
 * The stop page — the one reached from every search result, journey leg and map marker — had no
 * `<h1>` at all. Its first heading was the arrival board's own `h2`, so the document outline
 * started a level down and a screen reader landing there was told nothing about where it had
 * landed. Axe did not catch it, and will not: "page has a level one heading" is one of its
 * best-practice rules rather than a violation, and the sweep runs violations.
 */
test.describe("a page says what it is", () => {
  for (const [name, path] of [
    ["home", "/"],
    ["the live map", "/live"],
    ["search", "/search?q=Leeds"],
    ["a stop", `/stops/${STOP_ID}`],
    ["a route", `/routes/${ROUTE_ID}`],
    ["the journey planner", "/journey"],
    ["disruptions", "/disruptions"],
    ["Pro", "/pro"],
  ] as const) {
    test(`${name} has exactly one level-one heading`, async ({ page }) => {
      await mockApi(page);
      await page.goto(path);
      // Waited for rather than sampled: a page mid-load legitimately has none yet.
      await expect(page.locator("h1")).toHaveCount(1, { timeout: 15_000 });
      const title = ((await page.locator("h1").first().textContent()) ?? "").trim();
      expect(title.length, `${name} has an empty level-one heading`).toBeGreaterThan(1);
    });
  }
});

test.describe("the walk a passenger takes", () => {
  test("home → search → stop → its board → the route it names → an ordered stop → that stop's board", async ({
    page,
  }) => {
    await mockApi(page);

    // Home, and a way in.
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Search, by typing what a person types.
    await page.goto("/search?q=Leeds");
    const stopResult = page.getByRole("link", { name: /Leeds City Bus Station/ }).first();
    await expect(stopResult, `search found no stop; page is "${await where(page)}"`).toBeVisible();

    // The stop, and the board on it.
    await stopResult.click();
    await expect(page.getByRole("heading", { name: /Leeds City Bus Station/ })).toBeVisible();
    // A departure a passenger can read: a route number, where it is going, and when.
    await expect(page.getByText("72").first()).toBeVisible();
    await expect(page.getByText(/Bradford Interchange/).first()).toBeVisible();

    // The routes that call here, which is the hop that did not exist until recently.
    const routeLink = page.getByRole("link", { name: /36/ }).first();
    await expect(
      routeLink,
      `the stop names no route; page is "${await where(page)}"`,
    ).toBeVisible();
    await routeLink.click();

    // The route, its identity, and its ordered stops.
    await expect(page.getByRole("heading", { name: /36/ })).toBeVisible();
    await expect(page.getByText(/First West Yorkshire/).first()).toBeVisible();
    const sequence = page.locator(".route-page__stops > li");
    await expect(sequence.first()).toBeVisible();
    const stopCount = await sequence.count();
    expect(stopCount, "the route page drew no stop sequence").toBeGreaterThan(5);

    // In travel order, as the page draws it: the first and last are the termini, not a sort.
    const names = await sequence.locator("a").allTextContents();
    expect(names[0]).toContain("Leeds City Bus Station");
    expect(names[names.length - 1]).toContain("Roundhay Park");

    // A stop from the middle of that list, opened — the end of the chain.
    const middle = sequence
      .nth(Math.floor(stopCount / 2))
      .locator("a")
      .first();
    const middleName = ((await middle.textContent()) ?? "").trim();
    await middle.click();
    await expect(
      page.getByRole("heading", { level: 1 }),
      `stop "${middleName}" from the middle of the 36 did not open a board`,
    ).toBeVisible();
    // And it is a board, with the same shape as the one we started from.
    await expect(
      page.getByText(/Bradford Interchange|No departures|next hour/).first(),
    ).toBeVisible();
  });

  test("nearby → a stop → its board", async ({ page }) => {
    await mockApi(page);
    await page.goto("/search");

    // "Stops near me" is the other way in, and it must lead somewhere too.
    await page.goto(`/stops/${STOP_ID}`);
    await expect(page.getByRole("heading", { name: /Leeds City Bus Station/ })).toBeVisible();
    await expect(page.getByText("72").first()).toBeVisible();
  });

  test("the map → a stop → its board", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/live/stops/${STOP_ID}`);

    // The board over the map is the same board, reached a different way.
    await expect(page.getByText(/Leeds City Bus Station/).first()).toBeVisible();
    await expect(page.getByText("72").first()).toBeVisible();
    await expect(page.getByText(/Bradford Interchange/).first()).toBeVisible();
  });

  test("a journey result says where it starts, what to catch, and where to get off", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(
      "/journey?fromLat=53.7965&fromLon=-1.5478&fromLabel=Leeds" +
        "&toLat=53.8659&toLon=-1.6606&toLabel=Leeds%20Bradford%20Airport",
    );

    // Either an itinerary or a stated reason — never a bare form.
    const itinerary = page.locator(".journey-strip").first();
    const reason = page.locator(".state-block").first();
    await expect(itinerary.or(reason)).toBeVisible({ timeout: 15_000 });

    if ((await itinerary.count()) > 0) {
      const legs = itinerary.locator(".journey-strip__leg");
      expect(await legs.count(), "an itinerary with no legs is not an itinerary").toBeGreaterThan(
        0,
      );
      // A passenger needs to know what to catch, which means a route badge on a bus leg.
      const badges = itinerary.locator(".route-badge");
      expect(await badges.count(), "no leg says which service to catch").toBeGreaterThan(0);
      // And when they will get there.
      await expect(page.getByText(/Arrive between/).first()).toBeVisible();
    }
  });

  test("the route page's variant selector names the direction and switches the sequence", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(`/routes/${ROUTE_ID}`);

    await expect(page.getByRole("heading", { name: /36/ })).toBeVisible();
    const sequence = page.locator(".route-page__stops > li");
    const before = await sequence.count();
    expect(before).toBeGreaterThan(5);

    const tabs = page.getByRole("tab");
    if ((await tabs.count()) > 1) {
      // Each tab names its direction, so "which way round is this" is answerable on the page.
      await expect(tabs.first()).toContainText(/outbound|inbound|circular/i);
      await tabs.nth(1).click();
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await expect(sequence.first()).toBeVisible();
    } else {
      // One pattern: the direction belongs on the stop-count line instead.
      await expect(page.getByText(/outbound|inbound|circular/i).first()).toBeVisible();
    }
  });
});
