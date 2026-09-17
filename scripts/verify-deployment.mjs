#!/usr/bin/env node
/**
 * Deployed data verification.
 *
 * The smoke test deliberately asserts nothing about live bus data: whether an upstream feed is
 * healthy this minute is not a property of a deployment, and failing a deploy because the DfT had
 * a bad minute would be the wrong signal. This script asks the opposite question — is there real
 * national data behind the deployment, and can a passenger actually get to it? — and is run
 * separately, after a data bootstrap, where a "no" is meaningful.
 *
 * Every check is against the deployed Worker over the public internet. Nothing here is fixtured.
 *
 *   node scripts/verify-deployment.mjs <api-url> [site-url]
 */

const [, , apiUrlArg, siteUrlArg] = process.argv;

if (!apiUrlArg) {
  console.error("Usage: node scripts/verify-deployment.mjs <api-url> [site-url]");
  process.exit(2);
}

const apiUrl = apiUrlArg.replace(/\/$/, "");
const siteUrl = siteUrlArg?.replace(/\/$/, "");

const results = [];
let failures = 0;

/** Facts carried between checks: a stop found by one check is the input to the next. */
const observed = {};

/**
 * Whether a passenger standing at a stop right now should expect a bus.
 *
 * Several checks below used to accept zero on the grounds that "an empty board is legitimate at
 * night". That is true at night and false at nine in the morning, and while the timetable was
 * genuinely missing the excuse covered it permanently: run 28 reported
 * "Piccadilly: 0 departures, 0 routes" as a pass. Making the tolerance conditional on the clock
 * keeps the honest case honest without letting it hide the broken one.
 *
 * Europe/London rather than UTC, because that is when the buses run.
 */
function inServiceHours(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  // 07:00-19:00 is well inside the span when every English town has a bus due somewhere.
  const daytime = hour >= 7 && hour < 19;
  return { daytime, weekday, hour, sunday: weekday === "Sun" };
}

const SERVICE_HOURS = inServiceHours();

