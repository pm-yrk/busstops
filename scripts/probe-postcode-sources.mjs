/**
 * Can a passenger search by postcode without the project ever paying for anything?
 *
 * "LS1 4DY" is how a lot of people would start, and it currently matches nothing: the search
 * index holds stops, routes, operators and an OpenStreetMap gazetteer, and none of those is a
 * postcode. The rule is that a paid API dependency is not allowed, so the question is not "which
 * geocoder" but "is there an open, licence-clean, credential-free dataset we can hold ourselves".
 *
 * This asks the candidates directly from a runner and reports what came back. It downloads
 * nothing large — metadata, HEADs and short byte ranges only — because the point is to find out
 * whether a source is reachable, free, open-licensed and shaped usefully before any pipeline is
 * written for it. It asserts nothing and cannot fail a run.
 *
 * The candidates, and what each would cost us:
 *
 *   ONSPD / NSPL (ONS, Open Government Licence) — every UK unit postcode with a WGS84 lat/long
 *     already computed. Quarterly CSV inside a zip. No credential. The one that needs no
 *     coordinate conversion.
 *   Code-Point Open (Ordnance Survey, OGL with an attribution string) — every GB unit postcode as
 *     eastings/northings, so it would need an OSGB36 → WGS84 transform. The OS Downloads API
 *     serves open products without a key.
 *   postcodes.io — free, no key, OGL data. Listed for completeness and *not* a candidate for the
 *     request path: a live third-party lookup on every search is an uncapped external dependency
 *     on somebody else's volunteer hosting, which is the thing the £0 rule exists to avoid.
 *
 * What we would actually publish is a derived index, not the source: England's postcodes, bucketed
 * by outward code the way services are bucketed by id, so a search reads one small object.
 *
 *   node scripts/probe-postcode-sources.mjs
 */

import { annotate } from "./annotate.mjs";

const TIMEOUT_MS = 30_000;

