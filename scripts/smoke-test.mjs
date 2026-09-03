#!/usr/bin/env node
/**
 * Deployed smoke test.
 *
 * Run against a live deployment immediately after deploying. It checks the things that can only
 * be wrong once something is actually deployed: that the edge serves, that security headers are
 * present, that the caps are enforced by the running Worker rather than only by its tests, and
 * that the app shell loads.
 *
 * It deliberately does not assert that live bus data is present. Whether an upstream feed is
 * healthy at this moment is not a property of the deployment, and failing a deploy because the
 * DfT had a bad minute would be the wrong signal.
 *
 *   node scripts/smoke-test.mjs https://busstops.example https://api.busstops.example
 */

const [, , siteUrlArg, apiUrlArg] = process.argv;

if (!siteUrlArg) {
  console.error("Usage: node scripts/smoke-test.mjs <site-url> [api-url]");
  process.exit(2);
}

const siteUrl = siteUrlArg.replace(/\/$/, "");
const apiUrl = (apiUrlArg ?? `${siteUrl}/api`).replace(/\/$/, "");

const results = [];
let failures = 0;

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

await check("app shell loads", async () => {
  const response = await fetchWithTimeout(siteUrl);
  assert(response.ok, `expected 2xx, got ${response.status}`);
  const html = await response.text();
  assert(html.includes('<div id="root"'), "the app root element is missing");
  return `${response.status}, ${html.length} bytes`;
});

await check("security headers are set on the app shell", async () => {
  const response = await fetchWithTimeout(siteUrl);
  const required = ["content-security-policy", "x-content-type-options", "referrer-policy"];
  const missing = required.filter((header) => !response.headers.get(header));
  assert(
    missing.length === 0,
    `missing: ${missing.join(", ")}. These come from dist/_headers, written at deploy time by ` +
      `scripts/generate-headers.mjs and applied by Cloudflare Pages. A local 'vite preview' does ` +
      `not apply them, so this check is expected to fail against a local rehearsal and must ` +
      `pass against a real deployment.`,
  );
  return required.join(", ");
});

await check("source health endpoint answers", async () => {
  const response = await fetchWithTimeout(`${apiUrl}/v1/sources/health`);
  assert(response.ok, `expected 2xx, got ${response.status}`);
  const body = await response.json();
  assert(body.meta, "response envelope has no meta");
  assert(typeof body.meta.governorState === "string", "no governor state reported");
  return `governor ${body.meta.governorState}, ${body.data.sources.length} sources`;
});

await check("every response states its freshness and degradation", async () => {
  const response = await fetchWithTimeout(`${apiUrl}/v1/sources/health`);
  const body = await response.json();
  for (const field of ["generatedAt", "coverage", "degradation", "attribution"]) {
    assert(field in body.meta, `meta is missing ${field}`);
  }
  return `degradation ${body.meta.degradation}`;
});

await check("map query caps are enforced by the running Worker", async () => {
  // A bounding box covering most of England must be refused, not served slowly.
  const response = await fetchWithTimeout(`${apiUrl}/v1/map?bbox=-6,50,2,55&zoom=6`);
  assert(response.status === 400, `expected 400 for an oversized bbox, got ${response.status}`);
  return "oversized viewport refused";
});

await check("a missing bounding box is refused", async () => {
  const response = await fetchWithTimeout(`${apiUrl}/v1/map`);
  assert(response.status === 400, `expected 400, got ${response.status}`);
  return "bbox required";
});

await check("Pro is reachable without any credential", async () => {
  const response = await fetchWithTimeout(`${apiUrl}/v1/pro/control-tower`);
  assert(response.ok, `expected 2xx, got ${response.status}`);
  const body = await response.json();
  assert(
    ["live", "demo_snapshot", "unavailable"].includes(body.data.provenance.dataMode),
    "Pro did not state its data mode",
  );
  assert(!response.headers.get("www-authenticate"), "Pro demanded authentication");
  return `data mode ${body.data.provenance.dataMode}`;
});

await check("unknown endpoints 404 rather than erroring", async () => {
  const response = await fetchWithTimeout(`${apiUrl}/v1/nonexistent`);
  assert(response.status === 404, `expected 404, got ${response.status}`);
  return "404";
});

await check("write methods are refused", async () => {
  const response = await fetchWithTimeout(`${apiUrl}/v1/map`, { method: "DELETE" });
  assert(response.status === 405 || response.status === 400, `got ${response.status}`);
  return `${response.status}`;
});

await check("one-click unsubscribe accepts a POST", async () => {
  const response = await fetchWithTimeout(`${apiUrl}/v1/unsubscribe?r=smoke&t=smoke`, {
    method: "POST",
  });
  assert(response.ok, `expected 2xx, got ${response.status}`);
  return "POST accepted";
});

await check("no credential is echoed in any response", async () => {
  const response = await fetchWithTimeout(`${apiUrl}/v1/sources/health`);
  const text = await response.text();
  for (const marker of ["api_key", "apiKey", "Bearer ", "app_key", "CLOUDFLARE_API_TOKEN"]) {
    assert(!text.includes(marker), `response contained ${marker}`);
  }
  return "clean";
});

for (const result of results) {
  console.log(
    `${result.ok ? "  pass" : "  FAIL"}  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`,
  );
}

console.log(
  failures === 0
    ? `\nSmoke test passed: ${results.length} checks against ${siteUrl}.`
    : `\nSmoke test FAILED: ${failures} of ${results.length} checks failed against ${siteUrl}.`,
);

process.exit(failures === 0 ? 0 : 1);
