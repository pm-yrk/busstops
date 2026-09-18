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

/** What an isolate was holding either side of one request, when the endpoint reports it. */
function describeResidency(residency) {
  if (!residency) return "";
  return (
    `, isolate req#${residency.requestsServed}: held ${residency.shardsBefore} shard(s)/` +
    `${(residency.charsBefore / 1048576).toFixed(2)} MiB/${residency.recordsBefore} record(s), ` +
    `trimmed ${residency.evicted}, left ${residency.shardsAfter} shard(s)/` +
    `${(residency.charsAfter / 1048576).toFixed(2)} MiB/${residency.recordsAfter} record(s)` +
    `, national ${Object.entries(residency.singletons ?? {})
      .map(([name, count]) => `${name}=${count}`)
      .join("/")}`
  );
}

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

/**
 * What the server actually said, reduced to the part that identifies the failure.
 *
 * When the platform answers instead of the Worker it sends a Cloudflare error page, and the first
 * three hundred characters of that page are Internet Explorer conditional comments. Reporting
 * those was worse than reporting nothing: three separate 503s in run 37 were indistinguishable
 * from each other, and none of them named the limit that had been hit — which is the only fact
 * that decides whether the cause is memory, CPU, subrequests or a thrown exception.
 *
 * Cloudflare puts the code in a `cf-error-code` element and repeats it as "Error 1102" in the
 * prose, with a one-line summary in the `<title>`. Those, plus the ray id, are the diagnosis.
 */
function describe(response, body, text) {
  const fromWorker = body?.error?.message ?? body?.error?.code;
  if (fromWorker) return `${response.status}: ${fromWorker}`;
  return `${response.status}${describePlatformPage(response, text)}`;
}

