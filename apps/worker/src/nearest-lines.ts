import type { Coordinate } from "@busstops/contracts";
import { haversineMetres } from "@busstops/pipeline-core";

/**
 * The nearest N lines of an artifact to a point, chosen before any of them is parsed.
 *
 * A city viewport contains far more stops than the map draws. Manchester holds 3,006 projection
 * rows inside the box and four hundred markers come back, so five sixths of the work a viewport
 * did was spent on rows that lost. The box filter already ran before the parse — what did not was
 * the *cap*, because the four-hundredth-nearest distance is not known until the rows are in hand,
 * and the reader had to build all of them to find it.
 *
 * A bounded max-heap knows it as it goes. Once it holds N, the worst keeper's distance is the
 * admission price for everything after, and a row that cannot pay it is never sliced, never
 * parsed and never allocated. `offer` takes the line's text as a thunk for exactly that reason:
 * the slice is the first allocation a candidate causes, so it happens only on acceptance.
 *
 * The heap also hands the caller something it could not have before: a live bound it can use to
 * skip whole objects. See `tileFloorMetres`.
 *
 * ## Order is total here, where it was incidental before
 *
 * The ranking it replaces sorted the rows a read happened to produce, so two stops at exactly
 * equal distance came back in the order their tiles were fetched — which depends on the batching,
 * and so on the byte budget and on which tiles the cache already held. This breaks such a tie on
 * the line's own text, which is stable across all of that. The set is the same either way; a tie
 * means the choice is arbitrary, and an arbitrary choice that does not move is worth more than one
 * that does.
 */
export class NearestLines {
  /** Distances, as a binary max-heap: the worst keeper is at the root. */
  private readonly metres: Float64Array;
  private readonly lines: string[] = [];
  private count = 0;
  /** How many candidates were offered, which is how the caller knows the cap bound the answer. */
  private offered = 0;

  constructor(
    readonly capacity: number,
    readonly centre: Coordinate,
  ) {
    this.metres = new Float64Array(Math.max(1, capacity));
  }

  get size(): number {
    return this.count;
  }

  get full(): boolean {
    return this.count >= this.capacity;
  }

  get offeredCount(): number {
    return this.offered;
  }

  /**
   * The distance a candidate must beat, or `Infinity` while there is still room.
   *
   * This is the bound a caller prunes whole objects with, so it is deliberately the *worst
   * keeper's* distance rather than the best: anything at most this far away may still belong in
   * the answer.
   */
  get admissionMetres(): number {
    return this.full ? (this.metres[0] ?? Infinity) : Infinity;
  }

  /**
   * Offer a candidate. `text` is called only if it is kept.
   *
   * The admission test is in here rather than in the caller so that `offeredCount` is the count of
   * everything the caller saw: a viewport reports itself truncated when more stops were inside the
   * box than it was allowed to return, and that is a different number from the one the heap kept.
   *
   * A tie at the admission price is resolved on the text, so the answer does not depend on read
   * order. That costs one string comparison per tied candidate and nothing otherwise.
   */
  offer(metres: number, text: () => string): boolean {
    this.offered += 1;
    if (!this.full) {
      this.push(metres, text());
      return true;
    }
    const worst = this.metres[0] ?? Infinity;
    /* The cheap rejection, and the common one: no slice, no comparison, no allocation. */
    if (metres > worst) return false;
    const candidate = text();
    if (metres === worst && candidate >= (this.lines[0] ?? "")) return false;
    this.metres[0] = metres;
    this.lines[0] = candidate;
    this.sink(0);
    return true;
  }

  /** The keepers, nearest first, with ties broken on the line's text. */
  drain(): { metres: number; text: string }[] {
    const kept: { metres: number; text: string }[] = [];
    for (let i = 0; i < this.count; i++) {
      kept.push({ metres: this.metres[i] ?? 0, text: this.lines[i] ?? "" });
    }
    kept.sort((a, b) => (a.metres === b.metres ? (a.text < b.text ? -1 : 1) : a.metres - b.metres));
    return kept;
  }

  /** Distance from the centre this was built around. Here so a caller measures it exactly once. */
  distanceTo(lat: number, lon: number): number {
    return haversineMetres(this.centre, { lat, lon });
  }

