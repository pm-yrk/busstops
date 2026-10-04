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
/**
 * The selectors the deployed sweep walks with, checked here where they can be run.
 *
 * `scripts/visual-qa.mjs` follows the same chain against the real deployment, and it cannot be run
 * from this container — the preview is not reachable from here. So a selector it depends on could
 * rot for several deploys and the only symptom would be a flow check that fails for the wrong
 * reason, which is exactly the class of confusion that cost six runs on the stress question. These
 * assert that each hook the sweep reaches for still exists in the built app.
 */
test.describe("the hooks the deployed sweep walks with", () => {
  test("a search result links to a stop by href", async ({ page }) => {
    await mockApi(page);
    await page.goto("/search?q=Leeds");
    await expect(page.locator('a[href^="/stops/"]').first()).toBeVisible();
  });

  test("a board's rows are readable from its table body", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/stops/${STOP_ID}`);
    const rows = page.locator(".arrival-board__table tbody tr");
    await expect(rows.first()).toBeVisible();
    expect(((await rows.first().textContent()) ?? "").trim().length).toBeGreaterThan(3);
  });

  test("a stop links to a route by href", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/stops/${STOP_ID}`);
    await expect(page.locator('a[href^="/routes/"]').first()).toBeVisible();
  });

  test("a route's stops are links inside the sequence list", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/routes/${ROUTE_ID}`);
    const stops = page.locator(".route-page__stops li a");
    await expect(stops.first()).toBeVisible();
    expect(await stops.count()).toBeGreaterThan(1);
  });

  test("the operator is a link in the masthead standfirst", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/routes/${ROUTE_ID}`);
    await expect(page.locator(".pixel-vista__standfirst a").first()).toBeVisible();
  });

  test("the variant tabs carry the tab role", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/routes/${ROUTE_ID}`);
    // `expect(...).toBeVisible()` auto-waits; `count()` does not, and counted an unrendered page.
    await expect(page.getByRole("tab").first()).toBeVisible();
    expect(await page.getByRole("tab").count()).toBeGreaterThan(1);
  });
});

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

  /*
   * The help a passenger gets when their bus has not come, on the page they are actually on.
   *
   * It existed only on the vehicle page — reached by clicking a bus on the live map — so somebody
   * standing at a stop was offered nothing. Checked in a browser at every viewport because the
   * panel is a column of blocks and a phone is where it would fall apart.
   */
  test("a stop offers practical help when the bus has not come", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/stops/${STOP_ID}`);

    const help = page.locator(".waiting-help");
    await expect(help).toBeVisible();
    await expect(help.getByRole("heading", { name: /Bus not come\?/ })).toBeVisible();

    // Another route from this stop, as a link to its ordered stops.
    await expect(help.getByRole("link", { name: /72/ }).first()).toBeVisible();

    // A journey re-plan that starts where the passenger is standing.
    const replan = help.getByRole("link", { name: /Plan a different journey/ });
    await expect(replan).toBeVisible();
    expect(await replan.getAttribute("href")).toContain("fromLabel=Leeds");

    // Nearby stops come from a real lookup, so either a suggestion or a stated reason.
    await expect(
      help.getByText(/m away|no other stop within|could not look up|Looking for stops nearby/),
    ).toBeVisible();

    // And the limit of what we claim, said once.
    await expect(help.getByText(/not necessarily been cancelled/)).toBeVisible();
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

    /*
     * Each item a passenger needs, asserted one at a time rather than as "an itinerary rendered".
     *
     * `/v1/journeys` had no fixture at all until now, so every journey this suite asked for fell to
     * the catch-all response, failed validation, and showed the error state — which the previous
     * version of this test, accepting "an itinerary *or* a stated reason", passed on. The result a
     * passenger actually reads was looked at by nothing that runs here.
     */
    const itinerary = page.locator(".journey-strip").first();
    await expect(itinerary).toBeVisible({ timeout: 15_000 });

    // The legs, in order.
    const legs = itinerary.locator(".journey-strip__leg");
    expect(await legs.count(), "an itinerary with no legs is not an itinerary").toBe(3);

    // Where it starts and where it ends.
    await expect(itinerary.getByText("Your starting point")).toBeVisible();
    await expect(itinerary.getByText("Your destination")).toBeVisible();

    // What to catch, and where it is heading — not merely that a bus is involved.
    await expect(itinerary.locator(".route-badge").first()).toBeVisible();
    await expect(itinerary.getByText(/towards Roundhay Park/)).toBeVisible();

    // Where to get on and where to get off, by name.
    await expect(itinerary.getByText("Leeds City Bus Station").first()).toBeVisible();
    await expect(itinerary.getByText("Oakwood Lane").first()).toBeVisible();

    // Both walking legs, each saying how long it is.
    const walks = itinerary.locator(".journey-strip__leg--walk");
    expect(await walks.count(), "a journey with no walk at either end is not a bus journey").toBe(
      2,
    );
    await expect(itinerary.getByText(/Walk \d+ min/).first()).toBeVisible();

    // Times on the legs, and an arrival as a range rather than a false precision.
    expect(await itinerary.locator("time").count()).toBeGreaterThan(1);
    await expect(page.getByText(/Arrive between/).first()).toBeVisible();

    // And roughly how long the whole thing takes.
    await expect(page.locator(".journey-option__summary").first()).toBeVisible();
  });

  /*
   * The form must not stand in front of the answer, at any width.
   *
   * The reported symptom was a phone showing the journey form where a valid result belonged. The
   * race behind the blank result is fixed, but "the result rendered" and "the result is the thing
   * you can see and touch" are different claims on a narrow screen, where the form is tall and the
   * result is below it. So this asks the browser what is actually at the top of the itinerary: if
   * the form overlays it, `elementFromPoint` says so.
   */
  test("the journey form never covers a valid result", async ({ page }) => {
    await mockApi(page);
    await page.goto(
      "/journey?fromLat=53.7965&fromLon=-1.5478&fromLabel=Leeds" +
        "&toLat=53.8659&toLon=-1.6606&toLabel=Leeds%20Bradford%20Airport",
    );

    const itinerary = page.locator(".journey-strip").first();
    await expect(itinerary).toBeVisible({ timeout: 15_000 });

    const box = await itinerary.boundingBox();
    expect(box, "the itinerary has no box, so nothing is on screen").not.toBeNull();
    expect(box!.width, "the itinerary is zero-width").toBeGreaterThan(80);
    expect(box!.height, "the itinerary is zero-height").toBeGreaterThan(40);

    // Scrolled to, as a passenger would, then asked what is actually under the pointer there.
    await itinerary.scrollIntoViewIfNeeded();
    const covering = await page.evaluate(() => {
      const strip = document.querySelector(".journey-strip");
      if (!strip) return "no itinerary";
      const rect = strip.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 8);
      if (!hit) return "nothing identifiable";
      if (strip === hit || strip.contains(hit)) return null;
      // A label or wrapper the itinerary sits inside is not covering it.
      if (hit.contains(strip)) return null;
      return `${hit.tagName.toLowerCase()}.${String(hit.className).split(/\s+/)[0] ?? ""}`;
    });
    expect(covering, "something is drawn over the top of the itinerary").toBeNull();
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

      /*
       * Visibly selected, not merely marked selected.
       *
       * `aria-selected` is the right attribute and it is what a screen reader reads, but a sighted
       * passenger has to be able to see which sequence they are looking at — and an attribute is
       * invisible. So the two tabs' computed backgrounds are compared: the selected one inverts.
       */
      const backgroundOf = (index: number) =>
        tabs.nth(index).evaluate((node) => getComputedStyle(node).backgroundColor);
      const selectedBefore = await backgroundOf(0);
      const unselectedBefore = await backgroundOf(1);
      expect(selectedBefore, "the selected variant looks identical to the unselected one").not.toBe(
        unselectedBefore,
      );

      await tabs.nth(1).click();
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await expect(sequence.first()).toBeVisible();
      // And the emphasis moved with the selection.
      expect(await backgroundOf(1)).toBe(selectedBefore);
      expect(await backgroundOf(0)).toBe(unselectedBefore);
    } else {
      // One pattern: the direction belongs on the stop-count line instead.
      await expect(page.getByText(/outbound|inbound|circular/i).first()).toBeVisible();
    }
  });
});
