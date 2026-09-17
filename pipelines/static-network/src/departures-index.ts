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
 * needs none of that structure: it needs the rows for its own stop.
 *
 * The planner still needs whole trips, and gets them from `pattern-trips`, where a trip is the
 * pattern it runs on plus its times — 296 bytes for 45 calls against 10,313, because the pattern
 * already knows which stops they are.
 *
 * ## What the first national run of this layout measured, and what it cost
 *
 * It published. 29,358,096 departure rows across 7,168 shards, largest 1,489,273 bytes — the
 * sizing was right and the 281 MiB tile is gone for good. But it took twenty-seven and a half
 * minutes to write them, and the build was killed by its own time limit partway through the
 * trips that were supposed to follow.
 *
 * 7,168 objects in 1,647 seconds is 4.35 writes a second. Publishing runs eight requests at a
 * time, so that is not concurrency: it is a ceiling. The pipeline writes through Cloudflare's
 * REST API, which is rate-limited per account, and 4.35 a second is what that allowance works out
 * to. The same run moved about three gigabytes, which is 1.8 MB/s — so a second reading of the
 * same number is a bandwidth ceiling, and one run cannot tell the two apart.
 *
 * So this layout is sized against both, and the publish reports its own throughput per family so
 * the next run says which one was real:
 *
 *   - **No window dimension.** A service date is one object per bucket rather than seven. That is
 *     1,024 objects for a two-date national build instead of 7,168, and one read per service date
 *     instead of two when a board's hour and a half crosses a boundary.
 *   - **Rows are interned and grouped by stop.** Route names, destinations and pattern UUIDs
 *     repeat across every call of every trip; a 36-character UUID was 29% of a row on its own.
 *     They are now written once per shard in a header and referenced by index, times are offsets
 *     from the service date rather than ten-digit epochs, and the calls at one stop are one line.
 *     A row goes from about 144 bytes to about 37.
 *
 * Grouping by stop buys the edge something as well, and it is the larger win of the two: a board
 * finds its own line by prefix and parses that alone. Reading a stop costs one line of about a
 * hundred calls rather than JSON.parse over the shard's thirty thousand.
 */

/**
 * How many buckets the departure index is split into.
 *
 * The arithmetic, so this is a decision rather than a habit: England publishes on the order of
 * 29.4 million boardable calls across two service dates. At 512 buckets and no window dimension a
 * shard holds about 28,700 calls, which is a little over a megabyte once they are interned — a
 * fraction of the largest stop tile already served at the edge, and two hundred times smaller
 * than the journey tile it replaces.
 *
 * It also has to be paid for twice: R2 charges a Class A operation per object, and the REST API
 * the pipeline writes through only answers about four requests a second, so a shard count is a
 * quarter of a second of a build's runtime as well as an operation. `departureWriteBudget`
 * computes both and a test holds them against the allowance and against the job's time limit.
 */
export const DEPARTURE_BUCKETS = 512;

export const DEPARTURES_PREFIX = "network/departures";
export const PATTERN_TRIPS_PREFIX = "network/pattern-trips";

/**
 * Hours of the service day in one trip shard.
 *
 * Only the planner's trips are still cut by time. A board reads one stop out of one bucket, so a
 * window would only have multiplied its object count; a plan reads whole corridors and genuinely
 * benefits from not loading the small hours to answer a question about the morning peak.
 */
export const TRIP_WINDOW_HOURS = 8;

/**
 * Six, not three.
 *
 * A service day is not 24 hours. GTFS times run past midnight so that a bus leaving at 00:10
 * stays attached to the evening it belongs to, and this ingest accepts times up to 48:00. Windows
 * are numbered from the service date's own midnight, so the small hours of the following morning
 * land in the last window rather than being silently dropped or folded back onto the first —
 * which would put a Saturday-night bus on Saturday breakfast's board.
 */
export const TRIP_WINDOWS = 6;

/**
 * One boardable call at one stop: what an arrival board row is made of and nothing else.
 *
 * This is the shape the pipeline emits and the edge consumes. It is not the shape on the wire —
 * see `encodeDepartureShard` — because the wire form interns everything that repeats, and a
 * struct whose field names are single letters to save bytes it no longer saves is just a struct
 * that is hard to read.
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

/** Midnight UTC of a service date, which every offset in its shards is measured from. */
export function serviceDateEpochSeconds(serviceDate: string): number {
  return Math.floor(Date.parse(`${serviceDate}T00:00:00Z`) / 1000);
}

