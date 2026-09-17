/**
 * The published timetable, in the shape the edge actually reads it.
 *
 * Journeys used to be published whole, one JSONL record per journey, sharded onto a half-degree
 * grid. A departure board then read an entire tile and filtered it down to one stop. Measured on
 * England's real archive that tile reached 294,922,754 bytes for 31,449 journeys — 281 MiB into a
 * 128 MiB isolate — and six tiles failed to publish at all, three refused by R2 with a 413 and
 * three too large for Node to turn into a string. The board's `catch` returned an empty array, so
 * every stop in the country answered "no departures" with a 200 and the word `normal`.
 *
 * Two things were wrong with the shape, and the measurements say so precisely.
 *
 * A half-degree tile is the wrong unit because density varies by three orders of magnitude: the
 * same grid that holds four villages holds the whole of Birmingham. Nothing geographic can be
 * chosen that is small enough for a city and not absurd for a moor, so the departure index is
 * bucketed by a hash of the stop instead. Every bucket then holds roughly the same number of rows
 * whatever the country looks like, which is the property a byte budget needs.
 *
 * And a journey is the wrong record. One measured 10,313 bytes, of which the great majority was
 * 45 calls at 220 bytes each — a 36-character UUID and two ISO-8601 timestamps per call. A board
 * needs none of that structure: it needs the rows for its own stop. One row is 76 bytes, and the
 * board reads only the bucket its stop falls in rather than every journey that passes through the
 * region.
 *
 * The planner still needs whole trips, and gets them from `pattern-trips`, where a trip is the
 * pattern it runs on plus its times — 296 bytes for 45 calls against 10,313, because the pattern
 * already knows which stops they are.
 */

/**
 * How many buckets the departure index is split into.
 *
 * The arithmetic, so this is a decision rather than a habit: England publishes on the order of
 * 13.6 million calls per service date. At 512 buckets and seven windows that is about 3,800 rows
 * in a shard, under 300 KB — a fraction of the largest stop tile already served at the edge, and
 * a thousand times smaller than the journey tile it replaces.
 *
 * It also has to be paid for. Each service date writes `DEPARTURE_BUCKETS × DEPARTURE_WINDOWS`
 * objects; `departureWriteBudget` computes the monthly Class A operations that implies and a test
 * holds it against R2's free allowance, because a shard count is a cost as well as a size.
 */
export const DEPARTURE_BUCKETS = 512;

/** Hours of the service day in one shard. */
export const DEPARTURE_WINDOW_HOURS = 4;

/**
 * Seven, not six.
 *
 * A service day is not 24 hours. GTFS times run past midnight so that a bus leaving at 00:10
 * stays attached to the evening it belongs to, and this ingest accepts times up to 48:00. Windows
 * are numbered from the service date's own midnight, so the small hours of the following morning
 * land in window 6 rather than being silently dropped or folded back onto window 0 — which would
 * put a Saturday-night bus on Saturday breakfast's board.
 */
export const DEPARTURE_WINDOWS = 7;

export const DEPARTURES_PREFIX = "network/departures";
export const PATTERN_TRIPS_PREFIX = "network/pattern-trips";

/**
 * One boardable call at one stop: what an arrival board row is made of and nothing else.
 *
 * Keys are one character because there are millions of these and the key text is repeated in
 * every one of them. That is a real saving rather than a stylistic one — `stopAtcoCode` across
 * 13.6 million rows is 150 MB of the word "stopAtcoCode" — and the abbreviation is confined to
 * this one declaration, which both the pipeline that writes the rows and the edge reader that
 * consumes them are typed against.
 */
export interface DepartureRow {
  /** ATCO code, so a board filters without resolving a UUID first. */
  s: string;
  /** Departure as epoch seconds. Absolute, so the edge never re-derives a local time or a DST offset. */
  t: number;
  /** Route name as shown on the front of the bus. */
  r: string;
  /** Destination: the name of the last stop the trip calls at. */
  d: string;
  /** Trip id, so a live vehicle can be matched to this row. */
  j: string;
  /** Route pattern id, for the link to the route. */
  p: string;
  /** Whether this call is a timing point rather than an interpolated estimate. */
  k?: 1;
}

/**
 * One trip as the planner needs it: which pattern, and when it calls.
 *
 * The pattern already holds the ordered stop sequence, so a trip is only its times. That is the
 * whole saving: 296 bytes for 45 calls against the 10,313 of a journey carrying a UUID and two
 * timestamps per call. `t[i]` is the departure from `pattern.stopSequence[i]`, which is the
 * contract between this row and the pattern it names.
 */
