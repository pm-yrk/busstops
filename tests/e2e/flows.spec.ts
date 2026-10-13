import { expect, test, type Page } from "@playwright/test";
import {
  ROUTE_ID,
  STOP_ID,
  ROUTE_DETAIL,
  STOP_RESPONSE,
  POSTCODE_SEARCH_RESULTS,
  mockApi,
} from "./fixtures.js";

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

    /*
     * Above the weather and above the full timetable, which is where it belongs.
     *
     * It used to be the sixth section on the page, below a weather scene — the wrong order for
     * the only moment it matters, since somebody standing at a stop whose bus has not arrived
     * does not scroll past a forecast to find help. Asserted by position rather than by reading
     * the source order, because a stylesheet can reorder a flex or grid container and the DOM
     * would still look right.
     */
    const helpTop = (await help.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
    for (const below of [".stop-page__departures", ".stop-page__weather"]) {
      const target = page.locator(below);
      if ((await target.count()) === 0) continue;
      const top = (await target.first().boundingBox())?.y ?? 0;
      expect(helpTop, `"Bus not come?" must sit above ${below}`).toBeLessThan(top);
    }
  });

  /*
   * The other way in, actually walked.
   *
   * This test was named "nearby → a stop → its board" and navigated straight to the stop: it
   * opened /search, ignored it, typed the stop's URL and asserted the board. Every step it was
   * named for was skipped, so "Stops near me" could have been dead and nothing would have failed.
   * A test whose name misdescribes it is worse than no test, because it is counted as coverage.
   */
  test("nearby → a stop → its board", async ({ page, context }) => {
    // The browser will not offer a position otherwise, and the page asks for one.
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 53.7965, longitude: -1.5478 });
    await mockApi(page);
    await page.goto("/search");

    await page.getByRole("button", { name: /Stops near me/i }).click();

    // A real result, reached from the control rather than from a typed URL.
    const firstNearby = page.locator('a[href^="/stops/"]').first();
    await expect(firstNearby).toBeVisible();
    const nearbyName = ((await firstNearby.textContent()) ?? "").trim();
    expect(nearbyName.length, "a nearby result with no name is not a result").toBeGreaterThan(0);

    await firstNearby.click();
    await expect(page.locator("h1")).toBeVisible();
    expect(page.url()).toContain("/stops/");
    // And the board is there, which is the thing the walk was for.
    await expect(page.locator(".arrival-board, .arrival-board__table").first()).toBeVisible();
  });

  /*
   * Named for what it does, which is not the whole flow.
   *
   * It opens the map's stop deep link and reads the board over the map — the destination of
   * "map → click a stop → board" without the click. The click itself needs a real style, real
   * tiles and a rendered canvas, and it is covered where those exist: the deployed sweep's
   * "live opens the arrival board when a stop is clicked" clicks a painted marker against the
   * real deployment and reads the rows out of the panel.
   *
   * It was called "the map → a stop → its board", which claimed the click. A test counted as
   * coverage for a step it never takes is worse than no test for that step.
   */
  test("the board over the map, which is where a map click lands", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/live/stops/${STOP_ID}`);

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
   * Our own staleness must never be reported as a fact about the buses.
   *
   * With the horizon expired — which is the live state of the preview whenever the departures
   * refresh has not run — every timetable shard a board asks for is absent. "There are no
   * departures from this stop in the next hour" is then false, and it was what the full
   * departures list said while the board directly above it said the opposite. A page that
   * contradicts itself about whose fault an empty board is cannot be trusted about either answer.
   */
  test("an expired timetable is reported as ours, not as the buses not running", async ({
    page,
  }) => {
    await mockApi(page, {
      [`/v1/stops/${STOP_ID}`]: {
        ...STOP_RESPONSE,
        data: {
          ...STOP_RESPONSE.data,
          departures: [],
          timetableCoverage: { read: 0, missing: 4, serviceDates: ["2026-10-12"] },
        },
      },
    });
    await page.goto(`/stops/${STOP_ID}`);

    // Said once on the board, and once in the full list, and the same way both times.
    await expect(page.getByText(/no timetable published for today/i).first()).toBeVisible();
    await expect(
      page.locator(".stop-page__departures").getByText(/gap on our side/i),
    ).toBeVisible();

    // And never the sentence that blames the buses.
    await expect(page.getByText(/no departures from this stop in the next hour/i)).toHaveCount(0);
  });

  /*
   * A route with no published description still says where it goes.
   *
   * The deployed walk reported `route "Route UK002"` — a code with a word in front of it, which
   * tells a passenger nothing and reads like an identifier that leaked. The page already knew the
   * answer: the selected variant's first and last stops are drawn a few lines below the heading.
   */
  test("a route with no description is named by where it goes", async ({ page }) => {
    await mockApi(page, {
      [`/v1/routes/${ROUTE_ID}`]: {
        ...ROUTE_DETAIL,
        data: {
          ...ROUTE_DETAIL.data,
          route: { ...ROUTE_DETAIL.data.route, description: undefined },
        },
      },
    });
    await page.goto(`/routes/${ROUTE_ID}`);

    const heading = page.locator("h1");
    await expect(heading).toBeVisible();
    const text = (await heading.textContent()) ?? "";

    // Still leads with the number, because that is what somebody came for.
    expect(text).toContain("36");
    // And now says where it goes rather than "Route 36" and nothing else.
    expect(text, "a heading with no destination tells a passenger nothing").toMatch(/→/);
    expect(text).not.toBe("Route 36");
  });

  /*
   * A plan the passenger cannot act on is half a feature.
   *
   * Two things are wanted the moment a plan appears and neither is in the plan: the rest of the
   * service being recommended, and the board at the stop being recommended. So the walk continues
   * out of the journey — into the route, which is also where the ticket hand-off lives, and into
   * the boarding stop's own board.
   */
  /*
   * A postcode is how a lot of people would start, and it matched nothing at all.
   *
   * The index holds stops, routes, operators and landmarks; a postcode is none of those, so
   * "LS1 4DY" returned an empty page. What somebody who types their postcode wants is not a
   * journey plan to it — they are standing there — it is the stops within a few streets, so the
   * result opens the map around the position rather than the planner.
   */
  test("a postcode finds its position and opens the map around it", async ({ page }) => {
    await mockApi(page, { "/v1/search": POSTCODE_SEARCH_RESULTS });
    await page.goto("/search?q=LS1%204DY");

    const result = page.getByRole("link", { name: /LS1 4DY/ }).first();
    await expect(result).toBeVisible();

    // Labelled as what it is, and not warned about as though it were a stop with no live data.
    await expect(page.getByText("Postcode").first()).toBeVisible();
    await expect(page.getByText("Timetable only")).toHaveCount(0);

    /*
     * The link carries the position, which is the thing that makes it useful. Asserted before the
     * click because a bbox is what the map reads, and a result that linked to the right page with
     * the wrong box would look identical.
     */
    const href = (await result.getAttribute("href")) ?? "";
    expect(href, href).toContain("/live?bbox=");
    const bbox = decodeURIComponent(href.split("bbox=")[1] ?? "")
      .split(",")
      .map(Number);
    expect(bbox).toHaveLength(4);
    const [west, south, east, north] = bbox as [number, number, number, number];
    expect(west).toBeLessThan(-1.54666);
    expect(east).toBeGreaterThan(-1.54666);
    expect(south).toBeLessThan(53.79513);
    expect(north).toBeGreaterThan(53.79513);

    await result.click();
    await expect(page).toHaveURL(/\/live\?bbox=/);
    await expect(page.locator("h1")).toBeVisible();
  });

  test("a journey leads on to the route it recommends and the stop it starts from", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(
      "/journey?fromLat=53.7965&fromLon=-1.5478&fromLabel=Leeds" +
        "&toLat=53.8266&toLon=-1.4976&toLabel=Roundhay",
    );

    const itinerary = page.locator(".journey-strip").first();
    await expect(itinerary).toBeVisible();

    // The boarding stop opens its own board.
    await itinerary.getByRole("link", { name: "Leeds City Bus Station" }).first().click();
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator(".arrival-board, .arrival-row").first()).toBeVisible();
    expect(page.url()).toContain("/stops/");

    await page.goBack();
    await expect(itinerary).toBeVisible();

    // And the number on the front opens the service, which carries its stops and its tickets.
    await itinerary
      .getByRole("link", { name: /Route 36/ })
      .first()
      .click();
    await expect(page.locator("h1")).toBeVisible();
    expect(page.url()).toContain("/routes/");
    // The route page is the thing the hand-off hangs off, so it has to have arrived.
    await expect(page.getByRole("heading", { name: "Tickets" })).toBeVisible();
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