/**
 * Which trip window an instant falls in, counted from the service date's midnight UTC.
 *
 * Clamped at both ends rather than allowed to address a shard that was never written. A time
 * before the service date is a malformed row and a time beyond 48 hours is one the ingest should
 * already have rejected; neither should be able to point a reader at a key that does not exist.
 */
export function tripWindowFor(epochSeconds: number, serviceDate: string): number {
  const offsetHours = (epochSeconds - serviceDateEpochSeconds(serviceDate)) / 3600;
  const window = Math.floor(offsetHours / TRIP_WINDOW_HOURS);
  return Math.min(TRIP_WINDOWS - 1, Math.max(0, window));
}

/**
 * The windows a plan must read, given when it is searching.
 *
 * A trip is filed under the window its first call falls in, so a search at half past nine has to
 * read the window before it as well: a bus that left at seven is still running. One window of
 * lookback is eight hours, which is far longer than any bus trip in England.
 */
export function tripWindowsFor(
  fromEpochSeconds: number,
  toEpochSeconds: number,
  serviceDate: string,
): number[] {
  const first = Math.max(0, tripWindowFor(fromEpochSeconds, serviceDate) - 1);
  const last = tripWindowFor(toEpochSeconds, serviceDate);
  const windows: number[] = [];
  for (let window = first; window <= last; window += 1) windows.push(window);
  return windows;
}

/** One object per bucket per service date. A board reads exactly one of these per date. */
export function departureShardDataset(serviceDate: string, bucket: number): string {
  return `${DEPARTURES_PREFIX}/${serviceDate}/${bucket}`;
}

export function patternTripsDataset(serviceDate: string, tile: string, window: number): string {
  return `${PATTERN_TRIPS_PREFIX}/${serviceDate}/${window}/${tile}`;
}

/**
 * The wire format version. Bumped when the shard layout changes shape, so a reader meeting an
 * older publish says so rather than silently misreading integers as different integers.
 */
export const DEPARTURE_SHARD_VERSION = 1;

interface ShardHeader {
  v: number;
  /** The service date every offset in this shard is measured from. */
  d: string;
  /** Route names, referenced by index. */
  r: string[];
  /** Destination names, referenced by index. */
  n: string[];
  /** Route pattern ids, referenced by index. */
  p: string[];
}

/** `[offsetSeconds, routeIndex, destinationIndex, tripId, patternIndex, timingPoint]` */
type EncodedCall = [number, number, number, string, number, 0 | 1];
type EncodedStopLine = [string, EncodedCall[]];

class Intern {
  readonly values: string[] = [];
  private readonly index = new Map<string, number>();

  of(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const next = this.values.length;
    this.values.push(value);
    this.index.set(value, next);
    return next;
  }
}

/**
 * A shard as it is written: a header of everything that repeats, then one line per stop.
 *
 * Both properties matter and they are different. Interning is about the wire: a route name, a
 * destination and a 36-character pattern UUID appear on every call of every trip, and the UUID
 * alone was 29% of a row. Grouping by stop is about the edge: a board finds its own line by
 * prefix and parses that line only, so reading one stop out of a shard of thirty thousand calls
 * costs the hundred calls at that stop rather than all of them.
 *
 * Stops are written in sorted order and calls in time order, so a rebuild of unchanged data
 * produces an identical object.
 */
export function encodeDepartureShard(serviceDate: string, rows: readonly DepartureRow[]): string {
  const routes = new Intern();
  const destinations = new Intern();
  const patterns = new Intern();
  const midnight = serviceDateEpochSeconds(serviceDate);

  const byStop = new Map<string, EncodedCall[]>();
  for (const row of rows) {
    const calls = byStop.get(row.s);
    const call: EncodedCall = [
      row.t - midnight,
      routes.of(row.r),
      destinations.of(row.d),
      row.j,
      patterns.of(row.p),
      row.k === 1 ? 1 : 0,
    ];
    if (calls) calls.push(call);
    else byStop.set(row.s, [call]);
  }

  const header: ShardHeader = {
    v: DEPARTURE_SHARD_VERSION,
    d: serviceDate,
    r: routes.values,
    n: destinations.values,
    p: patterns.values,
  };

  const lines: string[] = [JSON.stringify(header)];
  for (const atcoCode of [...byStop.keys()].sort()) {
    const calls = byStop.get(atcoCode)!;
    calls.sort((a, b) => a[0] - b[0]);
    lines.push(JSON.stringify([atcoCode, calls] satisfies EncodedStopLine));
  }
  return lines.join("\n");
}

