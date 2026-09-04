# 02 — Design system

## Direction

Premium Korean/Japanese editorial clarity with playful pixel transport details. Use a warm-white canvas, near-black type, transport red as the principal accent, and restrained blue only for information/geography—not in the wordmark. Generous negative space, strong hierarchy, hairline grey rules, square/softly rounded geometry, and almost no heavy shadow.

## Brand

Hero wordmark is stacked:

```text
Bus
Stops.
```

The full stop is red and may contain a tiny front-facing pixel bus when legible; at small sizes use the plain red full stop. A thin red vertical rule may accompany the lockup. Horizontal usage is `Bus Stops.` Never revive unusual internal capitalisation or split the name into red/blue letters.

## Tokens

Define accessible tokens rather than scattering literals:

- canvas `#F7F6F1`, surface `#FFFFFF`, ink `#111111`, muted `#66645F`, hairline `#DAD8D1`
- primary red approximately `#E5242A`; dark red and pale-red status variants
- optional informational blue approximately `#1557FF`
- success/amber/critical colors selected to meet WCAG contrast; never communicate status with color alone
- 4/8px spacing rhythm; compact data density only in Pro tables
- 1px borders, small radii, shadow reserved for floating map panels

Use a modern grotesk/system sans with tabular numerals and a legible pixel/monospace display face only for boards, labels, and micro-illustrations. Do not render body copy in a pixel font.

## Pixel-art library

Create original consistent assets on a fixed pixel grid: side and front buses, bus-stop pole, shelter, road, traffic lights, cones/barriers, trees, bench, street lamp, shops, skyline, sun/cloud/rain/snow/flood, walking person, pin, clock, charts, warnings, and route/station marks. Preserve crisp edges, limited palettes, accessible alternatives, and reduced-motion fallbacks.

The artwork is authored as drawing code in `tools/pixel-art` and built to images; the small interface marks stay as `<rect>` units on a 16-unit grid. See ADR 0003 for why, and what that preserves and costs.

Required signature moments:

- Loading: a small pixel bus travels along a road; it must not block content indefinitely and must respect `prefers-reduced-motion`.
- Selected stop: a delightful mini digital arrival board with `NEXT BUS`, stop name/code, routes, countdowns, freshness, and scheduled/live state.
- Home: wordmark and small buses/roads above the fold; explanatory content reveals on scroll without hiding essential content from keyboard, assistive technology, or reduced-motion users.

## Components

Build reusable primitives: wordmark, route badge, state lozenge, metric tile, confidence/provenance chip, data-age label, arrival board, map sheet/panel, stop row, vehicle row, timeline, disruption card, evidence list, comparison bar, accessible chart, empty/error/stale state, skeleton, and quota/service banner.

## Maps and charts

Map base must be quiet and labels readable. Selected objects use red; routes retain distinguishable colors with redundant labels/patterns. Cluster at national/area zoom. Never attempt to render all England vehicles simultaneously in the browser. Charts need titles, units, comparison windows, tooltips, text/table equivalents, and color-safe palettes.

## Responsive behavior

Mobile is a first-class passenger surface: full-height map with draggable bottom sheet, 44px targets, thumb-friendly primary actions, safe-area support, and no hover-only interactions. Desktop Pro uses a grid with persistent navigation and denser evidence. Test 320px through wide desktop, zoom to 200%, dark OS chrome, high contrast, keyboard, and reduced motion. A dark theme is optional; do not compromise the approved light identity to add it.

## Content voice

Plain, calm, factual, and helpful. Display the action first. Avoid blaming operators or drivers. Distinguish “live,” “scheduled,” “estimated,” “inferred,” and “forecast.” Every anomalous claim includes evidence and confidence or a clear reason why confidence is limited.

