import type { Coordinate, StopWeather } from "@busstops/contracts";
import { stopWeatherCell } from "@busstops/adapters";
import { ArtifactStore, type ObjectStore } from "@busstops/pipeline-core";
import { weatherShardDataset, weatherShardForCell } from "@busstops/pipeline-weather";

/**
 * The weather at a stop, read at the edge.
 *
 * The scheduled job asks Open-Meteo about every cell that has a bus stop in it and publishes one
 * artifact per degree square. This reads exactly one square — never the country — and picks the
 * cell the stop falls in.
 *
 * Nothing here fetches weather. That is the whole point of the arrangement: the number of
 * upstream calls is a property of the schedule, so a stop page that suddenly has a thousand
 * readers costs Open-Meteo nothing.
 *
 * A missing square, a missing cell and a stale square are three different answers and none of
 * them is fair weather. The first two return null and the stop page shows no vignette; the third
 * returns what was measured, carrying the timestamp it was measured at, and the page says how old
 * it is.
 */

/**
 * How long a square is served before it is read again.
 *
 * The job publishes every half hour, so a five-minute cache costs at most a few minutes of age
 * and saves an R2 read on almost every request for the same part of the country.
 */
const TTL_MS = 5 * 60 * 1000;

/**
 * How many squares an isolate holds.
 *
 * A degree square of answers is a few kilobytes, so this is a small number of them by design
 * rather than by necessity — the isolate memory guard exists because the national datasets are
 * hundreds of megabytes, and a cache with no ceiling is how that failure comes back one shard at
 * a time.
 */
const MAX_CACHED_SHARDS = 12;

interface CachedShard {
  cells: Map<string, StopWeather>;
  loadedAt: number;
}

export class WeatherReader {
  private readonly cache = new Map<string, CachedShard>();
  private readonly inFlight = new Map<string, Promise<CachedShard>>();
  private readonly artifacts: ArtifactStore;

  constructor(
    store: ObjectStore,
    private readonly ttlMs = TTL_MS,
  ) {
    this.artifacts = new ArtifactStore(store);
  }

  async forCoordinate(
    coordinate: Coordinate,
    now: number = Date.now(),
  ): Promise<StopWeather | null> {
    const cell = stopWeatherCell(coordinate);
    const tile = weatherShardForCell(cell);
    const shard = await this.shard(tile, now);
    return shard.cells.get(cell) ?? null;
  }

  private async shard(tile: string, now: number): Promise<CachedShard> {
    const cached = this.cache.get(tile);
    if (cached && now - cached.loadedAt < this.ttlMs) return cached;

    const existing = this.inFlight.get(tile);
    if (existing) return existing;

    const load = this.read(tile, now).finally(() => this.inFlight.delete(tile));
    this.inFlight.set(tile, load);
    return load;
  }

  private async read(tile: string, now: number): Promise<CachedShard> {
    let cells = new Map<string, StopWeather>();
    try {
      const { records } = await this.artifacts.readCurrent<StopWeather>(weatherShardDataset(tile));
      cells = new Map(records.map((record) => [record.cell, record]));
    } catch {
      /*
       * An unreadable square is the same as an unpublished one as far as a stop page is
       * concerned: no vignette. It is cached as empty for the TTL rather than retried on every
       * request, because a broken square must not turn one slow read into a slow stop page.
       */
      cells = new Map();
    }

    const shard: CachedShard = { cells, loadedAt: now };
    // Deleted before it is set, so a refreshed square goes to the back of the queue rather than
    // keeping the position of the copy it replaced and being evicted as though it were old.
    this.cache.delete(tile);
    this.cache.set(tile, shard);
    // Oldest out first; Map iterates in insertion order.
    while (this.cache.size > MAX_CACHED_SHARDS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return shard;
  }
}
