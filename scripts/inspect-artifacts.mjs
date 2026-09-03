#!/usr/bin/env node
/**
 * Reports the size of every published artifact.
 *
 * A Workers isolate has a fixed memory ceiling, and the edge loads whole datasets into it. Whether
 * a national dataset fits is therefore a number, not an opinion — and it is a number nothing else
 * prints. Each manifest already records `recordCount` and `sizeBytes`; this reads them and says
 * plainly which datasets an isolate could not hold.
 *
 *   node scripts/inspect-artifacts.mjs
 *
 * Needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and R2_BUCKET_ARTIFACTS.
 */

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const bucket = process.env.R2_BUCKET_ARTIFACTS;

if (!accountId || !apiToken || !bucket) {
  console.error("CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and R2_BUCKET_ARTIFACTS must be set.");
  process.exit(2);
}

/** Cloudflare's documented per-isolate memory limit. */
const ISOLATE_MEMORY_BYTES = 128 * 1024 * 1024;

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`;
const auth = { Authorization: `Bearer ${apiToken}` };

async function listObjects(prefix) {
  const url = new URL(`${base}/objects`);
  url.searchParams.set("prefix", prefix);
  url.searchParams.set("per_page", "1000");
  const response = await fetch(url, { headers: auth });
  if (!response.ok) throw new Error(`list failed: ${response.status}`);
  const body = await response.json();
  return body.result ?? [];
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

// Keys are `manifests/<dataset>/current.json` and `data/<dataset>/<version>.jsonl`. The whole
// bucket is listed as well as the manifest prefix, so "nothing published" is distinguishable from
// "the filter was wrong" — the first version of this script confused the two and reported an
// empty bucket that was not empty.
const everything = await listObjects("");
const manifests = (await listObjects("manifests/")).filter((object) =>
  object.key?.endsWith("/current.json"),
);
console.log(`${everything.length} objects in ${bucket}, ${manifests.length} of them manifests`);
if (everything.length > 0 && manifests.length === 0) {
  console.log(
    `first keys: ${everything
      .slice(0, 5)
      .map((object) => object.key)
      .join(", ")}`,
  );
}
console.log();

const rows = [];
for (const object of manifests) {
  const key = object.key.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${base}/objects/${key}`, { headers: auth });
  if (!response.ok) {
    console.error(`  ${object.key}: read failed ${response.status}`);
    continue;
  }
  const manifest = await response.json();
  rows.push(manifest);
}

rows.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

let tooLarge = 0;
for (const manifest of rows) {
  // Half the ceiling is the honest threshold: the isolate holds the raw text and the parsed
  // objects at once, and parsed JSON is larger than its source.
  const risky = (manifest.sizeBytes ?? 0) > ISOLATE_MEMORY_BYTES / 2;
  if (risky) tooLarge += 1;
  console.log(
    `${risky ? "  TOO LARGE" : "        ok"}  ${manifest.dataset.padEnd(28)} ` +
      `${String(manifest.recordCount).padStart(8)} records  ${mib(manifest.sizeBytes ?? 0).padStart(10)}`,
  );
}

console.log(
  tooLarge === 0
    ? `\nEvery dataset is comfortably inside a ${mib(ISOLATE_MEMORY_BYTES)} isolate.`
    : `\n${tooLarge} dataset(s) are too large for an edge isolate to load whole. The edge must read ` +
        `these per tile rather than nationally, as the journeys dataset already does.`,
);
