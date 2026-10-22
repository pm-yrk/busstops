#!/usr/bin/env node
/**
 * Daily static-network job: fingerprint each source, rebuild only on change, publish atomically.
 *
 * Exits non-zero only on a real failure. A missing credential is reported as a configuration
 * outcome, not a crash, so the schedule keeps running and the gap stays visible in the report.
 */

import { writeFileSync } from "node:fs";
import {
  ArtifactStore,
  annotateReport,
  r2StoreFromEnv,
  type ObjectStore,
} from "@busstops/pipeline-core";
import { assembleGtfsNetwork } from "./src/gtfs-assemble.js";
import { discardGtfsArchive, fetchGtfsArchive } from "./src/gtfs-sources.js";
import {
  compareFingerprints,
  fingerprintFromBody,
  fingerprintFromParts,
  type SourceFingerprint,
} from "./src/fingerprint.js";
import { DATASETS, publishNetwork, rollbackNetwork } from "./src/publish.js";
import {
  publishSpilledJourneyTiles,
  type SpilledJourneyPublishResult,
} from "./src/publish-spilled-journeys.js";
import { encodeDepartureShardFromJsonl } from "./src/departures-index.js";
import { MAX_PUBLISH_BYTES, publishNetworkShards } from "./src/publish-shards.js";
import { serviceDateHorizonFromEnv } from "./src/service-dates.js";
import { earliestServiceDateToKeep, pruneExpiredServiceDates } from "./src/prune-service-dates.js";
import { bucketServices } from "./src/service-buckets.js";
import { SERVICE_NAMES_DATASET, serviceNames } from "./src/service-names.js";
import { SHARDED } from "./src/shards.js";
import { fetchStaticSources } from "./src/sources.js";

const FINGERPRINT_DATASET = "network/fingerprints";

/**
 * What a publish achieved, in the two currencies it can run out of.
 *
 * The first national departure publish wrote 7,168 objects in 1,647 seconds — 4.35 a second, at a
 * concurrency of eight — and the build was killed by its own time limit before it finished the
 * trips. That number reads equally as a per-account request limit on the REST API and as 1.8 MB/s
 * of bandwidth, and one run cannot tell those apart. Printing both means the next one can.
 */
function throughput(result: SpilledJourneyPublishResult): string {
  const { objects, bytes, seconds, objectsPerSecond } = result.throughput;
  const megabytes = bytes / (1024 * 1024);
  return (
    `Wrote ${objects} objects, ${megabytes.toFixed(1)} MiB in ${seconds.toFixed(1)}s ` +
    `(${objectsPerSecond.toFixed(2)} objects/s, ${(megabytes / Math.max(seconds, 0.001)).toFixed(2)} MiB/s).`
  );
}

/**
 * Deleting the days that have already happened, and the copies no version serves.
 *
 * A refresh joins new dates to the version already live rather than replacing it, and dated shards
 * are written as plain objects rather than published artifacts — so `prune-versions`, which works
 * from manifests, has never been able to see them. Between them those two facts mean an artifact
 * only ever grows, at about 1.27 GB a service date against a 10 GB free allowance for the account.
 *
 * Yesterday is kept: the board reads it for the buses that left before midnight and are still
 * running. So is the version the index names as its predecessor, because that is what a rollback
 * restores, and a rollback to an artifact with a map and no departures is not a rollback.
 */
async function prunePastServiceDates(
  store: ObjectStore,
  artifacts: ArtifactStore,
  startedAt: Date,
  report: Record<string, unknown>,
): Promise<void> {
  /*
   * Opt-in, so merging this branch cannot change what the production schedule does.
   *
   * The pruning is needed where the horizon is wide — every service date is about 1.27 GB against a
   * 10 GB free allowance for the account — and it is deliberately conservative: yesterday is kept
   * because a bus that left at 23:40 is still running, and the version a rollback would restore is
   * kept too. But it is still deletion, and `static-network-daily.yml` runs against the production
   * bucket on a schedule that already exists. A flag the preview sets and production does not means
   * this branch reaching main changes nothing there until somebody decides it should.
   */
  if (process.env.PRUNE_SERVICE_DATES !== "true") {
    report.prunedServiceDates = { skipped: "PRUNE_SERVICE_DATES is not true" };
    console.log(
      "Past service dates were not pruned: PRUNE_SERVICE_DATES is not set. Storage grows by about " +
        "1.27 GB a service date until it is.",
    );
    return;
  }

  const liveIndex = await artifacts.readManifest(SHARDED.index);
  const pruned = await pruneExpiredServiceDates(store, {
    keepFrom: earliestServiceDateToKeep(startedAt),
    keepVersions:
      liveIndex === null
        ? undefined
        : [liveIndex.version, liveIndex.previousVersion].filter(
            (candidate): candidate is string => typeof candidate === "string",
          ),
  });
  report.prunedServiceDates = pruned;
  if (pruned.keysDeleted > 0) {
    console.log(
      `Pruned ${pruned.keysDeleted} dated object(s): ${pruned.datesDeleted.length} past service ` +
        `date(s) (${pruned.datesDeleted.join(", ") || "none"}) and ` +
        `${pruned.staleVersionKeysDeleted} left by a version nothing serves.`,
    );
  }
  if (pruned.failed.length > 0) {
    console.error(
      `${pruned.failed.length} expired object(s) could not be deleted; they cost storage but ` +
        `nothing reads them. First: ${pruned.failed[0]?.key} (${pruned.failed[0]?.reason}).`,
    );
  }
}

