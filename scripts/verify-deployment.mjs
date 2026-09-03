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
  return `${stops.length} stops, first: ${stops[0].name}`;
});

await check("a stop can be selected and returns a departure board", async () => {
  assert(observed.stop, "no stop was found by the previous check");
  const { response, body, text } = await getJson(
    `/v1/stops/${encodeURIComponent(observed.stop.id)}`,
  );
  assert(response.ok, `expected 2xx, got ${describe(response, body, text)}`);
  const stop = body?.data?.stop;
  assert(stop, "the stop response has no stop");
  assert(stop.id === observed.stop.id, "a different stop came back than the one requested");
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
  return `${stop.name}: ${departures.length} departures, ${body.meta.degradation}`;
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
