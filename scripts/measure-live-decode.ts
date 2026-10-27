#!/usr/bin/env node
/**
 * What it costs to turn a live feed into Bus Stops' internal observations, by stage.
 *
 * `/v1/map` spends about 96 ms of CPU on a city viewport and 88 of those are this: fetching BODS
 * SIRI-VM and normalising it. A Workers Free invocation gets ten. So before any ingestion
 * architecture is proposed, this measures where the 88 go and whether a cheaper request-time path
 * exists — because moving work out of the request is a freshness cost, and paying it without
 * checking is how a day gets spent on the wrong thing.
 *
 * Four questions, in order:
 *
 *   1. **What does the current path cost, split?** `fast-xml-parser` builds a DOM of the whole
 *      document and then a Zod `safeParse` runs per vehicle. Those are very different costs with
 *      very different fixes, and the 88 ms figure does not say which dominates.
 *   2. **Is a targeted scanner dramatically cheaper?** The normaliser consumes twelve fields. A
 *      scanner that walks the XML text and extracts only those allocates no DOM and validates
 *      nothing it does not use.
 *   3. **Does BODS offer a cheaper machine format?** GTFS-RT is protobuf rather than XML. Whether
 *      this project's key can reach it, what it returns and which fields it carries is checked
 *      against the live service rather than assumed.
 *   4. **How much does the identity hashing cost?** Three FNV-1a hashes per vehicle, on a path
 *      allowed ten milliseconds in total.
 *
 * With `BODS_API_KEY` it measures the real feed for a real viewport. Without one it synthesises a
 * feed of the same shape and size from the documented fixture, so the stage ratios can be had
 * locally — and says which it did.
 *
 *   npx tsx scripts/measure-live-decode.ts [--json live-decode.json] [--vehicles 437]
 */

import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { annotateReport } from "@busstops/pipeline-core";
import {
  normalizeSiriVm,
  parseSiriVm,
  scanSiriVehicles,
  deterministicUuid,
  opaqueVehicleRef,
} from "@busstops/adapters";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const JSON_OUT = arg("json");
const WANT_VEHICLES = Number(arg("vehicles") ?? "437");

/** The Manchester viewport the probe, the cold walk and the CPU measurement all use. */
const BBOX = { west: -2.32, south: 53.42, east: -2.16, north: 53.52 };

/**
 * Milliseconds for one call, median of several, after a warm-up.
 *
 * The warm-up matters more than it looks: an earlier attempt at a measurement like this timed one
 * run of each implementation in sequence and concluded that a rewrite was 1.4 times faster, then
 * on a second run that the same rewrite was slower. A single JIT-cold run is not a measurement.
 */
function timed<T>(label: string, run: () => T, iterations = 7): { ms: number; value: T } {
  run();
  run();
  const times: number[] = [];
  let value!: T;
  for (let i = 0; i < iterations; i += 1) {
    const began = process.hrtime.bigint();
    value = run();
    times.push(Number(process.hrtime.bigint() - began) / 1e6);
  }
  times.sort((a, b) => a - b);
  const ms = times[Math.floor(times.length / 2)]!;
  console.log(
    `${label.padEnd(46)} median ${ms.toFixed(2).padStart(8)} ms   best ${times[0]!.toFixed(2)} ms`,
  );
  return { ms, value };
}

/* ------------------------------------------------------------------ the feed */

