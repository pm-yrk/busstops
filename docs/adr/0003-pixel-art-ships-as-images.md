# ADR 0003 — The pixel art is authored as drawing code and ships as images

Status: accepted, 2026-09-04.

## Context

`docs/02_DESIGN_SYSTEM.md` asks for "original consistent SVG/CSS/canvas assets on a fixed pixel
grid". The first implementation took that literally: every sprite was a React component built from
`<rect>` elements, hand-placed on a 16-unit grid.

At 16 units a bus is a red box with four white squares in it. That is what the product shipped: a
30x13 bus, a tree made of five stacked bars, a building drawn as a white box with three grey
rectangles. The idiom was right and the drawing was not, and the reason was the medium — nobody
hand-places a thousand `<rect>` elements, so nothing had more than about twenty.

Redrawing the artwork properly meant authoring at real resolutions: a hundred pixels of bus, three
hundred and twenty of street. Run-length encoded, the composed scenes and the sprite set came to
17,914 rectangles. That is a great deal of DOM for one illustration, and it buys nothing that
matters: pixel art wants `image-rendering: pixelated` and whole-number scaling, and an image gives
exactly that with no anti-aliasing anywhere.

## Decision

The artwork's source is drawing code in `tools/pixel-art`, on a fixed art-pixel grid with one
shared palette. `npm run art` renders it to PNG under `apps/web/public/art` (map markers are
inlined as data URIs, because MapLibre wants them without a round trip) and writes an index at
`apps/web/src/components/pixel/sprites/generated.ts`.

Small interface marks — a clock, a warning, the weather — stay as a handful of `<rect>` units on
the 16-unit grid, because at 16 to 24 pixels there is nothing to draw that a few squares cannot
say.

## What this preserves

- **A fixed pixel grid**, more strictly than before: one art pixel is one art pixel in every
  sprite, and every sprite is displayed at a whole-number multiple of its native size.
- **Crisp edges**: `image-rendering: pixelated`, and no fractional scaling anywhere.
- **A limited palette**, now in ramps, shared by every drawing and stated in one file.
- **Accessible alternatives**: sprites are decorative by default and hidden from assistive
  technology unless named; the hero carries one description of the whole scene.
- **Reduced motion**: unchanged — the traffic stops and the buses park at readable positions.

## What it costs

- The artwork can no longer be recoloured by CSS custom properties. Two states that used to be one
  drawing with different variables — a stale vehicle, a selected stop — are now separate drawings.
  That is arguably better: a stale bus is a different livery rather than the same bus faded.
- Changing a colour means re-running the build rather than editing a token. The palette is one
  file, so this is a one-line change and a regenerated set of images.
- The images are binary and do not diff usefully. The drawing code does, and that is the source.

## Alternatives considered

- **Keep SVG and accept the node count.** Eighteen thousand elements on the home page, most of them
  in an illustration nobody interacts with. Rejected on weight.
- **An SVG `<image>` with an embedded raster.** The same images with a wrapper around them.
- **A sprite sheet with CSS background positioning.** Fewer requests, but the whole set is 17 KiB
  and Pages serves it from cache; the complexity buys nothing at this size.