function parseHeader(text: string, upTo: number): ShardHeader {
  const header = JSON.parse(text.slice(0, upTo)) as ShardHeader;
  if (header.v !== DEPARTURE_SHARD_VERSION) {
    throw new Error(
      `departure shard is format ${String(header.v)}, this reader speaks ${String(DEPARTURE_SHARD_VERSION)}`,
    );
  }
  return header;
}

function expand(header: ShardHeader, atcoCode: string, calls: EncodedCall[]): DepartureRow[] {
  const midnight = serviceDateEpochSeconds(header.d);
  return calls.map(([offset, route, destination, trip, pattern, timingPoint]) => ({
    s: atcoCode,
    t: midnight + offset,
    r: header.r[route] ?? "",
    d: header.n[destination] ?? "",
    j: trip,
    p: header.p[pattern] ?? "",
    ...(timingPoint === 1 ? { k: 1 as const } : {}),
  }));
}

/**
 * The calls at one stop, without parsing the rest of the shard.
 *
 * Null means the shard was written and this stop is not in it, which is an ordinary answer: a
 * bucket holds every stop whose code hashes into it, and plenty of them have nothing scheduled on
 * a given date. It is not the same as the shard being missing, and neither is the same as it
 * being unreadable — the three answers stay distinguishable all the way to the board.
 */
export function decodeDepartureShardForStop(text: string, atcoCode: string): DepartureRow[] | null {
  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0) return null;
  const header = parseHeader(text, firstBreak);

  // The line for a stop begins with its own JSON-quoted code, so it is found by scanning for that
  // prefix rather than by parsing every line to look at its first element.
  const needle = `\n[${JSON.stringify(atcoCode)},`;
  const at = text.indexOf(needle, firstBreak);
  if (at < 0) return null;

  const start = at + 1;
  const end = text.indexOf("\n", start);
  const line = end < 0 ? text.slice(start) : text.slice(start, end);
  const [, calls] = JSON.parse(line) as EncodedStopLine;
  return expand(header, atcoCode, calls);
}

/** The whole shard. For the pipeline's own checks and for tests; the edge reads one stop. */
export function decodeDepartureShard(text: string): DepartureRow[] {
  const lines = text.split("\n");
  const first = lines[0];
  if (first === undefined || first.length === 0) return [];
  const header = parseHeader(first, first.length);

  const rows: DepartureRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const [atcoCode, calls] = JSON.parse(line) as EncodedStopLine;
    rows.push(...expand(header, atcoCode, calls));
  }
  return rows;
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
  /**
   * How long writing them takes, which the first national run showed to be the binding constraint
   * rather than the allowance. 7,168 objects took 1,647 seconds: 4.35 a second, at a concurrency
   * of eight, through an API that rate-limits per account.
   */
  writesPerSecond: number;
  publishSeconds: number;
}

/**
 * What this layout costs to publish, as arithmetic rather than an assurance.
 *
 * Sharding finely is not free and it is not free in two different currencies. Every shard is a
 * Class A operation and R2 gives a million a month; every shard is also a request against an API
 * that answers about four a second, and a build that cannot finish inside its job is as useless
 * as one that cannot be afforded. A test holds the real numbers against both.
 */
export function departureWriteBudget(
  serviceDates: number,
  buildsPerMonth = 30,
  buckets = DEPARTURE_BUCKETS,
  monthlyAllowance = 1_000_000,
  writesPerSecond = 4.35,
): WriteBudget {
  const objectsPerServiceDate = buckets;
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
    writesPerSecond,
    publishSeconds: objectsPerBuild / writesPerSecond,
  };
}

/**
 * The service date a departure shard belongs to, read back out of its own key.
 *
 * The publish stage receives spilled lines keyed by dataset and has to encode them against the
 * date its offsets are measured from. Deriving it from the key keeps that knowledge here, with
 * the function that built the key, rather than in the publisher.
 */
export function serviceDateOfDepartureDataset(dataset: string): string {
  const parts = dataset.split("/");
  const serviceDate = parts[parts.length - 2];
  if (serviceDate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    throw new Error(`not a departure shard dataset: ${dataset}`);
  }
  return serviceDate;
}

/** Spilled rows, one JSON object per line, as the shard they are published as. */
export function encodeDepartureShardFromJsonl(dataset: string, lines: readonly string[]): string {
  return encodeDepartureShard(
    serviceDateOfDepartureDataset(dataset),
    lines.map((line) => JSON.parse(line) as DepartureRow),
  );
}
