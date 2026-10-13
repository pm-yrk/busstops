/**
 * Every service's id and the number on its front, and nothing else.
 *
 * ## The cost this removes
 *
 * The buckets fixed the stop board, which wants two or three services. They cannot fix the map,
 * which wants hundreds: a viewport in a city holds a few hundred pattern geometries naming a few
 * hundred distinct services, and those hash across almost every one of the 256 buckets. Reading
 * 200 small objects is worse than reading one large one — a Workers Free invocation gets fifty
 * subrequests — so the map correctly falls through to the whole `network/services` object, which
 * the bucket proof measures at 4,669,134 bytes. Fetched, UTF-8 decoded and parsed on the one
 * endpoint that still answers Cloudflare's error page when a browser opens a page's worth of
 * requests at once.
 *
 * (The endpoint instrument's 2,182,908 characters is *not* this read. That figure counts tracked
 * shard reads — the stop and pattern tiles — and the services read reports itself through the
 * ledger's artifact notes instead, which the instrument did not surface until it was corrected to.
 * Attributing the tile figure to the services read was wrong and is recorded as such.)
 *
 * But the map does not want services. Reading `/v1/map`, every use of a resolved service is one of
 * two fields: `service.id`, to link a marker to its route page, and `service.publicName`, to put
 * the number on the bus. A `ServiceRoute` carries far more than that — operator, licence ids,
 * provenance, direction descriptions — and all of it is fetched, decoded and parsed to read two
 * strings off each record.
 *
 * So this is those two strings. About 13,000 records at roughly 55 bytes each is some 700 KiB
 * against 4.7 MiB: the same answer for a sixth of the bytes, and a sixth of the resident text when
 * the isolate holds it.
 *
 * ## Why one object rather than buckets
 *
 * Because the map's question is "all of them". Bucketing exists for a caller that knows a handful
 * of ids; this exists for a caller that needs the whole lookup table, and for that the cheapest
 * read is one object held once per isolate. The two are complements, not alternatives: a board
 * still reads its bucket, and the broad reads keep a broad representation — now a much smaller
 * one.
 *
 * It is additive. A deployment reading a version published before this family existed finds no
 * object, and the map falls back to the services it read before, which is what makes it safe to
 * publish into a live version.
 */

import type { ServiceRoute } from "@busstops/contracts";

/** One object, named like the other derived national families. */
export const SERVICE_NAMES_DATASET = "network/service-names";

/**
 * The projection, deliberately minimal.
 *
 * `id` and `publicName` and no third field, because a third field is how this grows back into the
 * object it replaces. A caller that needs the operator reads the service.
 */
export interface ServiceName {
  id: string;
  publicName: string;
}

export function serviceNames(services: readonly ServiceRoute[]): ServiceName[] {
  return services.map((service) => ({ id: service.id, publicName: service.publicName }));
}
