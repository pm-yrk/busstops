import { SourceClient } from "@busstops/pipeline-core";
import { getSourceRegistryEntry } from "@busstops/contracts";
import { bodsDatafeedUrl, dailyRotationSalt, normalizeSiriVm } from "@busstops/adapters";
import type { CollectionPartition } from "./partitions.js";

/**
 * The upstream fetcher for the intelligence path.
 *
 * The vehicle reference is salted per service day exactly as the user path does it, so the
 * intelligence store never holds a stable identifier for a vehicle. Rotating the salt daily means
 * a trace cannot be joined to yesterday's, which is what keeps this a traffic-conditions dataset
 * rather than a vehicle-tracking one.
 */

export interface BodsCollectorOptions {
  apiKey: string | undefined;
  /** Secret behind the daily salt. Never logged, never published, never stored with the data. */
  vehicleSaltSecret: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function createBodsPartitionFetcher(options: BodsCollectorOptions) {
  const entry = getSourceRegistryEntry("bods")!;
  const client = new SourceClient(
    "bods",
    "non_london",
    entry.freshnessSlaSeconds,
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
  );

  const fetchPartition = async (
    partition: CollectionPartition,
    signal: AbortSignal,
  ): Promise<readonly unknown[]> => {
    if (!options.apiKey) {
      throw new Error("BODS_API_KEY is not configured");
    }
    if (!options.vehicleSaltSecret) {
      // Without the salt the store would hold the operator's own vehicle identifiers. Refusing
      // to collect is the correct outcome; collecting unsalted would be a privacy regression.
      throw new Error("VEHICLE_SALT_SECRET is not configured");
    }
    const now = options.now ? options.now() : new Date();
    const url = bodsDatafeedUrl(partition.bbox, options.apiKey);
    const xml = await client.fetchText(url, { timeoutMs: 20_000, maxAttempts: 2, signal });
    const normalized = normalizeSiriVm(xml, {
      retrievedAt: now.toISOString(),
      vehicleSalt: dailyRotationSalt(now.toISOString().slice(0, 10), options.vehicleSaltSecret),
      now,
    });
    return normalized.observations;
  };

  return { fetchPartition, health: () => client.health() };
}
