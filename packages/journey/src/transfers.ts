/**
 * Walking transfers, in a form that allocates nothing per edge.
 *
 * A corridor's transfers are the largest structure a journey request builds: a Manchester corridor
 * holds 108,284 of them over 2,063 stops, and a Birmingham one 126,952. Held as objects —
 * `{ fromStopId, toStopId, walkSeconds }` in a `Map` of arrays — that is a hundred thousand small
 * allocations per request, in a request allowed ten milliseconds of CPU in total, for a structure
 * that is **identical for every passenger on a given published network**. Stops do not move.
 *
 * So they are held as three parallel arrays over an integer index space: the offsets of each
 * stop's edges, the neighbour each edge reaches, and the walk it costs. A search walks them with
 * integer arithmetic and one array read for the neighbour's id, and the same shape is what the
 * published artifact decodes into — which is the point. The artifact's whole value would be lost
 * if the reader turned it back into the object graph it replaces.
 *
 * The order of a stop's neighbours is canonical: shortest walk first, and the neighbour's own id
 * breaks ties. Both the grid builder and the artifact produce that order, so the two are
 * comparable edge for edge, and a search's tie-breaking cannot depend on which one answered.
 */

import type { Coordinate } from "@busstops/contracts";
import { haversineMetres } from "@busstops/pipeline-core";

export const WALK_SPEED_METRES_PER_SECOND = 1.3;

/** Walking time between two points, at a deliberately unhurried pace. */
export function walkSecondsBetween(from: Coordinate, to: Coordinate): number {
  return Math.round(haversineMetres(from, to) / WALK_SPEED_METRES_PER_SECOND);
}

export interface JourneyStopLike {
  id: string;
  coordinate: Coordinate;
}

/**
 * One corridor's walking transfers.
 *
 * `stopIds` is the index space: `neighbours[edge]` is an index into it. `offsets` has one more
 * entry than there are stops, so a stop's edges are `offsets[i]` up to `offsets[i + 1]`, and a
 * stop with none costs nothing to ask about.
 */
export interface TransferAdjacency {
  readonly stopIds: readonly string[];
  readonly offsets: Uint32Array;
  readonly neighbours: Uint32Array;
  readonly seconds: Uint32Array;
  /** The index this stop occupies, or −1 when it is not in this adjacency at all. */
  indexOf(stopId: string): number;
  /** Edges in total, which is what a diagnostic reports as `transferEdges`. */
  readonly edgeCount: number;
  /** The walking cap these edges were built under, in seconds. */
  readonly capSeconds: number;
}

/** An empty adjacency, for a corridor with no stops. */
export function emptyTransferAdjacency(capSeconds: number): TransferAdjacency {
  return adjacencyFrom([], new Uint32Array(1), new Uint32Array(0), new Uint32Array(0), capSeconds);
}

function adjacencyFrom(
  stopIds: readonly string[],
  offsets: Uint32Array,
  neighbours: Uint32Array,
  seconds: Uint32Array,
  capSeconds: number,
): TransferAdjacency {
  const index = new Map<string, number>();
  for (let at = 0; at < stopIds.length; at += 1) index.set(stopIds[at]!, at);
  return {
    stopIds,
    offsets,
    neighbours,
    seconds,
    indexOf: (stopId: string): number => index.get(stopId) ?? -1,
    edgeCount: neighbours.length,
    capSeconds,
  };
}

/**
 * Build the adjacency from a list of edges, in canonical order.
 *
 * `edges` may arrive in any order and may contain an edge twice; the result holds each stop's
 * neighbours sorted by walk and then by the neighbour's id, which is what makes two adjacencies
 * built from different sources comparable.
 */
