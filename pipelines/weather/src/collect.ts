import {
  MAX_LOCATIONS_PER_REQUEST,
  OPEN_METEO_ATTRIBUTION,
  STOP_WEATHER_CELL_DEGREES,
  normalizeStopWeatherBatch,
  openMeteoBatchUrl,
  stopWeatherCellCentre,
  weatherRequestBudget,
} from "@busstops/adapters";
import type { StopWeather } from "@busstops/contracts";
import { ArtifactStore, SourceClient, tileIdFor, type ObjectStore } from "@busstops/pipeline-core";

/**
 * Weather for every populated part of England, collected on a schedule.
 *
 * The Worker never asks Open-Meteo anything. If it did, the number of upstream calls would be a
 * property of how many people are looking at the site, which is exactly the shape that ends a
 * free non-commercial allowance. Here it is a property of the schedule: this job asks once for
 * every cell that has a bus stop in it, and the edge reads the answer.
 *
 * Two decisions keep the cost arithmetic rather than hope. Answers are cached per 0.10° cell —
 * about 11 km north-south, finer than a shower and far coarser than a bus stop — and Open-Meteo
 * takes comma-separated coordinate lists, so a few thousand cells cost tens of requests instead
 * of thousands. `weatherRequestBudget` computes the daily total for any cell count and interval,
 * and this job refuses to run a schedule that would not fit.
 *
 * Nothing here invents weather. A cell the model did not answer for is reported missing and left
 * out of the publish; the stop page then has no vignette, which is honest, rather than a picture
 * of a sky nobody measured.
 */

/**
 * How the published answers are grouped.
 *
 * One artifact for the whole country would be most of a megabyte, and the edge would read all of
 * it to show one stop — the mistake the network datasets were sharded to fix. A degree square
 * holds about a hundred cells and a few kilobytes, and a stop page reads exactly one.
 */
export const WEATHER_SHARD_DEGREES = 1;

export const WEATHER_SCHEMA_VERSION = "1";

/** The dataset holding one degree square of answers. */
export function weatherShardDataset(tile: string): string {
  return `weather/cells/${tile}`;
}

/** The shard a coordinate's answer lives in. Used by the edge, so the grids cannot drift apart. */
export function weatherShardForCell(cell: string): string {
  return tileIdFor(stopWeatherCellCentre(cell), WEATHER_SHARD_DEGREES);
}

/**
 * A ceiling on how much of the world this will ask about.
 *
 * England's stops fall in roughly two and a half thousand cells. A number far above that means
 * the tile listing returned something unexpected — a different grid, another country, a bug — and
 * asking Open-Meteo about it would spend the allowance on a mistake. The job stops instead.
 */
export const MAX_WEATHER_CELLS = 6000;

/** Where the stop tiles are listed. Their names are the only thing read: no stop is loaded. */
const STOP_TILE_MANIFEST_PREFIX = "manifests/network/stops-tile/";

/**
 * The tile grid the network publishes stops on.
 *
 * Duplicated as a number rather than imported from the static-network package so this pipeline
 * does not depend on it; the contract between them is the published key, and a test pins the two
 * values together.
 */
export const STOP_TILE_DEGREES = 0.25;

/**
 * The weather cells a set of published stop tiles covers.
 *
 * Derived from the tile names alone. Reading the stops themselves would give the exact set, at
 * the cost of pulling the national stop register through this job every time it runs; a 0.25°
 * tile is smaller than a 0.10° cell in one direction and larger in the other, so expanding each
 * tile to the cells it overlaps costs a handful of cells at the coast and no accuracy anywhere.
 */
