#!/usr/bin/env node
/**
 * Verifies the basemap before it is locked into a build.
 *
 * Two things have to be true and neither can be assumed. First, the terms: the platform's rule is
 * that normal operation costs nothing and depends on no paid provider, so a tile host is only
 * usable while its own policy still says free, keyless and open. Policies change, and a basemap
 * that quietly started requiring a key would break the map for everyone at once.
 *
 * Second, the origins. A MapLibre style is a document that points at other things — tiles, sprite
 * sheets, glyph ranges — often on different hosts. The Content-Security-Policy has to name every
 * one of them exactly, and the only way to know what they are is to read the style and look.
 *
 *   node scripts/verify-basemap.mjs [style-url]
 */

const DEFAULT_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const styleUrl = process.argv[2] ?? DEFAULT_STYLE;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Style URLs use {z}/{x}/{y} and {fontstack}/{range} placeholders that are not valid in a URL. */
function originOfTemplate(template) {
  return originOf(template.replace(/\{[^}]+\}/g, "0"));
}

const response = await fetch(styleUrl, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(30_000),
});

console.log(`style: ${styleUrl}`);
console.log(`  HTTP ${response.status} ${response.headers.get("content-type") ?? ""}`);
if (!response.ok) {
  console.error(`\nThe style did not load. It cannot be used until it does.`);
  process.exit(1);
}

const style = await response.json();
console.log(`  name: ${style.name ?? "(unnamed)"}, version ${style.version}`);
console.log(
  `  layers: ${(style.layers ?? []).length}, sources: ${Object.keys(style.sources ?? {}).length}`,
);

const origins = new Set([originOf(styleUrl)]);
const attributions = new Set();

for (const [name, source] of Object.entries(style.sources ?? {})) {
  if (source.attribution) attributions.add(String(source.attribution).replace(/<[^>]+>/g, ""));

  for (const tile of source.tiles ?? []) {
    const origin = originOfTemplate(tile);
    if (origin) origins.add(origin);
    console.log(`  source ${name}: tiles ${origin}`);
  }
  // A source can point at a TileJSON document instead of listing tiles inline; that document
  // names the real tile host, so it has to be followed rather than guessed at.
  if (source.url) {
    const origin = originOf(source.url);
    if (origin) origins.add(origin);
    console.log(`  source ${name}: url ${source.url}`);
    try {
      const tileJson = await (
        await fetch(source.url, { signal: AbortSignal.timeout(20_000) })
      ).json();
      for (const tile of tileJson.tiles ?? []) {
        const tileOrigin = originOfTemplate(tile);
        if (tileOrigin) origins.add(tileOrigin);
        console.log(`    → tiles ${tileOrigin}`);
      }
      if (tileJson.attribution) {
        attributions.add(String(tileJson.attribution).replace(/<[^>]+>/g, ""));
      }
    } catch (error) {
      console.log(
        `    → could not read TileJSON: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

if (style.sprite) {
  const sprite = Array.isArray(style.sprite) ? style.sprite.map((s) => s.url) : [style.sprite];
  for (const url of sprite) {
    const origin = originOf(url);
    if (origin) origins.add(origin);
    console.log(`  sprite: ${origin}`);
  }
}

if (style.glyphs) {
  const origin = originOfTemplate(style.glyphs);
  if (origin) origins.add(origin);
  console.log(`  glyphs: ${origin}`);
}

// Prove the tiles themselves are reachable and keyless, not merely that the style parses. A host
// that had started demanding a key would answer 401 or 403 here while the style still loaded.
const probeSource = Object.values(style.sources ?? {}).find((s) => s.tiles?.length || s.url);
if (probeSource) {
  let template = probeSource.tiles?.[0];
  if (!template && probeSource.url) {
    const tileJson = await (
      await fetch(probeSource.url, { signal: AbortSignal.timeout(20_000) })
    ).json();
    template = tileJson.tiles?.[0];
  }
  if (template) {
    // Zoom 6 over England: a tile that certainly exists.
    const probe = template.replace("{z}", "6").replace("{x}", "31").replace("{y}", "20");
    const tile = await fetch(probe, { signal: AbortSignal.timeout(20_000) });
    console.log(`\ntile probe: HTTP ${tile.status} ${tile.headers.get("content-type") ?? ""}`);
    console.log(`  ${(await tile.arrayBuffer()).byteLength} bytes, no key sent`);
    if (!tile.ok) {
      console.error("The tiles are not served without a key. This basemap cannot be used as is.");
      process.exit(1);
    }
  }
}

console.log(`\nattribution required:`);
for (const attribution of attributions) console.log(`  ${attribution}`);

console.log(`\nCSP origins the app must be allowed to reach:`);
for (const origin of [...origins].filter(Boolean).sort()) console.log(`  ${origin}`);