async function ask(url, { method = "GET", range = null, accept = null } = {}) {
  const began = Date.now();
  const headers = { "user-agent": "busstops-postcode-source-probe" };
  if (range) headers.range = range;
  if (accept) headers.accept = accept;
  try {
    const response = await fetch(url, {
      method,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = method === "HEAD" ? "" : await response.text();
    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - began,
      type: response.headers.get("content-type"),
      length: response.headers.get("content-length"),
      body,
      finalUrl: response.url,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - began,
      error: String(error?.message ?? error),
      body: "",
    };
  }
}

const report = { startedAt: new Date().toISOString(), candidates: {} };

/**
 * The ONS portal is an ArcGIS site, so its catalogue is searchable without a key. Ask for the
 * current ONSPD and NSPL items rather than hard-coding a quarterly URL that expires.
 */
async function onsCatalogue() {
  const out = {};
  for (const term of ["ONSPD", "NSPL"]) {
    const search = await ask(
      `https://www.arcgis.com/sharing/rest/search?f=json&num=10&q=${encodeURIComponent(
        `${term} AND owner:ONSGeography_data`,
      )}`,
    );
    if (!search.ok) {
      out[term] = { status: search.status, error: search.error ?? "search refused" };
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(search.body);
    } catch {
      out[term] = { status: search.status, error: "search answered something that is not JSON" };
      continue;
    }
    const items = Array.isArray(parsed?.results) ? parsed.results : [];
    out[term] = {
      status: search.status,
      ms: search.ms,
      found: parsed?.total ?? items.length,
      items: items.slice(0, 6).map((item) => ({
        id: item.id,
        title: item.title,
        type: item.type,
        licence: typeof item.licenseInfo === "string" ? item.licenseInfo.slice(0, 160) : null,
        modified: item.modified ? new Date(item.modified).toISOString().slice(0, 10) : null,
        size: item.size ?? null,
      })),
    };
    /*
     * And whether the newest item's data is actually fetchable. A HEAD on the item's data endpoint
     * says reachable-and-how-big without pulling a 200 MB zip onto a runner.
     */
    const first = items[0];
    if (first?.id) {
      const head = await ask(`https://www.arcgis.com/sharing/rest/content/items/${first.id}/data`, {
        method: "HEAD",
      });
      out[term].dataHead = {
        status: head.status,
        type: head.type,
        length: head.length === null ? null : Number(head.length),
        error: head.error ?? null,
      };
    }
  }
  return out;
}

/** The OS Downloads API serves open products without a credential; ask what Code-Point Open is. */
async function codePointOpen() {
  const meta = await ask("https://api.os.uk/downloads/v1/products/CodePointOpen");
  const result = { status: meta.status, ms: meta.ms, error: meta.error ?? null };
  if (meta.ok) {
    try {
      const parsed = JSON.parse(meta.body);
      result.name = parsed?.name ?? null;
      result.version = parsed?.version ?? null;
      result.url = parsed?.url ?? null;
    } catch {
      result.error = "product metadata is not JSON";
    }
  }
  const downloads = await ask(
    "https://api.os.uk/downloads/v1/products/CodePointOpen/downloads?area=GB&format=CSV",
  );
  result.downloads = { status: downloads.status, error: downloads.error ?? null };
  if (downloads.ok) {
    try {
      const parsed = JSON.parse(downloads.body);
      const list = Array.isArray(parsed) ? parsed : [];
      result.downloads.options = list.slice(0, 4).map((option) => ({
        format: option.format,
        size: option.size ?? null,
        md5: option.md5 ? "present" : null,
      }));
    } catch {
      result.downloads.error = "download list is not JSON";
    }
  }
  return result;
}

/** Listed, measured, and explicitly not proposed for the request path. See the header. */
async function postcodesIo() {
  const one = await ask("https://api.postcodes.io/postcodes/LS14DY");
  const result = { status: one.status, ms: one.ms, error: one.error ?? null };
  if (one.ok) {
    try {
      const parsed = JSON.parse(one.body);
      result.sample = {
        postcode: parsed?.result?.postcode ?? null,
        lat: parsed?.result?.latitude ?? null,
        lon: parsed?.result?.longitude ?? null,
        country: parsed?.result?.country ?? null,
      };
    } catch {
      result.error = "lookup is not JSON";
    }
  }
  result.suitableForRequestPath = false;
  result.why =
    "a live third-party lookup on every search is an uncapped external dependency; " +
    "useful only as a cross-check on a dataset we hold ourselves";
  return result;
}

async function main() {
  report.candidates.ons = await onsCatalogue();
  report.candidates.codePointOpen = await codePointOpen();
  report.candidates.postcodesIo = await postcodesIo();

  /*
   * One sentence per candidate, so the annotation can be read without unpicking the JSON. The
   * decision this feeds is "which source, if any, do we write a pipeline for" — and a source that
   * is unreachable from a runner is not a source, whatever its licence says.
   */
  const verdicts = [];
  for (const [term, found] of Object.entries(report.candidates.ons)) {
    const reachable = found.dataHead?.status;
    verdicts.push(
      `ONS ${term}: catalogue HTTP ${found.status}, ${found.found ?? 0} item(s)` +
        (found.items?.[0] ? `, newest "${found.items[0].title}"` : "") +
        (reachable === undefined ? "" : `, data HTTP ${reachable}`),
    );
  }
  verdicts.push(
    `Code-Point Open: product HTTP ${report.candidates.codePointOpen.status}, ` +
      `downloads HTTP ${report.candidates.codePointOpen.downloads?.status}`,
  );
  verdicts.push(
    `postcodes.io: HTTP ${report.candidates.postcodesIo.status} (reference only, not for the request path)`,
  );
  report.verdicts = verdicts;
  report.outcome = "probed";

  for (const line of verdicts) console.log(line);
  annotate("notice", "postcode source probe", JSON.stringify(report, null, 1));
}

await main();
