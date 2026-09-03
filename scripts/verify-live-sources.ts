#!/usr/bin/env node
/**
 * Live source verification.
 *
 * Fetches a small, real response from each upstream and runs it through the same parser the
 * platform uses, so that "the adapter works" is a claim about observed behaviour rather than about
 * a fixture we wrote ourselves. It exists because `contractVerification.method: "live_response"`
 * may only be set when a real response was actually inspected, and nothing else in the repository
 * can inspect one: the build sandbox has no egress to any of these hosts.
 *
 * It reports structure, never content. Counts, field presence and parser outcomes are safe to
 * publish; the payloads themselves are licensed data we do not redistribute, and a credential must
 * never appear in a log. Requests are deliberately tiny — one bounding box, one stop, a byte range
 * of the NaPTAN CSV — so verification cannot become a load source.
 *
 *   npx tsx scripts/verify-live-sources.ts
 */

import { writeFileSync } from "node:fs";
import {
  NaptanCsvRowSchema,
  TflArrivalSchema,
  bodsDatafeedUrl,
  normalizeNaptanRow,
  normalizeTflArrivals,
  parseCsv,
  parseSiriVm,
  tflUrl,
} from "@busstops/adapters";

interface Finding {
  source: string;
  reachable: boolean;
  httpStatus: number | null;
  /** What the parser made of the real response. Empty when the request never succeeded. */
  observations: string[];
  error: string | null;
}

const findings: Finding[] = [];
const retrievedAt = new Date().toISOString();

/** Never let a credential reach a log, even inside an error message from fetch or the URL parser. */
const secrets = [process.env.BODS_API_KEY, process.env.TFL_APP_KEY].filter(
  (value): value is string => typeof value === "string" && value.length > 0,
);

function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  // Belt and braces: a key can reach a message through a URL we did not construct.
  return out.replace(/(api_key|app_key)=[^&\s"']+/gi, "$1=[redacted]");
}

async function probe(
  source: string,
  url: string,
  read: (response: Response) => Promise<string[]>,
): Promise<void> {
  const finding: Finding = {
    source,
    reachable: false,
    httpStatus: null,
    observations: [],
    error: null,
  };
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "busstops-source-verification" },
      signal: AbortSignal.timeout(120_000),
    });
    finding.reachable = true;
    finding.httpStatus = response.status;
    if (!response.ok) {
      finding.error = `HTTP ${response.status}`;
    } else {
      finding.observations = await read(response);
    }
  } catch (error) {
    finding.error = redact(error instanceof Error ? error.message : String(error));
  }
  findings.push(finding);
  const state = finding.error ? `FAILED (${finding.error})` : "ok";
  console.log(`\n${source}: ${state}`);
  for (const observation of finding.observations) console.log(`  - ${observation}`);
}

