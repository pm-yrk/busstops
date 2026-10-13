# Pixel art

The artwork's source. Everything the product draws in the pixel idiom is drawn here and built
into `apps/web/public/art` plus an index at
`apps/web/src/components/pixel/sprites/generated.ts`.

```
npm run art        # redraw everything
node tools/pixel-art/sheet.mjs        # render a contact sheet to art-preview/
node tools/pixel-art/page-shots.mjs   # screenshot the running dev server at three widths
```

## The rules the drawings follow

- **One art pixel is one art pixel everywhere.** A sprite is authored at a deliberate native
  size on `Canvas`, and shown scaled by whole numbers. Nothing is ever drawn at 1.5x.
- **One palette** (`palette.mjs`), in ramps. A limited palette is not a flat one: each core
  colour carries a shadow, a mid and a highlight so surfaces have volume.
- **Light comes from the upper left**, in every sprite, without exception.
- **Silhouette first.** Each drawing starts from its outline and hangs detail on it. Detail
  assembled into a shape reads as a pile of rectangles; a shape with detail on it reads as a bus.
- **Irregularity is added, never subtracted.** Cutting discs out of a tree canopy spots it from
  the inside and shreds it from the rim; both were tried. Lumps are added instead.

## What is here

| file | what it draws |
| --- | --- |
| `canvas.mjs` | the char-grid canvas and its drawing operations |
| `palette.mjs` | the one palette, in ramps |
| `font.mjs` | the 3x5 face, for route numbers and shop signs |
| `bus.mjs` | the vehicle family: hero, mid, front, map marker |
| `street.mjs` | shelter, stop flag, trees, clouds, people, lamp, bench, bin |
| `buildings.mjs` | shopfronts and background blocks |
| `scene.mjs` | the two hero compositions and the strip that carries them off the edges |
| `png.mjs` | a dependency-free PNG writer |
| `build.mjs` | runs it all and writes the app's assets |
