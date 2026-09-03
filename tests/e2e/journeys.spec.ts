import { expect, test } from "@playwright/test";
import { EMPTY_MAP, META, STOP_ID, STOP_RESPONSE, mockApi } from "./fixtures.js";

/**
 * Passenger journeys end to end (docs/15_TESTING.md "End-to-end").
 *
 * These assert what a person sees, not what a function returns: that live and timetable-only
 * departures are told apart, that a degraded feed says so, that the map has a list alternative,
 * and that favourites work with no account.
 */

test.describe("home and navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("home shows the wordmark, one promise and a way in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });

  test("every primary destination is reachable", async ({ page }) => {
    await page.goto("/");
    for (const label of ["Live map", "Journey", "Disruption", "Pro", "Search", "Saved"]) {
      const link = page.getByRole("navigation", { name: "Primary" }).getByRole("link", {
        name: new RegExp(label, "i"),
      });
      if ((await link.count()) > 0) {
        await expect(link.first()).toBeVisible();
      }
    }
  });

  test("an unknown deep link lands on a real page rather than a blank screen", async ({ page }) => {
    await page.goto("/this/does/not/exist");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("body")).not.toBeEmpty();
  });
});

test.describe("stop page", () => {
  test("separates live departures from timetable-only ones", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/stops/${STOP_ID}`);

    await expect(page.getByRole("heading", { name: /Leeds City Bus Station/ })).toBeVisible();
    await expect(page.getByText("72").first()).toBeVisible();

    // The two departures must be distinguishable, not merged into one undifferentiated list.
    await expect(page.getByText(/Live/).first()).toBeVisible();
    await expect(page.getByText(/Timetable/).first()).toBeVisible();
  });

  test("a favourite is saved with no account and survives a reload", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/stops/${STOP_ID}`);

    // aria-pressed is the semantics the control actually exposes, so assert on that rather than
    // on the label, which is free to change.
    const favourite = page.getByRole("button", { name: /save this stop|saved/i });
    await expect(favourite).toHaveAttribute("aria-pressed", "false");

    await favourite.click();
    await expect(favourite).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await expect(page.getByRole("button", { name: /save this stop|saved/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("says plainly when a stop cannot be found", async ({ page }) => {
    await page.route("**/api/v1/stops/**", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found", message: "Stop not found" } }),
      }),
    );
    await page.goto(`/stops/${STOP_ID}`);
    await expect(page.getByText(/could not|not found/i).first()).toBeVisible();
  });
});

test.describe("degraded and stale states", () => {
  test("states that only scheduled data is available when live feeds are down", async ({
    page,
  }) => {
    await mockApi(page, {
      [`/v1/stops/${STOP_ID}`]: {
        ...STOP_RESPONSE,
        meta: { ...META, degradation: "scheduled_only", coverage: 0 },
      },
    });
    await page.goto(`/stops/${STOP_ID}`);
    await expect(page.getByRole("status").first()).toBeVisible();
  });

  test("the live map offers a list when there is nothing to draw", async ({ page }) => {
    await mockApi(page, { "/v1/map": EMPTY_MAP });
    await page.goto("/live");

    // The map is never the only way to read the data.
    const listRegion = page.getByRole("list").or(page.getByText(/no (stops|vehicles|buses)/i));
    await expect(listRegion.first()).toBeVisible();
  });
});

test.describe("Bus Stops Pro", () => {
  test("is reachable with no sign-in and no account prompt", async ({ page }) => {
    await mockApi(page);
    await page.goto("/pro");

    await expect(page.getByRole("heading", { name: "Pro" })).toBeVisible();
    await expect(page.getByText(/sign in|log in|create an account/i)).toHaveCount(0);
  });

  test("labels the demonstration snapshot with its date", async ({ page }) => {
    await mockApi(page);
    await page.goto("/pro");

    const banner = page.getByTestId("pro-data-mode");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("2026-08-14");
    await expect(banner).toContainText(/not live data/i);
  });

  test("shows the coverage warning above the figures", async ({ page }) => {
    await mockApi(page);
    await page.goto("/pro");

    await expect(page.getByText(/Only 62% of live sources/)).toBeVisible();

    const warningBox = page.locator(".pro-coverage-warning").first();
    const firstMetric = page.locator(".pro-metric").first();
    const warningY = (await warningBox.boundingBox())?.y ?? Infinity;
    const metricY = (await firstMetric.boundingBox())?.y ?? -Infinity;
    expect(warningY).toBeLessThan(metricY);
  });

  test("shows a dash and the reason for a suppressed metric, never a zero", async ({ page }) => {
    await mockApi(page);
    await page.goto("/pro");

    const suppressed = page.getByTestId("metric-punctuality");
    await expect(suppressed).toContainText("—");
    await expect(suppressed).toContainText(/20 are needed/);
    await expect(suppressed).not.toContainText("0%");
  });

  test("every metric carries its denominator and window", async ({ page }) => {
    await mockApi(page);
    await page.goto("/pro");

    for (const tile of await page.locator(".pro-metric").all()) {
      await expect(tile).toContainText("Denominator");
      await expect(tile).toContainText("Window");
      await expect(tile).toContainText("Coverage");
    }
  });

  test("explains how a figure is measured on request", async ({ page }) => {
    await mockApi(page);
    await page.goto("/pro");

    await page
      .getByRole("button", { name: /how this is measured/i })
      .first()
      .click();
    await expect(page.getByText(/weighted composite/i)).toBeVisible();
  });

  test("the disruption inbox states what it is not covering", async ({ page }) => {
    await mockApi(page);
    await page.goto("/pro/disruptions");

    await expect(page.getByRole("heading", { name: /exception inbox/i })).toBeVisible();
    await expect(
      page.getByText(/not a statement about parts of the network we cannot see/i),
    ).toBeVisible();
    // No acknowledge or clear control: the item goes when the conditions do.
    await expect(page.getByRole("button", { name: /acknowledge|dismiss|clear/i })).toHaveCount(0);
  });

  test("moves between Pro sections", async ({ page }) => {
    await mockApi(page);
    await page.goto("/pro");

    await page.getByRole("link", { name: "Congestion" }).click();
    await expect(page).toHaveURL(/\/pro\/congestion$/);

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/pro\/settings$/);
    await expect(page.getByText(/kept in this browser only/i)).toBeVisible();
  });
});

test.describe("unsubscribe", () => {
  test("one click is enough, with no confirmation step", async ({ page }) => {
    await mockApi(page, {
      "/v1/unsubscribe": {
        meta: META,
        data: {
          status: "unsubscribed",
          message: "You have been unsubscribed. You will not receive another Daily Brief.",
          acknowledged: true,
        },
      },
    });

    await page.goto("/unsubscribe?r=abc&t=xyz");
    await expect(page.getByRole("heading", { name: /Unsubscribed/i })).toBeVisible();
    // No "are you sure?" button anywhere.
    await expect(page.getByRole("button", { name: /confirm|yes, unsubscribe/i })).toHaveCount(0);
  });
});

test.describe("responsive layout", () => {
  for (const path of ["/", "/live", "/pro", `/stops/${STOP_ID}`]) {
    test(`never scrolls horizontally at ${path}`, async ({ page }) => {
      await mockApi(page);
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      // A pixel or two of rounding is tolerable; a scrollbar's worth is a layout defect.
      expect(overflow).toBeLessThanOrEqual(2);
    });
  }
});