async function main(): Promise<void> {
  // --- BODS SIRI-VM ------------------------------------------------------------------------------
  // One small bounding box over central Manchester. The national feed is large and this is a
  // contract check, not an ingestion.
  await probe(
    "bods",
    bodsDatafeedUrl(
      { west: -2.29, south: 53.44, east: -2.19, north: 53.52 },
      process.env.BODS_API_KEY,
    ),
    async (response) => {
      const xml = await response.text();
      const parsed = parseSiriVm(xml);
      const observations = [
        `content-type ${response.headers.get("content-type") ?? "(none)"}`,
        `${xml.length} bytes of XML`,
        `parseSiriVm: ${parsed.activities.length} vehicle activities, ${parsed.rejected.length} rejected`,
      ];
      if (parsed.responseTimestamp) {
        observations.push(`feed ResponseTimestamp present: ${parsed.responseTimestamp}`);
      }
      const first = parsed.activities[0];
      if (first) {
        // Field *names*, never values: which optional parts of the schema this operator populates
        // is exactly what a parser has to be right about.
        const journey = first.MonitoredVehicleJourney;
        const present = Object.keys(journey).filter(
          (key) => journey[key as keyof typeof journey] !== undefined,
        );
        observations.push(`MonitoredVehicleJourney fields present: ${present.sort().join(", ")}`);
      } else if (xml.length > 0) {
        observations.push(
          "no vehicles in this box at this moment (valid: buses may not be running)",
        );
      }
      return observations;
    },
  );

  // --- BODS timetable catalogue -------------------------------------------------------------------
  // The static pipeline reads this catalogue and then fetches each dataset as text. What a dataset
  // URL actually serves — XML, or a zip archive of XML — decides whether that is correct, and it is
  // not something the published documentation settles.
  {
    const url = new URL("https://data.bus-data.dft.gov.uk/api/v1/dataset/");
    if (process.env.BODS_API_KEY) url.searchParams.set("api_key", process.env.BODS_API_KEY);
    url.searchParams.set("status", "published");
    url.searchParams.set("limit", "25");

    await probe("bods-timetables", url.toString(), async (response) => {
      const body = (await response.json()) as {
        count?: number;
        results?: Array<Record<string, unknown>>;
      };
      const results = body.results ?? [];
      const observations = [
        `catalogue reports ${body.count ?? "unknown"} published datasets, ${results.length} in this page`,
      ];
      if (results[0]) {
        observations.push(`dataset fields: ${Object.keys(results[0]).sort().join(", ")}`);
      }
      const extensions = new Map<string, number>();
      for (const dataset of results) {
        const extension = typeof dataset.extension === "string" ? dataset.extension : "(absent)";
        extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
      }
      observations.push(
        `extensions: ${[...extensions].map(([name, count]) => `${name}×${count}`).join(", ")}`,
      );

      // Fetch exactly one dataset and report what the bytes are, because "fetchText on a zip" is a
      // silent corruption rather than an error: the XML parser simply finds no journeys.
      const first = results.find((dataset) => typeof dataset.url === "string");
      if (!first) {
        observations.push("no dataset in the page carries a url");
        return observations;
      }
      const datasetResponse = await fetch(first.url as string, {
        headers: { "user-agent": "busstops-source-verification" },
        signal: AbortSignal.timeout(120_000),
      });
      observations.push(
        `one dataset download: HTTP ${datasetResponse.status}, ` +
          `content-type ${datasetResponse.headers.get("content-type") ?? "(none)"}`,
      );
      const bytes = new Uint8Array(await datasetResponse.arrayBuffer());
      observations.push(`${bytes.length} bytes`);
      // "PK\x03\x04" is the zip local file header; "<" starts an XML document.
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
      const head = new TextDecoder().decode(bytes.slice(0, 200)).trimStart();
      observations.push(
        isZip
          ? "MAGIC: zip archive — fetchText would hand the XML parser binary and find no journeys"
          : `MAGIC: not a zip; body starts ${JSON.stringify(head.slice(0, 80))}`,
      );
      if (!isZip) {
        observations.push(head.startsWith("<") ? "looks like XML" : "does not look like XML");
      }
      return observations;
    });
  }

  // --- TfL Unified API ---------------------------------------------------------------------------
  // A single well-known stop point rather than a line or a region.
  await probe(
    "tfl",
    tflUrl("/StopPoint/490008660N/Arrivals", process.env.TFL_APP_KEY),
    async (response) => {
      const body: unknown = await response.json();
      const observations = [`content-type ${response.headers.get("content-type") ?? "(none)"}`];
      if (!Array.isArray(body)) {
        observations.push(`unexpected shape: ${typeof body}, expected an array`);
        return observations;
      }
      observations.push(`${body.length} arrivals returned`);
      const valid = body.filter((item) => TflArrivalSchema.safeParse(item).success);
      observations.push(`TflArrivalSchema accepts ${valid.length} of ${body.length}`);
      if (valid.length < body.length && body[0]) {
        const failure = TflArrivalSchema.safeParse(body[0]);
        if (!failure.success) {
          observations.push(
            `first rejection: ${failure.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
              .join("; ")}`,
          );
        }
      }
      const normalized = normalizeTflArrivals(valid, { retrievedAt, now: new Date() });
      observations.push(
        `normalizeTflArrivals produced ${normalized.departures.length} departures, ` +
          `${normalized.rejected} rejected`,
      );
      return observations;
    },
  );

  // --- NaPTAN ------------------------------------------------------------------------------------
  // The national CSV is hundreds of megabytes. A range request takes the header row and enough of
  // the first rows to run the row schema, without downloading a national dataset to check a parser.
  await probe(
    "naptan",
    "https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv",
    async (response) => {
      const reader = response.body?.getReader();
      const observations = [`content-type ${response.headers.get("content-type") ?? "(none)"}`];
      if (!reader) {
        observations.push("no readable body");
        return observations;
      }
      // Read a bounded prefix and stop: enough rows to verify the contract, then cancel the stream
      // so the rest of the national file is never transferred.
      const decoder = new TextDecoder();
      let text = "";
      while (text.length < 256_000) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel();

      // The final line of a truncated prefix is a partial row; drop it rather than reporting a
      // parse failure that only the truncation caused.
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      const rows = parseCsv(complete);
      observations.push(`${complete.length} bytes read (stream cancelled), ${rows.length} rows`);
      if (rows[0]) {
        observations.push(`columns: ${Object.keys(rows[0]).length}`);
      }
      const accepted = rows.filter((row) => NaptanCsvRowSchema.safeParse(row).success);
      observations.push(`NaptanCsvRowSchema accepts ${accepted.length} of ${rows.length}`);
      const stops = accepted
        .map((row) => NaptanCsvRowSchema.parse(row))
        .map((row) => normalizeNaptanRow(row, { retrievedAt }))
        .filter((stop) => stop !== null);
      observations.push(`normalizeNaptanRow produced ${stops.length} bus-related stops`);
      return observations;
    },
  );

  writeFileSync(
    "source-verification.json",
    JSON.stringify({ retrievedAt, findings }, null, 2),
    "utf8",
  );

  const failed = findings.filter((finding) => finding.error !== null);
  console.log(
    failed.length === 0
      ? `\nAll ${findings.length} sources verified against live responses.`
      : `\n${failed.length} of ${findings.length} sources could not be verified: ${failed
          .map((finding) => finding.source)
          .join(", ")}`,
  );

  // A source that answered but returned nothing is not a failure — buses stop running at night, and
  // reporting that as a broken adapter would be the wrong signal.
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error("Source verification failed:", redact(String(error)));
  process.exitCode = 1;
});