export interface PatternTripRow {
  /** Route pattern id. The pattern holds the stop sequence; this holds only the times. */
  p: string;
  /** Trip id. */
  j: string;
  /** Departure epoch seconds, one per call, in the pattern's own stop order. */
  t: number[];
  /**
   * Arrivals, only when at least one differs from its departure.
   *
   * Buses mostly arrive and leave at the same published minute, so carrying a second array for
   * every trip would double the size to say nothing. Where a trip genuinely waits — a layover at
   * an interchange — the difference decides whether a transfer is makeable, so it is kept.
   */
  a?: number[];
}

/**
 * The windows a plan must read, given when it is searching.
 *
 * A trip is filed under the window its first call falls in, so a search at half past nine has to
 * read the window before it as well: a bus that left at seven is still running. One window of
 * lookback is four hours, which is longer than any bus trip in England.
 */
export function patternTripWindowsFor(
  fromEpochSeconds: number,
  toEpochSeconds: number,
  serviceDate: string,
): number[] {
  const first = Math.max(0, departureWindowFor(fromEpochSeconds, serviceDate) - 1);
  const last = departureWindowFor(toEpochSeconds, serviceDate);
  const windows: number[] = [];
  for (let window = first; window <= last; window += 1) windows.push(window);
  return windows;
}

/**
 * Which bucket a stop's rows live in.
 *
 * FNV-1a over the ATCO code. The requirement is an even spread and the same answer in the
 * pipeline and at the edge, not cryptographic strength; both sides call this function so they
 * cannot drift, and a test pins a handful of real codes to their buckets so a change to the hash
 * is visible as a change to the published layout rather than as stops quietly losing their board.
 */
export function departureBucketFor(atcoCode: string, buckets = DEPARTURE_BUCKETS): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < atcoCode.length; index += 1) {
    hash ^= atcoCode.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
}

/**
 * Which window an instant falls in, counted from the service date's midnight UTC.
 *
 * Clamped at both ends rather than allowed to address a shard that was never written. A time
 * before the service date is a malformed row and a time beyond 48 hours is one the ingest should
 * already have rejected; neither should be able to point a reader at a key that does not exist.
 */
export function departureWindowFor(epochSeconds: number, serviceDate: string): number {
  const midnight = Date.parse(`${serviceDate}T00:00:00Z`) / 1000;
  const offsetHours = (epochSeconds - midnight) / 3600;
  const window = Math.floor(offsetHours / DEPARTURE_WINDOW_HOURS);
  return Math.min(DEPARTURE_WINDOWS - 1, Math.max(0, window));
}

/** Every window a time range touches, so a board spanning a boundary reads both shards. */
export function departureWindowsBetween(
  fromEpochSeconds: number,
  toEpochSeconds: number,
  serviceDate: string,
): number[] {
  const first = departureWindowFor(fromEpochSeconds, serviceDate);
  const last = departureWindowFor(toEpochSeconds, serviceDate);
  const windows: number[] = [];
  for (let window = first; window <= last; window += 1) windows.push(window);
  return windows;
}

export function departureShardDataset(serviceDate: string, bucket: number, window: number): string {
  return `${DEPARTURES_PREFIX}/${serviceDate}/${window}/${bucket}`;
}

export function patternTripsDataset(serviceDate: string, tile: string, window: number): string {
  return `${PATTERN_TRIPS_PREFIX}/${serviceDate}/${window}/${tile}`;
}

export interface WriteBudget {
  serviceDates: number;
  objectsPerServiceDate: number;
  objectsPerBuild: number;
  buildsPerMonth: number;
  classAOperationsPerMonth: number;
  /** R2's free monthly Class A allowance, which is what this is being held against. */
  monthlyAllowance: number;
  withinAllowance: boolean;
}

/**
 * What this layout costs to publish, as arithmetic rather than an assurance.
 *
 * Sharding finely is not free: every shard is a Class A operation, R2 gives a million a month,
 * and a layout that reads beautifully and cannot be written is not a layout. This is the
 * calculation, and a test holds the real numbers against the real allowance.
 */
export function departureWriteBudget(
  serviceDates: number,
  buildsPerMonth = 30,
  buckets = DEPARTURE_BUCKETS,
  windows = DEPARTURE_WINDOWS,
  monthlyAllowance = 1_000_000,
): WriteBudget {
  const objectsPerServiceDate = buckets * windows;
  const objectsPerBuild = objectsPerServiceDate * serviceDates;
  const classAOperationsPerMonth = objectsPerBuild * buildsPerMonth;
  return {
    serviceDates,
    objectsPerServiceDate,
    objectsPerBuild,
    buildsPerMonth,
    classAOperationsPerMonth,
    monthlyAllowance,
    withinAllowance: classAOperationsPerMonth <= monthlyAllowance,
  };
}