export function weatherCellsForStopTiles(
  tiles: readonly string[],
  cellSize = STOP_WEATHER_CELL_DEGREES,
  tileSize = STOP_TILE_DEGREES,
): string[] {
  const cells = new Set<string>();
  for (const tile of tiles) {
    const parts = tile.split("_");
    if (parts.length !== 2) continue;
    const latIndex = Number(parts[0]);
    const lonIndex = Number(parts[1]);
    if (!Number.isFinite(latIndex) || !Number.isFinite(lonIndex)) continue;

    const south = latIndex * tileSize;
    const west = lonIndex * tileSize;
    // The half-open square [south, south + tileSize) — a tile's northern edge belongs to the next
    // tile, so the epsilon stops every tile also claiming the cell above and to the right of it.
    const north = south + tileSize - 1e-9;
    const east = west + tileSize - 1e-9;

    for (let lat = Math.floor(south / cellSize); lat <= Math.floor(north / cellSize); lat += 1) {
      for (let lon = Math.floor(west / cellSize); lon <= Math.floor(east / cellSize); lon += 1) {
        cells.add(`${lat}_${lon}`);
      }
    }
  }
  return [...cells].sort();
}

/** Tile names from a listing of published stop-tile manifests. */
export function stopTileNamesFromKeys(keys: readonly string[]): string[] {
  const tiles = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(STOP_TILE_MANIFEST_PREFIX)) continue;
    const rest = key.slice(STOP_TILE_MANIFEST_PREFIX.length);
    const tile = rest.split("/")[0];
    if (tile && /^-?\d+_-?\d+$/.test(tile)) tiles.add(tile);
  }
  return [...tiles].sort();
}

/** Seconds between batches, as a burst limit rather than a daily one requires. */
const BETWEEN_BATCHES_MS = 2_000;

export type CollectWeatherOutcome =
  "published" | "network_not_published" | "budget_exceeded" | "too_many_cells" | "no_answer";

export interface WeatherBatchOutcome {
  cells: number;
  answered: number;
  ms: number;
  error?: string;
}

export interface CollectStopWeatherResult {
  outcome: CollectWeatherOutcome;
  /** Cells asked about. */
  requested: number;
  /** Cells the model answered for. */
  answered: number;
  /** Cells it did not, which are published as nothing rather than as fair weather. */
  missing: number;
  batches: WeatherBatchOutcome[];
  /** Shards written, with how many cells each carries. */
  shards: Array<{ tile: string; cells: number }>;
  budget: ReturnType<typeof weatherRequestBudget>;
  retrievedAt: string;
}

export interface CollectStopWeatherOptions {
  store: ObjectStore;
  /** Minutes between runs, used to prove the schedule fits the daily allowance. */
  refreshMinutes: number;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Injected in tests; production leaves it alone. */
  sleep?: (ms: number) => Promise<void>;
  /** Publish the shards, or only report what would be asked and written. */
  publish?: boolean;
  maxCells?: number;
  /**
   * Wait between batches, so a refresh is a trickle rather than a burst.
   *
   * Open-Meteo's free tier is generous per day and strict per moment, and this job asks nine
   * questions as fast as the network will carry them. Run 59 measured exactly where that lands:
   * six batches answered in 1.8 seconds and then three came back `429`, having each already
   * retried three times. Run 60, from a GitHub runner sharing its egress address with everyone
   * else doing the same thing, lost all nine and published nothing.
   *
   * Nine requests spaced two seconds apart is sixteen seconds added to a job that runs every
   * thirty minutes, against a daily allowance we use four per cent of. The cost of being a
   * well-behaved client here is nothing at all.
   */
  betweenBatchesMs?: number;
}