export function transferAdjacencyFromEdges(
  stopIds: readonly string[],
  edges: readonly { from: number; to: number; seconds: number }[],
  capSeconds: number,
): TransferAdjacency {
  const byStop: Array<Array<{ to: number; seconds: number }>> = Array.from(
    { length: stopIds.length },
    () => [],
  );
  for (const edge of edges) {
    if (edge.from < 0 || edge.from >= stopIds.length) continue;
    if (edge.to < 0 || edge.to >= stopIds.length) continue;
    if (edge.from === edge.to) continue;
    byStop[edge.from]!.push({ to: edge.to, seconds: edge.seconds });
  }

  const offsets = new Uint32Array(stopIds.length + 1);
  let total = 0;
  for (let at = 0; at < stopIds.length; at += 1) {
    const list = byStop[at]!;
    list.sort((a, b) =>
      a.seconds !== b.seconds
        ? a.seconds - b.seconds
        : stopIds[a.to]! < stopIds[b.to]!
          ? -1
          : stopIds[a.to]! > stopIds[b.to]!
            ? 1
            : 0,
    );
    offsets[at] = total;
    total += list.length;
  }
  offsets[stopIds.length] = total;

  const neighbours = new Uint32Array(total);
  const seconds = new Uint32Array(total);
  let at = 0;
  for (const list of byStop) {
    for (const edge of list) {
      neighbours[at] = edge.to;
      seconds[at] = edge.seconds;
      at += 1;
    }
  }
  return adjacencyFrom(stopIds, offsets, neighbours, seconds, capSeconds);
}

/**
 * Walking transfers between stops within range, without comparing every pair.
 *
 * This was two nested loops over the corridor's stops and it was the single most expensive thing a
 * journey request did. Profiled against the published artifact: a Birmingham corridor holds 2,737
 * stops and 126,952 transfer edges, and building them took 911 milliseconds against a budget of
 * ten for the whole request — 7.5 million haversines, of which 126,952 produced an edge.
 *
 * Stops go into a grid of cells about as wide as the furthest walk allowed, so every stop within
 * range of one is in its own cell or one of the eight around it, and no pair outside those is ever
 * considered. That is exact rather than approximate: a pair further apart than the cell
 * neighbourhood cannot be within the walking cap, by construction of the cell size.
 *
 * Inside the neighbourhood a flat distance decides who gets a haversine. The flat metric is within
 * a fraction of a per cent of the real thing at these ranges and costs no trigonometry, so it is
 * used as a sieve with a five per cent margin and the survivors are measured properly. It is
 * deliberately *only* a sieve: a property test caught a flat metric reordering exact ties when it
 * was used to rank, and the edge's own walk is what the search reads.
 *
 * The cells are keyed by one integer rather than by `${row}:${column}`. Same grid, same edges, and
 * measured at 32 ms against 52 on a 2,063-stop corridor: about twenty thousand short strings were
 * being built, hashed and compared per request to find a bucket. Rows and columns are taken
 * relative to the lowest corner of the set, so both are at least −1 and bounded by the set's own
 * span, and the row is multiplied by a stride wider than any column — no two cells can collide,
 * which a hash of two numbers mixed together could not promise.
 *
 * This stays for the corridor whose published transfers are missing, and for the oracle that the
 * published ones are proved against. On a published network it should not run at all.
 */
export function buildTransferAdjacency(
  stops: readonly JourneyStopLike[],
  maxTransferSeconds: number,
): TransferAdjacency {
  const stopIds = stops.map((stop) => stop.id);
  if (stops.length === 0) return emptyTransferAdjacency(maxTransferSeconds);
  const grid = gridOver(stops, maxTransferSeconds);
  const edges: Array<{ from: number; to: number; seconds: number }> = [];
  for (let from = 0; from < stops.length; from += 1) {
    grid.eachWithinCap(from, (to, seconds) => {
      edges.push({ from, to, seconds });
    });
  }
  return transferAdjacencyFromEdges(stopIds, edges, maxTransferSeconds);
}

/**
 * The spatial grid both builders use, and the walking cap applied through it.
 *
 * One implementation, because there are two callers — a corridor's own adjacency and the published
 * tiles — and a grid that differed between them would publish edges the request-time fallback
 * disagreed with. Which is exactly the bug the equivalence test exists to catch, and the easiest
 * way not to have it is to have one grid.
 */
