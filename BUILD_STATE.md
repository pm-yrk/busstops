# Bus Stops. Build State

Last updated: 2026-09-19 (run 67: page-specific scenes deployed; the 1102's cause is not what run 65 said)

## Current status

### Run 67: the scenes are deployed, and the 1102 diagnosis was wrong

`https://preview.busstops.pages.dev`. Nineteen of twenty-one data checks pass,
including geographic parity across eight English places and London, both journey
plans, and all five landmark searches. Two fail, and between them they overturn
run 65's conclusion.

**The route 1102 is not a byte problem.** Run 65 measured 0.93 MiB of SIRI-VM
XML on the route page's critical path and called that the cause. This run's
ledger says otherwise. The request that failed was the _smallest_ of the six:

```
Leeds#1 24  146ms   0.99 MiB   vehicles=0ms    bods fetch=0ms   0.44 MiB -> 283 accepted
Leeds#2 24  477ms   0.99 MiB   vehicles=276ms  bods fetch=276ms 0.44 MiB -> 283 accepted
Leeds#3 27  369ms   0.80 MiB   vehicles=161ms  bods fetch=161ms 0.44 MiB -> 283 accepted
Leeds#4 28 1200ms   0.76 MiB   vehicles=965ms  bods fetch=965ms 0.00 MiB -> FAILED   <- 1102
```

Fewest bytes, fewest stops (49), and it is the one that died. What is different
is the upstream: the BODS fetch took 965ms and returned **nothing**. Every
request that succeeded got its 0.44 MiB in 276ms or less, or out of cache.

So the correlation is with a **slow or failing upstream live fetch**, not with
parse volume — and the fix run 65 proposed, moving the XML off the critical
path, would not have addressed it. Taking the live lookup off the route page is
still probably right, but for a different reason and with a different measure of
success: what has to stop is a stalled upstream taking the whole request down.

**Also not established:** whether 1102 here is CPU or memory. The ledger reports
the isolate holding 2 shards / 3.88 MiB across requests, and trimming on the map
path ("held 8 shard(s)/6.58 MiB, trimmed 6"). That is well inside 128 MB, which
points at CPU — but Cloudflare's error page names neither, and nothing measured
so far distinguishes them. Naming one without evidence is how the last three
runs went wrong.

**The stop endpoint is intermittent, not weather-dependent.** `/v1/stops/:id`
passed for Piccadilly's departure board and 1102'd for Piccadilly's weather in
the same run, minutes apart. Same endpoint, same stop, different outcome. So
this is the same intermittent fault as route detail rather than a cost that
arrived with the weather artifact, which is what it looked like at first glance.

Visual sweep: 423 pass. The failures are almost all the same 1102 seen from a
browser — a missing `Access-Control-Allow-Origin` is what Cloudflare's error
page looks like to `fetch` — plus the live map failing to load any basemap tile
in the runner, which is worth separating from the rest next run.

**What this run actually shipped** is the art milestone: five page-specific
composed scenes, fourteen new props, and the stop page's wide world. Those are
described in the commit. I have not seen them on the deployment: this container
cannot reach `*.pages.dev`, so the only evidence available to me is the
workflow's own sweep, and the sweep has no check that looks at the new scenes.
That gap is the first thing to close next run.

### Run 66: the artwork stops being one illustration on the home page

The product had a street scene on the home page and seventeen pages of bare
`h2`s on warm white under it. Three pieces close that, none of them a redesign:

**A masthead band.** `PixelMasthead` puts a sliver of the hero's _own_ kerb tile
under a page title, full bleed, with one to three things standing on it. It is
the same `edgeWide` tile at the same whole-number scale, so every page stands on
literally the same pavement as the home page rather than on a second drawing of
one. Journey, Disruptions, Route and Operator take it; Pro takes the band alone
(`PixelKerb`) under the header it already has.

Three visual rounds were needed and each found a real fault by looking:

1. The props stood 104px tall in a 52px band and overlapped the heading. The box
   now grows to whatever is standing on it (`bandArtHeight`).
2. Everything stood six pixels _into the road_, because the band placed them on
   the bottom of its box rather than on the kerb. Fixed with `scene.mjs`'s own
   geometry — `{ pavement: 132, kerb: 154, road: 160 }` — not numbers read off a
   screenshot.
3. The tile is a whole building, so painting the band's full height sliced the
   terrace through the middle of its windows. Only the pavement-to-gutter strip
   is painted now; the props rise into transparent air above it.

A fourth fault was in the layout rather than the art: the props were positioned
with `:nth-child`, which counted the paving `<span>` as a child, so every offset
was one place out and the last prop had no rule at all. They are a flex row now,
which also handles a 96-pixel bus and an 11-pixel person in the same band.

**A section heading.** Route and Operator already headed their sections with the
pixel face, small and uppercase over a rule, and it was the best-looking thing on
either page. `PixelSectionHeading` is that treatment with a mark beside it, and
it is now the only one: the per-page copies in `RoutePage.css`,
`OperatorPage.css`, `DisruptionsPage.css`, `LiveMapPage.css` and `ProLayout.css`
were deleted rather than left to drift. Pro keeps its one deliberate difference —
a hairline rather than two pixels of ink, because Pro is calmer than Live.

Stop, Route, Operator, Disruptions, Home, Vehicle, Methodology, the live map's
two lists, the accessibility card, the official-notices block and eleven Pro
pages take it. Three new 16-unit marks were drawn for it (`PixelBusMark`,
`PixelStopMark`, `PixelPersonMark`): asking `PixelSprite` for a 24px bus rounds
to the nearest whole multiple of its 33-pixel height, which is one, so the
"small" mark would have come out 96 pixels wide. `PixelCloud` was redrawn too —
it was three rectangles of `--colour-hairline`, which on warm white is very
nearly invisible.

**The weather scene is on the stop page only.** It has come out of the map's
click panel entirely: that panel is a board, and a 384-pixel illustration above
the fold pushes the next bus underneath it. `SelectedStopBoard` is back to
58vh and a 500-560px desktop panel.

It also stopped being half a section. The `<figure>` carried an inline
`width` pinned to the artwork, so caption and picture wrapped to the picture's
column — right when they are stacked, wrong on a 1148px page, where the section
was 528px of content and 620px of nothing. The width is a CSS custom property
now, and above 900px the picture and its readings sit side by side.

**Journey times were an hour out in summer.** `clockLabel` was the only time
formatter in the app not going through `formatLondonTime`: it did UTC arithmetic
on a service-day offset, so during BST every journey time displayed an hour
behind — which is what "journeys in the past" was. Two tests asserted the wrong
numbers (01:10 and 09:00 for a 10:00 BST departure); they had encoded the
implementation rather than the requirement and now cover a BST date and a GMT
date each.

**And a CI failure that was nobody's regression.** `map-paints.spec.ts` has had
twelve cases red in CI for weeks, and the reason was environmental rather than
in the product: `configuredStyleUrl()` reads `VITE_MAP_STYLE_URL` at build time,
the e2e build never sets it, so `MapView` renders its list-only fallback and
never constructs a MapLibre map — and a spec that asks `queryRenderedFeatures`
what the renderer painted had no renderer to ask.

The first fix was the wrong one and the suite said so. Setting the variable for
the whole e2e build turned the map on for every spec, and the style-less build
is _deliberate_: the other specs use it to exercise the fallback a style-less
deployment really gets, and `art-bench` skips its marker section on exactly that
basis. Turning it on broke `art-bench` at two viewports — and incidentally
exposed that its marker assertions are themselves stale, written for DOM markers
the map replaced with GL layers, and only ever passing because that early return
always fired.

So the style is injected per-spec instead. `configuredStyleUrl()` honours a
`__busstopsMapStyle` global, the way `MapView` already exposes `__busstopsMap`
for the deployed visual pass, and `map-paints` sets it in an init script with the
glyphless style right there in the file. No route, no fetch, no 404, nothing
shipped to `public/`, and every other spec sees exactly what it saw before.

All twelve cases pass. They had never passed anywhere but a real deployment.

One thing worth writing down, because it cost a wrong conclusion. The first run
after the seam landed still reported three buses listed and none painted, and I
reported that as a possible live defect of the same class as run 51's glyph bug.
It was not. Playwright's `reuseExistingServer` had handed the run a preview
server left over from an earlier, killed run — serving a build made _before_ the
seam existed, so the injected style was ignored, `/style.json` 404ed, and the map
errored. A probe on a clean build showed the map entirely healthy:
`vehicle-pips` rendering 3 at zoom 12.4, `vehicle-clusters` summing to 3 at 11.9,
every icon registered, no console errors.

The lesson is narrow and practical: `reuseExistingServer` is true outside CI, so
a stale server silently invalidates any measurement taken after a source change.
Rebuild, or kill the server, before believing a number.

`art-bench`'s dead marker assertions are noted and left alone: that is a separate
change, and reaching into it while fixing something else is how a green suite
becomes an unreviewable diff.

Two of this run's own tests had to change, and both were describing the old
product rather than failing:

- The e2e assertion that the vignette is _in_ the map panel now asserts the rule
  it was given: the panel is a board, and clicking through to the stop page is
  where the picture is.
- `map-paints` read the bus count from `#vehicles-heading .lozenge`. The count
  now sits beside the heading rather than inside it, so that selector found
  nothing and the spec passed its first assertion by failing to look.

Gates: eslint clean, prettier clean, typecheck clean, 1180 node tests and 190 web
tests passing.

### Deployed: run 66

`https://preview.busstops.pages.dev`, Worker
`https://busstops-api-preview.paulmurrin13.workers.dev`.

**All twenty data-verification checks pass**, including the geographic parity the
brief asked for: Leeds, Manchester, Birmingham, Bristol, York, Newcastle,
Brighton and Shrewsbury all return real routes and departures, London returns
400 TfL stops with live arrivals and an honestly empty vehicle layer, and the
five landmark searches all resolve. 55 route-detail requests across eight cities
answered with no platform error page.

The visual sweep: **441 pass, 13 fail**, and every one of the thirteen is
accounted for.

**Mine, and fixed in this commit:**

- `phone/operator does not scroll sideways — 13px — span.pixel-masthead__paving
overhangs by 13px`. The masthead's full bleed uses `calc(50% - 50vw)`, and
  `100vw` counts the classic scrollbar while the page's own box does not. Only a
  long page shows it, which is why Operator was the one that caught it.
  `.app__main` now carries `overflow-x: clip` — `clip` not `hidden`, so it does
  not become a scroll container, and on `.app__main` not `.app`, so the header
  keeps `position: sticky`. Verified structurally rather than by eye: a
  deliberately 3000px-wide child inside main now produces zero page scroll.
- Six weather failures, all of the form "the selected stop board carries no
  vignette at all". Those checks asserted the old rule. The sweep now checks
  both halves of the new one: the map panel must carry no scene, and the page
  behind "Everything about this stop" must.

**Not mine, and still open:**

- Three CORS failures on `/v1/routes/:id` and `/v1/journeys`. No
  `Access-Control-Allow-Origin` is what Cloudflare's 1102 error page looks like
  from a browser. This is run 65's open item exactly, and the measured cause is
  unchanged: 0.93 MiB of SIRI-VM XML parsed on the route page's critical path.
- `desktop/journey-result-york is not accidentally empty` — the same 1102, seen
  from the page rather than from the console.
- `phone/vehicle` 404 on a vehicle ref. Most likely a vehicle that stopped being
  reported between the sweep picking it and asking for it, which is ordinary for
  a live feed; not yet confirmed either way, so it is listed rather than
  dismissed.

Also worth recording from the ledger, because it is the number the next run has
to move: route peak 1.44 MiB decoded, and the slowest route page was Birmingham
45 at `vehicles=972ms` against `route-patterns=77ms stops=151ms`. The live
lookup is now the overwhelming majority of a route request's time.

**Not done, and not claimed.** No new mockups reached the repository, so the art
_quality_ benchmark this run was asked to match could not be looked at; what is
here raises the treatment by the standard already written down in
`docs/02_DESIGN_SYSTEM.md`. The live map's clutter and bus-selection work is not
in this milestone. Run 65's open item — 0.93 MiB of SIRI-VM XML parsed on the
route page's critical path — is untouched and still the cause of the remaining 1102.

### Run 65: the stop read is a quarter of what it was, and the ceiling is still there

Route detail now resolves its stops from `network/map-stops` rather than the
general 0.25-degree tiles. Same routes, run 64 against run 65:

```
Leeds#4 874   stops 4.56MiB/237rec/3read  ->  stops 1.17MiB/278rec/5read
Leeds#3 28    stops 2.15MiB/49rec/1read   ->  stops 0.54MiB/49rec/1read
whole request      4.83 MiB               ->       1.44 MiB
```

A quarter of the bytes, and it resolves **more** stops than before — 278 of 281
against 237 — because the smaller rows fit inside the same budget. No republish
was needed: the projection was already published.

**And the 1102 is still there**, on Leeds attempt 5, with journeys and
`/v1/stops/:id` failing alongside it on the same isolate.

### What the trail now points at

With the stop read down to 1.17 MiB, the largest single thing a route request
parses is no longer JSON:

```
bods fetch=324ms parse=0ms 0.93 MiB -> 485 accepted
```

**0.93 MiB of SIRI-VM XML, parsed per route request**, to keep the handful of
vehicles whose published line matches this route. XML costs considerably more
per byte than scanning JSON lines, and `parse=0ms` is the Worker's clock being
unable to see its own CPU rather than evidence that it is free.

The bounded fix is a product change rather than a parser change: the route page
does not need its live buses in the same response. Fetching them separately, the
way the stop board already treats its live layer, takes that 0.93 MiB off the
critical path and lets the page render first. That is the next step, and it is
measurable the same way this one was.

Not attempted yet, and worth saying: filtering the XML at parse time would save
allocations and not bytes, and bytes have been the floor throughout.

### Runs 63-64: the collectors ran, and the remaining cost is named

**Nothing had ever collected.** `run_intelligence` was false in runs 59-62, so
Pro's empty sections were not a broken pipeline but a job nobody had asked for.
Worse, disruptions was _unaskable_: `disruptions.yml` exists only on this branch,
so its schedule has never fired and dispatching it answers 404, and the deploy
workflow had no step for it. "No disruption source has been queried yet on this
deployment" was exactly true and could never have become false. It has a step
now.

Run 63, the first collection in this project's history:

```
live collection  22,882 fetched, 21,495 accepted, coverage 1, "collected"
disruptions      ran, 57s, success
weather          42s successful, where run 60 lost all nine batches to rate limits
analytics batch  "outcome": "no_segments"
```

The chain breaks one link further on than I had found: the batch needs
`network/segments` from the OSM road extraction, which had never run either.

### Geographic parity, proven (run 64)

All eight places return real routes and departures, and not one needed the
`sparseOk` escape the three new ones carry:

```
Newcastle    Percy Street — 3 routes, 5 due, next X63 to Newcastle Monument
Brighton     Port Hall Road — 2 routes, 6 due, next 27 to Whitethorn Drive
Shrewsbury   Belvidere Lane Jct — 1 route, 1 due, next 23 to Bus Station
```

### The 1102's cost, measured rather than guessed

Per-family accounting was in the ledger all along and nothing printed it. It
now does, and it names the culprit on the first run:

```
Leeds#4 874: 4.83 MiB — route-patterns 0.27MiB/8rec, stops 4.56MiB/237rec/3read
Birmingham#1 35: 2.95 MiB — stops 2.65MiB/106rec/1read
```

**Route detail spends 94% of its bytes resolving stops through 0.25-degree
geographic tiles** — full `Stop` records at ~4 KB each, to get a name and a
coordinate. This is the same read the map replaced with `network/map-stops`.

The obvious substitution is wrong and worth writing down: `stop-detail` is 1024
hashed buckets, so a route's 237 stops land in ~200 of them and cost 200 object
reads. It is the right shape for one stop and the wrong shape for a route. The
right target is `map-stops`, whose rows are a quarter the size — **except that
its rows carry no `locality`**, which the route variant contract publishes. That
is the decision to make next: add `locality` to the projection (a republish), or
accept its loss, or narrow the read to the selected variant.

### Still failing

- Route detail, journeys and `/v1/stops/:id` still reach 1102 on a warm isolate.
  The cause above is the measured one.
- `phone/live` 1102s where desktop and tablet pass; the phone is the last width
  swept, so it lands on the most-used isolate.
- The weather scene reached scale 2 on a phone and was still **OFF SCREEN**: the
  arrival board fills a 62vh sheet and the picture starts past its bottom edge.
  Raised to 80vh; run 65 says whether that is enough.

### Runs 59-62: the republish landed, and the projection was working before I believed it

| Run | What it was for                                  | Outcome                                                                                                    |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 59  | First republish with `map-stops` + `stop-detail` | **Rolled back.** 11,483 shard objects wrote cleanly; `network/patterns` failed a 25% shrink guard at 32.4% |
| 60  | Republish with the guard fixed                   | **Published.** 1,681 MiB, 11,483 objects, inside the 2,560 MiB ceiling                                     |
| 61  | Cold Worker against the new artifact             | Same map numbers — which I misread                                                                         |
| 62  | Artifact diagnostic                              | `mapStopTiles=460 stopDetailBuckets=1024 projectionUsed=true`                                              |

**The shrink guard could not tell a Saturday from a broken read.** A pattern is
an ordered stop list accumulated only from trips inside the service-date horizon.
Run 59's horizon was Saturday and Sunday; the version it compared against was
published on the Friday, so its horizon held a weekday and its school runs, peak
extras and short workings. 31,045 against roughly 45,900. The report proves it
rather than suggesting it: **both source fingerprints came back `changed: false`**,
so the input bytes were identical to the build being compared against. Left
alone, that guard rejects every weekend rebuild. The relative comparison is now
0.6 and the protection moved to an absolute floor of one pattern per two
services — strictly more protection, since a floor does not assume the health of
the version it compares against.

**Three runs of self-correction on one number.** `/v1/map` reported `490 records
at 1.97 MiB` in runs 59, 60 and 61. I divided one by the other, got 4.2 KB, and
concluded it must be full `Stop` records — so I spent runs 61 and 62 hunting a
bug that was not there. `chars` counts the text a parse-time filter _scans_;
`records` counts what it _keeps_. 1.97 MiB scanned against the 7.00 MiB the two
general families used to read **is** the saving, and it had been live since run 60.

**The real defect was beside it.** The map reported `degraded
(stop_routes_budget)` on every dense viewport while every stop it drew carried a
full route list. `mapStopsInBoundingBox` returns `truncated: true` when the box
holds more stops than the map draws — a statement about marker count — and the
handler read it as "the labels are incomplete". With the projection the names
arrive on the same row as the stop, so the returned stops always have complete
labels. Fixed, with a test asserting both halves.

### What the deployment proves now

- Leeds → Leeds Bradford Airport and York Station → York Minster both plan, five
  legs each.
- 5 of 5 landmarks found, including `Bullring → Bull Ring`.
- London returns real TfL predictions; five cities return real routes and
  departures; 55 live vehicles; Pro reports `data mode live`.
- Visual sweep: **332 → 429 passes**.

### Still failing, and owned

- **Route detail 1102s in Bristol on attempt 4**, and `/v1/stops/:id` (so the
  weather field) 1102s outright. Both are the Workers Free 10 ms CPU ceiling on
  a warm isolate, not the artifact. `/v1/stops/:id` cannot report its own
  diagnostics while it 503s, so the way in is to reduce its work until it
  answers and then read what it says.
- **Phone `/v1/map` 1102s** where desktop and tablet pass — the phone is the
  last of the three widths, so it lands on the most-used isolate. Reported by
  the sweep as a CORS error, which is what a 1102 error page looks like from a
  browser: it carries no `Access-Control-Allow-Origin`.

### The visible passenger sprint (2026-09-19) — landed, evidence pending

Code on `claude/bus-stops-platform-build-f7qztb` through `e0f2a6e`. Gates: 1,175 node · 186 web ·
prettier · eslint `--max-warnings=0` · typecheck · secret scan clean. **Not yet photographed on a
deployment**: run 59 deployed Pages at 01:25 from `bdc78f1`, before any of this landed, so its
sweep is evidence about the _artifact_ and not about these surfaces. A follow-up run without the
bootstrap carries the frontend.

**The live map.**

- A selected stop has a ring, mirroring the selected bus. `emphasis` could not be reused for it:
  exploring with nothing chosen emphasises every stop — that is what "no filter" means — so a ring
  on emphasis rings four hundred stops at once. `selected` is one stop or none.
- Buses face the way they are going. The marker is a side view with its blind at the right-hand
  end, so it is already driving east; a bearing past 180° gets a mirrored texture. Not rotated: a
  side elevation turned through 200 degrees is a bus on its roof. No bearing keeps the eastbound
  drawing rather than inventing a direction.

**The weather artwork, and a two-pixel bug that made widening the panel pointless.**

The scene is 176 art pixels wide and is only ever drawn at a whole multiple, so the width the
panel hands it decides its size in steps. `.selected-stop__weather` bled out to the panel edge and
then padded itself back in, leaving the picture measuring the same column as the sentences. Full
bleed without the padding back gains 32px, which on a phone is a whole scale.

The desktop panel then went to 528 — three times 176 — which was arithmetic and was wrong:
`box-sizing: border-box` puts the hairline inside the width and the bleed does not cross it, so
the scene had 526px and floored to two. `tools/layout/panel-width.mjs` renders the panel's own
stylesheets over an empty box (no data of any kind — a ruler, not evidence about the product) and
reports what the scene actually gets:

```
desktop  1440   panel 533px   holder 531px   scale 3   scene 528px
tablet    768   panel 420px   holder 418px   scale 2   scene 352px
phone     390   panel 358px   holder 356px   scale 2   scene 352px
```

**Pro, using existing functionality only.**

- Congestion hotspots are charts: a ranked bar scaled to the list's own maximum, and a
  now-against-typical pair on one scale. "Most abnormal" ranks by rarity, so its bar grows as the
  frequency falls.
- `BandStrip` — one proportional bar, one hue in ordered steps, every band named and counted
  beside it — serves both the exception inbox's severity mix and the control tower's source
  health. A band with a count of zero is omitted; it has a test.
- Exception rows carry how long the exception has been running. Four minutes old and three hours
  old were identical on screen and are different situations.
- The Daily Brief has a masthead. It is the one Pro surface that is published, frozen and dated,
  and it was another `pro-section` with an h2.
- Route badges reach the Pro comparison table, so a route is the same object in both products.

**The sweep asks the questions a person asks of a screenshot**, because the artifact host that
holds the uploaded PNGs is outside this container's egress allowlist and they cannot be fetched
here. It now reports the weather scene's rendered size, the scale it landed on, the panel it sat
in, how many effect layers drew and whether the person, accessory and approaching bus are there —
reported, never asserted, since a clear noon has no effects and that is correct. A journey is
measured as an itinerary: legs, how many carry a route badge, whether a change is marked. A second
corridor was added, York Station → York Minster, because Leeds → its airport is a long
inter-urban hop and York is the short walk-plus-one-hop that most people actually plan.

### Run 58: the link targets are fixed, and the failure count tracks isolate warmth (2026-09-19)

Run 58 ([35408531339](https://github.com/pm-yrk/busstops/actions/runs/35408531339)) carried the
three `target-size` fixes.

**The stop-link violations are gone.** Run 57 reported three — `74.3px by 15px`, `126px by 15px`,
each with two pixels to its neighbour. Run 58 reports none.

**The obscured control moved rather than cleared**, and the new measurement says why:

```
run 57   .maplibregl-ctrl-zoom-out   partially obscured, smallest space 29px by 16px
run 58   .maplibregl-ctrl-zoom-in    partially obscured, smallest space 10px by 44px
```

Capping the phone sheet gave the buttons their full 44px of height. What was left is the _other_
axis: from 700px up the selected-stop board is a right-hand side panel running the full height of
the map, and MapLibre's default corner is the top right, so the panel covered all but ten pixels of
the buttons' width. Both measurements are the same mistake — putting the controls in the corner the
product uses — so they now go top left, where nothing is drawn at any width.

### The 1102 count tracks isolate warmth, not the last change

Worth stating plainly, because the run-to-run numbers look like progress and regression and are
neither:

```
run 56   4 failures   isolate req#1    (cold)
run 57   2 failures   isolate req#9    (warm)
run 58   4 failures   isolate req#1    (cold)
```

A cold isolate pays for the index as well — `index=142ms` against `index=0ms` warm — on top of the
same 7.00 MiB the viewport always reads. The CPU cost per request has not changed between these
runs because the bytes have not, and **that is exactly what the map projection is for**. Until it
is published, the honest summary is that the warm path is fixed and the cold path is not.

### Run 57: two more endpoints cleared, and what is left needs a republish (2026-09-19)

Run 57 ([35406889069](https://github.com/pm-yrk/busstops/actions/runs/35406889069)) carried the
national-services fix and the `nearby` radius filter.

**The services fix is visible in every residency line:**

```
before   national operators=636/services=13593/places=3178
after    national operators=636/services=0/places=3178
```

The national services table is no longer built at all. **Both endpoints it was targeting now
pass**: London's departure board (`Waterloo Station / Tenison Way: 5 departure(s), 5 live from
TfL`) and `/v1/nearby` (`25 within 800m of Piccadilly`), each a 1102 in run 56.

The 1102 count across the last four runs: **5 → 2 → 4 → 2**, and the two remaining are `/v1/map`
under repeated dense-city load, and the weather field on a non-London stop page.

### What is left is bytes, and bytes need a republish

Both remaining failures are endpoints that scan a 0.25-degree stop tile, and the measurement above
prices that at about three milliseconds a mebibyte before an object is built. Two things were
checked and ruled out rather than assumed:

- **The departure read is already optimal.** `decodeDepartureShardForStop` finds its stop's line
  with one native `indexOf` and parses that single line. It is not what costs.
- **The scan, not the parse, is the floor.** 39.3 ms to parse everything, 21.2 ms to scan and
  filter and parse 364, against a 10 ms budget.

So `network/map-stops` is built, tested and pushed: the stop and stop-route families projected to
what a marker actually draws, in one read instead of two, with the reader returning null and
falling back when an artifact has no projection tiles. **It needs a national republish to take
effect, and no bootstrap has been dispatched** — that is Paul's call, and it is the same call as
the finer stop grid, which is what the _stop page_ would need for the same reason.

### Measured: the filters cannot finish the job, because the scan is the floor (2026-09-18)

The parse-time filters took `/v1/map` from 23,806 objects to 788. They cannot take it under the
limit, and here is the number that says so — same 7.00 MiB of text the deployment reads, same
viewport, measured in Node:

```
parse everything:        39.3 ms   (14,098 records)
scan + filter + parse:   21.2 ms   (364 kept)
Workers Free budget:     10.0 ms
```

**Walking the text costs about three milliseconds a mebibyte whatever is kept.** Finding line
boundaries and reading two numbers out of each line is unavoidable once the bytes are in hand, so
a 45% saving is the most this approach can give, and 21 ms is still twice the budget.

So the remaining fix is **fewer bytes**, not fewer records, and there are two ways to get them:

- **A finer stop grid.** Tiles are `STOP_TILE_DEGREES = 0.25`. The verification's Leeds viewport is
  0.11° by 0.05° — a fraction of one tile — and reads seven of them, because a viewport that
  straddles a boundary takes the whole of every tile it touches.
- **A narrower record.** A published `Stop` carries `provenance`, `qualityFlags`, `localityId`,
  `amenities`, `naptanStatus` and `supersededByStopId`; a map marker uses none of them. A per-tile
  projection holding only what a marker draws would be a fraction of the bytes.

Both need a national republish, which is the decision already put to Paul rather than taken here.
The code can be written and tested without running one, and that is the order it will be done in.

### Run 56: 23,806 records become 788, and every landmark resolves (2026-09-18)

Run 56 ([35406254385](https://github.com/pm-yrk/busstops/actions/runs/35406254385)) carried the
stop-routes filter, the live-feed parse cache, the Bullring spacing fix and the station aliases.
**321 sweep checks passed**, up from 300 and 202.

**The parse-time filters, measured across three runs on the same viewport:**

```
run 54   7.00 MiB decoded;  23806 record(s)
run 55   7.00 MiB decoded;  13285 record(s)   (stops filtered)
run 56   7.00 MiB decoded;    788 record(s)   (stop-routes filtered too)
```

**Thirty times fewer objects built to answer the same question**, and `degraded: stop_routes_budget`
is gone — the enrichment now completes instead of being cut off, so the stops carry their services
without the budget talking it out of it.

**Every landmark P7 names now resolves**, including the two that did not:

```
5 of 5 landmarks found — York Minster → York Minster; Leeds Station → Leeds;
Manchester Arndale → Manchester Arndale; Bullring → Bull Ring;
Bristol Temple Meads → Bristol Temple Meads
```

**The remaining 1102s are cold-isolate failures.** The map line reports `isolate req#1` and
`national operators=0/services=0/places=0` — a fresh isolate, dying on its first request. Four
endpoints lose: the London departure board, `/v1/nearby`, `/v1/map` at Leeds, and weather. That is
a different failure from the warm-isolate one that has now gone, and it points at what a cold
isolate has to build before it can answer anything.

**Which is the national tables.** `readCurrent` hashes a whole multi-megabyte object and parses
every record in it: services 13,593, places 3,178, operators 636. `servicesByIds` and
`servicesForOperator` now make one pass over the text and parse only what is wanted, and the
departure board, route, vehicle and operator pages all move across.

**And `/v1/nearby` had the same shape in plain sight.** Its own comment says a quarter-degree tile
"holds tens of thousands of entries, all of which had to be decoded to answer a question about
eight hundred metres" — and the cap added in response bounds the _bytes_, not the parse. The radius
box was already being computed to pick the tiles; it is now handed to the parse as well.

### Run 55: the filter works, the 1102 halves, and the Bullring was a space (2026-09-18)

Run 55 ([35403959643](https://github.com/pm-yrk/busstops/actions/runs/35403959643), `67127fb`)
carried the viewport parse-filter and nothing else, so it measures that one change.

**The filter works.** The map's record count, same viewport, same 7.00 MiB of text:

```
run 54   7.00 MiB decoded; 23806 record(s)
run 55   7.00 MiB decoded; 13285 record(s)
```

The remainder is not stops. The same run reports `degraded: stop_routes_budget` and
`enrichment was skipped (stop_routes_budget)` — the ~12,900 records left are the **stop-routes**
family, which run 55 predates the filter for. That is `aa27d6a`, already committed, and it is the
next thing the numbers should move.

**The 1102 more than halved.** Run 54 answered the platform's error page on `/v1/search`, the
London viewport, `/v1/nearby`, `/v1/stops/:id/weather` and `/v1/map` on **attempt 1 of the first
city**. Run 55 loses only `/v1/map` — on **attempt 3, at the third city** — and the weather
endpoint. Everything else passed: search, London stops, Waterloo's 7 live TfL arrivals, nearby,
route detail, both journeys, Pro on `data mode live`.

Isolates now reach **req#19 through req#26**, against req#2 in run 54, and the residency trail
shows trimming doing real work: `held 15 shard(s)/11.31 MiB/44499 record(s), trimmed 13, left 6
shard(s)/4.37 MiB/14489 record(s)`.

**`bods fetch=0ms parse=0ms 0.00 MiB → FAILED`** on every route-detail live lookup is the breaker
open at 00:21 local, outside service hours, which is the honest answer rather than a fault.

### The Bullring was never missing; OpenStreetMap spells it "Bull Ring"

Run 54's places report lists Birmingham's twelve shopping centres in full:

```
Bull Ring (shopping)
```

Birmingham extracted **290 places**. The bounding box contained it. The ranker was measured and
correct. Tokenised, `"Bull Ring"` is `["bull","ring"]` and `"Bullring"` is `["bullring"]`, which
share no token — so it scored zero and was never returned.

Five runs looked for that in the extraction, the bbox and the scorer in turn, because **the
diagnostic I wrote for it asked the wrong question**: it searched the city, and a name search finds
names, so it returned eight places all beginning "Birmingham" and said nothing about the landmark.
It now probes the landmark's own words, each alone.

The ranker fix is general: where the spaced comparison finds nothing, query and title are compared
with spacing and punctuation removed. A match that disagrees only about a space scores as an exact
match; a query that already matched never reaches the branch, so ordinary scoring is untouched and
a test pins "Grand Central" at exactly 92.

### The 1102 is CPU, the plan allows 10 ms of it, and every budget here is wall clock (2026-09-18)

**This corrects the explanation I gave for the viewport fix earlier today.** I said the isolate was
running out of memory. It is not, and the measurement says so.

**What 23,806 parsed stop records actually cost**, measured in Node against records of the same
shape:

```
source text: 12.79 MiB
heap for the parsed objects: 17.3 MiB
ratio to source text: 1.3x
```

Parsed objects cost **1.3× their text**, not the five-to-ten I had assumed. The real map request
decodes 7.00 MiB, so its records are about 9 MiB, and the peak including the source text is under
20 MiB — against a **128 MB** isolate. Memory was never close.

**The limit being exceeded is CPU, and it is 10 milliseconds.** From Cloudflare's own limits table:

| Feature  | Workers Free | Workers Paid |
| -------- | ------------ | ------------ |
| CPU time | **10 ms**    | 5 min        |
| Memory   | 128 MB       | 128 MB       |

and, in the same document: _"CPU time measures how long the CPU spends executing your Worker code.
Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not**
count toward CPU time."_ `apps/worker/wrangler.toml` says in as many words: _"Keep the Worker on
the free plan explicitly: no usage-based pricing path."_

**Every budget in the Worker is denominated in the wrong unit.** `MAP_ENRICHMENT_BUDGET_MS = 1800`,
`ROUTE_DETAIL_BUDGET_MS = 1200`, `JOURNEY_BUDGET_MS = 6000`, `NEARBY_BUDGET_MS = 1500`,
`LIVE_LOOKUP_BUDGET_MS = 2500` — all wall clock, all hundreds or thousands of milliseconds, against
a real ceiling of ten milliseconds of compute. Which is why run 54's map request reported

```
509ms of a 1800ms budget ... degraded false
```

and was killed anyway. It was measuring the one resource that was never scarce. R2 reads and the
BODS fetch, which those budgets mostly bound, cost **no CPU at all**.

This accounts for every observation the last dozen runs produced:

- Isolates dying at req#2 and at req#9 indifferently — the limit is per invocation, not cumulative,
  so isolate age was never going to predict it.
- The retry bound helping and not fixing it: retries are network wait, which is free.
- `/v1/search`, `/v1/nearby` and the weather endpoint dying alongside the map — each parses shards
  of its own.
- The SIRI-VM parse measured at ~100 ms per MiB: that one parse is ten times the entire budget.
- Route detail, which reads least, surviving most.

**So the parse-time filters are the right fix for the wrong stated reason.** They remove
`JSON.parse` and object construction, which is pure CPU, and that is exactly the scarce resource —
the viewport filter and the stop-routes filter both stand, and their value is larger than I claimed,
not smaller. What does not stand is any budget that counts milliseconds of wall clock and reports
`degraded false` while the request is over its compute limit.

**The next candidate, measured but not yet changed.** `NetworkReader.services()` reads the national
services dataset through `ArtifactStore.readCurrent` and parses **13,593 records**, and it is
reached by the departure board, the route page, the operator page and the vehicle page — four of
the busiest passenger endpoints. It is cached per isolate, which sounds like it makes the cost
rare; it does the opposite while the 1102 persists, because every kill produces a cold isolate and
the next request pays the parse again. That is a feedback loop: over the limit, isolate destroyed,
next request cold, over the limit. It is deliberately left for the run after this one, so that the
three CPU reductions already made can be attributed before a fourth is stacked on them.

**The direction this implies** is that the edge should parse almost nothing: the artifacts want to
be shaped so `/v1/map` is a read and a concatenate rather than a read, a parse, a filter and a
rank. That is a larger change than the filters and it is put to Paul rather than started, because
the alternative — Workers Paid — is a £5/month path that `CLAUDE.md` forbids.

### Run 54: the journey plans, Pro is live, and the 1102 is one request's own peak (2026-09-18)

Run 54 ([35371821396](https://github.com/pm-yrk/busstops/actions/runs/35371821396), `651e766`) —
no bootstrap, retention applied, places and weather collected. **300 sweep checks passed**, up from 202.

#### Three things that were broken are now working

**The geographic pattern index did what it was rebuilt for.** Leeds → Leeds Bradford Airport
plans, and the numbers are the whole argument for the change:

```
patterns from the index-tiles (4 corridor pattern tile(s));
pattern index 4 read / 0 missing, 1.93 MiB, in 760ms
1 option(s): 3 legs (walk → bus → walk), 0 change(s), 9 min walking
```

Four tiles and 1.93 MiB, against the hashed layout's ~90 buckets and ~12 MiB for half the patterns
wanted, measured identically across runs 47, 50 and 52. **P1's journey defect is closed.**

**Pro is back on live intelligence** — `data mode live` — after reporting 503 in run 53. And **a
journey to a place found by searching for it** works: `York Station → York Minster: 2 option(s)`.

**The places gazetteer re-extracted and published 3,178 places**, including London.

#### The 1102 is one request's own peak, not accumulation

The map diagnostic is the measurement:

```
509ms of a 1800ms budget; 2 object(s) read, 5 cached; 7.00 MiB decoded; 23806 record(s);
degraded false, isolate req#2: held 7 shard(s)/7.00 MiB/23806 record(s), trimmed 2,
left 7 shard(s)/7.00 MiB/23806 record(s), national operators=0/services=0/places=0
```

**`req#2`, with no national singletons resident**, and the 1102s land immediately after it on
`/v1/search`, the London viewport, `/v1/nearby`, `/v1/stops/:id/weather` and Leeds on attempt 1.
Run 53 died at req#9 holding 636 operators, 13,593 services and 3,178 places. The two runs have
almost nothing in common except the map request itself, which is identical in both: **7.00 MiB
decoded into 23,806 records to answer with 400 stops.**

So the fix is to stop building the 23,406 records that are thrown away. The bounding box now
decides _before_ the record is built, through the same parse-time `LineFilter` the route path
already uses; `numberAt` reads a JSON number in place because `valueAt` expects a quoted value and
a coordinate is two numbers. A filtered parse is never cached, so a viewport read no longer fills
the shard cache at all. `stopTilesForBoundingBox` is a quarter of a degree and a dense city fills
one, so the ratio was a property of the grid rather than of that viewport.

Two existing cache tests drove the cache through `stopsInBoundingBox` and would have silently
stopped testing anything; they now read tiles unfiltered, and the trim test fills from two families
so it still proves eviction against more than one shard rather than being loosened to fit.

`sliceForBoundingBox` is deliberately left alone: a journey wants its corridor's stops, and that
endpoint did not 1102.

#### Two of the sweep's failures were the sweep again

Said plainly because both would otherwise read as product defects:

- `(no route) to (no destination) — no facts` at all three widths was the selected-bus panel's
  **loading state**, photographed after a fixed three-second wait. The component renders
  `LoadingBus` while its lookup is in flight and a real message when it fails. The check now waits
  for it to settle and reports "still loading after 15s" as its own outcome.
- `(no heading)` after following a route or vehicle link was the same fault: those pages refresh on
  a ticker, so `networkidle` never arrives, the wait always expired, and the DOM was read before
  anything had rendered. It now waits for a heading or an error state.

#### What is genuinely still open

- **`target-size` (serious) at phone**, on `.maplibregl-ctrl-zoom-out` and a stop link. Real, and
  **not reproducible here**: this container cannot reach the basemap host, so MapLibre never draws
  its controls. The sweep now carries axe's own `failureSummary`, which has the measured sizes, and
  the live-map accessibility test has been given a map with stops on it — its mock served
  `EMPTY_MAP`, so it was scanning a page with nothing on it to scan.
- **`Bullring`** is still unanswered: the 1102 killed the place-search check on "Leeds Station"
  before it reached the city diagnostic.
- The live map not painting at desktop and tablet remains the honest error state after `/v1/map`
  fails, not a separate rendering defect.

### Run 53: the bucket went over the free tier, and the 1102 is still there (2026-09-18)

Run 53 ([35359663871](https://github.com/pm-yrk/busstops/actions/runs/35359663871), `bd7d219`).
The bootstrap **succeeded** in 88 minutes — I had expected it to hit its 110-minute limit and it
did not — and both the verification and the sweep ran. **202 sweep checks passed.**

#### The finding that matters most is not the 1102

```
objectsBefore  32,000        bytesBefore  11,343,998,119   withinFreeStorageBefore  false
objectsAfter   22,455        bytesAfter    8,614,826,531   withinFreeStorageAfter   true
deleted 5,304   removable 9,545   remainingAfterRun 4,241
deletesPerSecond 4.01        stoppedBecause "time budget spent"
```

**The artifact bucket was over R2's 10 GB free storage before retention ran**, and retention could
not finish: it cleared 5,304 objects of 9,545 and ran out of its 35-minute budget with 4,241 still
removable. Then the bootstrap wrote a whole new national artifact on top. `CLAUDE.md` makes £0 a
non-negotiable, so this is ahead of the 1102 in priority.

**The 4.01 deletes per second is an account limit, not a slow loop.** `R2ObjectStore` addresses
objects through Cloudflare's REST API (`api.cloudflare.com/client/v4/…/r2/buckets/…/objects/<key>`),
one request per object, and that API is rate-limited per account at roughly this rate — which is
why a comment in `publish.ts` already records "about 4.35 objects a second whatever concurrency it
used". Concurrency 16 cannot beat it. R2's **S3-compatible** API is not on that limiter and takes
up to 1,000 keys in one `DeleteObjects` call, which would turn 9,545 deletes into ten requests —
but it signs with an R2 access key ID and secret, which this deployment does not have. **That is a
credential decision for Paul**, recorded rather than assumed.

Without it, two things keep the bucket inside the tier: run retention often enough that the
backlog never builds (one more pass clears the present one), and write fewer objects per
bootstrap.

#### The 1102 is better and not gone

```
FAIL  the pattern-heavy endpoints survive dense cities, repeatedly — Leeds: /v1/map answered
      the platform's error page ... on attempt 2
FAIL  a journey can be planned across real timetable data — 503, error 1102
FAIL  Pro is reachable with no credential and states its data mode — expected 2xx, got 503
```

The bound did work, and the diagnostics say so plainly:

```
Leeds#1 3: vehicles=839ms, bods fetch=839ms parse=0ms 0.00 MiB -> FAILED
```

One attempt, 839 ms, failed inside the deadline — against the 3.5–4.6 s retry chains of runs 50–52.
And isolates now reach **req#13 and req#14** before dying, against **req#2** in run 52. Neither of
those is the finish line: `/v1/map`, `/v1/journeys` and `/v1/pro/control-tower` still return 1102
under load, so **P1 is not done and P10 has regressed** (Pro was `dataMode = live` in run 46).

What the same lines now show, which no earlier run did, is what an isolate is holding while it
happens: `national operators=636/services=13593/places=3178` resident, plus up to 11.80 MiB of
shards before trimming, and a single map request decoding 7.00 MiB into 23,806 records. That is the
next thing to measure rather than the next thing to assert.

#### What is genuinely working

Five cities with full boards (Leeds 20 due, Manchester 17, Birmingham 17, Bristol 20, York 1 —
York at 17:54 local is honest), 191 live BODS vehicles, London proven again (400 of 400 stops with
London ATCO codes; Waterloo Station / Tenison Way 12 departures, 12 live from TfL), the map inside
its budget at 1,338 ms of 1,800 with `degraded false`, CSP and CORS exact.

#### Still open from this run

- `Bullring` remains the one landmark of five not found. My city-listing diagnostic was committed
  after `bd7d219`, so run 53 could not print it.
- `Leeds Station` resolves to `Leeds City Bus & Coach Station`, not the rail station.
- The vehicle page logs a **404** at all three widths.
- The live map fails to paint at desktop and tablet — which is the honest error state following the
  `/v1/map` 1102, not a separate rendering defect.

Run 54 is dispatched with **no bootstrap**, retention applied, and places and weather on: it clears
the storage backlog, answers `Bullring`, collects weather, and is the first run to exercise the new
Bus stopped?, search-results, cross-navigation and deployed-axe checks.

### Waiting on run 53: three honesty defects fixed, one hypothesis disproved (2026-09-18)

Run 53 ([35359663871](https://github.com/pm-yrk/busstops/actions/runs/35359663871), `bd7d219`) is
still bootstrapping the national artifact. Everything below was done locally while it runs, and
none of it needs a deployment to be correct.

**"Bus stopped?" could tell a passenger nothing was due about a board it had never read.** The
panel gathers its own context behind the button — the other buses in the viewport, the departure
board at the stop this one is heading for — and took `otherVehiclesObserved={0}`,
`otherVehiclesMoving={null}` and `nextServices={[]}` whether that lookup had finished, failed, or
genuinely come back empty. Three different facts, one sentence. It now carries the state with the
numbers: only `ready` licences a claim about the world, `unavailable` offers a retry, and the peer
counts are withheld from the assessment until they mean something (`otherVehiclesMoving: false`
with nothing observed reads as "nothing nearby is moving", which is a claim about the road).
Official incidents are deliberately _not_ withheld — they arrive with the vehicle, not the lookup.
The state is derived from the lookup's own key rather than a flag set as the effect starts, so it
costs no extra render and a stale answer from the previous viewport cannot be mistaken for this
one's.

**The sweep had never opened that panel, and had never run a search with anything in it.** Both are
now targets at all three widths. The search one asserts the specific defect this page had: a result
linking to `/search?q=<its own title>`, a loop that read as a broken link. Saved's empty state also
offered to save "a stop" when the route page has had a working save control for some time.

**The `Bullring` ranking hypothesis was wrong, and testing it was the point.** A plausible story was
that `searchIndex` weights all query tokens equally, so "Birmingham Bullring" would be swamped by
everything else named Birmingham. Measured against an index of 300 Birmingham stops plus the
landmark: `Bullring = 19.50`, `Birmingham Road Stop N = 13.50`. The prominence bonus carries it and
the ranking is fine. Birmingham's bbox (`-1.96,52.43,-1.83,52.52`) also contains the Bullring's
real position, so the bbox is not the gap either. That leaves extraction — the OSM tagging against
`placesQuery`'s selectors — and Overpass is blocked from this container, so **only a CI places run
with the improved report can answer it**. That run is queued behind run 53 rather than guessed at.

**Two things checked and found already correct**, recorded so they are not re-opened: the homepage's
London copy is accurate (it states plainly that TfL publishes no vehicle positions, so there will
never be a bus on the map in London, and describes what London does have), and the journey
itinerary continuity check does cover transfer walks — every leg takes its coordinates from the
same graph stops, and the access and egress walks both carry the stop id the adjacent leg carries.

Gates: 1,147 node, **174 web** (168 + 6), 166 e2e; prettier, eslint `--max-warnings=0`, typecheck,
secret scan clean across 512 tracked files. Production untouched.

### Run 52: bounding one caller bought nothing, and the index moves grid (2026-09-18)

Run 52 ([35357930168](https://github.com/pm-yrk/busstops/actions/runs/35357930168)) ran in the
afternoon peak and was **worse** than run 51, on a Worker that had not changed between them. The
platform answered `/v1/map` on the first attempt of the first city, and took `/v1/search`,
`/v1/nearby` and the London viewport down with it.

**The reason is that the previous commit bounded route detail's live lookup and nothing else.**
The map, the vehicle page and the live endpoint still called `vehiclesInBoundingBox` with no
deadline, so they still got three attempts and two backoffs against a slow upstream. A request
holding a four-second retry chain does not fail alone: `/v1/search` reads no live feed at all and
died anyway, on the same isolate. **A fix that covers one caller covers none.** All four call sites
are bounded now, and a test reads `index.ts` and fails on any call site that passes no deadline.

The surviving map request corroborates the mechanism: `isolate req#2`, where earlier runs reported
req#9 to req#20 by the same point in the verification. Isolates are being destroyed and replaced,
which is what 1102 does.

**The pattern index moves to the grid it is queried on.** Four runs measured the same ceiling:

```
run 47   112 of 197 patterns   91 buckets   12.23 MiB
run 50   113 of 229 patterns   89 buckets   11.91 MiB
run 52   116 of 231 patterns   90 buckets   11.96 MiB
```

The hashed buckets were the right idea aimed at the wrong question. A corridor wants the patterns
along one strip of the country, and a hash scatters them across all 512 buckets — so the planner
read a bucket per pattern and discarded almost all of each. The same rows filed by **where the
pattern runs** put a corridor's patterns in the two or three tiles it crosses, where almost
everything is wanted; run 48 measured the geometry version of that read at 4.21 MiB for 625
patterns, and these are those patterns without their polylines.

The hashed layout stays published and readable, because an artifact built before this existed has
to keep working until it is rebuilt. **This is the one change that has genuinely required a
national republish**, which is why run 53 carries `bootstrap_data: true` with retention applied
first.

### Run 51's sweep: one real defect, two faults in the checking (2026-09-18)

The extended sweep became readable for the first time in run 51
([35315999539](https://github.com/pm-yrk/busstops/actions/runs/35315999539)) — 193 checks passing
and a list of failures. Three of them were investigated locally. **One was the product and two
were the sweep**, which is worth recording as plainly as the defect itself, because both wrong ones
were reported as product failures first.

**Real, and the cause is one line.** `0 bus(es) painted ... the list says 155`, at every width.
`vehicle-pips` drew its directional mark with `"text-field": "▲"`, and a symbol layer's text needs
glyphs: the basemap must serve a font, and MapLibre asks for its **default** stack unless told
otherwise. The deployment's two unexplained 404s are those glyph requests. Reproduced locally
against a style with no glyphs at all — stops drew, buses did not — and fixed by making the mark an
image built in code (`addImage`, `icon-rotate`) so it depends on no font at all. Desktop went from
`busesDrawn: 0` to `busesDrawn: 3` against a list of 3.

The same fault was in three more layers, all of them P3 requirements: the two cluster counts
("clustered live vehicle counts") and the route number on a bus at street zoom ("route numbers
where known"). Those are genuinely text, so they genuinely need a font — and rather than hard-code
a name and hope, which is the same guess in a different place, the layers now **borrow whatever
stack the basemap's own labels use**. Change the basemap and the map follows it. Where a style has
no symbol layers at all, the text is omitted and the circles and icons still draw.

`tests/e2e/map-paints.spec.ts` holds it: every bus the list counts is on the map, at three widths,
against a style with no glyphs.

**Not real: "the passenger gets a blank screen."** The sweep reported `canvas absent, list-only
fallback not shown` and that was read here as a blank page. The page was showing its error state
with a retry, which is honest; the check knew two outcomes and there are three. It now separates a
missing map from an API that failed and said so — a real failure either way, but the API's, and
calling it a missing fallback sends the next person looking in the wrong place.

**Not real: "the mobile hero shows no buses."** The check counted `.street-scene__vehicle img`
inside `.street-scene__street`, and the traffic is deliberately a **sibling** of the composition —
the composition is as wide as the artwork and clips what overflows, which is why a bus used to
vanish two thirds of the way across a desktop window. The check had been reporting that fix as
"0 vehicle frames" ever since. Measured locally after correcting it: **4 vehicle frames at
desktop, tablet and phone.**

### Run 50 names the 1102: BODS times out and is retried three times (2026-09-18)

The fetch/parse split answered it on the first run that carried it
([35315151386](https://github.com/pm-yrk/busstops/actions/runs/35315151386)):

```
Leeds#2 3:   vehicles=192ms   fetch=192ms   parse=0ms  0.46 MiB → 301 accepted
Leeds#2 3A:  vehicles=3746ms  fetch=?       parse=?    0.00 MiB → 0 accepted
Leeds#3 3A:  vehicles=3710ms  fetch=?       parse=?    0.00 MiB → 0 accepted
Leeds#3 24:  vehicles=3548ms  fetch=?       parse=?    0.00 MiB → 0 accepted
Leeds#4 24:  vehicles=1640ms  fetch=1640ms  parse=0ms  0.47 MiB → 304 accepted
Leeds#4 116: vehicles=4367ms  fetch=?       parse=?    0.00 MiB → 0 accepted
                                                          → 1102 on attempt 5
```

**The parse is 0ms.** A local benchmark had put it at about a hundred milliseconds a mebibyte —
2.51 MiB in 242ms, 7.53 MiB in 728ms — and the real feed is under half a mebibyte, so the parse was
never the cost. The stages that take three to four seconds report `?` because the fetch **threw**:
they took the catch branch, and `fetchMs` was assigned after the call rather than before it.

Three to four seconds from a call bounded at 1,200ms is the retry chain. `SourceClient.fetchText`
retries three times with exponential backoff and its `timeoutMs` bounds **one attempt**, not the
operation — so handing it the request's remaining time, as the previous commit did, made the
overrun worse rather than better: the first attempt now times out where it would have finished, and
two retries and their backoff follow.

So a caller that passes a deadline gets one attempt inside it; a scheduled collector with no
passenger waiting keeps its three. And the failure path now records how long it spent failing,
which is the number that went missing exactly where it was needed.

**This also explains the shape of the whole defect.** The 1102 never landed on a particular
endpoint — route detail in runs 45 and 48, `/v1/map` in runs 49 and 50 — because it was never
about what an endpoint reads. It followed whichever request was holding a four-second upstream
retry when the isolate ran out, which is why it looked intermittent and why residency, bytes and
record counts all came back innocent.

### Run 49: London proven in service hours, and 1102 has one common factor (2026-09-18)

Run 49 ([35313671271](https://github.com/pm-yrk/busstops/actions/runs/35313671271), head
`ce4ad55`) ran at 06:14 — the first verification inside service hours.

**P11 is done.** `a London stop returns real TfL arrival predictions — Waterloo Station /
Tenison Way: 12 departure(s), 12 live from TfL`. Every earlier run asked at three in the morning
and could only show that the path worked. The passenger claim on the home page now rests on
evidence.

Service hours also fill the rest in: **128 live vehicles** where 3am showed seven, and the five
cities return 20, 18, 20, 20 and 3 departures due.

**Every 1102 this deployment has produced follows the largest `vehicles` stage in its own trail.**
Run 49's route trail, against a 1,200ms budget:

```
188ms · 1379ms · 257ms · 1729ms · 332ms · 2530ms   → then 1102, this time on /v1/map
```

Every other stage in those requests is tens of milliseconds — `route-patterns=97ms stops=96ms
disruptions=95ms`. The stage scales with the morning traffic, and the kill lands on whichever
endpoint reads the feed when it is heaviest: route detail in runs 45 and 48, the map in run 49.

The deadline handed to the fetch in the commit before did not shorten it, which points at the
parse rather than the network — but "points at" is not a measurement, and the last sound-looking
inference that went in without one cost three runs. So the stage reports its fetch and its parse
separately now, with the bytes, and the route trail prints them. Run 50 says which half to fix.

**A byte limit went up, stated plainly.** A journey corridor now gets six mebibytes of pattern
where the map gets three. Three is the map's number and protects against a viewport, which can
span ninety-six pattern tiles; run 48 measured a corridor at two tiles and 4.21 MiB holding 625
patterns, where the index path spent 12.23 MiB across 91 buckets for 112. The cheap read was being
stopped by a number chosen to protect against the expensive one. Every other bound is unchanged,
the reader still refuses a caller's budget above the request's own ceiling, and a corridor past two
tiles still goes to the index.

### Runs 47 and 48: London proven, and both journey paths named (2026-09-18)

**P11 London passes on the deployment.** Run 47:
`400 stop(s), 400 with a London ATCO; sources [tfl]; vehicle layer empty, as TfL publishes no
positions`, and a real 490 stop answers. Stated plainly: that second check ran at 03:23, outside
service hours, so it proved the path and not the predictions — the live claim still needs a
daytime run. The home page and the live map now say London has live arrivals at every stop and no
buses on the map, rather than describing a permanent property of TfL's API as a temporary gap.

**The pattern index reads seven times more than the tiles it replaced.** Run 47 measured it
exactly: `112 of 197 pattern(s) resolved; pattern index 91 read/0 missing, 12.23 MiB` — the
request's whole byte budget, with the ledger's own stop reason absent, so the clock did not end it.
A bucket averages **137 KB** because it holds every pattern in England whose id hashes to it, and a
corridor wants a handful from each.

Run 48 took the tile path instead and measured the other side: a four-tile corridor read
**4.21 MiB across two tiles** before the three-mebibyte pattern budget cut it short, so the slice
came back incomplete and the journey refused before the trips were read at all. But the same read
held **625 patterns** where the index path held 112 — about fifteen times more pattern per byte.

So the tile limit is **one**, which is where run 44 proved it works, and above that the index is
used. **Neither path plans a multi-tile corridor today.** That is the honest state. The fix is to
bucket the pattern index so a corridor's patterns land together instead of hashing across the
country — which is a republish of a national artifact, and is not being done unilaterally.

**Route detail: the parse filter worked, and 1102 has a new suspect with two runs behind it.**
Residency per request fell from 5,157–12,215 records to a steady **3,636** once a route's stops
were parsed instead of its tiles. It still answered 1102, on attempt 4 — and the trail shows what
both kills have in common:

```
run 45, request before the kill:  vehicles=891ms
run 48, request before the kill:  vehicles=1167ms  (1549ms total, budget 1200ms)
```

Every stage but one is tens of milliseconds. The live-vehicle fetch is the largest stage in every
trail, and both kills arrived immediately after the largest one in theirs. The budget was checked
before that stage and could not help, because the overrun happens inside it: the request entered
with time to spare. The deadline is now handed down to the fetch, with a 300ms floor, so the page
answers degraded rather than being answered by the platform.

**Also.** Every pipeline runner writes a report when it throws — their steps run with
`continue-on-error`, which marks a failed step "success", so a collection that threw was
indistinguishable from one that worked and chose not to report. The visual sweep covers the stop,
route, operator, Saved and all ten Pro pages, carries a viewport on the vehicle page (it had been
screenshotting "This link needs a map area" at three sizes and calling it covered), and scans every
page for raw identifiers. The phone nav fits six items at 390px and fades rather than guillotines
at 320px.

### Run 46: Pro is live, and residency rules out the memory reading (2026-09-18)

Run 46 ([35300783901](https://github.com/pm-yrk/busstops/actions/runs/35300783901), head
`799592c`, no bootstrap) answered four of run 45's five open questions.

**Three things now work that did not.**

- **Pro reports `dataMode = live`.** The analytics batch fell from **960 seconds to 5 minutes**
  and published: `1 of 6 headline metric(s) carry a figure over 0 observation(s)`. Thin, and
  honestly thin — one figure over no observations is what a preview bucket with nineteen samples
  should say. The batch also stopped itself where it was designed to:
  `stopped after 2852 of 2927 traces to leave time for the stages after this one`.
- **`/v1/sources/health` reports** — `2 sources, governor green`, after four runs of
  "no sources reported". The lazy client map was the whole of it.
- **Bristol Temple Meads resolves as itself** rather than as `Temple`. Four of five landmarks;
  `Bullring` is still the one missing.

**Residency: the memory reading is ruled out, by measurement.**

The route trail now carries what the isolate held either side of every request:

```
req#13: held 5 shard(s)/7.37 MiB/15055 record(s), trimmed 3, left 5/7.49 MiB/12215
req#14: held 5/7.49 MiB/12215,                    trimmed 4, left 1/2.15 MiB/3773
req#16: held 4/4.95 MiB/10728,                    trimmed 2, left 3/4.75 MiB/7409
req#17: held 3/4.75 MiB/7409,                     trimmed 2, left 2/2.94 MiB/5157
                                            → 1102 on the next request
```

Residency is not climbing. It oscillates between 2.9 and 7.5 MiB, the trim does its job, and the
request that was killed began against the **lowest** residency in the whole trail — two shards and
5,157 records. The national singletons are small: 637 operators, 13,579 services, 3,178 places.
**So the isolate was not full, and cross-request accumulation is not the cause.** That was one of
the two readings that had been possible for four runs, and it is now closed. What remains possible
is a CPU ceiling on parsing, and that is still not claimed: nothing measured says so either.

**The journey's refusal has a cause, and it is bytes.**

`114 of 190 pattern(s) resolved; pattern index 92 read/0 missing in 64574ms` — with the ledger's
own stop reason **absent**, so the time budget did not end it. Sixty-four seconds of summed read
time across a 96-wide batch is latency, not work; the wall clock was 1,724ms. What ended it is the
other branch: the twelve-mebibyte request budget. Ninety-two buckets exhausted it, which means a
pattern-index bucket is well over a hundred kilobytes rather than the "tens of kilobytes" the
comment claimed — a bucket holds every pattern in England whose id hashes to it, and a corridor
wants a handful from each.

The fix is fewer buckets, not a larger budget. The planner was asking the index for **every**
pattern its trips named — including the ones the corridor slice had just read as geometry — and
then _replacing_ the slice's patterns with the index's answer, discarding what the index could not
supply. It now asks only for what the slice lacks and merges rather than replaces: strictly less
reading, strictly more patterns.

**Two things run 46 could not answer, one of them my fault.** The London checks failed on
`stop.id` where they should have read `stop.atcoCode` — a map stop carries both and `id` is the
internal UUID, so the check reported that Westminster "is not reaching TfL's stops" when it was
reporting on itself. Fixed; London is unproven either way until the next run.

**Also in this milestone.** `ProService` was reading the whole national `intelligence/segment-metrics`
dataset into the isolate in order to test a manifest for null — harmless while the batch was
failing, and not harmless now that it works. It reads the manifest. The whole-dataset guard was
named "every reader in the Worker" and listed two files; it now derives the list, which is how
that read had gone unnoticed. `intelligence/incidents` is capped at publish, worst-first, on the
same reasoning and with the same condition as the disruption notices and the gazetteer.

**Gates.** 1,137 node tests, 163 web, 160 e2e; prettier, eslint `--max-warnings=0`, typecheck,
preflight at `ci` and `deploy`, secret scan clean. Production untouched.

### Run 45: five real answers, one measurement that was missing (2026-09-18)

Run 45 ([35294669787](https://github.com/pm-yrk/busstops/actions/runs/35294669787), head
`51842005`, `bootstrap_data:false`) was the cheap proof of run 44's four fixes. Five things it
settled, and two it did not.

**What now works, measured.**

- **Overpass answers us.** Both extractions succeeded with the descriptive User-Agent: 76,298 road
  segments across six areas with `"failed": []`, and 2,872 gazetteer places. The `406` was the
  missing agent and nothing else.
- **Place search finds real landmarks.** Four of five: York Minster, Leeds Station (as
  `Leeds City Bus & Coach Station`), Manchester Arndale and Bristol Temple Meads (as `Temple`).
  Bullring is still missing, and Bristol's places extraction failed on its own with
  `osm server error 504` — so one of the five gaps has a cause and one does not yet.
- **The map is comfortable.** `325ms of a 1800ms budget; 0 object(s) read, 7 cached; 7.01 MiB
decoded; 23823 record(s); degraded false`, with `297 of the returned stops have a service`.
- **Five cities return real routes and departures** at 02:23 on a Friday, including live rows in
  Manchester and Bristol.
- **The analytics batch ran for the first time**, where it had previously reported `no_segments`
  in two seconds.

**What is still broken, and why.**

1. **Route detail answered 1102 on Leeds attempt 4.** The six requests before it cost 303–934ms
   each and decoded 2.37–3.23 MiB, and every stage was measured: `route-patterns=43ms stops=0ms
vehicles=891ms`. On those numbers "these requests are cheap" and "this isolate is full" are the
   same reading, because **every figure in the diagnostics described one request**. That is the
   measurement that was missing, and it is the one this milestone adds: `residency()` on the
   reader, `IsolateResidency` on the ledger, and a trim to a four-mebibyte floor before each
   instrumented request rather than an eviction after it. The next run's route trail says what the
   isolate held before and after each request, how much was trimmed, and which request number it
   was. **This is not a claim that memory is the limit.** Nothing measured says whether 1102 is CPU
   or memory. This is the measurement that would show it if it is, and rule it out if it is not.
2. **The journey refused with `incomplete_read`, correctly.** 455 trips loaded, 1 of 1 shard read,
   0 missing, 0 unopened — and then `resolvePatterns=4184ms` resolved 108 patterns and reported
   incomplete, so the planner refused rather than plan around the patterns it could not see. Run
   44's corridor carried 164 trips and took 5,411ms; run 45's carried 455 and ran past the
   six-second budget. The cause is round trips, not bytes: pattern ids hash across 512 buckets, so
   three hundred patterns are three hundred small objects and 24 at a time is thirteen rounds of
   latency. The batch cap is now 96 — the rows carry no geometry, so ninety-six of them is a few
   mebibytes against a twelve-mebibyte request budget, and that budget, not the cap, decides when
   to stop. The verification line now prints `N of M pattern(s) resolved`, the ledger's own stop
   reason and the pattern-index read count, so the next run distinguishes "rows are missing" from
   "the budget ran out part way through".
3. **`/v1/sources/health` reported "no sources reported" for the fourth run running, and the cause
   is certain.** `LiveService.health()` returned the clients that happened to have been
   constructed, and clients are built lazily by whichever request first needs one — so a status
   request arriving before any map request found an empty map. It now names both sources whether
   or not either has been asked anything. A source that has never been called reports its own
   never-fetched state, which is the truth.
4. **Pro is still `demo_snapshot`, and the batch report says exactly why.** `segment_samples`
   completed in **960 seconds** over 2,927 traces and emitted 19 samples; `interval_aggregates` and
   `incident_lifecycle` were then both `skipped because the run exhausted its time budget`. Two
   defects, both fixed here:
   - `sampleSegmentsForTrace` was handed **every segment in the batch for every trace** and rebuilt
     a 76,298-entry candidate array per vehicle — matching a bus in Leeds against a road in
     Bristol. That is the 960 seconds and it is also why 2,184 of 2,927 traces came back below the
     confidence floor: a matcher with no locality has nothing to reason from. There is now a
     quarter-degree grid index, built once per batch, filing each segment under every cell its path
     crosses and returning a cell's neighbours too.
   - A stage could spend the whole run's budget. `StageDefinition.budgetShare` gives
     `segment_samples` half of it and the loop stops itself at the boundary, reporting how many
     traces it got through. Aggregating the traces that were processed is worth more than
     processing every trace and aggregating none.
5. **London has never been checked at all.** The home page carries a London claim and no
   verification has ever asked a 490 stop anything. Two checks now do: London stops come back from
   a London viewport with TfL named as the source and the vehicle layer empty (TfL publishes
   arrival predictions, not positions, so a vehicle there would have been invented), and a real
   London stop returns real TfL predictions with `liveState: "live"`. Until that passes on a
   deployment the claim stays as it is. The live map also now says _why_ London has no buses
   instead of advising the passenger to pan, which over Westminster is advice that can never work.

**Also in this milestone.** The vehicle endpoint resolves its operator and its route's published
notices — `operatorContactUrl` and `operatorName` were literal `null`s, so "Bus stopped?" offered
to put somebody in touch with an operator it had never looked up. Route detail carries its notices
too, on the clock like every other read.

**Gates.** 1,134 node tests, 163 web; prettier, eslint `--max-warnings=0`, typecheck, preflight at
`ci` and `deploy`, secret scan clean across 510 tracked files. Production untouched.

### Run 44 named four causes; the weather art is second generation (2026-09-18)

**Run 44 rebuilt the nation and proved two things.** Leeds → Leeds Bradford Airport plans:
`3 legs (walk → bus → walk), 0 change(s), 9 min walking`, and every leg passed the coherence
checks — where it starts, where it ends, when, on which service by `routeId`, and joining up with
its neighbour in time and in place. And the map came back `degraded false` with
`297 of the returned stops carry a service` on a cold isolate, where run 43 had `0 of the returned
stops` on every dense viewport. Both new artifact families published; the additive fallbacks were
never needed.

**Four causes, each measured rather than guessed.**

1. **Overpass refused us by name.** Both OSM extractions failed identically and instantly with
   `406` across all six areas — a request refused before it is read, not a query that is wrong.
   Overpass's policy asks every consumer to identify itself and its operators enforce that on
   generic agents; Node sends `undici`. This is why `network/segments` stayed empty, why the batch
   reported `no_segments`, and why Pro is still on its demonstration snapshot.
2. **The map was reading more than before the index existed.** The condition for reading pattern
   geometry was "are there any vehicles", which in a city is always yes, so stop tiles, stop-routes
   _and_ pattern tiles were all read. A SIRI-VM record carries the line name on the front of the
   bus; shape matching is the fallback for a feed that publishes none, and is read only when a bus
   is in that state.
3. **`nearby` was the last unbounded read on the reader** — search entries on the stop grid, tens
   of thousands decoded to answer a question about eight hundred metres.
4. **The journey planned correctly and spent 5,411ms of its 6,000ms budget** reading pattern-index
   buckets two at a time: forty-five round trips of latency for a corridor's ninety patterns.

**On 1102, and what is not being claimed.** Three endpoints still answered it in run 44. Across
runs 42 to 44 the pattern is that requests answering from a warm shard cache pass and cold ones sit
at the edge, which is consistent with either a CPU ceiling on parsing or with memory. Nothing
measured settles which, and neither is claimed. Every fix above reduces bytes decoded per request,
which helps under either reading.

**The retention budget did not cover the phase that was slow.** The deadline was measured from the
start of the delete loop; the listing before it follows the cursor over every object under the
prefix, which after a national rebuild is tens of thousands. So the step's wall time is the listing
_plus_ the budget, and in run 45 that was heading for the workflow's forty-five minute cap rather
than stopping at thirty-five — the failure the budget exists to prevent, reached through the one
phase it did not cover. (The first version of this note said the step had already passed forty
minutes. It had not: it was thirty-four minutes in when I wrote it, and I had misread the clock.
The defect is real; the number was wrong.) The clock starts at the process now, and a listing that
spends the budget reports the plan and deletes nothing.

### The weather vignette, redrawn (2026-09-18)

96 × 72 was the right composition at the wrong size: a shelter is a box with three grey panels in
it, and every detail that makes a British bus stop recognisable costs more pixels than there were.
At **176 × 128** — the same generational jump the hero made — it carries brick with staggered
perpends, a cranked roof, four glazed bays with their own reflections, a timetable case that reads
as print, a perch rail, a litter bin, buff tactile paving with its blisters, a kerb, asphalt, the
yellow clearway line where the double yellows break, a gully, and a street tree with a lit flank.
At night the frontage and the case light up.

Three composition failures were caught by screenshotting all eight weather states, and none would
have been caught by reading the code. The first pass filled the background with a wall and left
four rows of sky — and sky is where the rain has to happen. The second drew the stop cage as a
wash in the 32%-alpha red, and `px` replaces rather than composites, so the asphalt was destroyed
and the translucent red came back as pale pink: the same bug the hero's bus bay had, made twice.
The third tried to fix the tree's outline by punching a disc of `.` out of it, and `.` is
transparent rather than sky, so it cut a hole through the picture to the page behind.

The effects follow the scene's size rather than carrying their counts over — thirty-four raindrops
read as rain over the old area and as drizzle over three times as much. Fog took a fourth attempt
and the failure was density. Rain now has a road to land on, snow settles, and a bus can approach,
drawn only when one is truthfully due.

**Gates.** 1,126 node tests, 159 web, 160 e2e; prettier, eslint `--max-warnings=0`, typecheck,
preflight at `ci`, secret scan clean across 510 tracked files.

### Run 43 named the cause, and it was the same cause twice (2026-09-17)

**What run 43 proved.** `/v1/map` no longer hits error 1102 — twenty-five dense requests across
five cities, zero platform error pages, diagnostics verbatim: `901ms of a 1800ms budget; 0
object(s) read, 5 cached, 0 missing, 0 failed; 11.16 MiB decoded; 13633 record(s)`. Retention
brought the bucket from 44,367 objects / 18.73 GB to **20,976 objects / 8.35 GB**, inside the
10 GiB allowance, 9,511 deleted at 4.08/s with zero failures. Route detail survived four of five
attempts where it used to die on the first, which is the locator fan-out having genuinely been the
cost.

**What it did not fix, and why.** Two failures, one cause. The map reported
`enrichment was skipped (pattern_enrichment_budget), so 0 of the returned stops carry a service`
on every dense viewport, and Leeds → Leeds Bradford Airport came back `incomplete_read`. Both were
reading **pattern tiles** — which carry route geometry and reach 3,935,975 bytes each — against a
three-mebibyte cap, to answer questions that are not about geometry. The map asks "what routes call
at this stop". The planner asks "what stops does this pattern call at". Neither needs a polyline,
and capping the bytes had turned an expensive read into permanent degradation, which is worse than
either the cost or the error it was avoiding.

So two new artifact families, both additive — a reader meeting an older publish sees neither field
and takes the old path:

- **`network/stop-routes`** — one row per stop, its route names, on the stops' own grid. A name is
  tens of bytes where a polyline is megabytes, so the map reads the tiles it was already reading
  and opens no pattern tile at all. Geometry is now read only when there is a live vehicle to
  match, so a quiet viewport skips it entirely — and that is no longer reported as degraded,
  because nothing was missed.
- **`network/pattern-index`** — every pattern by its id, without its shape. The journey's read
  order reverses to use it: trips first, then exactly the patterns those trips named.
  `buildGraphFor` reads `stopSequence` and never touches a shape.

**Two smaller findings from the same run.** The map's stop read and its live vehicle fetch were
sequential, and BODS took 828ms of an 1800ms budget with the stop read queued behind it, so
enrichment was declined before it started; they are different resources and run together now. And
the repeated verification loop threw away every route diagnostic it had collected when it failed —
`assert` throws before the summary is built — so the four requests that answered before attempt
five reported nothing. The request that gets killed can never report anything, so the ones that
live are the only evidence there is.

### Bus Stops Pro has never had an input (2026-09-17)

`run-batch.ts` names `network/segments`, reads it, finds nothing and stops. Nothing in the
repository published that dataset — one constant naming a producer that did not exist — so every
scheduled intelligence run since the first has ended on "No road segments published", and Pro has
only ever been able to serve its dated demonstration snapshot. The red runs looked like an
analytics problem and were a missing input.

`pipelines/road-network` is the producer: bus-routable roads from OpenStreetMap, keeping the
geometry the adapter's `normalizeOverpass` discards, cut at existing nodes rather than
interpolated points, with ids derived from the way and the piece so re-extraction does not orphan
the interval buckets aggregated against them. Coverage is six urban areas, stated in the artifact,
because Overpass is a shared volunteer service whose policy asks for targeted queries and a
national extract needs Geofabrik's PBF and a parser for it. A bounded coverage left unsaid is a
claim that the quiet roads are clear.

`pipelines/places` is the other half of the same shape: "York Minster" matched nothing because
search knew about stops, routes and operators, and the answer to that is a gazetteer rather than a
special case. A place is deliberately not a stop — no ATCO code, no departures, no live coverage —
and a place result opens the planner with the destination filled in.

### Passenger interactions that were drawn but not wired (2026-09-17)

The buses on the map were painted and inert. Clicking one now opens a panel with route,
destination, punctuality, movement, when it was last seen and the next stops, at street zoom and
at neighbourhood zoom both.

Four things were the same mistake — the number on the front of a bus being used as an identifier.
`routePublicName` is "36"; several operators run one. The vehicle page linked to `/routes/36`,
which the route endpoint looks up by service id, so every one of those links was a guaranteed 404.
Map vehicles and vehicle detail carry `routeId` and `routePatternId` now, resolved where the
viewport's own patterns make it unambiguous and null where they do not — and null means no link,
because a link to somebody else's route is worse than none.

`/vehicles/:ref` needs a viewport because the live feeds are area-scoped; requiring the _caller_ to
have a map viewport was a choice, and it sent every "buses running now" link on every route page to
"This link needs a map area". A position is enough to build the box from.

`/live/stops/:stopId` was a route nothing read. The camera-focus effect it needed did not exist
either, which is also why "Use my location" refetched data for a box the map was not looking at.

The stop panel is three intentional shapes instead of 380px at every size, with the stop's real
weather under NEXT BUS from the response the board already fetches. Feed names like
`White_Rose_Shopping_Centre` are cleaned once at the read boundary, identifiers untouched. And the
search loop was two bugs meeting: a route result linked to `/search?q=<its own title>`, and the
page never read `?q=` anyway.

**Gates.** 1,126 node tests, 155 web, 160 e2e; prettier, eslint `--max-warnings=0`, typecheck,
preflight at `ci` and `deploy`, secret scan clean across 506 tracked files. Run 44 is the single
expensive run carrying all of it: the national rebuild the two new families require, the road
segments, the places gazetteer, the live collection and the analytics batch.

### The two remaining 1102 paths, bounded at the stage that was actually costing (2026-09-17)

**What was still failing.** Run 42 eliminated error 1102 on `/v1/map` and left two endpoints
answering Cloudflare's error page: `/v1/routes/:id` inside the repeated verification loop, and
`/v1/journeys` for Leeds → Leeds Bradford Airport. Both had been partly instrumented, and in both
cases the stage that was killing the isolate was one of the stages nobody was counting.

**Route detail — the cost was stop resolution, not patterns.** The route-pattern index made the
pattern read one object and one `JSON.parse` of one line, and it was measured, and route detail
died anyway. The unmeasured stage was `stopsByKeys`: it resolves a stop by reading the locator
bucket its key hashes into, which is right for a departure board asking about one stop and wrong
for a route asking about every stop on it. Keys are spread across 256 buckets, so a route with a
few hundred stops asked for very nearly all of them — in a single `Promise.all`, hundreds of
objects in one round trip, before any budget could see a byte of it — to learn the names of about
three tiles.

The fix is a smaller question rather than a larger budget. A route's shape already says which
tiles its stops are in, so `NetworkReader.stopsForGeometries` derives them
(`stopTilesForShape`, with a kilometre of margin so a stop just over a tile edge is not lost) and
reads those tiles through the same measured batching the map uses. The locator is not touched.
Two tests hold it: one asserts no key containing `network/stop-locator` is read, and one asserts
the locator path costs more than five times as many objects for the same stops.

Everything else in the handler is now on the ledger too — index, services, operators, patterns,
stops, variants, vehicles, incidents, reliability — and the response carries `meta.diagnostics` and
a `Server-Timing` header. Incidents and reliability report zero because they are stubs on this
endpoint; that is a finding, recorded rather than assumed.

The live lookup was the other unbounded thing on the page. It fetches a SIRI-VM feed for a
bounding box and coalesces per URL, and the box was the route's own extent, so no two route pages
ever shared a fetch and a long route asked for more ground than a map viewport is allowed. It is
now snapped outward to the quarter-degree grid, so neighbouring routes share one feed, and capped
at `MAP_QUERY_LIMITS.maxBboxAreaSquareDegrees` — the same limit the map has. A capped box is
reported as `route_live_area_capped`; a lookup skipped because the reads already spent the clock
is reported as a failed source, never as "no buses on this route".

**Journeys — two unbounded reads, one of them in the half nobody suspected.** `loadTrips` was a
plain nested loop over up to sixteen corridor tiles crossed with up to six windows, each
`await store.get(...)` followed by a whole-shard parse, with nothing counting what it had opened;
the largest published pattern-trips shard is 8,109,406 bytes. It now reads in measured batches
(one shard first, then sized from the measured average, at most three), owns a 12 MiB character
budget and a 3-second clock, and drops rows as it parses them — a row on a pattern the corridor
slice does not have, or outside the plan's four-hour window, is discarded before it becomes an
object rather than after the graph builder has looked at it.

The other one was `sliceForBoundingBox`, which the endpoint calls before the planner is reached at
all. It opened the corridor's stop tiles and its pattern tiles in a single `Promise.all` against
the shared twelve-mebibyte budget, so a journey could decode fifteen mebibytes before asking for a
single trip. It is sequential now, on the request's ledger, with the map's five-mebibyte stop cap.

**A journey is refused rather than shortened.** This is where the planner and the map deliberately
differ. A map that ran out of budget draws the stops it has and says so, because a partly-drawn map
is still a map. A plan cannot: the shard that was not opened is where the fast direct bus was, and
the itinerary that comes back without it is not a worse plan but a wrong one, offered with
departure times on it. So a truncated corridor read — of the slice or of the trips — returns
`code: "incomplete_read"` with a sentence a passenger can act on, and never an option list. A test
proves the refusal by removing it: two of the four journey-budget tests fail without it.

**The three-leg assembly bug.** Run 41's itinerary failed on "leg 1 of 3 does not say where it
goes", and the reason was that a leg carried a mode, two names and two offsets into the service day
and nothing else. It now carries `fromCoordinate`/`toCoordinate`, `departAtExpected`/
`arriveAtExpected` as instants, and on a bus leg `routeId` (the published service identifier, not
the number on the front — several operators run a 36) and `routePatternId`, alongside the route
number and headsign, both cleaned through `routeBadgeName`/`passengerName`. The planner refuses to
assemble an option containing a leg between stops the graph cannot place or a ride with no trip
behind it, and `apps/worker/src/itinerary-check.ts` checks every option at the edge of the API
before it is sent: both ends named and placed, times that run forwards, bus legs identified,
consecutive legs joining in time _and in place_, and a change count that matches the rides. An
option that fails is dropped whole — half a journey presented as a journey is the thing being
guarded against.

**Gates.** 1,090 node tests, 147 web, 148 e2e; prettier, eslint `--max-warnings=0`, typecheck,
preflight at `ci`, secret scan clean across 487 tracked files. Deployed evidence for these two
endpoints is the next cheap preview run; until that run reports, this entry records a fix that is
proven locally and not yet proven in the isolate.

### Error 1102 named, five cities green, the bucket back inside the free tier (2026-09-17)

**The 503 has a name at last.** Runs 35 to 39 reported it as three hundred characters of
Internet Explorer conditional comments, because that is what the first three hundred characters of
a Cloudflare error page are. Run 40, with the error page actually parsed:

```
Cloudflare error 1102 — Worker exceeded resource limits
  /v1/map          cf-ray a3c9fa1558b9d46b-IAD
  /v1/routes/:id   cf-ray a3c9fa1cfe67d46b-IAD
  /v1/journeys     cf-ray a3c9fa67af35d6af-IAD
```

1102 is the platform killing the isolate. It does not say whether the limit was CPU or memory, and
nothing measured so far settles that, so it is not claimed either way. What is known:

- The _same URL_ — `/v1/map?bbox=-2.26,53.46,-2.21,53.50&zoom=15` — passes at check 1 (400 stops),
  fails at check 5, and then succeeds fifteen times out of fifteen at check 9 across five cities.
  Identical input, three different outcomes in one run. That rules out per-request input size and
  points at state accumulating in a reused isolate, or at a per-request ceiling this work sits
  right on the edge of.
- Measured parsed-to-source expansion, since every reader budget is denominated in characters of
  source text: stops tile 1.21x, pattern tile 1.37x, pattern-trips 1.57x, departure shard 4.66x.
  A budget in characters is not a budget in memory and is wrong by between one and five times
  depending on which shard it is spent on. Recorded, not yet acted on.
- `journeysServingStop` — unbounded, never expiring, never invalidated on a version change, and
  dead — has been removed.

Next: a wall-clock budget the Worker owns, so pattern enrichment stops and reports itself degraded
rather than being killed, plus request timing in `meta` so a _successful_ request says how close to
the edge it ran. That is what will separate CPU from memory.

**Five cities pass.** Every sampled stop returns real routes and real destinations:

| City       | Stop              | Routes | Due | Next                                    |
| ---------- | ----------------- | ------ | --- | --------------------------------------- |
| Leeds      | Hunslet Hall Road | 9      | 16  | 2 to Roundhay Park                      |
| Manchester | Piccadilly        | 2      | 8   | 1 to Manchester Piccadilly Rail Station |
| Birmingham | Bromsgrove Street | 3      | 13  | 45 to Longbridge Island                 |
| Bristol    | Temple Meads Stn  | 20     | 20  | 8 to Temple Quarter Campus              |
| York       | NRM               | 3      | 3   | 59 to Poppleton Bar Park & Ride         |

York used to offer a bus called `Golden_Tours_Hop_On_Hop_Off`. The feed puts its key in
`route_short_name`, which the first fix trusted; every candidate is cleaned now, and the Worker
cleans again on read so a board is right without waiting sixty-six minutes for a rebuild.

**Retention.** The bucket was 38,628,675,295 bytes across 54,415 objects against a 10 GiB free
allowance — over the free tier, and therefore costing money, which is why it was pruned rather
than left alone. Two passes so far:

|                     | run 39                    | run 40              |
| ------------------- | ------------------------- | ------------------- |
| Deleted             | unknown (killed mid-loop) | 9,430               |
| Rate                | not recorded              | 4.03 objects/second |
| Stopped because     | step timeout              | time budget spent   |
| Bytes before        | 38,628,675,295            | 23,985,716,811      |
| Removable remaining | —                         | 15,045              |
| Deletion failures   | —                         | 0                   |

4.03 deletes a second against a sixteen-way pool confirms the ceiling is the account's, not the
code's — the same ~4.35/s a national publish measured. Two or three more passes will finish it;
projected end state is 8,124,438,709 bytes across 18,578 objects, inside the allowance.

Run 39 also proved a workflow fault worth recording: the retention step failed on its timeout and
GitHub skipped every step after it, including the verification the run existed to read. Housekeeping
is `continue-on-error` now and the steps that state their own preconditions carry `!cancelled()`.

**Weather** ran against the preview bucket for the first time: 870 cells requested, 600 answered,
270 lost to `open_meteo rate limited` in the last three batches of nine, published across 9 tiles,
432 requests a day against an allowance of 10,000.

### Real departures are on the deployed site; routes and journeys are not (2026-09-17)

`Deploy Preview` run 33 (`35211138685`, a55694d) **published the national artifact** — 63.5
minutes, `outcome: published`, 349,589 stops, 13,579 services, 773,393 journeys — and the
passenger-facing result is that a person clicking a real stop on the deployed map now sees real
upcoming buses. Visual QA: **84 of 84**.

| Width   | City  | Buses inside the map | Stop clicked   | Board      |
| ------- | ----- | -------------------- | -------------- | ---------- |
| desktop | Leeds | 167 of 167           | Merrion D      | **4 rows** |
| desktop | York  | 73 of 73             | Eboracum Way   | **3 rows** |
| tablet  | Leeds | 166 of 166           | Merrion E      | **4 rows** |
| tablet  | York  | 72 of 72             | Willerby House | 0 rows     |
| phone   | Leeds | 169 of 169           | LGI A&E        | **4 rows** |
| phone   | York  | 73 of 73             | Langley House  | **2 rows** |

**The departure index is settled.** Every row emitted was published, and the sizing held:

```
"departures": { "published": 1024, "rows": 29358096, "rowsEmitted": 29358096,
                "failed": [], "oversized": [],
                "largest": { "network/departures/2026-09-17/125", 35905 records, 2518894 bytes } }
```

1,024 objects against 7,168, every row published, largest shard 2.5 MB against an 8 MiB budget.
The bucket spread is not perfectly even — the largest shard holds 35,905 calls against a mean of
28,670 — which is what a hash gives and is well inside the margin.

**Three checks failed, and they are three different things.**

1. **The planner's trips lost London.** 687,164 of 773,393 published; four shards refused as
   oversized, all of them `102_-1` and `103_-1` — 51.0-51.5N by 0.5W-0.0E — at 11.1 to 12.5 MB.
   That is a regression introduced by opening the trip grid to half a degree, and the largest
   shard that _did_ publish was another London tile at 8,351,605 bytes, fitting by 37 kilobytes.
   The grid is now a quarter degree and `maxTiles` 16 to match.

2. **`routePublicNames` was a hard-coded `[]` in the Worker's map projection.** The contract
   declares it, the marker reads it, nothing filled it. So the check "the viewport's stops carry
   the services that call at them" could only ever fail, and its message blamed the national
   timetable for a stub. It is populated now, from the patterns already read for the viewport,
   and a test fails against the stub.

3. **Leeds -> Leeds Bradford Airport still plans nothing, and Manchester Piccadilly still reports
   no route calling at it.** Not yet root-caused, and not guessed at here. The pattern shards
   published without failure or truncation (`truncated` names only `search-prefix/bound_`), the
   ids on both sides of the join are `deterministicUuid("stop", atcoCode)`, and the tile reader
   drops whole tiles rather than parts of them — so the obvious explanations are all ruled out
   and the next step is to reproduce the join against real pattern data rather than fixtures.

Not claimed: that any of the three fixes above works against real data. Run 33's artifact is in
the bucket, so a deploy without a bootstrap can test (2) and (3) in minutes; (1) needs a rebuild.

### The timetable publishes; the write budget is what it ran out of (2026-09-17)

**Live buses are done and deployed.** `Deploy Preview` run 30 proved the CSS positioning fix — at
every width, in Leeds and York, every bus the API returned was inside the rectangle the map
occupies. Run 32 proved the pointer-events fix that followed it: **84 of 84 visual checks passed**
against https://preview.busstops.pages.dev, and clicking a stop opened the arrival board on all
six camera/width combinations, where run 30 had failed that check three times in Leeds.

| Width   | City  | Buses inside the map | Map scrollHeight | Stop click                |
| ------- | ----- | -------------------- | ---------------- | ------------------------- |
| desktop | Leeds | 156 of 156           | 672px            | NEXT BUS — Merrion D      |
| desktop | York  | 71 of 71             | 690px            | NEXT BUS — Eboracum Way   |
| tablet  | Leeds | 154 of 154           | 489px            | NEXT BUS — Merrion E      |
| tablet  | York  | 70 of 70             | 497px            | NEXT BUS — Willerby House |
| phone   | Leeds | 158 of 158           | 378px            | NEXT BUS — LGI A&E        |
| phone   | York  | 71 of 71             | 393px            | NEXT BUS — Langley House  |

Every board opened with **0 rows**, which is the honest state: run 32's bootstrap never finished,
so there is no timetable in the bucket for them to read.

**The departure index published at national scale. Writing it is what ran out of time.** Run 32
(`35202327336`, 0848752) got as far as:

```
08:58:48  Timetable source: BODS GTFS "all", 1332.2 MiB in 41.5s
09:22:56  Read 62,012,873 stop_times rows across 13,729 routes; 773,393 journeys on 2 dates
09:50:23  Departure index: 29,358,096 rows across 7,168 shards, largest 1,489,273 bytes
10:05:57  ##[error]The operation was canceled.
```

So the sharding works: the 281 MiB journey tile is gone, the largest shard is 1.49 MB, and nothing
failed or was refused as oversized. What killed it is that **7,168 objects took 1,647 seconds —
4.35 writes a second at a concurrency of eight**. That is a ceiling, not a pace. The pipeline
writes through Cloudflare's REST API, which rate-limits per account; the same run moved about
3.9 GB, which is 1.8 MB/s, so the identical number also reads as a bandwidth ceiling. One run
cannot tell those two apart, and the job was cancelled fifteen minutes into the planner's trips.

**What changed, and what it is measured at.** The layout is now sized against both currencies, and
every publish reports its own objects/second and MiB/s so the next run says which one was real.

|                             | Before                                    | After                             |
| --------------------------- | ----------------------------------------- | --------------------------------- |
| Departure objects per build | 7,168 (512 buckets × 7 windows × 2 dates) | **1,024** (512 buckets × 2 dates) |
| Bytes per boardable call    | 134.6                                     | **46.5**                          |
| National departure index    | 3.91 GB                                   | **1.35 GB**                       |
| Largest shard               | 1,489,273 bytes                           | ~1.26 MiB                         |
| Class A operations / month  | 215,040                                   | **30,720**                        |

The window dimension is gone from departures: a board reads one object per service date. Rows are
interned against a per-shard header — a 36-character pattern UUID, a route name and a destination
repeated on every one of 29.4 million calls — times are offsets from the service date rather than
ten-digit epochs, and the calls at one stop are grouped onto one line. That last part is the edge
win as much as the wire win: a board finds its own line by prefix and parses that alone, so
reading one stop out of a 28,000-call shard costs the hundred calls at that stop.

The planner's trips moved from the eighth-degree pattern grid to a half-degree trip grid with
eight-hour windows, for the same reason: a trip is filed once rather than copied into every tile
its route crosses, so a fine grid there buys nothing and costs objects. `maxTiles` went 24 → 8 to
match.

**And the job limit was the wrong shape.** 70 minutes was rationing something that is not scarce —
this repository is public, so Actions minutes are free — and worse, a _job_ timeout cancels every
remaining step, so run 32 threw away the data verification that would have said how far it got.
The job cap is now 150 minutes and the bootstrap step carries its own 110-minute limit, so a
bootstrap that hangs fails the step and leaves the run able to report.

Not yet proven, and not claimed: that a national build now finishes inside the job, and that
Leeds, Manchester, Birmingham, Bristol and York return real routes and real departures with
Leeds → Leeds Bradford Airport returning an option. That needs the next bootstrap run.

### Live buses are real in the deployment; the timetable is not (2026-09-17)

Actions execution came back. `Deploy Preview` run 27 (`35184912332`, 8308013, `bootstrap_data:
true`) deployed the Worker and Pages, then **failed at the national network bootstrap**. The probe
job runs regardless, so the passenger surfaces were measured against the real deployment at
2026-09-17T05:20Z.

**Live vehicles: settled.** The deployed Worker's count matched an independent request made
straight to BODS from the runner, in the same second, in every non-London city:

| Area                 | `/v1/map` through the deployment | BODS direct from the runner | Diagnostics                               |
| -------------------- | -------------------------------- | --------------------------- | ----------------------------------------- |
| Leeds                | **115 vehicles**                 | 115 accepted                | bods ok · raw 230 · 115 rejected as stale |
| Manchester           | **181**                          | 181                         | raw 421 · 240 stale                       |
| Birmingham           | **163**                          | 163                         | raw 307 · 144 stale                       |
| Bristol              | **106**                          | 106                         | raw 213 · 107 stale                       |
| London (Westminster) | **0**                            | 345 (BODS)                  | TfL `degraded`, never fetched             |

Exact agreement in four cities is what closes the "runner has hundreds of buses, the deployment
has zero" question: the `SourceClient` fetch-receiver fix was the cause, and it is confirmed in a
real isolate rather than argued from the diff. The stale rejections are the freshness filter doing
its job — ages run to 84,797s in the raw feed, so roughly half of what BODS publishes for a
viewport is a position from yesterday.

**London is a separate, open failure.** The Worker serves London from TfL, and TfL reports
`status: degraded` with `lastSuccessfulFetchAt: null` — it has never succeeded. BODS has 345
vehicles in that same box, so the data exists and the London path is not reaching it.

**The timetable is the thing that is broken.** Every sampled Manchester stop answered HTTP 200
with **0 departures and 0 routes** — not a quiet hour, but a published network that knows no route
at those stops at all. The journey planner returns 0 options for Leeds → Leeds Bradford Airport,
which follows. `/v1/disruptions` reports `official 0`, and no weather: both jobs publish on a
schedule, and a schedule only fires from the default branch, so neither has ever run against the
preview bucket.

**Why the rebuild failed, and what it says.** The archive itself was fine — `BODS GTFS "all",
1332.2 MiB in 31.9s`, uncapped, exactly as designed. Then:

```
Daily static-network job failed: Error: Invalid time of day: 106:25:00
```

One `stop_times` row in England's national extract carries a time four and a half days past its
service date. The resolver's pattern allowed a one- or two-digit hour, threw on a three-digit one,
and the exception came out through the zip stream and ended the build with nothing published. The
shape of that is the timetable cap again: a single input deciding whether England has departure
boards. The hour is now bounded by how far past the service date it actually lands rather than by
how many characters it was written in, a trip carrying a time that cannot be placed is dropped and
counted in `tripsRejectedForTime`, and a test pins that the rest of the archive still publishes.

Not yet proven, and not claimed: that the rebuild succeeds. That needs the next run.

### The recruiter preview cut (2026-09-05) — built, not deployed

> **The one thing that was asked for could not be done.** The deliberate `Deploy Preview`
> dispatch was refused: `failed to run workflow: Actions has been disabled for this user`, at
> 2026-09-05T17:14Z, on `deploy-preview.yml` at `claude/bus-stops-platform-build-f7qztb` with
> `bootstrap_data: false`. A repository-wide `list_workflow_runs` a minute earlier returned
> `total_count: 0` — not one run, historic ones included — so this is execution being withheld
> rather than a workflow that failed. The Cloudflare API says the preview Worker was last
> modified at 2026-09-04T09:38:13Z, which is the run-26 build: **nothing from 2026-09-04 or
> 2026-09-05 is deployed**, including the CORS-on-error fix, the diagnostics endpoint,
> disruptions, accessibility, GTFS or any of the below. This container cannot substitute: the
> egress policy refuses `preview.busstops.pages.dev` and `*.workers.dev` with a 403 at CONNECT,
> and the Cloudflare MCP surface can read Workers but not deploy one.
>
> So the live-bus failure is **still not diagnosed**. The deployed probe is what would diagnose
> it, and the probe cannot run. Nothing below should be read as "the preview shows real buses".

- **The one fetch path that only ran in a deployment is gone.** `SourceClient` read the global
  fetch as a property and called it as a method, so `fetch` ran with the client as its receiver:
  Node tolerates that, workerd refuses it. It is bound to `globalThis` now. This is hazard
  removal and not a diagnosis — reproduced locally, Node threw identically either way — but every
  test injects its own `fetchImpl`, so that line was the only code in the live path that a test
  never executed, which is the shape of thing that turns out to be broken in production.
- **`network_error` says which network error.** The Worker reported a fetch that never left, a
  runtime that refused the call and an unreachable host under one label, and telling those apart
  is the entire diagnosis. The class now carries the message with URLs replaced wholesale and any
  `api_key` redacted first.
- **Weather at the stop is real, end to end.** A scheduled job (`pipelines/weather`) asks
  Open-Meteo about every 0.10° cell that has a bus stop in it — derived from the published stop
  tile _names_, so no stop is loaded to find out — and publishes one artifact per degree square.
  The Worker reads exactly one square and attaches `weather` to the stop response, or null. The
  cost is arithmetic: about 2,500 cells, batched a hundred to a request, is ~25 requests a run and
  ~1,200 a day against an allowance of 10,000, and the job refuses to run a schedule that would
  not fit rather than trusting the comment above its cron. A cell the model did not answer for is
  reported missing and published as nothing: the stop page then shows no vignette.
- **The live map's default view opens on Leeds, ~12 km across** rather than ~4 km. A camera
  position, not data: whatever is in frame is whatever is really there. The tight version framed
  three streets, and a first view holding two buses demonstrates far less than one holding twenty.
- **Buses on the map stay upright and wear their number.** The marker used to rotate to the
  reported bearing, which looked right heading east and stood the bus on its back end heading
  north — the sprite is a side view, and a side view has no top-down rotation to give; an
  arbitrary angle also destroyed the pixel grid. It now mirrors east/west only, and the compass
  direction is a pip that orbits it. Route numbers, previously hover-only, are shown outright
  while the viewport holds 40 buses or fewer.
- **Every marker announces itself again.** MapLibre overwrites the `aria-label` on the element it
  is handed, so a map of named stops and numbered buses told a screen reader "Map marker" a
  hundred times. The name is reapplied after construction, and the bench asserts it.
- **A green bench over a broken page, found by looking at it.** The art bench asserted that every
  sprite loaded; a page in its error state has no sprites, so it passed for days over a live map
  reading "Something went wrong" — its fixture had gone on missing `disruptions` after that field
  was added to the map contract. The fixture now lives in `tests/e2e/fixtures.ts` where the
  contract test parses it, and the bench fails on a rendered error state.

### Passenger product recovery (2026-09-04)

> **Locally complete, not yet verified against real data.** Everything in this section is built,
> unit- and integration-tested, and green on the full local gate — but this container has no
> upstream egress and no deploy, so none of it has met a real BODS archive, a real SIRI-SX
> document or a deployed Worker. "The GTFS ingest reads the whole archive" is a claim about code
> that has been proved against archives built byte by byte in tests; it becomes a claim about
> England when the deliberate online verification run measures it. Until then, treat every count,
> size and coverage figure below as a design target rather than an observation.

- **The 60-of-945 timetable cap is retired.** It was a memory limit wearing a coverage limit's
  clothes: everything fetched was assembled into one in-memory network, so how much of England
  could have a departure board was decided by how much would fit in a heap. The daily and weekly
  jobs now read BODS's own GTFS extract as a stream — `gtfs-zip.ts` reads the central directory
  off disk (Zip64 included), `gtfs-csv.ts` parses RFC 4180 rows off that stream, `gtfs-network.ts`
  emits one journey at a time, and `gtfs-spill.ts` sorts them into tiles on disk. Only journeys
  moved to disk, because only journeys scale with every trip on every service date; stops,
  patterns, services and the search index are unchanged. `BODS_MAX_TIMETABLE_DATASETS` is gone and
  `BODS_GTFS_REGION` replaces it.
- **Official disruption notices are real.** A separate model from `Incident` — one is what an
  operator published, the other is what Bus Stops inferred — collected every ten minutes from BODS
  SIRI-SX and TfL, published as a bounded artifact, and shown as "Official now" above "Observed by
  Bus Stops". The map's hardcoded `incidents: []` is gone.
- **Accessibility is a set of sourced facts.** Fourteen stop facts and three vehicle facts, each
  with a status, a source, the field it came from, a provenance sentence and a confidence. A
  missing value is UNKNOWN and never NO. No score.
- **A Worker error is readable again.** CORS headers were only on successful responses, so every
  404, 405, 429 and 500 reached the browser as `net::ERR_FAILED` with no status — which is what
  the live map's "This stop could not be loaded" actually was.
- **Run 26's mismatch is a regression test.** BODS answered 237/364/338/233 vehicles for
  Leeds/Manchester/Birmingham/Bristol at 09:38Z while the deployment answered zero for all four.
  Both halves are pinned: the counts must be published, and an empty viewport must name which of
  `request_failed`, `empty_feed` or `all_rejected` happened.

- Phase: P0–P9 complete → P10 (deployment, automated and executing)
- Overall: foundations, all eight source adapters, the national static-network pipeline, the
  Worker edge API, the full Bus Stops Live passenger app, the journey planning engine, the
  analytics engine, the national intelligence pipeline, Bus Stops Pro and the Daily Brief are
  complete, and the platform is hardened with browser, accessibility, property and free-tier
  drill suites. P10 is now a single GitHub Actions run rather than a manual checklist.
- Deployment: preview deploy runs from `Deploy Preview`, which provisions Cloudflare resources,
  sets the Worker's runtime secrets, deploys both halves, bootstraps real national data and smoke
  tests what it deployed. Production stays behind a separate, reviewer-gated button.
- Data: the preview serves real national data. A bootstrap publishes 349,531 NaPTAN stops, 1,043
  services, 48,448 patterns and 32,199 journeys from live BODS and NaPTAN, sharded so the edge
  reads only what a request spans — see ADR 0002 for why the mechanism differs from the letter of
  the architecture document, and what it costs.
- Design: the pixel artwork is a real asset library rather than shapes assembled out of
  rectangles. It is authored as drawing code in `tools/pixel-art` on a fixed art-pixel grid with
  one ramped palette and one light direction, and built to images (`npm run art`); see ADR 0003.
  The hero street is composed in three planes at two native sizes — 320x144 wide, 144x250
  upright — and displayed only at whole-number scales, with a repeating edge tile carrying it off
  both sides of the window. The map markers, the loading bus, the empty states and the arrival
  board's mark are the same drawings reduced.
- Design verification: `scripts/visual-qa.mjs` opens the deployed preview at desktop, tablet and
  phone widths and measures what can be measured — the hero fills the fold, the artwork loaded and
  is scaled by a whole number, the basemap paints, nothing scrolls sideways — and keeps its
  screenshots as a run artifact. It does not judge the artwork, and says so: `npm run art:bench`
  renders every surface carrying artwork for that.
- **B4 — GitHub Actions stopped executing (2026-09-04, ~09:40 UTC onwards).** Dispatch answered
  `Actions has been disabled for this user` at 14:03Z, and — the decisive evidence — CI, which
  triggers on push to this branch, has not produced a run since `run_number: 94` at 09:36:47Z
  across four subsequent pushes. Read access to the Actions API returned later in the day, so this
  was never a token being blind; nothing was being _run_. Everything needing a runner is blocked
  until execution resumes: the deployed probe, the GTFS measurement, deploys, and the product
  audit. Everything else continues here — the container has no upstream egress of its own (the
  agent proxy answers 403 to `data.bus-data.dft.gov.uk`), but adapters, pipelines, the Worker, the
  app, tests and the artwork are all buildable and testable locally, and Chromium is installed.
- **B4 (original note) — GitHub Actions is disabled on this account (2026-09-04 12:09 UTC).** Dispatching any
  workflow returns `Actions has been disabled for this user`, and the run history now lists zero
  runs where it listed twenty-six an hour earlier. This container has no upstream egress of its
  own — the agent proxy answers 403 to `data.bus-data.dft.gov.uk` and to the Actions artifact
  host — so with Actions off there is no route to a real upstream, no way to deploy, and no way
  to run the deployed probe or the GTFS measurement. Everything that needs a runner is stopped
  until Actions is re-enabled (usually a spending limit or an account flag, in the repository's
  Actions settings or the account's billing page). Everything that does not need one continues:
  adapters, pipelines, the Worker, the app, tests and the artwork are all buildable and testable
  here, and Chromium is installed locally for visual work.
- Blockers: B1 and B2 are unchanged and are properties of _this build container_, not of the
  platform — the GitHub Actions runner has the egress and the credentials that this container
  lacks, which is precisely why the deploy happens there. B3 is resolved (see below).

## Environment audit (measured 2026-09-02)

Host reachability was measured directly rather than assumed:

| Host                                  | Result                          |
| ------------------------------------- | ------------------------------- |
| `registry.npmjs.org`                  | reachable (npm install works)   |
| `github.com`                          | reachable (git push works)      |
| `api.cloudflare.com`                  | CONNECT denied by egress policy |
| `data.bus-data.dft.gov.uk` (BODS)     | CONNECT denied                  |
| `api.tfl.gov.uk`                      | CONNECT denied                  |
| `naptan.api.dft.gov.uk`               | CONNECT denied                  |
| `environment.data.gov.uk` (EA floods) | CONNECT denied                  |
| `api.open-meteo.com`                  | CONNECT denied                  |
| `tile.openstreetmap.org`              | CONNECT denied                  |

Re-measured 2026-09-03: unchanged. Every one of those hosts still answers `403` to `CONNECT`
through the environment's egress proxy, and no upstream credential is present here.

This constrains what can be _verified from this container_; it does not constrain the platform.
A GitHub-hosted runner has ordinary egress and holds the repository secrets, so live verification
of BODS, TfL and NaPTAN, and every Cloudflare API call, happen in the workflow rather than here.
Per `CLAUDE.md`, all credential-independent work proceeded and the blocked verifications are
isolated and documented. See `docs/adr/0001-stack-and-build-environment-constraints.md`.

### Completed

- [x] Repository/toolchain audit — spec docs only, no prior application code
- [x] Stack decision recorded (ADR 0001): npm workspaces, TypeScript, Vite/React PWA,
      Cloudflare Worker + R2, MapLibre, GitHub Actions, Vitest + Playwright
- [x] Monorepo scaffold: `apps/`, `packages/`, `pipelines/`, `tests/`, `infra/`, `scripts/`
- [x] Quality gates run locally: format, lint, typecheck, tests, preflight, secret scan
- [x] `packages/contracts` — typed + zod-validated model for static, live, derived, account
      and API entities, with England bounds and hard map-query caps
- [x] Source registry with owner, purpose, geography, licence, attribution, credential env name,
      freshness SLA, cache policy, terms notes and contract-verification method
- [x] `packages/governor` — £0 budget registry, 70/85/95% thresholds, projection, capability
      gating, degradation ladder and safe mode
- [x] `packages/ui` design tokens for the approved warm-white/black/red direction
- [x] Threat model (`docs/THREAT_MODEL.md`) mapping 10 threats to implemented, tested controls
- [x] CI workflow with least-privilege permissions and no secrets for pull requests
- [x] `.env.example` with names only; `.gitignore` excludes all env files

- [x] `packages/pipeline-core` — retention classes (raw traces hard-capped at 48h), geo and
      DST-correct time primitives, resilient HTTP with circuit breaking and request coalescing,
      atomic versioned artifacts with checksum validation and rollback, poison-record quarantine
- [x] `packages/adapters` — all eight sources: NaPTAN (with OSGB36→WGS84 recovery), TfL,
      BODS SIRI-VM, TransXChange, Open-Meteo, Environment Agency, National Highways,
      Street Manager and OpenStreetMap
- [x] `pipelines/static-network` — national build, search index, atomic publish with
      previous-good rollback, daily fingerprint change detection, weekly full reconciliation
- [x] Scheduled workflows with concurrency groups, runtime caps and least-privilege permissions

**P2 — live data and edge delivery**

- [x] `apps/worker` — dependency-free router serving versioned envelopes for viewport, stop,
      route and search queries, with hard map-query caps enforced server-side
- [x] Isolate-level snapshot caching, request coalescing and per-client rate limiting
- [x] Security headers and CSP; no upstream credential ever reaches a response
- [x] Source health surfaced per response: `sources`, `coverage`, `degradation`,
      `governorState` and `attribution` on every envelope
- [x] Degradation derivation — `scheduled_only` when every live source for the viewport is
      down, `partial_sources` when some remain, so the UI can state exactly what is missing
- [x] `packages/matching` — vehicle-to-journey matching by distance, bearing and sequence
      continuity, with delay interpolated between scheduled stop times
- [x] 40 worker tests driving the real fetch handler end to end

**P3 — Bus Stops Live**

- [x] React 18 + Vite PWA shell, warm-white/black/red tokens, pixel-art SVG library, wordmark
- [x] Home, stop, search, live map, saved, methodology, legal and not-found pages
- [x] Arrival board with live/scheduled/stale distinction and visible source confidence
- [x] "Will I make it?" and "Bus Stopped?" logic with honest uncertainty
- [x] Local-first favourites (no account required), maps handoff, allowlisted ticket links
- [x] MapLibre in a lazy chunk; with no configured style the map renders nothing rather than
      silently falling back to a third-party tile provider, and the list stands alone
- [x] Vehicle page: route, destination, punctuality, movement, match confidence, next four stops
      with an expandable full sequence, and an explicit statement that the reference rotates daily
      so an old link is expected to stop resolving
- [x] Route page: variants as selectable directions, the stop sequence drawn as a route line,
      buses currently running it, and a frequency only where the timetable supports one
- [x] Operator page: factual overview with per-metric suppression and an explicit statement that
      the operator cannot be ranked, rather than a league-table position the sample cannot support
- [x] Disruptions page: the two rankings kept separate, each explaining what it answers, with the
      uncovered areas named so an empty list is never read as nothing being wrong
- [x] Journey planner page: search or geolocation endpoints, arrival shown as a range with its
      confidence, walk-only fallback, and a statement that the locations are not stored
- [x] "Bus Stopped?" panel: plausible states rather than one cause, never claiming a breakdown or
      cancellation, with the next useful services, an alternative stop, a maps handoff and fixed
      minimal emergency guidance
- [x] Worker endpoints added for route, operator, disruptions, vehicle and journey, and the stop
      endpoint now returns the routes that actually call there
- [x] Journeys are additionally published one artifact per spatial tile, so the edge can plan a
      journey by loading the two or three tiles a corridor spans instead of the national timetable
- [x] 83 web tests and 56 worker tests

**P4 — journey planning engine**

- [x] `packages/journey` — RAPTOR-style rounds keyed by change count, initial footpaths,
      walk-only itineraries and transfer handling
- [x] Brute-force verification harness that proves the planner's answers against exhaustive
      search; it found three real planner bugs, all fixed
- [x] Nearest-versus-fastest explanation gated on uncertainty, so the app only claims a
      further stop is better when the evidence supports it
- [x] 26 journey tests

**P6 — analytics engine**

- [x] `packages/analytics/statistics.ts` — robust statistics: quantiles, median, MAD, IQR,
      MAD→IQR-fallback robust z-score, empirical percentile, Wilson proportion intervals
- [x] `metrics.ts` — punctuality, reliability, headway adherence and network health, each with
      a mandatory denominator, small-sample suppression, and source outages excluded from the
      denominator so a dead feed can never be reported as cancelled services
- [x] `baseline.ts` — comparable-period baselines with explicit sufficiency rules, and an
      abnormality classifier that takes the _less_ alarming of percentile and z-score, then
      applies materiality and persistence gates before anything is called unusual
- [x] `events.ts` — bunching, service gaps, diversions and skipped stops, each refusing to fire
      when the feed is unhealthy, and worded observationally ("appears to have taken a
      different route", never "is diverted")
- [x] `congestion.ts` — excess vehicle-minutes, delay-origin location with competing
      explanations, and speed anomalies that require a sourced limit and are never framed as
      an accusation against a driver
- [x] `weather-risk.ts` — weather sensitivity from matched strata only (association, never
      causation), flood susceptibility behind the official-wording gate, and route risk as a
      probability band that widens as coverage falls
- [x] `confidence.ts` — confidence capped by the weakest _essential_ evidence component, with
      supporting evidence able to adjust only within that cap, plus calibration measurement
- [x] 93 analytics tests

**P5 — national intelligence pipeline**

- [x] `packages/matching/map-match.ts` — bounded Viterbi map matching with emission, transition,
      bearing and plausible-speed terms. Nearest-line matching is not used: it flips between
      parallel carriageways and manufactures phantom diversions, which is the most damaging false
      positive this system can publish. Display traces are simplified separately from the
      analytical match, as the specification requires.
- [x] `pipelines/live-collection` — the scheduled intelligence path, wholly separate from the user
      path: a 24-cell England partition grid, quota-aware cadence that never polls faster than the
      source updates and suspends entirely in critical state, ingest quality gates that reject
      rather than silently correct, and a rolling window that deduplicates on source timestamps and
      hard-caps itself at the retention ceiling by age and by count
- [x] Multiple snapshots per run: one position per vehicle cannot yield a traversal, a speed or a
      delay, so a scheduled run collects a short bounded burst rather than a single frame
- [x] Collection refuses to run without `VEHICLE_SALT_SECRET` rather than storing operators'
      own vehicle identifiers unsalted
- [x] `pipelines/analytics-batch` — checkpointed stage runner (idempotent, bounded, emitting
      counts, rejections and timing; a failed stage skips its dependants instead of letting them
      build on a gap), segment sampling behind a match-confidence floor, interval aggregation with
      an open/closed bucket model and versioned revisions, roll-up-before-pruning, storage
      inventory with forward quota projection, enrichment joins, incident lifecycle and atomic
      publication with rollback
- [x] Enrichment states its distance, window and match confidence on every join; National
      Highways silence about a local street is reported as "not covered", never as "clear"; Street
      Manager records are corroboration and the type carries no cause field; Environment Agency
      notices join by licensed flood area rather than an invented radius
- [x] Incidents open as `emerging` and need a second detection to become `active`, then decay
      through `recovering` to `resolved`; identity is deterministic so a retried run cannot
      duplicate an incident already on screen
- [x] Retention runs as its own scheduled job, independent of the batch, so raw expiry can never
      be blocked by an analytics failure
- [x] 94 pipeline tests (27 collection, 42 batch, 7 map matching, plus artifact contract tests)

**P7 — Bus Stops Pro**

- [x] All ten sections built and publicly reachable with no sign-in anywhere: Control Tower, Live
      Operations, Routes, Operators, Congestion, Analytics, Reports, Daily Brief and Settings,
      with working filters and drilldowns
- [x] Every response carries an explicit `dataMode` — live, demo_snapshot or unavailable — so a
      viewer never has to guess. The demonstration snapshot is dated, labelled in the UI, and is
      reached only when no live intelligence artifact has been published; live and snapshot data
      are never blended
- [x] `ProMetric` makes it structurally impossible to publish a figure without its definition,
      denominator, comparison window, freshness, coverage and suppression state; the tile renders
      a dash and the reason rather than a placeholder number
- [x] Control Tower leads with the coverage warning, before any headline figure, and the outlook
      is assembled from the figures by a fixed rule with no model and no free text
- [x] Delay-burden and abnormality rankings kept distinct on both Control Tower and Congestion,
      each stating what it ranks on
- [x] Operator scorecards publish raw and context-adjusted figures together, and an operator below
      the comparison threshold is shown separately with its reason rather than ranked
- [x] Analytics sections carry wording the UI reproduces verbatim: association-not-causation for
      weather, the Environment Agency wording gate for flooding, and the explicit statement that
      speed anomalies are properties of a road segment and not statements about any driver
- [x] Live Operations shows no dispatch controls, and says why
- [x] Pro settings in the public demo are local and ephemeral, and say so
- [x] 12 Pro component tests and 11 Pro worker tests

**P8 — accounts and the Daily Brief**

- [x] `packages/daily-brief` — the frozen snapshot, from which both the email and the browser view
      are rendered, so a recipient opening the link an hour later sees the same figures
- [x] Deterministic narrative assembled from ranked facts by a fixed template. No model writes any
      part of it, which is a requirement rather than a preference: a rewriting step cannot be
      trusted not to change a number or soften a caveat
- [x] Route rankings are withheld when coverage or sample size cannot support comparing routes
- [x] A thin-data day is either sent under a clear limited-data label or skipped by preference,
      and never quietly padded out
- [x] Investigation priorities are phrased as suggestions and never as operational instructions;
      a test asserts the wording contains no imperative
- [x] Table-based responsive HTML with inline styles and no images, a full plain-text part carrying
      the same figures and the same unsubscribe link, and charts degraded to numbers and bars
- [x] Data-derived text is escaped, so crafted content cannot inject markup into an email
- [x] `canSend` returns a typed refusal with a reason, so no caller can treat "unverified" as
      "fine": verification, explicit opt-in, unsubscribe state, idempotency, the daily cap, the
      governor state, the provider being configured and the delivery window are all checked
- [x] The self-imposed daily cap sits below the provider's free limit and halves under budget
      pressure; sending is suspended entirely in the critical state
- [x] One-click unsubscribe over both GET and POST (RFC 8058), honoured immediately, idempotent on
      a second click, spending the token so a leaked link cannot be replayed, and answering
      identically whether or not the token was valid so it cannot be used to test an address
- [x] Only unsubscribe token hashes are stored; the plaintext exists only long enough to be put in
      the email
- [x] Every send attempt is recorded including the refusals, so an absence of email is explainable
- [x] The whole product works with no email provider configured: the snapshot is still built and
      published and the browser Daily Brief works normally
- [x] 55 Daily Brief tests (41 package, 14 pipeline) and 4 unsubscribe worker tests

**P9 — hardening and free-tier proof**

- [x] Playwright end-to-end suite: passenger journeys, degraded and stale states, the Pro
      surfaces, the disruption inbox and unsubscribe, across 320/375/768/1440 widths
- [x] axe-core accessibility pass at WCAG 2.2 AA on nine pages, plus keyboard focus, heading
      outline, reduced-motion, 200% zoom and map-alternative checks
- [x] Property-based tests for geometry, tiling, statistics, metrics and idempotency invariants
- [x] Free-tier drills simulating each governor threshold, asserting that the API, the scheduled
      collectors, the batch pipeline and email delivery all respond coherently to the same pressure
- [x] Retention drills: roll up before pruning, raw expiry at its ceiling regardless, correct
      prune ordering, and no retention class that keeps anything indefinitely
- [x] Storage projection drill naming the date storage would fill at the observed growth rate
- [x] Five runbooks covering source outage, budget pressure, bad artifacts, Daily Brief incidents
      and data subject requests
- [x] Pro Disruptions exception inbox with severity, abnormality, lifecycle, confidence and source
- [x] Journey planner accepts a destination handed over from the map or a stop page
- [x] README rewritten as a working guide to the repository

**Defects the hardening suites found, and fixed**

1. The stop page crashed to a blank white screen on a malformed API payload. Responses are now
   validated at the client boundary, and a route-level error boundary means a component failure
   degrades to a panel instead of blanking the app.
2. Saving a stop as a favourite silently did nothing: the favourite was written under the ATCO
   code and read back under the URL parameter, which is a UUID. Both sides now key on the ATCO
   code.
3. Three WCAG AA colour-contrast failures — brand red on white at 11px, the same red on the
   near-black arrival board, and the light-background muted grey used on that board.
4. The Wilson score interval could return an upper bound below its own point estimate at p = 1,
   through floating-point rounding. The bounds now bracket the value.

**P10 — deployment (credential-independent work complete)**

- [x] Deploy workflow: manual rather than deploy-on-push, re-running the whole gate on the commit
      being deployed, gated on the stricter deploy-stage preflight, and smoke-testing what it
      deployed with rollback guidance on failure
- [x] `scripts/smoke-test.mjs` — 11 checks against a live deployment, executed here against the
      Worker running under `wrangler dev` with 10 passing; it deliberately does not assert that
      upstream feeds are healthy, since that is not a property of the deployment
- [x] `apps/web/public/_headers` and `_redirects`. The smoke test found that the static site would
      have shipped with no Content-Security-Policy at all: the Worker hardened API responses while
      the pages people actually load had nothing. Six tests now assert the policy
- [x] `infra/cloudflare/PROVISIONING.md` — the exact minimum API token scopes, the Worker secrets,
      and why quota verification is deliberately a human step

**Deployment-readiness audit (2026-09-03)**

A reconciliation pass over every file that describes what must be provisioned. Seven defects
found, all fixed; the repository is now ready to provision.

1. **Production deploys would have gone to preview.** `deploy.yml` selected the Worker
   environment with `inputs.environment == 'production' && '' || 'preview'`. GitHub expressions
   short-circuit like JavaScript and the empty string is falsy, so that returns `preview` for
   _both_ branches. Verified empirically, then replaced with a shell step that computes the
   target once. A test rejects any expression whose truthy branch is an empty string.
2. **The preview Worker had no bindings of its own beyond R2.** Wrangler does not inherit
   bindings into named environments — a binding declared only at the top level is simply absent
   and the deploy still succeeds. Preview now declares every binding, var and observability
   setting explicitly, and both preflight and a test compare the two environments structurally,
   so a binding added later and forgotten under preview fails before it ships.
3. **The KV namespace was dead configuration.** `CACHE` was bound in `wrangler.toml` and declared
   in `WorkerEnv`, but no code read it. It has been removed rather than left for someone to
   provision for nothing: the free tier allows 1,000 KV writes a day, which suits none of the
   caching this Worker would want. Its two budget-registry entries went with it.
4. **GitHub Actions minutes were modelled as a fictitious 50,000/month allowance.** That is the
   included quota for private repositories on a paid plan; standard GitHub-hosted runners are
   free and unlimited for public repositories. The entry is now `metered: false` with the
   condition recorded, because making this repository private would turn minutes into a real
   budget.
5. **The BODS limit was a number nobody published.** 20,000 requests/day appeared nowhere in
   BODS guidance, which instead asks for no more than one central live-data request every five
   seconds. Recorded as 12 requests/minute and — more importantly — enforced at the point of
   request: the collector previously issued its whole partition list as fast as the responses
   came back, breaching the interval while appearing to be well inside budget. Four tests cover
   the spacing, including that coverage is sacrificed before the publisher's rule is.
6. **The cadence interval double-counted.** Waiting the full interval _after_ a pass, on top of
   per-request spacing, stretched a 60-second cadence to nearly two minutes and pushed a normal
   run over its time budget. The interval now counts from the start of the previous pass, which
   is what a cadence means.
7. **`evaluateResource` reported unverified allowances as verified**, substituting the current
   time when `verifiedAt` was null. An unverified figure could not be told apart from a checked
   one. `allowanceVerifiedAt` is now nullable and reports null.

Also: `.env.example` had five variables nothing read (`R2_BUCKET_RAW`, `KV_NAMESPACE_CACHE`,
`DATABASE_URL`, `AUTH_SECRET`, `AUTH_ALLOWED_ORIGIN`). A contract test now fails on drift in
either direction. National Highways and Street Manager keys are documented as not required to
deploy, because their adapters are contract-tested but not yet called by any scheduled job.

## Deployment automation (2026-09-03)

The deploy was a document describing eleven manual steps. It is now one button, because each step
a person performs before a deploy works is a step that gets performed wrong once.

**The API routing defect, fixed.** The frontend `ApiClient` defaulted to a relative `/api`. The
app is served by Pages and the API by a Worker — different origins — so every call would have
resolved to the Pages host and 404'd, and the static CSP's `connect-src 'self'` would have
blocked the correct origin even after it was pointed there. Three changes, applied together:

1. `defaultApiBaseUrl()` reads `import.meta.env.VITE_API_URL`, which the deploy workflows set to
   the Worker URL they just read back from wrangler's output. It is baked into the bundle: no
   runtime lookup, no configuration endpoint to get wrong. Unset, it still falls back to `/api`,
   which the Vite dev server now proxies to a local `wrangler dev` on 8787.
2. `scripts/generate-headers.mjs` writes `dist/_headers` at deploy time with
   `connect-src 'self' <exact Worker origin>` — named, never wildcarded. `public/_headers` stays
   deliberately restrictive so a skipped generator fails visibly in a browser console rather than
   silently shipping a wider policy.
3. `PUBLIC_BASE_URL` is declared per environment in `wrangler.toml`, so the Worker's CORS
   allow-list names exactly the Pages origin for that environment. This needed no chicken-and-egg
   resolution: Pages hostnames are deterministic (`busstops.pages.dev`,
   `preview.busstops.pages.dev`), unlike the account-specific workers.dev subdomain.

A Pages Functions proxy at `/api` was considered and rejected. Pages Functions are Workers, so
every API request would have invoked two of them against the same free-tier request budget.

**Provisioning.** `scripts/provision-cloudflare.mjs` checks before it creates, treats a
concurrent run's "already exists" as success, and can reach nothing chargeable. It creates the two
R2 buckets and the Pages project; wrangler creates the Worker scripts.

**Manual configuration removed.** `R2_BUCKET_ARTIFACTS`, `BUDGET_UTILIZATION`, `PUBLIC_BASE_URL`
and `PUBLIC_API_URL` were required repository variables. The first two now default in every
workflow that reads them, `PUBLIC_BASE_URL` moved into `wrangler.toml` where it is also the CORS
origin, and `PUBLIC_API_URL` is gone entirely — deriving the URL from the deploy is strictly
stronger than validating a variable, because a variable can be set and still name the wrong
environment, and a smoke test against production after a preview deploy reports a confident pass.
The preview path needs no GitHub Environment. The `production` environment is kept, because a
required reviewer on it is a real gate rather than ceremony.

Two tests changed rather than being deleted, and both were stale premises rather than weakened
assertions:

- `governor.test.ts` asserted `unverifiedRequiredResources()` returns a non-empty list. That was
  written when nothing had been verified; all deployment-required allowances now are, so it
  correctly returns none. It is replaced by three tests of the mechanism: that required-and-
  unverified is selected exactly, that an optional unverified allowance never blocks a deploy,
  and that every required allowance carries a note saying how it was verified.
- `deployment-config.test.ts` required the workflow to refuse an unset `$SITE_URL`/`$API_URL`.
  Those variables no longer exist; the replacement asserts the stronger property that both URLs
  come from the deploy steps and from no repository or environment variable.

A dead `quota:check` npm script pointing at a file that was never written has been removed.

### In progress

- [x] P10 — `Deploy Preview` run 25 green end to end: gates, deploy, data verification and the
      deployed visual pass. Production remains un-deployed and un-requested.

### Next

1. **Run `Deploy Preview` the moment Actions executes again.** Everything the recruiter cut needs
   is committed and pushed; the deploy is the only remaining step, and its probe is also what
   diagnoses the live-bus failure. Then verify, in order: home loads with the artwork, the live
   map loads, the basemap loads, the deployed `/v1/map` returns more than zero real vehicles for
   Leeds, buses render on the map, clicking a stop opens NEXT BUS, and the console carries no
   major failures.
2. **The deployed live-bus failure is unexplained.** BODS answered 237/364/338/233 vehicles for
   Leeds/Manchester/Birmingham/Bristol from a runner while the deployment answered zero for all
   four; both halves are a passing regression test, which itself says the code path is correct
   given a healthy feed. `/v1/diagnostics/live` will name which of `request_failed`, `empty_feed`
   or `all_rejected` actually happens up there.
3. Deferred to the next session, deliberately and with nothing started: GTFS verified against a
   real archive, departures at every non-London stop, place-first search, "take me to York
   Minster", the rest of accessibility, "Bus stopped?", mobile bottom sheets and the phone map
   layout (the live map on a phone still puts its controls above the map), a Pro baseline from
   real observations, the final art passes, and the full deployed product audit.
4. Watch the shard sizes each publish reports. The byte budget is a backstop, not a target: a
   family that starts truncating is telling you its key needs to be finer, and it says which.
5. The remaining TfL adapters (route sequence, stop point, disruptions) are still verified
   against published documentation rather than against a live response.
6. Production remains un-deployed pending explicit approval after the preview is reviewed.

### Deployment evidence

Preview, deployed by `Deploy Preview` from a GitHub-hosted runner:

|                 |                                                       |
| --------------- | ----------------------------------------------------- |
| Preview site    | https://preview.busstops.pages.dev                    |
| API (Worker)    | https://busstops-api-preview.paulmurrin13.workers.dev |
| Artifact bucket | `busstops-artifacts-preview`                          |

Verified against those real URLs, not against a rehearsal:

- **Smoke test: 11 of 11 passed.** App shell serves; security headers present; source health
  answers with its governor state; every response states freshness and degradation; the map's
  size cap and required bounding box are enforced by the running Worker; Pro answers with no
  credential; unknown paths 404; write methods are refused; one-click unsubscribe accepts a POST;
  no credential appears in any response body.
- **The cross-origin path works end to end.** The deployed bundle
  (`/assets/index-*.js`) contains the Worker origin, so `VITE_API_URL` really was baked in; the
  served CSP is `connect-src 'self' https://busstops-api-preview.paulmurrin13.workers.dev`, naming
  the exact origin with no wildcard; and the Worker answers a request from the Pages origin with
  `Access-Control-Allow-Origin: https://preview.busstops.pages.dev`. This was the defect most
  likely to produce an app whose every request fails in a browser while every server-side test
  passes, so it is checked against the deployment rather than reasoned about.
- **Pro is public.** `dataMode: "demo_snapshot"`, no `WWW-Authenticate`, no sign-in wall.

**Real national data is published.** `Deploy Preview` run 4 bootstrapped
`busstops-artifacts-preview` from live BODS and NaPTAN, outcome `published`, nothing failed:

| Dataset                | Records                                        |
| ---------------------- | ---------------------------------------------- |
| `network/stops`        | 349,531                                        |
| `network/search-index` | 350,596                                        |
| `network/patterns`     | 48,448                                         |
| `network/journeys`     | 32,199                                         |
| `network/services`     | 1,043                                          |
| `network/shapes`       | 515                                            |
| `network/operators`    | 22                                             |
| journey tiles          | 46 published, 0 failed, 0 journeys unplaceable |

Getting there took three real defects, each found by measurement rather than assumption:

1. **BODS timetables are zip archives.** 945 published datasets, all 25 in the first page
   `extension: "zip"`, the download `application/zip` with PK magic bytes. The pipeline fetched
   them as text, so the XML parser was handed binary — no journeys parsed, every downstream
   dataset came out empty, and the publish rolled back with nothing to explain why.
2. **The build exhausted the heap.** Fixing the zips meant 25 archives really were decompressed,
   and fingerprinting joined all of them into one string. FNV-1a folds left to right, so the join
   was never needed.
3. **Tile publishing was serial.** Thousands of independent writes, three round trips each.

**The national datasets do not fit in an edge isolate, so the edge stopped reading them.**
Measured, not inferred (`scripts/inspect-artifacts.mjs`, run against the preview bucket):

| Dataset                | Records | Size      |
| ---------------------- | ------- | --------- |
| `network/journeys`     | 32,199  | 292.2 MiB |
| `network/stops`        | 349,531 | 197.6 MiB |
| `network/patterns`     | 48,448  | 100.1 MiB |
| `network/search-index` | 350,596 | 87.5 MiB  |

A Workers isolate has 128 MiB. The former `NetworkRepository.read()` loaded stops, operators,
services, patterns, shapes and the search index together — roughly 390 MiB of text before any of
it was parsed, and parsed JSON is larger than its source. The isolate was killed, so every
endpoint that loaded the snapshot answered 500 and every endpoint that did not — health, Pro, the
query caps, unsubscribe — worked. That is exactly the pattern that was observed.

An earlier guess at this same 500 was that the free tier's CPU limit was being exceeded parsing
SIRI-VM. That was wrong: the response body is the Worker's own error text, not Cloudflare's
resource-limit page, which is what prompted printing the body rather than the status code.

**The fix is the one the codebase already chose once for journeys.** `publish.ts` says of them:
"The national journeys dataset is far too large to load in a Worker isolate, but a journey plan
only ever needs the corridor between two points." The same is now true of everything a passenger
query touches.

- `pipelines/static-network/src/shards.ts` addresses the shards. Spatial families — stops,
  patterns and the search tiles — use the half-degree tile the journey tiles already used. Key
  families — the stop locator and the search prefixes — use an FNV-1a bucket and a two-character
  word prefix, so an identifier or a typed word resolves to exactly one small object. A search is
  a prefix bucket plus, where the query has a location, the tiles around it: not one 87 MiB index
  moved somewhere else.
- `apps/worker/src/network-reader.ts` replaced `NetworkRepository`. Nothing in it opens a national
  object except `operators` (22 records), `services` (1,043) and the one-record index. Its shard
  cache is bounded by count _and_ by the size of the text it parsed, because twenty-four dense
  city tiles are not the same quantity of memory as twenty-four rural ones.
- **Versioning is atomic.** The index record is read first and names the version; every shard is
  then read at that exact version rather than through its own pointer. A publish writes shards
  first and the index last, so a version that is visible is complete, and a reader mid-publish
  keeps serving the previous one.
- `apps/worker/src/isolate-memory.test.ts` asserts the _shape_ of the access rather than a size,
  because a fixture small enough to run in a test is small enough to hide the defect. A recording
  store logs every key read; a viewport, a stop page and a search must touch none of the national
  datasets, and a source scan fails if `NetworkSnapshot` or `network-repository` reappear.

Publishing the shards then failed twice more, and both were about size rather than logic:

4. **Rate limiting, not memory.** 962 shard publishes returned 429. A full artifact publish costs
   three round trips; two of them — the per-shard manifest and the shrink check — are meaningless
   for a shard the reader addresses directly at a version the index names. One write per shard,
   and `R2ObjectStore` now waits out a 429 honouring `Retry-After`.
5. **A shape key that was not unique, and a cap counted in the wrong unit.** A TransXChange
   journey pattern id is unique only inside its own document, and shapes were keyed by it alone —
   so nationally 48,448 patterns collapsed onto 515 shapes. Most patterns carried another
   operator's geometry, and every pattern sharing a key piled into the same tiles: one tile threw
   `Invalid string length` while being serialised and the next was refused with 413, both while
   inside the 20,000-record cap. Shapes are now keyed by route, scoped to the service, which is
   also the deduplication the old key was reaching for. Published geometry is simplified to ten
   metres and rounded to five decimal places, a tile stores each shape once, and the cap is now on
   bytes measured on the exact text written — with the largest shard in each family reported after
   every publish, because the useful question is how close the largest one came.

### Verification evidence

Local checks run in the build container; live checks cite the GitHub Actions run that observed
them, because this container has no egress (B1).

| Check                         | Command or method                          | Result                                                                                                                                                                                                                                                                                                                                               | Date       |
| ----------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Install                       | `npm ci`                                   | Clean install from lockfile                                                                                                                                                                                                                                                                                                                          | 2026-09-03 |
| Unit + contract + integration | `npm test`                                 | 941 passed / 941 (837 root across 37 files, 104 web)                                                                                                                                                                                                                                                                                                 | 2026-09-04 |
| Lint                          | `npm run lint`                             | Clean, `--max-warnings=0`                                                                                                                                                                                                                                                                                                                            | 2026-09-03 |
| Format                        | `npm run format:check`                     | Clean                                                                                                                                                                                                                                                                                                                                                | 2026-09-03 |
| Type check                    | `npm run typecheck`                        | Passed for every workspace                                                                                                                                                                                                                                                                                                                           | 2026-09-03 |
| Free-tier preflight (ci)      | `npm run preflight`                        | Passed, 0 warnings                                                                                                                                                                                                                                                                                                                                   | 2026-09-03 |
| Free-tier preflight (deploy)  | `PREFLIGHT_STAGE=deploy npm run preflight` | Passed, 0 warnings                                                                                                                                                                                                                                                                                                                                   | 2026-09-03 |
| Secret scan                   | `node scripts/secret-scan.mjs`             | Clean across 313 tracked files                                                                                                                                                                                                                                                                                                                       | 2026-09-03 |
| End-to-end + accessibility    | `npm run test:e2e`                         | 140 passed / 140 across desktop, tablet and two phone sizes                                                                                                                                                                                                                                                                                          | 2026-09-04 |
| Journey planner verification  | `npx vitest run packages/journey`          | Brute-force equivalence against exhaustive search                                                                                                                                                                                                                                                                                                    | 2026-09-03 |
| Zip reader                    | `npx vitest run pipelines/static-network`  | 7 passed against a fixture written by Python's zipfile                                                                                                                                                                                                                                                                                               | 2026-09-03 |
| Live sources                  | `Verify live sources` run 2                | BODS, BODS timetables, TfL and NaPTAN all answered and parsed                                                                                                                                                                                                                                                                                        | 2026-09-03 |
| Provisioning                  | `Deploy Preview` run 1                     | R2 buckets and Pages project ensured; nothing chargeable enabled                                                                                                                                                                                                                                                                                     | 2026-09-03 |
| Worker deploy                 | `Deploy Preview` run 1                     | Deployed, secrets set, `/v1/sources/health` answered 200                                                                                                                                                                                                                                                                                             | 2026-09-03 |
| Pages deploy                  | `Deploy Preview` run 1                     | Deployed to the `preview` branch alias                                                                                                                                                                                                                                                                                                               | 2026-09-03 |
| Basemap terms and origins     | `Verify sources and artifacts` run 6       | OpenFreeMap Liberty: style loaded, a tile fetched with no key answered 200 image/png (154,821 bytes), attribution "OpenFreeMap © OpenMapTiles Data from OpenStreetMap", one CSP origin                                                                                                                                                               | 2026-09-03 |
| Data bootstrap                | `Deploy Preview` run 18                    | Outcome `published`; 349,531 stops, 1,043 services, 48,448 patterns, 32,199 journeys from 60 BODS timetable datasets                                                                                                                                                                                                                                 | 2026-09-04 |
| Smoke test                    | `Deploy Preview` run 25                    | 11 of 11 against the deployed pair                                                                                                                                                                                                                                                                                                                   | 2026-09-04 |
| Real data through the edge    | `Deploy Preview` run 25                    | Passed: viewport stops, nearby, stop board, search, route detail, journey plan, and that a viewport's stops carry the services calling at them                                                                                                                                                                                                       | 2026-09-04 |
| Artwork build                 | `npm run art`                              | 17 images, 20.3 KiB total, from tools/pixel-art                                                                                                                                                                                                                                                                                                      | 2026-09-04 |
| Deployed visual pass          | `Deploy Preview` run 25                    | 51 of 51 in Chromium at 1440/768/390: basemap paints (382,427 bytes at tablet, 114,150 at phone), 8–12 tiles at 200, attribution present, 230 markers, arrival board opens on a real Leeds stop, the hero artwork loads and is scaled by a whole number at every width (4x, 3x, 2x), no page scrolls sideways; 21 screenshots kept as a run artifact | 2026-09-04 |

### Acceptance audit (docs/17_ACCEPTANCE_CRITERIA.md)

Audited 2026-09-03. "Blocked" means the work is complete and testable but final verification needs
something unavailable in this environment; the blocker is named. Nothing is marked passing on the
strength of a fixture where the criterion asks for live data.

**Product and design** — all passing. Brand, pixel library with a reduced-motion loading bus,
functional pixel arrival board with live/scheduled/freshness states, responsive and keyboard
accessible UI verified by 140 browser tests at four widths with zero axe violations, and every
Live and Pro page present and substantive.

**England-wide data**

| Criterion                                                                                      | State                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No regional hard-code; configuration supports all England                                      | Pass — `ENGLAND_BOUNDS`, a 24-cell national partition grid, no per-city branching                                                                                                                                                                                             |
| BODS and TfL adapters live-verified with provenance/freshness                                  | Pass, within the scope recorded above — BODS SIRI-VM and the timetable catalogue, TfL arrivals and NaPTAN have all answered and parsed against the live services from a runner. Not every operator's dialect, and the remaining TfL adapters are still documentation-verified |
| NaPTAN identity, schedules, routes, patterns reconcile nationally                              | Pass — a national build published 349,531 stops, 1,043 services, 48,448 patterns and 32,199 journeys, with 4,211 dangling stop references reported rather than published                                                                                                      |
| Daily fingerprint ingest and weekly reconciliation run idempotently                            | Pass — tested; scheduled workflows configured                                                                                                                                                                                                                                 |
| Remaining five adapters implemented and contract-tested                                        | Pass                                                                                                                                                                                                                                                                          |
| Source failure, stale, partial coverage and previous-good fallback are user-visible and tested | Pass — worker tests and browser tests both assert the visible states                                                                                                                                                                                                          |

**Bus Stops Live**

| Criterion                                                                               | State                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewport map, nearby/search, departures, vehicles, tracking, next stops, show-all-stops | Pass against real published data — a Manchester viewport returns 400 real stops, selecting one returns its departure board, and search finds it by name, all through the deployed edge                                                                                                                                             |
| Recent actual path versus scheduled shape                                               | **Partial** — the scheduled shape is served and drawn; the actual path is held only in the bounded intelligence window and is not served at the edge. The vehicle page states this rather than drawing a line it cannot support                                                                                                    |
| Cautious diversion and skipped-stop evidence                                            | Pass — detectors, wording gates and tests                                                                                                                                                                                                                                                                                          |
| "Will I make it?" calibrated range, confidence, next service                            | Pass                                                                                                                                                                                                                                                                                                                               |
| "Bus Stopped?" evidence-aware recovery without unsupported claims                       | Pass — 10 component tests including "never claims a breakdown or cancellation"                                                                                                                                                                                                                                                     |
| Journey planner: searched and map-tapped destinations, three rankings                   | Pass                                                                                                                                                                                                                                                                                                                               |
| Nearest versus fastest boarding stop, explained when material                           | Pass — with a brute-force verification harness                                                                                                                                                                                                                                                                                     |
| Maps handoffs valid; favourites local-first                                             | Pass                                                                                                                                                                                                                                                                                                                               |
| Ticket links allowlisted, labelled, safely opened                                       | **Partial, deliberately** — the https-only domain allowlist, labelling and safe-open behaviour are implemented and tested, but `TICKET_REGISTRY` is empty. Entries require human verification that a domain is the operator's official retailer; adding unverified entries would be the exact harm the allowlist exists to prevent |

**Bus Stops Pro** — all passing. No login wall anywhere (asserted by a browser test), all ten
sections working with filters and drilldowns, every documented algorithm implemented, every metric
carrying denominator/window/freshness/coverage/confidence/evidence with incomparable rankings
suppressed, and the two rankings distinct on both Control Tower and Congestion.

**Daily Brief**

| Criterion                                                                           | State                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser and email from the same frozen snapshot                                     | Pass                                                                                                                                                                                                                   |
| Yesterday/today sections, caveats, evidence, deterministic narrative                | Pass                                                                                                                                                                                                                   |
| Verified opt-in, settings, authorization, one-click unsubscribe, idempotency, audit | Pass — 55 tests                                                                                                                                                                                                        |
| Hard send caps and degraded behaviour                                               | Pass                                                                                                                                                                                                                   |
| One authorized production test send                                                 | **Blocked** — needs a configured email provider and a real consenting recipient. Neither exists here, and sending to an unconsented address to satisfy a checkbox would violate the consent rules this system enforces |

**£0, security and operations**

| Criterion                                                                               | State                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Official quotas recorded; billing cannot increase automatically                         | **Partial** — the registry records every allowance with its terms URL, and no paid upgrade path exists in any code path. All 14 allowances carry `verifiedAt: null` because provider terms pages are unreachable (B1); the deploy-stage preflight fails until they are confirmed, which is the intended gate |
| Budget registry, thresholds, projections, kill switches, preflight                      | Pass                                                                                                                                                                                                                                                                                                         |
| Simulated amber/red/critical degrade in order, preserving deletion/unsubscribe/security | Pass — 18 drills                                                                                                                                                                                                                                                                                             |
| Raw GPS expires within 24–48h; rollups/pruning/inventory tested; no Replay              | Pass                                                                                                                                                                                                                                                                                                         |
| Secrets, validation, authorization, CSP, URL allowlist, privacy minimisation, audit     | Pass — threat model, secret scan, worker tests                                                                                                                                                                                                                                                               |
| Source/map attribution and privacy/terms/methodology pages ship                         | Pass                                                                                                                                                                                                                                                                                                         |

**Engineering, tests and deployment**

| Criterion                                                                                               | State                |
| ------------------------------------------------------------------------------------------------------- | -------------------- |
| Typed contracts, idempotent pipelines, versioned atomic artifacts, rollback                             | Pass                 |
| Format, lint, types, unit, property, contract, integration, golden, E2E, accessibility, security, build | Pass — all green     |
| Live checks: London, multiple non-London areas, national catalogue evidence                             | **Blocked (B1, B2)** |
| Cloud deployment at a free URL; mobile/desktop smoke tests                                              | **Blocked (B3)**     |
| README, runbooks, environment template complete; BUILD_STATE current                                    | Pass                 |

**Rejection conditions** — none apply. The product is not a static mock; fixtures appear only in
tests and in one conspicuously labelled dated demo snapshot that live data takes precedence over;
it is England-wide with no regional hard-code; Pro has no login wall; no production path falls back
to fabricated data; quota controls are hard and tested; raw telemetry expires within 48 hours;
there is no Replay; nothing depends on a paid service or on AI at runtime; the critical algorithms
are tested, including by brute-force verification and property tests; and deployment is blocked by
the absence of credentials rather than left undone.

### Coverage and source health

"Adapter" = normalization code exists. "Contract tests" = parser verified against fixtures built
from the provider's published schema. "Live verified" = a real upstream response was inspected —
which nothing can claim in this environment, and nothing does.

| Source              | Adapter | Contract tests | Live verified   | Freshness |
| ------------------- | ------- | -------------- | --------------- | --------- |
| BODS (SIRI-VM)      | done    | 21 passing     | blocked (B1/B2) | unknown   |
| BODS (TransXChange) | done    | 35 passing     | blocked (B1/B2) | unknown   |
| TfL                 | done    | 29 passing     | blocked (B1/B2) | unknown   |
| NaPTAN              | done    | 37 passing     | blocked (B1)    | unknown   |
| National Highways   | done    | 8 passing      | blocked (B1/B2) | unknown   |
| Street Manager      | done    | 9 passing      | blocked (B1/B2) | unknown   |
| OpenStreetMap       | done    | 11 passing     | blocked (B1)    | unknown   |
| Open-Meteo          | done    | 8 passing      | blocked (B1)    | unknown   |
| Environment Agency  | done    | 7 passing      | blocked (B1)    | unknown   |

### Free-tier budget

`packages/governor/src/budget-registry.ts` tracks 14 constrained resources across Cloudflare
Workers/R2/KV, GitHub Actions, email sends and each upstream API. Thresholds are green <70%,
amber 70–85%, red 85–95%, critical ≥95% or projected breach, verified by 28 governor tests
including every threshold boundary and the full degradation ladder.

**Every allowance is currently recorded as `verifiedAt: null`.** The numbers in the registry are
starting assumptions, not verified allowances, and `scripts/preflight.mjs` fails at
`PREFLIGHT_STAGE=deploy` while any required resource remains unverified. Confirming them against
current published provider terms is a deployment-time step and cannot be done from this
environment (B1). Billing cannot increase automatically: no payment method is configured on any
provider, the governor stops work at self-imposed ceilings below each free allowance, and
provider rejection is never used as the governor.

### Known limitations

**B0 — GitHub Actions execution withheld (resolved 2026-09-17).** Dispatch was refused with
`Actions has been disabled for this user` through 2026-09-05 and a repository-wide run listing
returned `total_count: 0`. Execution is back: the listing returns 147 runs and `Deploy Preview`
run 27 executed normally. _Still true:_ this container's egress policy denies `*.pages.dev` and
`*.workers.dev` at CONNECT, so the deployed preview can only be measured from a runner — which is
what the probe job is for.

**B1 — Upstream egress blocked from the build container (resolved for verification).** The build
sandbox's egress policy still denies CONNECT to every transport, weather, flood and map host and
to `api.cloudflare.com`, re-measured 2026-09-03. That is a property of this container, not of the
platform, and it no longer blocks verification: a GitHub-hosted runner has ordinary egress and
holds the repository secrets, so `Verify live sources` runs the adapters against real responses
there. _Still true:_ nothing can be verified by running it in this container, so every live claim
in this file cites a workflow run rather than a local command.

**B2 — Upstream credentials (resolved for BODS, TfL and Cloudflare).** `BODS_API_KEY`,
`TFL_APP_KEY`, `VEHICLE_SALT_SECRET`, `UNSUBSCRIBE_SECRET`, `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` are provisioned as repository secrets and are consumed by workflows only.
National Highways and Street Manager credentials are still absent; their adapters are implemented
and contract-tested but called by no scheduled job, so nothing degrades. _Resolution when they are
wanted:_ register, add the key names to `.env.example`, the source registry entry and that job's
workflow.

**B3 — Deployment (resolved).** The preview is deployed. What changed is not the egress policy but
where the deploy runs: `Deploy Preview` provisions, deploys and verifies from a runner, so the
container's inability to reach `api.cloudflare.com` no longer matters. See "Deployment evidence"
above for the URLs and the checks that passed against them.

**Timetable coverage is a fraction of England, and the figure is published.** NaPTAN gives every
stop in the country — 349,531 of them — so the map, search and nearby are national. Services,
routes and departures come only from the BODS timetable datasets a build downloads, and that is
capped: 25 originally, 60 now, against the 945 BODS publishes. The visible effect is a complete
map with a departure board at some stops and nothing at others, which reads as a defect at the
stop and is really this number — so the build report carries what was taken against what exists,
and the deployed verification reports how many stops in a viewport have any service at all.

Raising the cap further is a change rather than a larger number. Three national artifacts that
nothing read — journeys at 292 MiB, shapes and the search index — have been removed, which is what
allowed 60. The next ceiling is `network/patterns`, still a single object because the weekly
reconciliation reads it: 100 MiB at 25 datasets, so it runs out of room somewhere past 100.
Reaching every published operator means the weekly job reading pattern shards instead.

**Live verification is narrower than "the adapters work".** What was observed is recorded in
`packages/contracts/src/source-registry.ts` with the observation, not the conclusion:

- **BODS** — the SIRI-VM datafeed for one Manchester bounding box, and the timetable catalogue
  plus one dataset download. Not national coverage, and not every operator's dialect.
- **TfL** — arrivals for one stop point. The route-sequence, stop-point and disruption adapters
  are still verified against published documentation only.
- **NaPTAN** — the first 255,959 bytes of the national CSV. The stream is cancelled deliberately
  rather than downloading a national dataset to check a parser, so this verifies the head of the
  file and says nothing about national reconciliation.

Everything else — National Highways, Street Manager, OpenStreetMap, Open-Meteo, the Environment
Agency — remains `published_documentation`, because no live response has been inspected. The
registry's schema refuses to let those say otherwise.

No limitation above excuses unfinished credential-independent work; remaining work is tracked as
work, not as a blocker.

### Pro demonstration snapshot

`apps/worker/src/pro-demo-snapshot.ts` holds a fixed, dated example dataset. It exists because the
specification allows the public Pro demo to be served from "a conspicuously labelled dated
snapshot if live national analytics are unavailable", and no live analytics can be produced in
this environment (blockers B1/B2). It is reached only when no intelligence artifact has been
published, is never blended with live figures, and every response built from it carries
`dataMode: "demo_snapshot"`, the snapshot date and a notice the UI displays. A worker test asserts
that a published artifact — even one with zero incidents — takes precedence over it.

### Decisions and deviations

- **ADR 0001** — stack adopted as specified; no architectural deviation was required. Adapters are
  built from published provider contracts, and fixtures are labelled by origin
  (`constructed_from_published_schema` vs `captured`) so that "contract tests pass" is never
  reported as "live verified".
- **Preflight staging** — preflight distinguishes `ci` from `deploy` stages so unverified provider
  allowances warn during development but hard-fail before any deployment.