async function liveFeed(): Promise<{ xml: string; source: string } | null> {
  const key = process.env.BODS_API_KEY;
  if (!key) return null;
  const url =
    `https://data.bus-data.dft.gov.uk/api/v1/datafeed/?api_key=${key}` +
    `&boundingBox=${BBOX.west.toFixed(5)},${BBOX.south.toFixed(5)},` +
    `${BBOX.east.toFixed(5)},${BBOX.north.toFixed(5)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const xml = await response.text();
  if (!response.ok) return null;
  return { xml, source: `BODS datafeed, Manchester viewport (HTTP ${String(response.status)})` };
}

/** A feed of the same shape and size as a real one, built from the documented fixture. */
function syntheticFeed(count: number): { xml: string; source: string } {
  const fixture = readFileSync("tests/fixtures/documented/bods-siri-vm.xml", "utf8");
  const open = fixture.indexOf("<VehicleActivity>");
  const lastClose = fixture.lastIndexOf("</VehicleActivity>") + "</VehicleActivity>".length;
  const block = fixture.slice(open, fixture.indexOf("</VehicleActivity>") + 18);
  const now = Date.now();
  const blocks: string[] = [];
  for (let i = 0; i < count; i += 1) {
    blocks.push(
      block
        .replace(
          /<VehicleRef>[^<]*<\/VehicleRef>/,
          `<VehicleRef>FLEE-${String(30000 + i)}</VehicleRef>`,
        )
        .replace(
          /<Latitude>[^<]*<\/Latitude>/,
          `<Latitude>${(BBOX.south + (i % 97) * 0.001).toFixed(6)}</Latitude>`,
        )
        .replace(
          /<Longitude>[^<]*<\/Longitude>/,
          `<Longitude>${(BBOX.west + (i % 97) * 0.0016).toFixed(6)}</Longitude>`,
        )
        .replace(
          /<RecordedAtTime>[^<]*<\/RecordedAtTime>/,
          `<RecordedAtTime>${new Date(now - (i % 90) * 1000).toISOString()}</RecordedAtTime>`,
        )
        .replace(
          /<DatedVehicleJourneyRef>[^<]*<\/DatedVehicleJourneyRef>/,
          `<DatedVehicleJourneyRef>VJ_${String(i)}_0915</DatedVehicleJourneyRef>`,
        ),
    );
  }
  return {
    xml: fixture.slice(0, open) + blocks.join("\n") + fixture.slice(lastClose),
    source: `synthetic, ${String(count)} activities from the documented fixture`,
  };
}

/* ------------------------------------------------------------------ GTFS-RT availability */

/**
 * Whether BODS will serve this project a GTFS-RT VehiclePositions feed, and what it looks like.
 *
 * Checked rather than assumed, and only as far as bytes and shape: decoding protobuf would mean a
 * dependency and a decoder, and that is only worth writing if the format is both reachable and
 * materially smaller. A protobuf feed carries a varint-delimited stream of `FeedEntity` messages,
 * so the entity count can be had from a cheap scan of field tags without a full decoder.
 */
async function gtfsRealtime(): Promise<Record<string, unknown>> {
  const key = process.env.BODS_API_KEY;
  if (!key) return { available: "not measured", reason: "no BODS_API_KEY" };

  const attempts: Array<Record<string, unknown>> = [];
  for (const [name, url] of [
    [
      "gtfsrtdatafeed, viewport",
      `https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/?api_key=${key}` +
        `&boundingBox=${BBOX.west.toFixed(5)},${BBOX.south.toFixed(5)},` +
        `${BBOX.east.toFixed(5)},${BBOX.north.toFixed(5)}`,
    ],
    [
      "gtfsrtdatafeed, no box",
      `https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/?api_key=${key}`,
    ],
  ] as const) {
    const began = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const bytes = new Uint8Array(await response.arrayBuffer());
      /*
       * `FeedMessage.entity` is field 2, wire type 2 — tag byte 0x12. Counting those is not a
       * decode; it is enough to say whether the feed has vehicles in it and roughly how many.
       */
      let entities = 0;
      for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0x12) entities += 1;
      attempts.push({
        name,
        status: response.status,
        contentType: response.headers.get("content-type"),
        bytes: bytes.length,
        approxEntities: entities,
        ms: Date.now() - began,
        /* A protobuf FeedMessage begins with field 1 (header), tag byte 0x0a. */
        looksLikeProtobuf: bytes.length > 2 && bytes[0] === 0x0a,
        head: Buffer.from(bytes.slice(0, 24)).toString("hex"),
      });
      console.log(
        `${name.padEnd(30)} HTTP ${String(response.status)} ${String(bytes.length).padStart(9)} bytes  ` +
          `protobuf=${String(bytes.length > 2 && bytes[0] === 0x0a)}  ~entities=${String(entities)}`,
      );
    } catch (error) {
      attempts.push({ name, error: String(error).slice(0, 200) });
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { attempts };
}

/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const feed = (await liveFeed()) ?? syntheticFeed(WANT_VEHICLES);
  console.log(`feed: ${String(feed.xml.length)} chars — ${feed.source}`);
  const activities = (feed.xml.match(/<VehicleActivity>/g) ?? []).length;
  console.log(`activities: ${String(activities)}\n`);

  const options = {
    retrievedAt: new Date().toISOString(),
    vehicleSalt: "measurement",
    now: new Date(),
    /* Generous, so a synthetic feed's ages do not reject everything and measure nothing. */
    maxAgeSeconds: 86_400,
  };

  const whole = timed("normalizeSiriVm (current, whole path)", () =>
    normalizeSiriVm(feed.xml, options),
  );
  console.log(
    `   -> ${String(whole.value.observations.length)} observations, ` +
      `${String(whole.value.rejected.length)} rejected\n`,
  );

  const parse = timed("  parseSiriVm (DOM + Zod per vehicle)", () => parseSiriVm(feed.xml));
  const dom = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: true,
    removeNSPrefix: true,
  });
  const domOnly = timed("    fast-xml-parser DOM only", () => dom.parse(feed.xml));

  const refs = Array.from(
    { length: Math.max(1, whole.value.observations.length) },
    (_, i) => `FLEE-${String(30000 + i)}`,
  );
  const stamp = Date.now();
  const hashing = timed("  identity hashing (3 FNV-1a per vehicle)", () => {
    let n = 0;
    for (const ref of refs) {
      const opaque = opaqueVehicleRef(ref, "measurement");
      n += deterministicUuid("vehicle", `${opaque}:${String(stamp)}`).length;
    }
    return n;
  });

  /* The candidate: a targeted scan, which is what A2 asks to be benchmarked rather than assumed. */
  const scan = timed("scanSiriVehicles (targeted, no DOM, no Zod)", () =>
    scanSiriVehicles(feed.xml, {
      vehicleSalt: "measurement",
      nowMs: Date.now(),
      maxAgeSeconds: 86_400,
      within: BBOX,
    }),
  );
  console.log(
    `   -> ${String(scan.value.vehicles.length)} vehicles, ` +
      `${String(scan.value.rejectedCount)} rejected ` +
      `${JSON.stringify(scan.value.rejected)}\n`,
  );

  const report = {
    outcome: "measured",
    feed: { chars: feed.xml.length, activities, source: feed.source },
    freeCpuBudgetMs: 10,
    stages: {
      normaliseWholePathMs: Number(whole.ms.toFixed(2)),
      parseDomPlusZodMs: Number(parse.ms.toFixed(2)),
      domOnlyMs: Number(domOnly.ms.toFixed(2)),
      zodPerVehicleMs: Number((parse.ms - domOnly.ms).toFixed(2)),
      buildObservationsMs: Number((whole.ms - parse.ms).toFixed(2)),
      identityHashingMs: Number(hashing.ms.toFixed(2)),
      /* The candidate. */
      targetedScanMs: Number(scan.ms.toFixed(2)),
      scanSpeedup: Number((whole.ms / Math.max(scan.ms, 0.0001)).toFixed(1)),
      targetMs: 4,
      scanWithinTarget: scan.ms <= 4,
    },
    scanned: {
      vehicles: scan.value.vehicles.length,
      rejected: scan.value.rejected,
      responseTimestamp: scan.value.responseTimestamp,
      /* Parity: the scan and the normaliser must agree on how many vehicles survive. */
      agreesWithNormaliser: scan.value.vehicles.length === whole.value.observations.length,
      sample: scan.value.vehicles[0] ?? null,
    },
    observations: whole.value.observations.length,
    rejected: whole.value.rejected.length,
    gtfsRealtime: await gtfsRealtime(),
  };

  console.log("");
  console.log(JSON.stringify(report, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  annotateReport("live decode cost", report);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Measuring the live decode failed:", error);
    annotateReport("live decode cost", { outcome: "threw", error: String(error) });
    process.exitCode = 1;
  });