function gridOver(
  stops: readonly JourneyStopLike[],
  maxTransferSeconds: number,
): {
  eachWithinCap: (from: number, visit: (to: number, seconds: number) => void) => void;
} {
  const maxMetres = maxTransferSeconds * WALK_SPEED_METRES_PER_SECOND;
  const latitudeSpan = maxMetres / 111_320;
  /*
   * Taken at the highest latitude in the set, not its middle, and that is the difference between
   * exact and nearly. A degree of longitude shortens towards the poles, so sizing the cell on the
   * mean latitude makes it narrower than the walking cap wherever the set reaches higher than its
   * mean — and a pair within walking distance could then sit two cells apart and never be
   * compared. The smallest cosine in the set makes every cell at least as wide as the cap
   * everywhere in it. The same figure sieves below, where under-stating the metres in a degree of
   * longitude under-states the distance, and therefore keeps pairs rather than discarding them.
   */
  let cosLatitude = 1;
  for (const stop of stops) {
    cosLatitude = Math.min(cosLatitude, Math.cos((Math.abs(stop.coordinate.lat) * Math.PI) / 180));
  }
  cosLatitude = Math.max(0.01, cosLatitude);
  const longitudeSpan = latitudeSpan / cosLatitude;

  let lowestLatitude = Infinity;
  let lowestLongitude = Infinity;
  let highestLongitude = -Infinity;
  for (const stop of stops) {
    if (stop.coordinate.lat < lowestLatitude) lowestLatitude = stop.coordinate.lat;
    if (stop.coordinate.lon < lowestLongitude) lowestLongitude = stop.coordinate.lon;
    if (stop.coordinate.lon > highestLongitude) highestLongitude = stop.coordinate.lon;
  }
  /* Two spare columns: one for the cell the neighbourhood reaches below zero, one above the top. */
  const stride = Math.floor((highestLongitude - lowestLongitude) / longitudeSpan) + 3;
  const rowOf = (stop: JourneyStopLike): number =>
    Math.floor((stop.coordinate.lat - lowestLatitude) / latitudeSpan);
  const columnOf = (stop: JourneyStopLike): number =>
    Math.floor((stop.coordinate.lon - lowestLongitude) / longitudeSpan);
  const keyOf = (row: number, column: number): number => (row + 1) * stride + (column + 1);

  const cells = new Map<number, number[]>();
  for (let at = 0; at < stops.length; at += 1) {
    const key = keyOf(rowOf(stops[at]!), columnOf(stops[at]!));
    const existing = cells.get(key);
    if (existing) existing.push(at);
    else cells.set(key, [at]);
  }

  const sieve = (maxMetres * 1.05) ** 2;
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = 111_320 * cosLatitude;

  return {
    eachWithinCap: (from: number, visit: (to: number, seconds: number) => void): void => {
      const here = stops[from]!;
      const fromRow = rowOf(here);
      const fromColumn = columnOf(here);
      for (let row = fromRow - 1; row <= fromRow + 1; row += 1) {
        for (let column = fromColumn - 1; column <= fromColumn + 1; column += 1) {
          const neighbours = cells.get(keyOf(row, column));
          if (!neighbours) continue;
          for (const to of neighbours) {
            if (to === from) continue;
            const there = stops[to]!;
            const dLat = (there.coordinate.lat - here.coordinate.lat) * metresPerDegreeLatitude;
            const dLon = (there.coordinate.lon - here.coordinate.lon) * metresPerDegreeLongitude;
            if (dLat * dLat + dLon * dLon > sieve) continue;
            const seconds = walkSecondsBetween(here.coordinate, there.coordinate);
            if (seconds <= maxTransferSeconds) visit(to, seconds);
          }
        }
      }
    },
  };
}

/**
 * The same transfers, cut into the tiles they are published as.
 *
 * One tile holds every stop whose coordinate falls inside it, with its complete neighbour list,
 * plus the stops within the walking cap of one of those as targets only. That halo is the whole
 * correctness argument for publishing per tile: a corridor reads the tiles its own stops fall in,
 * and every edge between two of its stops is in one of them, because the edge's near end is in a
 * tile that was read and its far end is within the cap of that end.
 *
 * Stop ids come out ascending, so a reader can find one without decoding the rest, and two
 * publishes of the same network produce the same bytes.
 */
export interface TransferTilePlan {
  tile: string;
  /** The index space: the tile's own stops and their neighbours, ascending. */
  stopIds: string[];
  offsets: Uint32Array;
  neighbours: Uint32Array;
  seconds: Uint32Array;
  /** How many of `stopIds` are the tile's own, rather than halo targets. */
  ownStops: number;
}