async function check(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (error) {
    failures += 1;
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getJson(path) {
  const response = await fetch(`${apiUrl}${path}`, { signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Left null; `text` is reported instead. A non-JSON body is usually the platform speaking
    // rather than the Worker — a resource-limit or startup error — and that text is the whole
    // diagnosis, so throwing it away turns a specific failure into "got 500".
  }
  return { response, body, text };
}

/** A status line that carries what the server actually said, truncated to stay readable. */
function describe(response, body, text) {
  const detail =
    body?.error?.message ?? body?.error?.code ?? text.replace(/\s+/g, " ").trim().slice(0, 300);
  return `${response.status}${detail ? `: ${detail}` : ""}`;
}

// A small viewport over central Manchester: inside the map's size cap, densely stopped, and
// outside London, so a pass here is evidence about the BODS/NaPTAN side rather than TfL's.
const BBOX = "-2.26,53.46,-2.21,53.50";

await check("the live map returns real stops for a real viewport", async () => {
  const { response, body, text } = await getJson(`/v1/map?bbox=${BBOX}&zoom=15`);
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const stops = body?.data?.stops ?? [];
  assert(Array.isArray(stops), "the map response has no stops array");
  assert(
    stops.length > 0,
    "the map returned zero stops for a dense city-centre viewport, which means no national " +
      "network artifact has been published — not that Manchester has no bus stops",
  );
  const withName = stops.filter((stop) => typeof stop.name === "string" && stop.name.length > 0);
  assert(withName.length === stops.length, `${stops.length - withName.length} stops have no name`);
  const inBox = stops.filter(
    (stop) =>
      stop.coordinate?.lat > 53.4 &&
      stop.coordinate?.lat < 53.55 &&
      stop.coordinate?.lon > -2.35 &&
      stop.coordinate?.lon < -2.15,
  );
  assert(inBox.length === stops.length, "some stops fall outside the requested viewport");
  observed.stop = stops[0];
  /*
   * A stop the map says has a service, if there is one. Timetables come from the BODS datasets a
   * build ingested and stops come from all of NaPTAN, so a stop with no routes is a coverage
   * figure rather than a broken endpoint — and picking one arbitrarily would test the wrong
   * thing. How many stops here have a service is reported as its own check below.
   */
  observed.stopWithRoutes = stops.find((stop) => (stop.routePublicNames ?? []).length > 0) ?? null;
  observed.stopsWithRoutes = stops.filter(
    (stop) => (stop.routePublicNames ?? []).length > 0,
  ).length;
  return `${stops.length} stops, first: ${stops[0].name}`;
});

await check("a stop can be selected and returns a departure board", async () => {
  assert(observed.stop, "no stop was found by the previous check");
  // Prefer a stop the map says has a service, so the board is exercised with something on it.
  const target = observed.stopWithRoutes ?? observed.stop;
  observed.stop = target;
  const { response, body, text } = await getJson(`/v1/stops/${encodeURIComponent(target.id)}`);
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const stop = body?.data?.stop;
  assert(stop, "the stop response has no stop");
  assert(stop.id === target.id, "a different stop came back than the one requested");
  // Departures may legitimately be empty at night or on a stop with no service today. What must
  // exist is the board itself and its freshness, which is what the pixel display renders.
  const departures = body?.data?.departures;
  assert(Array.isArray(departures), "the stop response has no departures array");
  for (const departure of departures) {
    // What the pixel arrival board needs in order to render a row at all.
    assert(departure.serviceRoutePublicName, "a departure has no route name to display");
    assert(departure.destinationName, "a departure has no destination to display");
    assert(departure.confidence !== undefined, "a departure states no confidence");
    assert(departure.liveState !== undefined, "a departure does not say whether it is live");
  }
  assert(body?.meta?.generatedAt, "the stop response does not state its freshness");
  // Carried to the route check: this is the only response that names the services calling here.
  observed.routes = body?.data?.routes ?? [];

  /*
   * A stop the published timetable knows nothing about is a coverage failure at any hour. This
   * check deliberately ran against `stopWithRoutes` where one exists, so zero routes here means
   * no stop in the whole viewport had a service.
   */
  assert(
    observed.routes.length > 0,
    `the published timetable names no route calling at ${stop.name}`,
  );

  /*
   * And a stop with routes, in service hours, must have something due. This is the check that
   * separates "the timetable is published" from "a passenger can use it".
   */
  if (SERVICE_HOURS.daytime) {
    assert(
      departures.length > 0,
      `${stop.name} has ${observed.routes.length} routes but nothing due at ` +
        `${SERVICE_HOURS.hour}:00 ${SERVICE_HOURS.weekday} London time`,
    );
  }

  return (
    `${stop.name}: ${departures.length} departures, ${observed.routes.length} routes, ` +
    `${body.meta.degradation}` +
    (SERVICE_HOURS.daytime ? "" : " (outside service hours: departures not required)")
  );
});

/*
 * Five real cities, not one.
 *
 * A single viewport proves a shard published. It does not prove the country did, and the failure
 * this guards against is precisely regional: the departure index is bucketed by a hash of the
 * stop, so a bucket that failed to write takes an arbitrary scatter of stops across England with
 * it and leaves every other bucket looking perfect. Five cities in five different parts of the
 * country, each with its own bucket spread, is what turns "a board works" into "boards work".
 *
 * All five are outside London, so these are BODS and NaPTAN rather than TfL.
 */
/** How many stops per city are asked for a board before concluding the city has none. */
const SAMPLED_STOPS_PER_CITY = 5;

const CITIES = [
  { name: "Leeds", bbox: "-1.57,53.78,-1.52,53.81" },
  { name: "Manchester", bbox: "-2.26,53.46,-2.21,53.50" },
  { name: "Birmingham", bbox: "-1.92,52.46,-1.87,52.49" },
  { name: "Bristol", bbox: "-2.61,51.44,-2.56,51.47" },
  { name: "York", bbox: "-1.10,53.95,-1.05,53.97" },
];

/** What a board has to say for a row to be worth rendering, beyond merely existing. */
function assertDepartureIsPlausible(departure, stopName, city) {
  const route = departure.serviceRoutePublicName ?? "";
  /*
   * A service designation as it is written on the front of a bus: 36, X84, 1A, 555. Anything
   * longer than this is a route *description* leaking into the number field, which is a real
   * failure mode when a feed puts "Leeds - Ripon - Newcastle" where the number belongs.
   */
  assert(
    /^[A-Za-z0-9]{1,5}$/.test(route),
    `${city}: "${route}" at ${stopName} is not a service number a bus would display`,
  );

  const destination = departure.destinationName ?? "";
  assert(
    destination.length >= 3,
    `${city}: a departure at ${stopName} has destination "${destination}"`,
  );
  assert(
    destination !== stopName,
    `${city}: a bus at ${stopName} is signed for ${destination}, where it already is`,
  );

  const scheduled = Date.parse(departure.scheduledTime ?? "");
  assert(
    Number.isFinite(scheduled),
    `${city}: a departure at ${stopName} has no readable scheduled time`,
  );
  /*
   * Inside the window the board asked for. A time far outside it means the epoch or the offset
   * arithmetic is wrong — which is exactly the failure a service-date offset could introduce, and
   * it would otherwise show up as a board full of confident, plausible, wrong times.
   */
  const minutesAway = (scheduled - Date.now()) / 60_000;
  assert(
    minutesAway > -30 && minutesAway < 24 * 60,
    `${city}: ${route} to ${destination} at ${stopName} is due ${Math.round(minutesAway)} ` +
      `minutes from now, which is outside the board's window`,
  );
}

await check("five cities across England return their real routes and departures", async () => {
  const lines = [];
  for (const city of CITIES) {
    const map = await getJson(`/v1/map?bbox=${city.bbox}&zoom=15`);
    assert(
      map.response.ok,
      `${city.name}: /v1/map gave ${describe(map.response, map.body, map.text)}`,
    );
    const stops = map.body?.data?.stops ?? [];
    assert(stops.length > 0, `${city.name}: the map returned no stops at all`);

    /*
     * Which stops to try, and why not the ones the map says carry a service.
     *
     * `routePublicNames` on a map stop is a hard-coded empty array in the Worker — the field is
     * declared in the contract and never filled. Selecting by it, or asserting on it, tests
     * nothing but the stub: the first version of this check did exactly that, and would have
     * failed in all five cities whether or not a single board worked.
     *
     * So the map is used only to find real stops, and the board endpoint is asked directly. A few
     * are tried rather than one, because an individual stop can legitimately be out of use, on a
     * diversion, or served in one direction only. What cannot be true is that none of several
     * stops in a city centre has a service.
     */
    const candidates = stops.slice(0, SAMPLED_STOPS_PER_CITY);
    const boards = [];
    for (const candidate of candidates) {
      const board = await getJson(`/v1/stops/${encodeURIComponent(candidate.id)}`);
      assert(
        board.response.ok,
        `${city.name}: ${candidate.name} gave ${describe(board.response, board.body, board.text)}`,
      );
      boards.push({
        // The board's own name for the stop, not the map's. They are the same stop and must
        // agree, and the "signed for where it already is" check below compares against this one.
        name: board.body?.data?.stop?.name ?? candidate.name,
        mapName: candidate.name,
        routes: board.body?.data?.routes ?? [],
        departures: board.body?.data?.departures ?? [],
        degradation: board.body?.meta?.degradation ?? "unknown",
      });
    }

    for (const board of boards) {
      assert(
        board.name === board.mapName,
        `${city.name}: the map calls it ${board.mapName}, the board calls it ${board.name}`,
      );
    }

    const served = boards.filter((board) => board.routes.length > 0);
    assert(
      served.length > 0,
      `${city.name}: the published timetable names no route calling at any of ` +
        `${boards.length} city-centre stops (${boards.map((b) => b.name).join(", ")})`,
    );

    /*
     * A board that could not read its shard must not look like a quiet one. The reader reports a
     * failed shard and the Worker degrades on it, so "normal" with nothing due is a claim that
     * there is genuinely nothing due — and in service hours, at none of several stops in a city
     * centre, that claim is false.
     */
    const due = served.filter((board) => board.departures.length > 0);
    if (SERVICE_HOURS.daytime) {
      assert(
        due.length > 0,
        `${city.name}: ${served.length} stop(s) carry routes but none has anything due at ` +
          `${SERVICE_HOURS.hour}:00 ${SERVICE_HOURS.weekday} London time ` +
          `(${served.map((b) => `${b.name}: ${b.routes.length} routes, ${b.degradation}`).join("; ")})`,
      );
    }

    for (const board of boards) {
      for (const departure of board.departures) {
        assertDepartureIsPlausible(departure, board.name, city.name);
      }
    }

    const best = due[0] ?? served[0];
    lines.push(
      `${city.name}: ${best.name} — ${best.routes.length} routes, ${best.departures.length} due` +
        (best.departures[0]
          ? `, next ${best.departures[0].serviceRoutePublicName} to ${best.departures[0].destinationName}`
          : "") +
        ` (${served.length}/${boards.length} stops served)`,
    );
  }
  return lines.join("; ");
});

await check("search finds a real stop by name", async () => {
  assert(observed.stop, "no stop was found by the earlier check");
  // Search for a word from a stop the API itself returned, so the query is guaranteed to be a
  // real name rather than something we hoped would be in the index.
  const term = observed.stop.name.split(/[\s,]+/).find((word) => word.length >= 4);
  assert(term, `no searchable word in "${observed.stop.name}"`);
  const { response, body, text } = await getJson(`/v1/search?q=${encodeURIComponent(term)}`);
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const matches = body?.data?.results ?? [];
  assert(matches.length > 0, `search for "${term}" found nothing, so the search index is empty`);
  return `"${term}" → ${matches.length} results`;
});

await check("live vehicles are reported for a covered area", async () => {
  /*
   * How many buses are moving is a property of the hour, not of the deployment — at three in the
   * morning the honest answer is very few — so the count is reported rather than asserted. What
   * is asserted is that the feed is wired up and that each vehicle carries what the map marker
   * needs to draw it, which is a property of the deployment and would break silently.
   */
  const { response, body, text } = await getJson(`/v1/map?bbox=${BBOX}&zoom=15`);
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const vehicles = body?.data?.vehicles;
  assert(Array.isArray(vehicles), "the map response has no vehicles array");
  for (const vehicle of vehicles) {
    assert(vehicle.vehicleRef, "a vehicle has no reference");
    assert(Number.isFinite(vehicle.coordinate?.lat), "a vehicle has no position to draw");
    assert(Number.isFinite(vehicle.freshnessSeconds), "a vehicle does not state its age");
    assert(vehicle.motionState !== undefined, "a vehicle does not say whether it is moving");
  }
  const sources = (body?.meta?.sources ?? []).map((source) => source.source ?? source).join(", ");
  return `${vehicles.length} vehicles from [${sources}] at ${new Date().toISOString()}`;
});

await check("nearby stops come back for a real point", async () => {
  assert(observed.stop, "no stop was found by the earlier check");
  const { lat, lon } = observed.stop.coordinate;
  const { response, body, text } = await getJson(`/v1/nearby?lat=${lat}&lon=${lon}&radius=800`);
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const results = body?.data?.results ?? [];
  assert(
    results.length > 0,
    "nothing was found within 800m of a stop the API itself returned, which means the search " +
      "tiles around that point are not readable",
  );
  return `${results.length} within 800m of ${observed.stop.name}`;
});

await check("the viewport's stops carry the services that call at them", async () => {
  /*
   * This used to be reported rather than asserted, on the grounds that it measured how much
   * timetable the build took rather than whether the deployment worked. That distinction stopped
   * being true once the whole national archive was ingested: a viewport in a English city with
   * no stop carrying a service now means the timetable did not reach the edge, and reporting it
   * as a pass is how run 28 called an empty product verified.
   */
  assert(observed.stopsWithRoutes !== undefined, "the map check did not run");
  assert(
    observed.stopsWithRoutes > 0,
    "not one stop in the viewport carries a service, so no board in this area can have a row",
  );
  return `${observed.stopsWithRoutes} of the returned stops have a service`;
});

await check("route detail answers without the Worker falling over", async () => {
  /*
   * The endpoint most likely to be the next isolate failure: it reads every tile a service
   * touches, which for a long route is many. A 500 here is the specific thing being watched for,
   * so a route with no data is reported differently from a route that killed the request.
   */
  const first = observed.routes?.[0];
  if (!first?.id) {
    /*
     * No service calls at the stop this run happened to pick, which is a timetable-coverage fact
     * and not a failure of the endpoint. What must still be true is that asking for a route the
     * network does not have is answered rather than crashed.
     */
    const { response, body, text } = await getJson("/v1/routes/does-not-exist");
    assert(
      response.status !== 500,
      `the Worker failed on an unknown route: ${describe(response, body, text)}`,
    );
    assert(
      response.status === 404 || response.status === 400 || response.status === 503,
      `an unknown route should be refused, got ${describe(response, body, text)}`,
    );
    return `no service calls at ${observed.stop?.name ?? "the sampled stop"}; an unknown route answered ${response.status}`;
  }
  const { response, body, text } = await getJson(`/v1/routes/${encodeURIComponent(first.id)}`);
  assert(response.status !== 500, `the Worker failed: ${describe(response, body, text)}`);
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const route = body?.data?.route ?? body?.data?.service;
  assert(route, "the route response has no route");
  return `${first.publicName ?? first.id} answered ${response.status}`;
});

await check("a journey can be planned across real timetable data", async () => {
  /*
   * A journey a person would actually make, not two points a diagonal kilometre apart.
   *
   * The old version took whichever stop the viewport happened to return and added 0.012 degrees
   * to both coordinates, which lands in a field as often as not — so "0 options" told you
   * nothing and was accepted as a pass. Leeds city centre to Leeds Bradford Airport is a route
   * the network genuinely serves, all day, every day, by several operators. If that cannot be
   * planned, the planner does not work.
   */
  const from = { lat: 53.7965, lon: -1.5479 };
  const to = { lat: 53.8659, lon: -1.6606 };
  const { response, body, text } = await getJson(
    `/v1/journeys?fromLat=${from.lat}&fromLon=${from.lon}&toLat=${to.lat}&toLon=${to.lon}`,
  );
  assert(response.status !== 500, `the Worker failed: ${describe(response, body, text)}`);
  assert(response.ok, `expected an answer, got ${describe(response, body, text)}`);
  const options = body?.data?.options ?? [];
  /*
   * `unavailableReason` is what the endpoint actually sends. This read `data.reason`, which does
   * not exist, so a failing run reported "reason: none" and threw away the one sentence the API
   * had written to explain itself — a check unable to see the thing it was checking.
   *
   * `diagnostics` is the useful half: counts that separate an unwritten shard from a broken
   * pattern join from a search that genuinely found no path.
   */
  const unavailable = body?.data?.unavailableReason ?? body?.error?.code ?? "none";
  const diagnostics = body?.data?.diagnostics ?? null;
  const explained = diagnostics
    ? `${diagnostics.code}: ${diagnostics.corridorTiles} corridor tile(s), ` +
      `windows [${diagnostics.windows.join(",")}], ${diagnostics.shardsRead} shard(s) read and ` +
      `${diagnostics.shardsMissing} missing, ${diagnostics.tripsLoaded} trip(s) loaded ` +
      `(${diagnostics.tripsWithPattern} matched a pattern, ${diagnostics.tripsWithoutPattern} did not), ` +
      `${diagnostics.tripsInGraph} in the graph over ${diagnostics.stopsInGraph} stop(s); ` +
      `slice held ${diagnostics.patternsInSlice} pattern(s) and ${diagnostics.stopsInSlice} stop(s)` +
      (diagnostics.failures.length > 0
        ? `; failures: ${diagnostics.failures.map((f) => `${f.dataset} (${f.reason})`).join(", ")}`
        : "")
    : "no diagnostics in the response";

  if (SERVICE_HOURS.daytime) {
    assert(
      options.length > 0,
      `Leeds to Leeds Bradford Airport gave no option at ${SERVICE_HOURS.hour}:00 ` +
        `${SERVICE_HOURS.weekday} London time — ${unavailable} — ${explained}`,
    );
  }

  /*
   * A plan must never be built on part of its corridor and presented as whole. A shard that could
   * not be read is a fault on our side, and saying "no journey found" for it is the same lie the
   * departure board used to tell.
   */
  assert(
    !diagnostics || diagnostics.failures.length === 0,
    `the corridor could not be fully read: ${explained}`,
  );
  /*
   * And the option has to be a journey rather than a shape that satisfies the schema.
   *
   * "At least one option" was the bar while there were none at all. It is the wrong bar now: a
   * planner reading a corrupt timetable can return a confident itinerary made of legs that do not
   * join up, and a count of one would pass it. So every leg is checked for the things a passenger
   * reads off it — where it starts, where it ends, when, on what — and the legs are checked
   * against each other for the thing a passenger relies on: that you are never asked to be in two
   * places at once.
   */
  for (const option of options) {
    const legs = option.legs ?? [];
    assert(legs.length > 0, "an option has no legs");

    let previousArrival = null;
    for (const [index, leg] of legs.entries()) {
      const at = `leg ${index + 1} of ${legs.length}`;
      assert(["walk", "bus", "coach", "tram"].includes(leg.mode), `${at} has mode "${leg.mode}"`);
      assert(
        Number.isFinite(leg.fromCoordinate?.lat) && Number.isFinite(leg.toCoordinate?.lat),
        `${at} does not say where it goes`,
      );

      const departs = Date.parse(leg.departAtExpected ?? "");
      const arrives = Date.parse(leg.arriveAtExpected ?? "");
      assert(Number.isFinite(departs) && Number.isFinite(arrives), `${at} has unreadable times`);
      assert(arrives >= departs, `${at} arrives before it departs`);

      const minutes = (arrives - departs) / 60_000;
      if (leg.mode === "walk") {
        // A walking leg the planner would actually offer: it caps access walks at 1200m, which is
        // a good deal less than an hour at any pace.
        assert(minutes <= 60, `${at} is a ${Math.round(minutes)}-minute walk`);
      } else {
        // A bus leg is a real vehicle on a real pattern, not an abstract hop between points.
        assert(leg.routePatternId, `${at} is a ${leg.mode} leg on no route`);
        assert(leg.fromStopId && leg.toStopId, `${at} is a ${leg.mode} leg not between two stops`);
        assert(minutes <= 240, `${at} is a ${Math.round(minutes)}-minute bus ride`);
      }

      // The transfer: you cannot board a bus before the one before it has put you down.
      assert(
        previousArrival === null || departs >= previousArrival,
        `${at} departs before the previous leg arrives — the legs do not join up`,
      );
      previousArrival = arrives;
    }

    const rides = legs.filter((leg) => leg.mode !== "walk").length;
    assert(rides > 0, "an option is entirely walking, which is not a bus journey");
    assert(
      option.changeCount === Math.max(0, rides - 1),
      `an option claims ${option.changeCount} changes across ${rides} ride(s)`,
    );
  }

  const best = options[0];
  const summary = best
    ? `: ${best.legs.length} legs (${best.legs.map((leg) => leg.mode).join(" → ")}), ` +
      `${best.changeCount} change(s), ${Math.round((best.totalWalkSeconds ?? 0) / 60)} min walking`
    : "";

  return (
    `Leeds → Leeds Bradford Airport: ${options.length} option(s)${summary} [${explained}]` +
    (SERVICE_HOURS.daytime ? "" : " (outside service hours: options not required)")
  );
});

await check("the source health endpoint reports on real sources", async () => {
  const { response, body } = await getJson("/v1/sources/health");
  assert(response.ok, `expected 2xx, got ${response.status}`);
  const sources = body?.data?.sources ?? [];
  assert(sources.length > 0, "no sources reported");
  return `${sources.length} sources, governor ${body.meta.governorState}`;
});

await check("Pro is reachable with no credential and states its data mode", async () => {
  const { response, body } = await getJson("/v1/pro/control-tower");
  assert(response.ok, `expected 2xx, got ${response.status}`);
  assert(!response.headers.get("www-authenticate"), "Pro demanded authentication");
  const mode = body?.data?.provenance?.dataMode;
  assert(
    ["live", "demo_snapshot", "unavailable"].includes(mode),
    "Pro did not state its data mode",
  );
  observed.proDataMode = mode;
  return `data mode ${mode}`;
});

if (siteUrl) {
  await check("the app is compiled against this API, not a relative /api", async () => {
    const response = await fetch(siteUrl, { signal: AbortSignal.timeout(20_000) });
    assert(response.ok, `expected 2xx, got ${response.status}`);
    const html = await response.text();
    const script = html.match(/src="(\/assets\/[^"]+\.js)"/);
    assert(script, "no bundle script tag found in the app shell");
    const bundle = await fetch(`${siteUrl}${script[1]}`, { signal: AbortSignal.timeout(30_000) });
    const code = await bundle.text();
    assert(
      code.includes(apiUrl),
      `the bundle does not contain ${apiUrl}, so VITE_API_URL was not baked in and every API ` +
        `call would resolve against the Pages origin`,
    );
    return `${script[1]} names the Worker origin`;
  });

  await check("the served CSP permits exactly this API origin", async () => {
    const response = await fetch(siteUrl, { signal: AbortSignal.timeout(20_000) });
    const csp = response.headers.get("content-security-policy");
    assert(csp, "no Content-Security-Policy header is served");
    const connect = csp.split(";").find((directive) => directive.trim().startsWith("connect-src"));
    assert(connect, "the CSP has no connect-src, so the default-src fallback would block the API");
    assert(connect.includes(apiUrl), `connect-src does not name ${apiUrl}: ${connect.trim()}`);
    assert(!connect.includes("*"), `connect-src is wildcarded: ${connect.trim()}`);
    return connect.trim();
  });

  await check("the API accepts a cross-origin request from the app", async () => {
    const response = await fetch(`${apiUrl}/v1/sources/health`, {
      headers: { Origin: siteUrl },
      signal: AbortSignal.timeout(20_000),
    });
    const allowed = response.headers.get("access-control-allow-origin");
    assert(
      allowed === siteUrl || allowed === "*",
      `the Worker does not allow ${siteUrl} (Access-Control-Allow-Origin: ${allowed ?? "absent"}), ` +
        `so the browser would refuse every response`,
    );
    return `Access-Control-Allow-Origin: ${allowed}`;
  });
}

for (const result of results) {
  console.log(
    `${result.ok ? "  pass" : "  FAIL"}  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`,
  );
}

console.log(
  failures === 0
    ? `\nDeployment verified: ${results.length} checks against real data at ${apiUrl}.`
    : `\nVerification FAILED: ${failures} of ${results.length} checks failed against ${apiUrl}.`,
);

process.exit(failures === 0 ? 0 : 1);