  private push(metres: number, text: string): void {
    const at = this.count;
    this.metres[at] = metres;
    this.lines[at] = text;
    this.count = at + 1;
    this.swim(at);
  }

  private swim(from: number): void {
    let at = from;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.worseThan(at, parent)) break;
      this.swap(at, parent);
      at = parent;
    }
  }

  private sink(from: number): void {
    let at = from;
    for (;;) {
      const left = at * 2 + 1;
      if (left >= this.count) break;
      const right = left + 1;
      let worst = left;
      if (right < this.count && this.worseThan(right, left)) worst = right;
      if (!this.worseThan(worst, at)) break;
      this.swap(at, worst);
      at = worst;
    }
  }

  /** The heap order, ties on the text so the root is a single well-defined worst entry. */
  private worseThan(a: number, b: number): boolean {
    const da = this.metres[a] ?? 0;
    const db = this.metres[b] ?? 0;
    if (da !== db) return da > db;
    return (this.lines[a] ?? "") > (this.lines[b] ?? "");
  }

  private swap(a: number, b: number): void {
    const metres = this.metres[a] ?? 0;
    this.metres[a] = this.metres[b] ?? 0;
    this.metres[b] = metres;
    const line = this.lines[a] ?? "";
    this.lines[a] = this.lines[b] ?? "";
    this.lines[b] = line;
  }
}

/**
 * Metres per degree of latitude, deliberately under-stated.
 *
 * The real figure runs from 110,574 m at the equator to 111,694 m at the pole. A *floor* on a
 * distance has to use the small end, because the only error that matters here is one that makes a
 * tile look further away than it is — that would drop stops the map should draw, silently.
 */
const METRES_PER_DEGREE_LATITUDE = 110_500;

/**
 * A floor on the distance from a point to anywhere inside a tile, in metres.
 *
 * This is what lets a viewport stop reading. Tiles are opened nearest-first, and once the heap
 * above is full at an admission price of `D`, a tile whose floor exceeds `D` cannot contain a stop
 * that would be kept — so it is not fetched, not decoded and not walked. On a Manchester viewport
 * the centre tiles alone fill four hundred markers, and the rest of the box is skipped entirely:
 * the saving is the whole object, not just its parse.
 *
 * Two deliberate conservatisms, because a floor that is ever too high loses markers:
 *
 * **The larger of the two separations, not their hypotenuse.** Each is independently a floor —
 * projecting a great-circle path onto either axis can only shorten it — whereas their hypotenuse
 * is a flat-earth combination that is not guaranteed to be one. It gives up a factor of at most
 * √2 of pruning power for a bound that needs no argument about spherical triangles.
 *
 * **The longitude term is scaled by 99%.** A degree of longitude is `111_320·cos(lat)` metres
 * along the parallel, and a great-circle path between two points on that parallel is very
 * slightly *shorter* than the parallel itself — 554 km against 556 km for ten degrees at
 * latitude 60. Over a tile of an eighth of a degree the difference is immaterial, but a bound
 * should not depend on that being true, and one per cent costs nothing.
 */
export function tileFloorMetres(tile: string, sizeDegrees: number, from: Coordinate): number {
  const underscore = tile.indexOf("_");
  if (underscore <= 0) return 0;
  const latIndex = Number(tile.slice(0, underscore));
  const lonIndex = Number(tile.slice(underscore + 1));
  if (!Number.isFinite(latIndex) || !Number.isFinite(lonIndex)) return 0;

  const south = latIndex * sizeDegrees;
  const north = south + sizeDegrees;
  const west = lonIndex * sizeDegrees;
  const east = west + sizeDegrees;

  const latGap = from.lat < south ? south - from.lat : from.lat > north ? from.lat - north : 0;
  const lonGap = from.lon < west ? west - from.lon : from.lon > east ? from.lon - east : 0;
  if (latGap === 0 && lonGap === 0) return 0;

  /* The highest latitude in play, because that is where a degree of longitude is shortest. */
  const absLat = Math.max(Math.abs(south), Math.abs(north), Math.abs(from.lat));
  const lonMetres = lonGap * 111_320 * Math.cos((absLat * Math.PI) / 180) * 0.99;
  const latMetres = latGap * METRES_PER_DEGREE_LATITUDE;
  return Math.max(latMetres, lonMetres);
}