export function buildTransferTiles(
  stops: readonly JourneyStopLike[],
  options: { capSeconds: number; tileOf: (stop: JourneyStopLike) => string },
): TransferTilePlan[] {
  if (stops.length === 0) return [];
  const grid = gridOver(stops, options.capSeconds);

  const byTile = new Map<string, number[]>();
  for (let at = 0; at < stops.length; at += 1) {
    const tile = options.tileOf(stops[at]!);
    const existing = byTile.get(tile);
    if (existing) existing.push(at);
    else byTile.set(tile, [at]);
  }

  const plans: TransferTilePlan[] = [];
  for (const tile of [...byTile.keys()].sort()) {
    const own = byTile.get(tile)!;
    /* The index space, built as the edges are found: own stops first, then the halo. */
    const localOf = new Map<number, number>();
    const localIds: string[] = [];
    const intern = (at: number): number => {
      const held = localOf.get(at);
      if (held !== undefined) return held;
      const index = localIds.length;
      localOf.set(at, index);
      localIds.push(stops[at]!.id);
      return index;
    };

    const edges: Array<{ from: number; to: number; seconds: number }> = [];
    for (const from of own) {
      const fromLocal = intern(from);
      grid.eachWithinCap(from, (to, seconds) => {
        const toLocal = intern(to);
        /* The same id twice is the same stop: a duplicated row must not become an edge. */
        if (toLocal !== fromLocal) edges.push({ from: fromLocal, to: toLocal, seconds });
      });
    }

    /* Re-indexed into ascending id order, which is what the artifact stores. */
    const order = [...localIds.keys()].sort((a, b) =>
      localIds[a]! < localIds[b]! ? -1 : localIds[a]! > localIds[b]! ? 1 : 0,
    );
    const rank = new Uint32Array(localIds.length);
    for (let at = 0; at < order.length; at += 1) rank[order[at]!] = at;
    const adjacency = transferAdjacencyFromEdges(
      order.map((at) => localIds[at]!),
      edges.map((edge) => ({ from: rank[edge.from]!, to: rank[edge.to]!, seconds: edge.seconds })),
      options.capSeconds,
    );

    plans.push({
      tile,
      stopIds: [...adjacency.stopIds],
      offsets: adjacency.offsets,
      neighbours: adjacency.neighbours,
      seconds: adjacency.seconds,
      ownStops: own.length,
    });
  }
  return plans;
}

/**
 * One corridor's adjacency, from the published tiles, restricted to the stops it actually holds.
 *
 * The tiles carry a halo, so they know about stops this corridor does not use; an edge to one of
 * those is dropped here rather than offered to the search, which is what makes the result equal to
 * what building the corridor's own transfers would have produced. Integer copies only: no
 * geometry, no objects, nothing decoded that the search will not read.
 *
 * Returns null when a tile was built under a different walking cap. An adjacency is only valid for
 * its cap, and quietly using one built for a longer walk would offer a transfer a passenger cannot
 * make — so the caller falls back to building its own and says it did.
 */
export function mergeTransferTiles(
  corridorStopIds: readonly string[],
  tiles: readonly {
    stopIds: readonly string[];
    offsets: Uint32Array;
    neighbours: Uint32Array;
    /** Sixteen bits is what the artifact stores; the builder's own arrays are wider. */
    seconds: Uint32Array | Uint16Array;
    capSeconds: number;
  }[],
  capSeconds: number,
): TransferAdjacency | null {
  for (const tile of tiles) {
    if (tile.capSeconds !== capSeconds) return null;
  }

  const indexOfStop = new Map<string, number>();
  for (let at = 0; at < corridorStopIds.length; at += 1) indexOfStop.set(corridorStopIds[at]!, at);

  const edges: Array<{ from: number; to: number; seconds: number }> = [];
  for (const tile of tiles) {
    /* Each tile's own index space mapped once, not once per edge. */
    const mapped = new Int32Array(tile.stopIds.length);
    for (let at = 0; at < tile.stopIds.length; at += 1) {
      mapped[at] = indexOfStop.get(tile.stopIds[at]!) ?? -1;
    }
    for (let at = 0; at < tile.stopIds.length; at += 1) {
      const from = mapped[at]!;
      if (from < 0) continue;
      const end = tile.offsets[at + 1]!;
      for (let edge = tile.offsets[at]!; edge < end; edge += 1) {
        const to = mapped[tile.neighbours[edge]!]!;
        if (to < 0) continue;
        edges.push({ from, to, seconds: tile.seconds[edge]! });
      }
    }
  }

  return transferAdjacencyFromEdges(corridorStopIds, edges, capSeconds);
}