export async function collectStopWeather(
  options: CollectStopWeatherOptions,
): Promise<CollectStopWeatherResult> {
  const now = options.now ?? new Date();
  const retrievedAt = now.toISOString();
  const maxCells = options.maxCells ?? MAX_WEATHER_CELLS;

  const keys = await options.store.list(STOP_TILE_MANIFEST_PREFIX);
  const tiles = stopTileNamesFromKeys(keys);
  const cells = weatherCellsForStopTiles(tiles);
  const budget = weatherRequestBudget(cells.length, options.refreshMinutes);

  const base: Omit<CollectStopWeatherResult, "outcome"> = {
    requested: cells.length,
    answered: 0,
    missing: 0,
    batches: [],
    shards: [],
    budget,
    retrievedAt,
  };

  /*
   * No stops published means no idea which part of the country matters, and asking about a
   * default rectangle would be inventing coverage. The stop page simply has no weather until the
   * network is there — which is the same state it is in before this job has ever run.
   */
  if (cells.length === 0) return { ...base, outcome: "network_not_published" };
  if (cells.length > maxCells) return { ...base, outcome: "too_many_cells" };
  if (!budget.withinAllowance) return { ...base, outcome: "budget_exceeded" };

  const client = new SourceClient("open_meteo", "england", 3600, {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
  });

  const answers: StopWeather[] = [];
  const batches: WeatherBatchOutcome[] = [];
  let missing = 0;

  const pauseMs = options.betweenBatchesMs ?? BETWEEN_BATCHES_MS;
  const pause =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let first = true;

  for (const group of batchesOf(cells, MAX_LOCATIONS_PER_REQUEST)) {
    // Spaced, not throttled after the fact: the first batch pays nothing and the rest queue.
    if (!first && pauseMs > 0) await pause(pauseMs);
    first = false;

    const startedAt = Date.now();
    try {
      const payload = await client.fetchJson<unknown>(openMeteoBatchUrl(group), {
        timeoutMs: 20_000,
        /*
         * Patient rather than persistent. The default three attempts half a second apart is
         * tuned for a server having a bad moment; a rate limit is a server telling us to come
         * back later, and half a second is not later. Open-Meteo sends `Retry-After` when it
         * knows, and the client honours it in preference to this.
         */
        maxAttempts: 4,
        baseDelayMs: 2_000,
      });
      const result = normalizeStopWeatherBatch(payload, {
        cells: group,
        retrievedAt,
        now,
      });
      answers.push(...result.weather);
      missing += result.missing.length;
      batches.push({
        cells: group.length,
        answered: result.weather.length,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      missing += group.length;
      batches.push({
        cells: group.length,
        answered: 0,
        ms: Date.now() - startedAt,
        // The URL carries no key, but it does carry a hundred coordinates; the class of failure
        // is what a log needs.
        error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 120)}` : "failed",
      });
    }
  }

  if (answers.length === 0) {
    return { ...base, outcome: "no_answer", missing, batches };
  }

  const byShard = new Map<string, StopWeather[]>();
  for (const answer of answers) {
    const tile = weatherShardForCell(answer.cell);
    const existing = byShard.get(tile);
    if (existing) existing.push(answer);
    else byShard.set(tile, [answer]);
  }

  const shards: Array<{ tile: string; cells: number }> = [];
  if (options.publish !== false) {
    const artifacts = new ArtifactStore(options.store);
    const version = retrievedAt.replace(/[:.]/g, "-");
    for (const [tile, records] of [...byShard].sort(([a], [b]) => a.localeCompare(b))) {
      await artifacts.publish({
        dataset: weatherShardDataset(tile),
        version,
        records,
        schemaVersion: WEATHER_SCHEMA_VERSION,
        sources: [OPEN_METEO_ATTRIBUTION],
        /*
         * Each shard stands alone. A degree square that failed this run keeps its previous
         * answer, which the stop page shows with its own timestamp, rather than the whole country
         * waiting for the worst tile. There is no cross-shard consistency to preserve: weather is
         * not a graph.
         */
        allowEmpty: false,
      });
      shards.push({ tile, cells: records.length });
    }
  } else {
    for (const [tile, records] of byShard) shards.push({ tile, cells: records.length });
  }

  return {
    ...base,
    outcome: "published",
    answered: answers.length,
    missing,
    batches,
    shards,
  };
}

/** Fixed-size groups, because one request carries a hundred coordinates rather than one. */
function batchesOf<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}
