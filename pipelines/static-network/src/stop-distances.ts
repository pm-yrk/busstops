import type { Coordinate, RoutePattern, Stop } from "@busstops/contracts";
import { haversineMetres, pathLengthMetres } from "@busstops/pipeline-core";

/**
 * Along-path distance of each stop in a pattern.
 *
 * Each stop is projected onto the shape in order, so a route that passes near the same stop twice
 * — a loop or a circular — still yields a monotonically increasing sequence rather than jumping
 * backwards to the nearer of the two passes.
 *
 * This runs at publish time. It used to run in the Worker, which meant every match needed the
 * whole national stop set in the isolate; the result is static between publishes, so computing it
 * once here and shipping it with the pattern removes that need entirely.
 */
export function stopDistancesAlongShape(
  pattern: RoutePattern,
  shape: readonly Coordinate[],
  stopsById: ReadonlyMap<string, Stop>,
): number[] {
  const cumulative: number[] = [0];
  for (let i = 1; i < shape.length; i++) {
    cumulative.push(cumulative[i - 1]! + haversineMetres(shape[i - 1]!, shape[i]!));
  }
  const total = cumulative[cumulative.length - 1] ?? pathLengthMetres(shape);

  const distances: number[] = [];
  let searchFrom = 0;

  for (const stopId of pattern.stopSequence) {
    const stop = stopsById.get(stopId);
    if (!stop) {
      distances.push(searchFrom);
      continue;
    }

    let bestDistance = Number.POSITIVE_INFINITY;
    let bestAlong = searchFrom;

    for (let i = 0; i < shape.length; i++) {
      if (cumulative[i]! < searchFrom) continue;
      const metres = haversineMetres(stop.locationCoordinate, shape[i]!);
      if (metres < bestDistance) {
        bestDistance = metres;
        bestAlong = cumulative[i]!;
      }
    }

    distances.push(bestAlong);
    // Monotonic: the next stop cannot be behind this one.
    searchFrom = Math.min(bestAlong, total);
  }

  return distances;
}