async function main(): Promise<number> {
  const startedAt = new Date();
  const report: Record<string, unknown> = { startedAt: startedAt.toISOString() };

  /*
   * Two modes, because the expensive half of a build is not the half that goes stale.
   *
   * Everything except departures and pattern trips — stops, patterns, the search index, the stop
   * detail buckets — is 11,594 objects and about 48 minutes of publishing, and none of it is keyed
   * by a service date, so none of it expires. The two families that *are* keyed by date are 1,852
   * objects a day and cost minutes. A refresh that republishes only those extends a live artifact's
   * timetable without rebuilding the country, at a fraction of the metered writes, and publishes at
   * the version already serving traffic so the edge needs no new pointer.
   */
  const departuresOnly = process.env.DEPARTURES_ONLY === "true";

  const storeResult = r2StoreFromEnv(process.env);
  if (!storeResult.ok) {
    report.outcome = "not_configured";
    report.missing = storeResult.missing;
    console.error(`Artifact storage is not configured. Missing: ${storeResult.missing.join(", ")}`);
    writeReport(report);
    return 0;
  }

  const store = storeResult.store;
  const artifacts = new ArtifactStore(store);

  // NaPTAN only. The timetable no longer comes from paging the dataset catalogue.
  const sources = await fetchStaticSources({
    bodsApiKey: process.env.BODS_API_KEY,
    maxTimetableDatasets: 0,
  });
  report.sourceHealth = sources.health;
  report.sourceErrors = sources.errors;
  /*
   * How much of England has a timetable, as a number.
   *
   * NaPTAN gives every stop in the country whatever happens here; services, routes and departures
   * come only from the datasets this run took. A build that fetched a fraction of them produces a
   * complete map with a departure board at some of its stops and none at others, which looks like
   * a defect at the stop and is really a coverage figure — so the figure is published.
   */
  const region = process.env.BODS_GTFS_REGION ?? "all";
  const archive = await fetchGtfsArchive({ apiKey: process.env.BODS_API_KEY, region });
  if (!archive.ok) {
    report.outcome = "source_unavailable";
    report.timetableSource = { region, error: archive.failure.error, ms: archive.failure.ms };
    console.error(
      `The ${region} GTFS timetable archive could not be fetched (${archive.failure.error}); ` +
        `keeping the previous good network.`,
    );
    writeReport(report);
    return 1;
  }
  archiveToDiscard = archive.download.path;
  report.timetableSource = {
    region,
    bytes: archive.download.bytes,
    ms: archive.download.ms,
    contentType: archive.download.contentType,
  };
  console.log(
    `Timetable source: BODS GTFS "${region}", ${(archive.download.bytes / 1024 / 1024).toFixed(1)} MiB ` +
      `in ${(archive.download.ms / 1000).toFixed(1)}s. Every registration in it is read; there is no cap.`,
  );

  if (!sources.naptanCsv) {
    report.outcome = "source_unavailable";
    console.error("NaPTAN could not be fetched; keeping the previous good network.");
    writeReport(report);
    return 1;
  }

  const currentFingerprints: SourceFingerprint[] = [
    fingerprintFromBody("naptan", sources.naptanCsv, startedAt.toISOString()),
    /*
     * The archive is fingerprinted by its size and the region it came from rather than by its
     * bytes: it is measured in hundreds of megabytes, and hashing it would mean reading the whole
     * thing an extra time to answer a question — "has this changed?" — that its length answers
     * well enough to decide whether to rebuild. FORCE_REBUILD exists for when it does not.
     */
    fingerprintFromParts(
      "bods",
      [`gtfs:${region}:${archive.download.bytes}`],
      startedAt.toISOString(),
    ),
  ];

  const previous = await artifacts.readCurrent<SourceFingerprint>(FINGERPRINT_DATASET);
  const previousBySource = new Map(previous.records.map((f) => [f.source, f]));

  const comparisons = currentFingerprints.map((current) =>
    compareFingerprints(previousBySource.get(current.source) ?? null, current),
  );
  report.fingerprints = comparisons.map((c) => ({
    source: c.current.source,
    changed: c.changed,
    reason: c.reason,
  }));

  const forceRebuild = process.env.FORCE_REBUILD === "true";
  const changed = comparisons.some((c) => c.changed);

  /*
   * A departures refresh runs even when nothing upstream changed, because nothing upstream has to:
   * what changed is the date. Short-circuiting on an unchanged fingerprint is exactly how an
   * artifact with two days of timetable reaches its third day still believing it is current.
   */
  if (!changed && !forceRebuild && !departuresOnly) {
    // Record the check so "unchanged" is distinguishable from "did not run".
    await artifacts.publish({
      dataset: FINGERPRINT_DATASET,
      version: startedAt.toISOString(),
      records: currentFingerprints,
      schemaVersion: "1.0.0",
      sources: ["naptan", "bods"],
    });
    report.outcome = "unchanged";
    console.log("No source changes detected; check recorded, rebuild skipped.");
    writeReport(report);
    return 0;
  }

  /*
   * How many days of timetable this artifact will be able to answer for. See service-dates.ts: the
   * horizon used to be today and tomorrow, which is why boards across England went blank on an
   * artifact's third day without anything having failed.
   */
  const horizon = serviceDateHorizonFromEnv(startedAt, process.env);
  const serviceDates = horizon.serviceDates;
  report.horizon = { days: horizon.days, offsetDays: horizon.offsetDays, serviceDates };
  console.log(
    `Service-date horizon: ${serviceDates.length} day(s), ${serviceDates[0]} to ` +
      `${serviceDates[serviceDates.length - 1]}.`,
  );

  /*
   * In refresh mode, the version is the one already live rather than a new one.
   *
   * Shards are addressed at the version the index names, so writing today's new dates at
   * `startedAt` would publish them where nothing will ever look. Reading the index's own manifest
   * is the only honest source for that string, and a missing index means there is no artifact to
   * extend — which is a configuration mistake, not something to paper over with a new version.
   */
  let version = startedAt.toISOString();
  if (departuresOnly) {
    const index = await artifacts.readManifest(SHARDED.index);
    if (!index) {
      report.outcome = "no_artifact_to_refresh";
      console.error(
        `Departures-only refresh asked for, but ${SHARDED.index} has no published version to ` +
          `extend. Run a full build first.`,
      );
      writeReport(report);
      return 1;
    }
    version = index.version;
    report.refreshedVersion = version;
    console.log(`Refreshing departures at the live artifact version ${version}.`);
  }

  const assembled = await assembleGtfsNetwork({
    naptanCsv: sources.naptanCsv,
    archivePath: archive.download.path,
    serviceDates,
    retrievedAt: startedAt.toISOString(),
  });
  // Both spills are build intermediates; neither survives the run.
  spillToDispose = {
    dispose: () => {
      assembled.departureSpill.dispose();
      assembled.patternTripSpill.dispose();
    },
  };
  const network = assembled.network;
  report.counts = network.counts;
  report.warnings = network.warnings.slice(0, 50);
  report.serviceDates = serviceDates;
  report.gtfs = assembled.gtfsCounts;
  report.gtfsTables = assembled.tables;
  report.spill = {
    departures: assembled.departureSpill.stats(),
    patternTrips: assembled.patternTripSpill.stats(),
  };

  /*
   * Coverage, as a measurement rather than a claim.
   *
   * NaPTAN gives every stop in the country whatever happens here. What this figure says is how
   * much of the *timetable* was read — which is now the whole archive, so the number that matters
   * is how many of the country's stops have a journey calling at them.
   */
  report.timetableCoverage = {
    source: `bods_gtfs_${region}`,
    routesRead: assembled.gtfsCounts.routes,
    routesKept: assembled.gtfsCounts.routes - assembled.gtfsCounts.routesSkippedByMode,
    tripsInHorizon: assembled.gtfsCounts.tripsInHorizon,
    stopTimeRowsRead: assembled.gtfsCounts.stopTimeRows,
    journeys: assembled.journeyCount,
    stopsMatchedToNaptan: assembled.gtfsCounts.stopsMatchedToNaptan,
    stopsWithoutNaptan: assembled.gtfsCounts.stopsWithoutNaptan,
    outOfOrderTrips: assembled.gtfsCounts.outOfOrderTrips,
    tripsRejectedForTime: assembled.gtfsCounts.tripsRejectedForTime,
  };
  console.log(
    `Read ${assembled.gtfsCounts.stopTimeRows} stop_times rows across ` +
      `${assembled.gtfsCounts.routes} routes; ${assembled.journeyCount} journeys on ` +
      `${serviceDates.join(" and ")}.`,
  );
  // Printed rather than left in the report, because the number this replaced was an exception
  // that ended the build, and a silent count would be a worse answer than a loud crash.
  if (assembled.gtfsCounts.tripsRejectedForTime > 0) {
    console.log(
      `${assembled.gtfsCounts.tripsRejectedForTime} trips carried a time too far past their ` +
        `service date to place, and were dropped.`,
    );
  }

  /*
   * The national datasets, skipped by a refresh: none of them is keyed by a service date, so none
   * of them is what expired.
   */
  const result = departuresOnly
    ? null
    : await publishNetwork(store, network, {
        version,
        journeyCount: assembled.journeyCount,
      });
  if (result) {
    report.published = result.published.map((m) => ({
      dataset: m.dataset,
      records: m.recordCount,
    }));
    report.failed = result.failed;
  }

  /*
   * One exception to "a refresh publishes nothing national": the operators.
   *
   * A refresh builds the whole network in memory and publishes only what expired, which is right.
   * But `network/operators` is the one national dataset whose *contents* were wrong rather than
   * stale: it recorded only `agency_id`, which in the BODS feed is an internal row id (OP10232),
   * while the live vehicle feed identifies operators by National Operator Code (FCYM). So the
   * analytics batch mapped 0 of 20,033 observed vehicles to a published route, and Pro could show
   * no route or operator figure at all. Reading `agency_noc` fixes the build; without this, that
   * fix would not reach the deployment until somebody paid for a full national rebuild — and a
   * rebuild writes a second eight-gigabyte version into a ten-gibibyte free allowance, which is
   * the one thing this project will not do.
   *
   * It is safe to republish alone. An operator's id is `deterministicUuid("operator", agency_id)`
   * and the key is unchanged, so every `operatorId` a service already carries still resolves; the
   * only difference in the record is that `licenceRegistryIds` gains the code the live feed sends.
   * It is one small object, published at the version already live, and a failure is reported
   * rather than fatal because a refresh exists to carry the timetable forward and must still do
   * that.
   */
  if (departuresOnly) {
    try {
      const manifest = await artifacts.publish({
        dataset: DATASETS.operators,
        version,
        records: network.operators,
        schemaVersion: "1.0.0",
        sources: ["bods"],
        partialCoverage: false,
        notes: "Republished by a departures refresh to carry agency_noc.",
      });
      const withNoc = network.operators.filter(
        (operator) => operator.licenceRegistryIds.length > 1,
      ).length;
      report.republishedOperators = { records: manifest.recordCount, withNoc };
      console.log(
        `Republished ${manifest.recordCount} operator(s) at ${version}; ` +
          `${withNoc} carry a National Operator Code.`,
      );
    } catch (error) {
      report.republishedOperators = {
        failed: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
      console.error("Operators could not be republished; the timetable refresh still stands.");
    }

    /*
     * The services object itself, republished beside its buckets so the two agree.
     *
     * Found by the proof step rather than by reasoning, which is what it is for. The buckets are
     * built from the GTFS this run downloaded — 13,027 services — and `network/services` still
     * held the 13,626 from the national build of 30 September. The proof duly reported 849
     * "missing" and 250 "extra" with `misplaced: 0` and `duplicated: 0`: the bucketing was
     * perfect and the baseline was two weeks old.
     *
     * Left alone, that is worse than a failed comparison. A board reading buckets would get
     * today's services and a board falling back would get September's, and two representations of
     * the same data disagreeing is the kind of fault that surfaces as one stop naming a route
     * another stop does not. The operators are republished here for the same reason; services
     * belong beside them.
     *
     * One object of about 4.7 MiB, at the version already live. The shrink guard still applies and
     * still should: 13,027 against 13,626 is 4.4%, well inside it, while a build that produced a
     * tenth of the network has no business replacing one that did not.
     */
    try {
      const manifest = await artifacts.publish({
        dataset: DATASETS.services,
        version,
        records: network.services,
        schemaVersion: "1.0.0",
        sources: ["bods"],
        partialCoverage: false,
        notes: "Republished by a departures refresh to stay in step with its buckets.",
      });
      report.republishedServices = { records: manifest.recordCount, bytes: manifest.sizeBytes };
      console.log(`Republished ${manifest.recordCount} service(s) at ${version}.`);
    } catch (error) {
      report.republishedServices = {
        failed: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
      console.error("Services could not be republished; the timetable refresh still stands.");
    }

    /*
     * And the service buckets, published into the live version beside the services object rather
     * than instead of it.
     *
     * A stop board resolves two or three service ids and was fetching and decoding 4.7 MiB of
     * `network/services` to do it, every time, because a filtered read cannot cache its records.
     * Partitioned by id, the same question costs one object of about 19 KiB. The records are
     * identical and the total data is unchanged; only the partitioning is new.
     *
     * Published the same way the operators are — into the version already live, so this needs no
     * national rebuild, which a 10 GiB free allowance holding an 8 GB artifact could not take.
     *
     * **The old object is left exactly where it is.** That is the rollback: the reader treats an
     * absent bucket as "no service of yours is here" and falls back to scanning the full object,
     * so a deployment reading a version published before this family existed behaves as it always
     * did, and withdrawing the family is a matter of ceasing to publish it rather than of undoing
     * anything.
     *
     * A failure here is reported and not fatal, for the same reason as the operators: a refresh
     * exists to carry the timetable forward and must still do that.
     */
    try {
      const buckets = bucketServices(network.services);
      let published = 0;
      let records = 0;
      let bytes = 0;
      const failures: string[] = [];
      for (const [dataset, rows] of buckets) {
        try {
          const manifest = await artifacts.publish({
            dataset,
            version,
            records: rows,
            schemaVersion: "1.0.0",
            sources: ["bods"],
            partialCoverage: false,
            // The bucket count is a property of the hash, so a bucket shrinking is ordinary.
            maximumShrinkFraction: 1,
            notes: "Services partitioned by id for targeted reads.",
          });
          published += 1;
          records += manifest.recordCount;
          bytes += manifest.sizeBytes;
        } catch (error) {
          failures.push(
            `${dataset}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160),
          );
        }
      }
      report.serviceBuckets = {
        buckets: buckets.size,
        published,
        records,
        bytes,
        meanBucketBytes: published > 0 ? Math.round(bytes / published) : 0,
        sourceServices: network.services.length,
        // The number that decides whether the reader can be trusted: every service placed.
        complete: records === network.services.length && failures.length === 0,
        ...(failures.length > 0 ? { failures: failures.slice(0, 5) } : {}),
      };
      console.log(
        `Published ${published} of ${buckets.size} service bucket(s) at ${version}: ` +
          `${records} of ${network.services.length} service(s), ` +
          `${Math.round(bytes / 1024)} KiB total, ` +
          `${published > 0 ? Math.round(bytes / published / 1024) : 0} KiB mean per bucket.`,
      );
    } catch (error) {
      report.serviceBuckets = {
        failed: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
      console.error("Service buckets could not be published; the timetable refresh still stands.");
    }
  }

  if (departuresOnly) {
    /*
     * And the names-only projection, which is what the map actually reads.
     *
     * The buckets fixed the board and cannot fix the map: a city viewport names a few hundred
     * distinct services, those hash across nearly every bucket, and reading two hundred small
     * objects is worse than reading one large one when an invocation gets fifty subrequests. So
     * the map falls back to the whole services object, which the bucket proof measures at
     * 4,669,134 bytes — fetched, decoded and parsed on the one endpoint still answering
     * Cloudflare's error page when a browser opens a page's worth of requests at once.
     *
     * Every use of a resolved service in `/v1/map` is `id` or `publicName`. This publishes those
     * two fields and nothing else: about 700 KiB against 4.7 MiB, the same answer for a sixth of
     * the bytes. Additive and reversible in the same way the buckets are — an absent object means
     * the map reads the services as it always did.
     */
    try {
      const manifest = await artifacts.publish({
        dataset: SERVICE_NAMES_DATASET,
        version,
        records: serviceNames(network.services),
        schemaVersion: "1.0.0",
        sources: ["bods"],
        partialCoverage: false,
        notes: "Service ids and public names only, for callers that need every name at once.",
      });
      report.serviceNames = {
        records: manifest.recordCount,
        bytes: manifest.sizeBytes,
        bytesPerRecord: Math.round(manifest.sizeBytes / Math.max(1, manifest.recordCount)),
      };
      console.log(
        `Published ${manifest.recordCount} service name(s) at ${version}: ` +
          `${Math.round(manifest.sizeBytes / 1024)} KiB.`,
      );
    } catch (error) {
      report.serviceNames = {
        failed: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
      console.error("Service names could not be published; the timetable refresh still stands.");
    }
  }

  /*
   * Journey tiles are not published any more.
   *
   * They were the 281 MiB objects: one half-degree tile reached 294,922,754 bytes, six refused to
   * publish at all — three with an R2 413 and three too large for the runtime to serialise — and
   * nothing reads them now. The board reads the departure index and the planner reads pattern
   * trips, both of which carry the same information in a shape that fits. Continuing to write
   * them would cost a national build several gigabytes of disk and object storage to produce
   * something no request would ever open.
   */

  /*
   * The departure index: what an arrival board actually reads.
   *
   * Bucketed by a hash of the stop, one object per bucket per service date, so a board reads one
   * object instead of a region's entire timetable. The spill keys are already dataset names, so
   * the publisher is handed identity rather than a tile-naming function.
   *
   * The encode is where the spilled rows become the shard: interned and grouped by stop, which is
   * a whole-tile transform and so cannot happen as each row is emitted.
   */
  const departureResult = await publishSpilledJourneyTiles(store, assembled.departureSpill, {
    version,
    datasetFor: (dataset) => dataset,
    encode: (lines, dataset) => encodeDepartureShardFromJsonl(dataset, lines),
  });
  report.departures = {
    published: departureResult.tiles.length,
    rows: departureResult.records,
    rowsEmitted: assembled.departureRowCount,
    failed: departureResult.failed.slice(0, 10),
    oversized: departureResult.oversized.slice(0, 10),
    largest: departureResult.largest,
  };
  console.log(
    `Departure index: ${departureResult.records} rows across ${departureResult.tiles.length} ` +
      `shards, largest ${departureResult.largest?.bytes ?? 0} bytes. ${throughput(departureResult)}`,
  );

  /*
   * And the planner's trips, on the trip grid. Published from their own spill for the same
   * reason the departures are: derived once as each journey streams past, never re-read.
   */
  const tripResult = await publishSpilledJourneyTiles(store, assembled.patternTripSpill, {
    version,
    datasetFor: (dataset) => dataset,
  });
  report.patternTrips = {
    published: tripResult.tiles.length,
    trips: tripResult.records,
    tripsEmitted: assembled.patternTripCount,
    failed: tripResult.failed.slice(0, 10),
    oversized: tripResult.oversized.slice(0, 10),
    largest: tripResult.largest,
  };
  console.log(
    `Pattern trips: ${tripResult.records} trips across ${tripResult.tiles.length} shards, ` +
      `largest ${tripResult.largest?.bytes ?? 0} bytes. ${throughput(tripResult)}`,
  );
  if (tripResult.failed.length > 0 || tripResult.oversized.length > 0) {
    console.error(
      `${tripResult.failed.length} pattern-trip shard(s) failed and ` +
        `${tripResult.oversized.length} were refused as oversized; journeys through those areas ` +
        `will report a degraded plan rather than silently having no options.`,
    );
  }

  if (departureResult.failed.length > 0 || departureResult.oversized.length > 0) {
    console.error(
      `${departureResult.failed.length} departure shard(s) failed and ` +
        `${departureResult.oversized.length} were refused as oversized; boards in those buckets ` +
        `will report a degraded read rather than an empty timetable.`,
    );
  }

  /*
   * A refresh ends here: the two date-keyed families are written at the live version, so the edge
   * can answer for the new dates from the next request onwards with no pointer to move.
   *
   * It fails loudly on a partial write rather than reporting success, because a half-written
   * horizon is a board that works in Leeds and not in Bristol — which looks like a Bristol problem.
   */
  if (departuresOnly) {
    const broken = [...departureResult.failed, ...tripResult.failed];
    if (broken.length > 0 || departureResult.oversized.length > 0) {
      report.outcome = "refresh_incomplete";
      console.error(
        `Departures refresh wrote ${departureResult.tiles.length} departure and ` +
          `${tripResult.tiles.length} pattern-trip shard(s), but ${broken.length} failed. The ` +
          `previous dates are untouched; the new ones are incomplete.`,
      );
      writeReport(report);
      return 1;
    }
    await prunePastServiceDates(store, artifacts, startedAt, report);

    report.outcome = "departures_refreshed";
    console.log(
      `Refreshed ${serviceDates.length} service date(s) (${serviceDates.join(", ")}) at version ` +
        `${version}: ${departureResult.tiles.length} departure and ${tripResult.tiles.length} ` +
        `pattern-trip shard(s). The rest of the artifact was not touched.`,
    );
    writeReport(report);
    return 0;
  }

  // The edge reads shards, never the national datasets: measured against real data those are
  // 292 MiB of journeys, 198 MiB of stops and 100 MiB of patterns, against a 128 MiB isolate.
  // Published after the national datasets and before the fingerprints, so a failure here is a
  // failed run rather than a live index pointing at shards that do not exist.
  const shardResult = await publishNetworkShards(store, network, { version });
  report.shards = {
    published: shardResult.published,
    failed: shardResult.failed.slice(0, 10),
    oversized: shardResult.oversized,
    truncated: shardResult.truncated.slice(0, 10),
    // The size of the biggest shard in each family, which is the number that says whether the
    // sharding key is still fine enough — a record count never did.
    largest: shardResult.largest,
    // Where the wall clock went. A family that doubles in object count doubles the writes, and
    // the writes are most of this step's runtime as well as the metered operation.
    families: shardResult.families,
    publishedBytes: shardResult.publishedBytes,
    stopTiles: shardResult.index?.stopTiles.length ?? 0,
    patternTiles: shardResult.index?.patternTiles.length ?? 0,
    searchPrefixes: shardResult.index?.searchPrefixes.length ?? 0,
  };
  console.log(
    "Shard families: " +
      shardResult.families
        .map(
          (family) =>
            `${family.name} ${family.objects} object(s), ` +
            `${(family.bytes / 1024 / 1024).toFixed(1)} MiB in ${(family.ms / 1000).toFixed(1)}s` +
            (family.failed > 0 ? ` (${family.failed} failed)` : ""),
        )
        .join(", "),
  );
  console.log(
    `This publish occupies ${(shardResult.publishedBytes / 1024 / 1024).toFixed(0)} MiB across ` +
      `${shardResult.published} object(s); one version may hold ` +
      `${(MAX_PUBLISH_BYTES / 1024 / 1024).toFixed(0)} MiB of R2's 10 GiB free allowance.`,
  );
  if (shardResult.index === null) {
    console.error(
      `Shard publish incomplete (${shardResult.failed.length} failed); the edge keeps the ` +
        `previous version rather than reading a half-written one.`,
    );
  }
  if (shardResult.truncated.length > 0) {
    const worst = shardResult.truncated.reduce((a, b) => (b.dropped > a.dropped ? b : a));
    console.error(
      `${shardResult.truncated.length} shard(s) were truncated at the byte budget, worst ` +
        `${worst.dataset} losing ${worst.dropped} record(s). Those records are not readable at ` +
        `the edge; the sharding key needs to be finer for that family.`,
    );
  }
  if (shardResult.oversized.length > 0) {
    console.error(
      `${shardResult.oversized.length} shard(s) exceeded the record cap: ` +
        `${shardResult.oversized.slice(0, 5).join(", ")}. The sharding key needs to be finer.`,
    );
  }

  if (result && !result.complete) {
    /*
     * A partial publish is worse than no publish: restore the previous consistent version.
     *
     * The rollback can itself fail — a run that could not write its shards is a run whose storage
     * was refusing writes — and when it did, it threw out of `main` and took the build report
     * with it. The report is the only description of why a run published nothing, so a rollback
     * that fails is recorded as part of the report rather than instead of it.
     */
    report.outcome = "rolled_back";
    try {
      const rolledBack = await rollbackNetwork(store);
      report.rolledBack = rolledBack;
      console.error(
        `Publish incomplete; rolled back: ${rolledBack.join(", ") || "(nothing to restore)"}`,
      );
    } catch (error) {
      report.outcome = "rollback_failed";
      report.rollbackError = error instanceof Error ? error.message : String(error);
      console.error(`Publish incomplete and the rollback failed too: ${report.rollbackError}`);
    }
    writeReport(report);
    return 1;
  }

  await artifacts.publish({
    dataset: FINGERPRINT_DATASET,
    version,
    records: currentFingerprints,
    schemaVersion: "1.0.0",
    sources: ["naptan", "bods"],
  });

  if (shardResult.index === null) {
    report.outcome = "shards_incomplete";
    writeReport(report);
    return 1;
  }

  await prunePastServiceDates(store, artifacts, startedAt, report);

  report.outcome = "published";
  console.log(
    `Published national network: ${network.counts.stops} stops, ${network.counts.services} services, ` +
      `${network.counts.journeys} journeys.`,
  );
  writeReport(report);
  return 0;
}

/**
 * The archive and the spill are build intermediates; neither survives the run.
 *
 * Tracked at module scope rather than passed around because `main` returns from a dozen places —
 * a missing credential, an unavailable source, a failed publish — and a temporary file left
 * behind on any of those paths is hundreds of megabytes of a runner's disk that the next job
 * needs. They are cleaned up once, after main, whatever happened.
 */
let archiveToDiscard: string | null = null;
let spillToDispose: { dispose(): void } | null = null;

async function cleanUp(): Promise<void> {
  if (archiveToDiscard) await discardGtfsArchive(archiveToDiscard);
  spillToDispose?.dispose();
  archiveToDiscard = null;
  spillToDispose = null;
}

function writeReport(report: Record<string, unknown>): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync("build-report.json", JSON.stringify(report, null, 2));
  /*
   * And as an annotation. The workflow's "report, where the log can reach it" step cats this
   * file into the job log — and a job log is served from a host this project's container cannot
   * reach, so for anyone working from here it has always been written to nowhere. The departures
   * refresh is a 170-minute job whose whole purpose is to say how far the timetable now reaches;
   * that answer has to survive the job.
   */
  /*
   * A digest, not the report.
   *
   * The full build report runs to tens of kilobytes — source health for every upstream, per-table
   * GTFS counts, spill statistics — and an annotation survives about 3,400 characters. Sending the
   * whole thing meant the fields a reader actually came for were cut off: run 38227490547's
   * annotation ended mid-way through `spill`, so whether the operators had been republished with
   * their National Operator Codes, which was the entire point of that run, was unreadable. The
   * full report is still written to `build-report.json` and uploaded.
   */
  annotateReport("static network", {
    outcome: report.outcome,
    refreshedVersion: report.refreshedVersion,
    serviceDates: report.serviceDates,
    republishedOperators: report.republishedOperators,
    /*
     * The three derived families a refresh now republishes, each a line in the digest.
     *
     * Left out, and the run that published them could not be told from the run that did not: the
     * bucket proof reads the bucket and says the family is there, but nothing said whether *this*
     * refresh wrote it, and the names projection has no proof step of its own at all. A publish
     * that silently stopped happening is the failure this names.
     */
    republishedServices: report.republishedServices,
    serviceBuckets: report.serviceBuckets,
    serviceNames: report.serviceNames,
    prunedServiceDates: report.prunedServiceDates,
    publishedDatasets: Array.isArray(report.published) ? report.published.length : undefined,
    failed: report.failed,
    /*
     * Why a publish did not produce an index, and what each family cost.
     *
     * `shards_incomplete` means the index was withheld, which is the right thing to do — the
     * previous complete artifact stays live rather than a version with holes in it. But the
     * digest said only that, so a run that stopped because one shard threw and a run that stopped
     * because the whole publish would not fit were the same four words. The per-family bytes are
     * also the cost gate for any new family: it is the only measurement of what one actually
     * occupies nationally, and guessing at that is how a bucket goes over its allowance.
     */
    shardOutcome:
      report.shards === undefined
        ? undefined
        : {
            published: (report.shards as { published?: number }).published,
            publishedBytes: (report.shards as { publishedBytes?: number }).publishedBytes,
            failed: (report.shards as { failed?: unknown[] }).failed?.slice(0, 3),
            /*
             * Minutes as well as objects and bytes, because the wall clock is the constraint.
             *
             * The step is bounded in time, not in objects, and three runs were lost to that
             * ceiling before anything said which family was spending it. A family's write time
             * is roughly its object count over the account's write rate, so the two numbers
             * together say what a retiling would cost before it is attempted rather than after.
             */
            families: (
              report.shards as { families?: Array<Record<string, unknown>> }
            ).families?.map(
              (family) =>
                `${String(family.name)} ${String(family.objects)} obj ${String(
                  Math.round(Number(family.bytes ?? 0) / 1024 / 1024),
                )} MiB ${(Number(family.ms ?? 0) / 60000).toFixed(1)} min` +
                (Number(family.failed ?? 0) > 0 ? ` ${String(family.failed)} FAILED` : ""),
            ),
            truncated: (report.shards as { truncated?: unknown[] }).truncated?.length,
          },
    departureShards: report.departureShards,
    counts: report.counts,
    // Named rather than included whole: a source that is down is the thing worth seeing.
    sourcesDown: Array.isArray(report.sourceHealth)
      ? report.sourceHealth
          .filter((entry) => (entry as { status?: string }).status !== "healthy")
          .map((entry) => {
            const row = entry as { source?: string; status?: string; message?: string };
            return `${row.source}: ${row.status}${row.message ? ` (${row.message})` : ""}`;
          })
      : undefined,
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Daily static-network job failed:", error);
    process.exitCode = 1;
  })
  .finally(() => cleanUp());