/** The identifying parts of a Cloudflare error page, or the plain text when it is not one. */
function describePlatformPage(response, text) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const ray = response.headers.get("cf-ray");
  const suffix = ray ? ` [cf-ray ${ray}]` : "";

  if (!/<html/i.test(flat)) return `: ${flat.slice(0, 300)}${suffix}`;

  const parts = [];
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(flat)?.[1]?.trim();
  if (title) parts.push(title);

  // "Error 1102" in the prose, and the same number in Cloudflare's own error-code element.
  const codes = new Set();
  for (const match of flat.matchAll(/\berror\s*(?:code[: ]*)?(\d{4})\b/gi)) codes.add(match[1]);
  for (const match of flat.matchAll(/class="[^"]*cf-error-code[^"]*"[^>]*>\s*(\d{4})/gi)) {
    codes.add(match[1]);
  }
  if (codes.size > 0) parts.push(`Cloudflare error ${[...codes].join("/")}`);

  // The human sentence, e.g. "Worker exceeded resource limits". `cf-error-type` is not it: that
  // span holds the literal word "Error", which adds nothing to a line that already says 503.
  const reason = /class="[^"]*cf-subheadline[^"]*"[^>]*>\s*([^<]+)</i.exec(flat)?.[1]?.trim();
  if (reason) parts.push(reason);
  for (const phrase of [
    "Worker exceeded resource limits",
    "Worker threw exception",
    "Exceeded CPU",
    "Exceeded Memory",
    "too many subrequests",
    "Script startup exceeded",
  ]) {
    if (flat.toLowerCase().includes(phrase.toLowerCase())) parts.push(phrase);
  }

  const unique = [...new Set(parts)];
  if (unique.length === 0) return `: an HTML page with no error code in it${suffix}`;
  return `: ${unique.join(" — ")}${suffix}`;
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
  observed.mapDegraded = body?.data?.degraded === true;
  observed.mapDegradationReason = body?.data?.degradationReason ?? null;
  return (
    `${stops.length} stops, first: ${stops[0].name}` +
    (observed.mapDegraded ? ` (degraded: ${observed.mapDegradationReason})` : "")
  );
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
   * What may appear in the route badge.
   *
   * The first version of this demanded a designation like 36, X84 or 1A. That is what most rows
   * are, and it caught a real bug on the first run — York Rail Station offering a bus called
   * `Golden_Tours_Hop_On_Hop_Off`, which is a GTFS route_id rendered as a service number. But it
   * is the wrong rule: England genuinely runs services whose only published name is a phrase, and
   * failing those would be the check disagreeing with the country.
   *
   * The invariant that is actually true is narrower and more useful. A passenger may be shown a
   * number or a name; they may never be shown an internal key. Underscores and colons are what
   * separates the two, and a length bound keeps a description out of a badge sized for three
   * characters.
   */
  assert(route.length > 0, `${city}: a departure at ${stopName} has no route name at all`);
  assert(
    !/[_:]/.test(route),
    `${city}: "${route}" at ${stopName} is an internal identifier, not a route a bus displays`,
  );
  assert(
    route.length <= 24,
    `${city}: "${route}" at ${stopName} is ${String(route.length)} characters — a description ` +
      `in the badge, not a route name`,
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

/*
 * Places, which is the search that could never work.
 *
 * "York Minster" matched nothing, because search knew about stops, routes and operators and a
 * minster is none of those. The gazetteer is what fixes that — and the check has to be for a real
 * landmark by its real name, because a special case for York Minster would pass a test written
 * against York Minster.
 *
 * Reported rather than asserted while the gazetteer may not have been extracted into this bucket
 * yet: an empty result says "no gazetteer here", which is a different fact from "place search is
 * broken", and the line says which.
 */
await check("search finds real places, not only bus stops", async () => {
  const wanted = [
    "York Minster",
    "Leeds Station",
    "Manchester Arndale",
    "Bullring",
    "Bristol Temple Meads",
  ];
  const found = [];
  const missed = [];

  for (const term of wanted) {
    const { response, body, text } = await getJson(`/v1/search?q=${encodeURIComponent(term)}`);
    assert(response.ok, `search for "${term}" gave ${describe(response, body, text)}`);
    const results = body?.data?.results ?? [];
    const place = results.find((result) => result.kind === "place");
    if (place) {
      /*
       * A place must be a place. Presenting one as a stop would send somebody to a departure
       * board for a cathedral, and claiming live coverage would put a live lozenge on a park.
       */
      assert(
        Number.isFinite(place.coordinate?.lat) && Number.isFinite(place.coordinate?.lon),
        `"${term}" returned a place with nowhere to go to`,
      );
      assert(
        place.hasLiveCoverage !== true,
        `"${term}" returned a place claiming live bus coverage of its own`,
      );
      found.push(`${term} → ${place.title}`);
    } else {
      missed.push(term);
    }
  }

  observed.placesFound = found.length;
  return found.length === 0
    ? `no gazetteer in this bucket yet: none of ${wanted.length} landmarks matched ` +
        "(run the preview with run_places to extract one)"
    : `${found.length} of ${wanted.length} landmarks found — ${found.join("; ")}` +
        (missed.length > 0 ? `; still missing: ${missed.join(", ")}` : "");
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

/*
 * What a map request that *survives* cost.
 *
 * Every 1102 is a request that could not report anything, so the evidence has to come from the
 * ones that finish. This prints it rather than asserting a threshold: nobody outside Cloudflare
 * knows where the line is, and a made-up limit here would fail runs for no reason.
 */
/*
 * London, which is a different product behind the same map.
 *
 * Outside London a bus is an observation: BODS publishes where the vehicle is, and the board is
 * composed from the timetable. Inside London it is the other way round — TfL publishes arrival
 * predictions per stop and does not publish vehicle positions at all — so the live vehicle layer
 * over London is empty by design, and the thing that has to work is the board.
 *
 * The home page has been claiming London coverage, and nothing here has ever checked it. These
 * two checks are what that claim has to rest on: a real 490 stop returning real TfL predictions,
 * and the map over London being honestly empty of vehicles rather than accidentally so.
 */
const LONDON_BBOX = "-0.14,51.49,-0.09,51.52";

await check("London stops come back from a London viewport", async () => {
  const { response, body, text } = await getJson(`/v1/map?bbox=${LONDON_BBOX}&zoom=15`);
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const stops = body?.data?.stops ?? [];
  assert(
    stops.length > 0,
    "the map returned zero stops over central London, which means NaPTAN's London stops are " +
      "missing from the published artifact — not that Westminster has no bus stops",
  );
  /*
   * The ATCO code, not the id.
   *
   * A map stop carries both, and `id` is the internal UUID — so this matched nothing over
   * Westminster and reported that the viewport was "not reaching TfL's stops", which was a
   * statement about this line rather than about the deployment.
   */
  const londonStops = stops.filter((stop) => /^(490|940)/.test(stop.atcoCode ?? ""));
  assert(
    londonStops.length > 0,
    `${stops.length} stops came back over central London and none of them carries a London ` +
      `ATCO prefix — the first is ${stops[0]?.atcoCode ?? "(none)"} — so the viewport is not ` +
      "reaching TfL's stops",
  );
  observed.londonStop =
    londonStops.find((stop) => (stop.routePublicNames ?? []).length > 0) ?? londonStops[0];

  /*
   * And the vehicle layer, which must be empty for the stated reason rather than by accident.
   *
   * A London-only viewport asks TfL and nothing else, so a vehicle here would mean the map had
   * invented one. What is required is that TfL is named as a source: an empty layer with no
   * source named would be indistinguishable from London simply not being wired up.
   */
  const vehicles = body?.data?.vehicles ?? [];
  const sources = (body?.meta?.sources ?? []).map((source) => source.source ?? source);
  assert(
    sources.includes("tfl"),
    `a London viewport reported sources [${sources.join(", ")}] and did not consult TfL`,
  );
  assert(
    vehicles.length === 0,
    `${vehicles.length} vehicle(s) came back over London, where TfL publishes no vehicle ` +
      "positions — so these were invented somewhere",
  );
  observed.londonVehicleLayerEmpty = true;
  return (
    `${stops.length} stop(s), ${londonStops.length} with a London ATCO; ` +
    `sources [${sources.join(", ")}]; vehicle layer empty, as TfL publishes no positions`
  );
});

await check("a London stop returns real TfL arrival predictions", async () => {
  assert(observed.londonStop, "no London stop was found by the previous check");
  const target = observed.londonStop;
  const { response, body, text } = await getJson(`/v1/stops/${encodeURIComponent(target.id)}`);
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const stop = body?.data?.stop;
  assert(stop, "the London stop response has no stop");
  const departures = body?.data?.departures ?? [];
  for (const departure of departures) {
    assert(departure.serviceRoutePublicName, "a London departure has no route name to display");
    assert(departure.destinationName, "a London departure has no destination to display");
  }
  /*
   * TfL's predictions are live, so in service hours a central London stop with a service has
   * something due. Out of hours the honest answer is an empty board, and asserting on it would
   * fail the run for the time of day rather than for the deployment.
   */
  const live = departures.filter((departure) => departure.liveState === "live").length;
  if (SERVICE_HOURS.daytime) {
    assert(
      departures.length > 0,
      `${stop.name} is a London stop with nothing due at ${SERVICE_HOURS.hour}:00 ` +
        `${SERVICE_HOURS.weekday} London time, so the TfL arrivals path is not working`,
    );
    assert(
      live > 0,
      `${stop.name} returned ${departures.length} departure(s) and none of them is live, ` +
        "so these are timetable rows rather than TfL predictions",
    );
  }
  observed.londonDepartures = departures.length;
  observed.londonLiveDepartures = live;
  return (
    `${stop.name} (${stop.id}): ${departures.length} departure(s), ${live} live from TfL` +
    (SERVICE_HOURS.daytime ? "" : " (outside service hours: departures not required)")
  );
});

await check("the map says what it cost", async () => {
  const { response, body, text } = await getJson(`/v1/map?bbox=${BBOX}&zoom=15`);
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const d = body?.meta?.diagnostics;
  assert(d, "the map response carries no diagnostics");
  assert(typeof body?.data?.degraded === "boolean", "the map does not say whether it is degraded");
  const stages = Object.entries(d.stages ?? {})
    .map(([stage, ms]) => `${stage}=${ms}ms`)
    .join(" ");
  return (
    `${d.elapsedMs}ms of a ${d.budgetMs}ms budget; ` +
    `${d.objectsRead} object(s) read, ${d.objectsCached} cached, ${d.objectsMissing} missing, ` +
    `${d.objectsFailed} failed; ${(d.chars / 1048576).toFixed(2)} MiB decoded; ` +
    `${d.records} record(s); ${stages}; ` +
    `degraded ${String(body.data.degraded)}${body.data.degradationReason ? ` (${body.data.degradationReason})` : ""}` +
    describeResidency(d.residency)
  );
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

  /*
   * A degraded map is allowed unlabelled stops; a confident one is not.
   *
   * Route names come from pattern tiles, the most expensive thing this endpoint reads, so they
   * are the half dropped when a request runs out of budget. That is a legitimate answer as long
   * as it is declared. What must never happen is a response claiming to be complete while
   * quietly reporting that every stop has no services — which is a claim about the timetable
   * rather than about this request.
   */
  if (observed.mapDegraded) {
    return (
      `enrichment was skipped (${observed.mapDegradationReason}), so ` +
      `${observed.stopsWithRoutes} of the returned stops carry a service`
    );
  }
  assert(
    observed.stopsWithRoutes > 0,
    "not one stop in the viewport carries a service, and the map did not say it was degraded",
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

/*
 * The two endpoints that fell over, asked repeatedly in the densest places.
 *
 * `/v1/map` and `/v1/routes/:id` are the only two that read pattern tiles in bulk, and both
 * answered Cloudflare's own HTML 503 on two consecutive deployments — desktop one time, tablet the
 * next. A single sample per run is how that hid: it appeared in the visual pass and not in the
 * verification, or the other way round. So each city is asked several times, because the failure
 * is intermittent and one success proves very little about it.
 *
 * A Worker past its resource limit is answered by the platform, whose page is HTML and carries no
 * CORS header — which is why a browser reported it as a CORS failure rather than a server error.
 * That is what the HTML check below is looking for.
 */
await check("the pattern-heavy endpoints survive dense cities, repeatedly", async () => {
  /*
   * Five cities, five times each: twenty-five dense map requests in one run.
   *
   * One request proves nothing here. The failure was never deterministic — the same URL returned
   * 400 stops at one check and Cloudflare's error page at the next, because what killed the
   * isolate was what the *previous* requests had left in it. A count this size is what makes
   * "survives" a claim rather than a hope.
   */
  const ATTEMPTS_PER_CITY = 5;
  const lines = [];
  let platformErrors = 0;
  let mapRequests = 0;
  let degradedResponses = 0;
  let peakChars = 0;
  let peakObjects = 0;
  let peakMs = 0;
  let routeRequests = 0;
  let routePeakChars = 0;
  let routePeakObjects = 0;
  let routePeakMs = 0;
  let routeWorstMs = -1;
  let routeWorst = "no route detail was sampled";
  /*
   * What every route request cost, kept as it happens.
   *
   * Run 43 died on attempt five. The four before it answered, and each carried a full stage
   * breakdown — and every one of them was thrown away, because `assert` throws and the check's
   * summary is only built if it returns. The request that gets killed can never report anything,
   * so the ones that live are the only evidence there is, and they have to survive the failure.
   */
  const routeTrail = [];
  const trail = () =>
    routeTrail.length === 0
      ? ""
      : ` — what the requests before it cost: ${routeTrail.slice(-6).join(" | ")}`;

  /*
   * And it has to survive a throw that is not an assertion, too.
   *
   * Run 47 failed here with "The operation was aborted due to timeout" and nothing else: the
   * fetch's own abort escaped the loop before any assertion ran, taking the whole trail with it.
   * A request that is slow enough to abort is exactly the case the trail exists to describe, so
   * the loop is wrapped and any escape is re-thrown carrying what the requests before it cost.
   */
  try {
    await sweepCities();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.includes("what the requests before it cost") ? message : message + trail(),
    );
  }

  async function sweepCities() {
    for (const city of CITIES) {
      let mapOk = 0;
      let routeOk = 0;
      let routeComplete = 0;
      let routeIncomplete = 0;
      let sampledRoute = null;

      for (let attempt = 0; attempt < ATTEMPTS_PER_CITY; attempt += 1) {
        const map = await getJson(`/v1/map?bbox=${city.bbox}&zoom=15`);
        // An HTML body from an API is the platform speaking, not the Worker.
        const html = map.text.trimStart().toLowerCase().startsWith("<!doctype");
        if (html || map.response.status === 503) platformErrors += 1;
        assert(
          !html,
          `${city.name}: /v1/map answered the platform's error page, not the Worker ` +
            `(${map.response.status}${describePlatformPage(map.response, map.text)}) on attempt ` +
            `${String(attempt + 1)}${trail()}`,
        );
        assert(map.response.ok, `${city.name}: /v1/map gave ${map.response.status}`);
        mapOk += 1;
        mapRequests += 1;

        /*
         * The core of the map is not optional, whatever happened to the enrichment.
         *
         * Stops and live vehicles are read first and are never skipped; route names run on what
         * time is left. So a degraded answer must still be a real map — and it must say it is
         * degraded rather than implying those stops have no services.
         */
        const data = map.body?.data;
        assert(
          Array.isArray(data?.stops) && data.stops.length > 0,
          `${city.name}: /v1/map returned no stops on attempt ${String(attempt + 1)}`,
        );
        assert(
          Array.isArray(data?.vehicles),
          `${city.name}: /v1/map returned no vehicles array on attempt ${String(attempt + 1)}`,
        );
        assert(
          typeof data?.degraded === "boolean",
          `${city.name}: /v1/map does not say whether it is degraded`,
        );
        if (data.degraded) {
          degradedResponses += 1;
          assert(
            typeof data.degradationReason === "string" && data.degradationReason.length > 0,
            `${city.name}: /v1/map says it is degraded and will not say why`,
          );
        } else {
          // Not degraded means the enrichment finished, so the stops must actually carry it.
          const named = data.stops.filter((stop) => (stop.routePublicNames ?? []).length > 0);
          assert(
            named.length > 0,
            `${city.name}: /v1/map claims it is not degraded and yet no stop carries a service`,
          );
        }

        const diagnostics = map.body?.meta?.diagnostics;
        assert(diagnostics, `${city.name}: /v1/map carries no diagnostics`);
        assert(
          diagnostics.objectsRequested > 0,
          `${city.name}: /v1/map says it requested no objects, which cannot be true`,
        );
        peakChars = Math.max(peakChars, diagnostics.chars ?? 0);
        peakObjects = Math.max(peakObjects, diagnostics.objectsRequested ?? 0);
        peakMs = Math.max(peakMs, diagnostics.elapsedMs ?? 0);

        // Routes that genuinely call in this city, taken from a stop the map just returned.
        const stop = (map.body?.data?.stops ?? [])[0];
        if (!stop) continue;
        const board = await getJson(`/v1/stops/${encodeURIComponent(stop.id)}`);
        /*
         * More than one route per attempt, and different ones.
         *
         * The loop used to take the first route of the first stop every time, so five attempts in
         * Leeds were five requests for the same route and the fifth was answered from a warm cache.
         * The failure being hunted is what a *sequence of different* route pages leaves in an
         * isolate, so the sample has to move.
         */
        const routes = (board.body?.data?.routes ?? []).filter((candidate) => candidate?.id);
        if (routes.length === 0) continue;
        const chosen = [routes[attempt % routes.length], routes[(attempt + 1) % routes.length]]
          .filter(Boolean)
          .filter((candidate, at, all) => all.findIndex((r) => r.id === candidate.id) === at);

        for (const route of chosen) {
          sampledRoute = route.publicName ?? route.id;

          const detail = await getJson(`/v1/routes/${encodeURIComponent(route.id)}`);
          routeRequests += 1;
          const detailHtml = detail.text.trimStart().toLowerCase().startsWith("<!doctype");
          if (detailHtml || detail.response.status === 503) platformErrors += 1;
          assert(
            !detailHtml,
            `${city.name}: /v1/routes/${route.id} answered the platform's error page, not the ` +
              `Worker (${detail.response.status}${describePlatformPage(detail.response, detail.text)}) ` +
              `on attempt ${String(attempt + 1)}${trail()}`,
          );
          assert(
            detail.response.ok,
            `${city.name}: route detail gave ${describe(detail.response, detail.body, detail.text)}`,
          );
          routeOk += 1;

          /*
           * What the route page actually cost, by stage.
           *
           * Run 42 had the pattern read measured and route detail still died, so the rest of the
           * handler is on the ledger now: the index, services, operators, stop resolution, the live
           * feed. This is the line that says which of them is expensive, rather than leaving it to
           * be guessed at from the outside.
           */
          const routeDiagnostics = detail.body?.meta?.diagnostics;
          assert(routeDiagnostics, `${city.name}: route detail carries no diagnostics${trail()}`);
          routeTrail.push(
            `${city.name}#${String(attempt + 1)} ${sampledRoute}: ` +
              `${String(routeDiagnostics.elapsedMs ?? 0)}ms, ` +
              `${String(routeDiagnostics.objectsRequested ?? 0)} req/${String(routeDiagnostics.objectsRead ?? 0)} read/` +
              `${String(routeDiagnostics.objectsCached ?? 0)} cached, ` +
              `${((routeDiagnostics.chars ?? 0) / 1048576).toFixed(2)} MiB, ` +
              `${String(routeDiagnostics.stopTilesRequested ?? 0)} tile(s), ` +
              `${String(routeDiagnostics.stopsResolved ?? 0)}/${String(routeDiagnostics.stopsRequested ?? 0)} stop(s), ` +
              Object.entries(routeDiagnostics.stages ?? {})
                .map(([stage, ms]) => `${stage}=${ms}ms`)
                .join(" ") +
              /*
               * What the isolate was already holding, which is the half of the question that four
               * runs of diagnostics could not answer.
               *
               * Run 45 answered six of these requests in 300–900ms, reading two or three mebibytes
               * apiece, and the platform killed the seventh. On the per-request numbers alone
               * "these requests are cheap" and "this isolate is full" are the same reading. This is
               * the line that separates them: if the trail shows residency climbing request by
               * request and the kill arrives at the top of it, that is a memory ceiling; if it
               * shows the same figures throughout, it is not.
               */
              /*
               * And where the live stage's own time went. It is the largest stage in every trail
               * and every 1102 has followed the largest one in its own; fetch and parse apart is
               * what says whether that is the network or the isolate's CPU.
               */
              (routeDiagnostics.liveSources ?? [])
                .map(
                  (entry) =>
                    `, ${entry.source} fetch=${entry.fetchMs ?? "?"}ms ` +
                    `parse=${entry.parseMs ?? "?"}ms ` +
                    `${((entry.chars ?? 0) / 1048576).toFixed(2)} MiB → ${entry.accepted} accepted`,
                )
                .join("") +
              describeResidency(routeDiagnostics.residency),
          );
          routePeakMs = Math.max(routePeakMs, routeDiagnostics.elapsedMs ?? 0);
          routePeakChars = Math.max(routePeakChars, routeDiagnostics.chars ?? 0);
          routePeakObjects = Math.max(routePeakObjects, routeDiagnostics.objectsRequested ?? 0);
          if ((routeDiagnostics.elapsedMs ?? 0) >= routeWorstMs) {
            routeWorstMs = routeDiagnostics.elapsedMs ?? 0;
            routeWorst =
              `${city.name} ${sampledRoute}: ` +
              Object.entries(routeDiagnostics.stages ?? {})
                .map(([stage, ms]) => `${stage}=${ms}ms`)
                .join(" ") +
              `; ${String(routeDiagnostics.objectsRequested ?? 0)} object(s), ` +
              `${((routeDiagnostics.chars ?? 0) / 1048576).toFixed(2)} MiB, ` +
              `${String(routeDiagnostics.stopTilesRequested ?? 0)} stop tile(s), ` +
              `${String(routeDiagnostics.stopsResolved ?? 0)}/${String(routeDiagnostics.stopsRequested ?? 0)} stop(s)` +
              (routeDiagnostics.liveLookupSkipped ? ", live skipped" : "") +
              (routeDiagnostics.liveBoxCapped ? ", live area capped" : "");
          }

          /*
           * Completeness is a fact about the answer, not a confidence score. A capped read must say
           * so; what must never happen is a truncated variant list presented as the route's extent.
           */
          const complete = detail.body?.data?.complete;
          const coverage = detail.body?.meta?.coverage;
          if (complete === false) {
            routeIncomplete += 1;
            assert(
              coverage === 0,
              `${city.name}: route detail says it is incomplete but reports coverage ${String(coverage)}`,
            );
          } else if (complete === true) {
            routeComplete += 1;
            /*
             * And a complete route has to be a route. `complete: true` with no stops on it would be
             * the same wrong answer the flag exists to prevent, arrived at from the other side.
             */
            const variants = detail.body?.data?.variants ?? [];
            const stops = variants.reduce(
              (total, variant) => total + (variant.stops?.length ?? 0),
              0,
            );
            assert(
              stops > 0,
              `${city.name}: route ${sampledRoute} calls itself complete and lists no stops`,
            );
          }
        }
      }

      lines.push(
        `${city.name}: map ${mapOk}/${ATTEMPTS_PER_CITY}, route ${routeOk}` +
          (sampledRoute ? ` (${sampledRoute})` : "") +
          `, complete ${routeComplete}, incomplete ${routeIncomplete}`,
      );
    }
  }

  assert(platformErrors === 0, `${String(platformErrors)} platform error page(s) were returned`);
  assert(
    mapRequests >= 20,
    `only ${String(mapRequests)} dense map requests were made; twenty is the bar`,
  );
  assert(
    routeRequests >= 20,
    `only ${String(routeRequests)} route-detail requests were made; twenty is the bar`,
  );
  return (
    `${String(mapRequests)} dense map requests and ${String(routeRequests)} route-detail ` +
    `requests, no platform error pages; ${String(degradedResponses)} maps answered degraded; ` +
    `map peak ${String(peakObjects)} object(s), ${(peakChars / 1048576).toFixed(2)} MiB decoded, ` +
    `${String(peakMs)}ms; route peak ${String(routePeakObjects)} object(s), ` +
    `${(routePeakChars / 1048576).toFixed(2)} MiB decoded, ${String(routePeakMs)}ms. ` +
    `Slowest route page — ${routeWorst}. ` +
    lines.join("; ")
  );
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
  /*
   * The platform's error page first, by name.
   *
   * A journey that ends in error 1102 is the Worker being killed, and it arrives as HTML with no
   * CORS header on it — which a browser reports as a CORS failure and a check that only looked at
   * the status reported as "expected an answer, got 503". Saying which is which is the difference
   * between a lead and a shrug.
   */
  const isHtml = text.trimStart().toLowerCase().startsWith("<!doctype") || /<html/i.test(text);
  assert(
    !isHtml,
    `the platform answered instead of the Worker: ${response.status}` +
      describePlatformPage(response, text),
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
  // The planner's own counts live under data; the read ledger's live under meta, and the two
  // together are what distinguish a missing row from an exhausted budget.
  const meta = body?.meta ?? null;
  const explained = diagnostics
    ? `${diagnostics.code}: ${diagnostics.corridorTiles} corridor tile(s), ` +
      `windows [${diagnostics.windows.join(",")}], ` +
      `${diagnostics.shardsRead} of ${diagnostics.shardsRequested ?? "?"} shard(s) read, ` +
      `${diagnostics.shardsMissing} missing, ${diagnostics.shardsSkipped ?? 0} left unopened, ` +
      `${diagnostics.tripsFiltered ?? 0} row(s) dropped while parsing, ` +
      `${diagnostics.tripsLoaded} trip(s) loaded ` +
      `(${diagnostics.tripsWithPattern} matched a pattern, ${diagnostics.tripsWithoutPattern} did not), ` +
      `${diagnostics.tripsInGraph} in the graph over ${diagnostics.stopsInGraph} stop(s) ` +
      `and ${diagnostics.transferEdges} transfer edge(s); ` +
      `${diagnostics.originCandidates} origin and ${diagnostics.destinationCandidates} destination ` +
      `candidate stop(s); ${diagnostics.roundsWithOption} of ${diagnostics.rounds} round(s) found ` +
      `an itinerary; slice held ${diagnostics.patternsInSlice} pattern(s) and ` +
      `${diagnostics.stopsInSlice} stop(s)` +
      /*
       * How many patterns the trips named, against how many were resolved.
       *
       * Run 45 refused this journey with `incomplete_read` after resolving 108 patterns in
       * 4,184ms, and the line printed neither how many it had been asked for nor the ledger's own
       * reason for stopping — so "the index is missing rows" and "the budget ran out part way
       * through three hundred round trips" read identically. They are different defects with
       * different fixes.
       */
      (typeof diagnostics.patternsRequested === "number"
        ? `; ${diagnostics.patternsInSlice} of ${diagnostics.patternsRequested} pattern(s) resolved`
        : "") +
      (meta?.diagnostics?.patternSource
        ? `; patterns from the ${meta.diagnostics.patternSource} ` +
          `(${meta.diagnostics.corridorPatternTiles} corridor pattern tile(s))`
        : "") +
      (meta?.diagnostics?.degradationReason
        ? `; the read stopped itself: ${meta.diagnostics.degradationReason}`
        : "") +
      (meta?.diagnostics?.families?.patterns
        ? `; pattern index ${meta.diagnostics.families.patterns.read} read/` +
          `${meta.diagnostics.families.patterns.missing} missing, ` +
          // The bytes, which is what actually ended run 46's read: 92 buckets spent the whole
          // twelve-mebibyte request budget, and the summed milliseconds hid that behind latency.
          `${(meta.diagnostics.families.patterns.chars / 1048576).toFixed(2)} MiB, in ` +
          `${meta.diagnostics.families.patterns.ms}ms of summed read time`
        : "") +
      // Where the time actually went, which is the whole point of asking after a 1102.
      (diagnostics.stageMs
        ? `; stages ${Object.entries(diagnostics.stageMs)
            .map(([stage, ms]) => `${stage}=${ms}ms`)
            .join(" ")}` +
          (typeof diagnostics.tripChars === "number"
            ? `; ${(diagnostics.tripChars / 1048576).toFixed(2)} MiB of trip text decoded` +
              (typeof diagnostics.tripCharBudget === "number"
                ? ` of a ${(diagnostics.tripCharBudget / 1048576).toFixed(0)} MiB budget`
                : "")
            : "")
        : "") +
      (diagnostics.failures.length > 0
        ? `; failures: ${diagnostics.failures.map((f) => `${f.dataset} (${f.reason})`).join(", ")}`
        : "")
    : "no diagnostics in the response";

  /*
   * A corridor read short is a distinct failure with a distinct fix, and it is named.
   *
   * The planner refuses rather than offering a plan built on part of the timetable, which is the
   * right behaviour — but it is not a passing run. Reporting it as "gave no option" would send
   * the next person looking at the search when the answer is in the read budget.
   */
  assert(
    !diagnostics || diagnostics.code !== "incomplete_read",
    `the corridor was not read in full, so the planner refused: ${explained}`,
  );

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
        assert(leg.routeId, `${at} is a ${leg.mode} leg with no service identity`);
        assert(leg.routeName, `${at} is a ${leg.mode} leg with no route number on it`);
        assert(leg.fromStopId && leg.toStopId, `${at} is a ${leg.mode} leg not between two stops`);
        assert(minutes <= 240, `${at} is a ${Math.round(minutes)}-minute bus ride`);
      }

      // The transfer: you cannot board a bus before the one before it has put you down.
      assert(
        previousArrival === null || departs >= previousArrival,
        `${at} departs before the previous leg arrives — the legs do not join up`,
      );
      // And you cannot board it somewhere you were never taken to.
      const previousTo = index > 0 ? legs[index - 1].toStopId : null;
      assert(
        !previousTo || !leg.fromStopId || previousTo === leg.fromStopId,
        `${at} does not start where the previous leg ended`,
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

  /*
   * What the mode actually means, in the response's own numbers.
   *
   * "data mode live" on its own is not evidence of anything: a run with four observations
   * publishes a manifest and suppresses every figure for want of a denominator, which is the
   * designed and honest behaviour — and reads identically to a healthy one in a one-word summary.
   * So the line says how many headline metrics carry a value, out of how many, and over what
   * total denominator.
   */
  const headline = body?.data?.headline ?? [];
  const withValue = headline.filter((metric) => metric?.value !== null && !metric?.suppressed);
  const denominator = headline.reduce((total, metric) => total + (metric?.denominator ?? 0), 0);

  /*
   * A demonstration snapshot has to be dated. It is the one mode that is not a claim about now,
   * and an undated one presented beside live figures is the confusion the mode exists to prevent.
   */
  if (mode === "demo_snapshot") {
    assert(
      typeof body?.data?.provenance?.snapshotDate === "string",
      "Pro is serving a demonstration snapshot and will not say which one",
    );
  }

  observed.proHeadlineWithValue = withValue.length;
  return (
    `data mode ${mode}` +
    (mode === "demo_snapshot" ? ` (${body.data.provenance.snapshotDate})` : "") +
    `; ${withValue.length} of ${headline.length} headline metric(s) carry a figure ` +
    `over ${denominator} observation(s)` +
    (mode === "live" && withValue.length === 0
      ? " — live, and not yet enough observations to publish a single figure"
      : "")
  );
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
