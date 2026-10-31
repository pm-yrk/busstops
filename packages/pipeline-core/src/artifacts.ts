import { z } from "zod";

/**
 * Versioned artifact publishing with atomic manifest swap (docs/04_ARCHITECTURE.md
 * "Artifacts and atomicity"). A partial or invalid build must never become the live dataset:
 * data is written to a versioned key, validated for count/schema/checksum, and only then does a
 * small manifest pointer swap make it live. Readers keep the previous good version on failure.
 */

export const ArtifactManifestSchema = z.object({
  dataset: z.string().min(1),
  version: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  /** Key of the object holding the data for this version. */
  objectKey: z.string().min(1),
  recordCount: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  schemaVersion: z.string().min(1),
  /** Version this replaced, kept so a rollback has an explicit target. */
  previousVersion: z.string().nullable(),
  sources: z.array(z.string()).default([]),
  /** Set when the build ran with known-incomplete inputs. */
  partialCoverage: z.boolean().default(false),
  notes: z.string().optional(),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

/** Minimal object-store surface; implemented over R2 in production and a map in tests. */
export interface StoredObject {
  key: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface ObjectStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /**
   * Listing with size and upload time, which the storage inventory needs. Optional because a
   * store may not expose it; a caller that cannot get real figures must report that it could
   * not, rather than estimating a projection from numbers it invented.
   */
  listDetailed?(prefix: string): Promise<StoredObject[]>;
  /**
   * The object's body as a stream, for a reader that wants its lines rather than its text.
   *
   * Optional, and the reason it is optional is the reason it exists. Cloudflare's first listed
   * remedy for a Worker that exceeds its 128 MB isolate is to stream large payloads instead of
   * buffering them, and `get` cannot do that: it returns one string the size of the object. A
   * store that can hand back a body implements this and the large reads take it; a store that
   * cannot — or an object small enough that it makes no difference — keeps `get`.
   *
   * Null means the object is absent, exactly as `get` does. A throw means it exists and could not
   * be read, which is a different answer and every caller here keeps them apart.
   */
  getStream?(key: string): Promise<ReadableStream<Uint8Array> | null>;
  /**
   * The object's body as bytes, for an artifact that is not text.
   *
   * Optional for the same reason `getStream` is: a store may not be able to, and a caller that
   * needs bytes checks first and reads the text sibling when it cannot. The pattern-trips shards
   * are published in a columnar binary form because `JSON.parse` over eight megabytes was the
   * largest single item in a journey request's CPU, and a string cannot carry that form —
   * `get` would decode the bytes as UTF-8 and hand back something that is neither the object nor
   * an error.
   *
   * Null means absent, exactly as `get` does. A throw means it exists and could not be read.
   */
  getBytes?(key: string): Promise<Uint8Array | null>;
  /** Write bytes. Optional, and for the same reason. */
  putBytes?(key: string, value: Uint8Array): Promise<void>;
}

/** An object store that can stream a body. Narrowed from `ObjectStore` by `canStream`. */
export interface StreamingObjectStore extends ObjectStore {
  getStream(key: string): Promise<ReadableStream<Uint8Array> | null>;
}

/** Whether this store can hand back bodies as streams, so a caller can take the cheaper path. */
export function canStream(store: ObjectStore): store is StreamingObjectStore {
  return typeof store.getStream === "function";
}

/** An object store that can read and write bytes. Narrowed from `ObjectStore` by `canHoldBytes`. */
export interface BinaryObjectStore extends ObjectStore {
  getBytes(key: string): Promise<Uint8Array | null>;
  putBytes(key: string, value: Uint8Array): Promise<void>;
}

/** Whether this store can carry an artifact that is not text. */
export function canHoldBytes(store: ObjectStore): store is BinaryObjectStore {
  return typeof store.getBytes === "function" && typeof store.putBytes === "function";
}

export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, string>();
  private readonly bytes = new Map<string, Uint8Array>();
  private readonly uploadedAt = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async get(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }

  /**
   * The same body, as a stream, in several chunks.
   *
   * Chunked deliberately rather than enqueued whole: a fixture that delivers an object in one
   * piece exercises none of what a streaming reader exists to handle — no line split across a
   * boundary, no multi-byte character on one — and would let a reader that silently buffered pass
   * every test in the suite.
   */
  async getStream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    const bytes = new TextEncoder().encode(body);
    const size = Math.max(1, Math.ceil(bytes.length / 7));
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      },
    });
  }

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
    this.bytes.delete(key);
    this.uploadedAt.set(key, this.now().toISOString());
  }

  /**
   * The same object as bytes.
   *
   * A text object asked for as bytes is still that object, so it is encoded rather than reported
   * absent: a fixture written with `put` can be read either way, which is what lets a reader that
   * prefers a binary artifact be tested against a store holding only the text one.
   */
  async getBytes(key: string): Promise<Uint8Array | null> {
    const held = this.bytes.get(key);
    if (held !== undefined) return held;
    const text = this.objects.get(key);
    return text === undefined ? null : new TextEncoder().encode(text);
  }

  async putBytes(key: string, value: Uint8Array): Promise<void> {
    this.bytes.set(key, value);
    this.objects.delete(key);
    this.uploadedAt.set(key, this.now().toISOString());
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.bytes.delete(key);
    this.uploadedAt.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys(), ...this.bytes.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
  }
  async listDetailed(prefix: string): Promise<StoredObject[]> {
    const sizes = new Map<string, number>();
    for (const [key, value] of this.objects) sizes.set(key, new TextEncoder().encode(value).length);
    for (const [key, value] of this.bytes) sizes.set(key, value.byteLength);
    return [...sizes.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, sizeBytes]) => ({
        key,
        sizeBytes,
        uploadedAt: this.uploadedAt.get(key) ?? this.now().toISOString(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  get size(): number {
    return this.objects.size + this.bytes.size;
  }
}

/** FNV-1a: a fast non-cryptographic content hash, sufficient for integrity of our own artifacts. */
export function contentHash(value: string): string {
  return contentHashOf([value]);
}

/**
 * The same hash over a sequence of strings, without joining them first.
 *
 * FNV-1a folds left to right, so hashing parts in order is identical to hashing their
 * concatenation — but concatenating a national dataset to fingerprint it allocates a second copy
 * of it. That is how the first data bootstrap died: joining 25 decompressed timetable archives
 * into one string exhausted the heap before anything could be published.
 */
export function contentHashOf(parts: Iterable<string>): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

export interface PublishOptions<T> {
  dataset: string;
  version: string;
  records: readonly T[];
  schemaVersion: string;
  sources?: readonly string[];
  partialCoverage?: boolean;
  notes?: string;
  /** Minimum record count for the build to be considered valid. */
  minimumRecordCount?: number;
  /**
   * Whether an empty dataset is a legitimate result. Off by default, because an empty national
   * network is always a broken parse. On for datasets where nothing to report is a real answer —
   * a day with no incidents — since refusing that publish would leave the last non-empty version
   * live and yesterday's incidents on screen indefinitely.
   */
  allowEmpty?: boolean;
  /**
   * Maximum tolerated drop versus the previous version, as a fraction. A national dataset
   * that suddenly loses 40% of its records is far more likely to be a broken upstream parse
   * than a real change, so the publish is rejected and the previous version stays live.
   */
  maximumShrinkFraction?: number;
  validate?: (record: T) => boolean;
  now?: () => Date;
}

export class ArtifactValidationError extends Error {
  constructor(
    message: string,
    readonly reason:
      "empty" | "below_minimum" | "excessive_shrink" | "record_invalid" | "checksum_mismatch",
  ) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

export function manifestKey(dataset: string): string {
  return `manifests/${dataset}/current.json`;
}

export function objectKeyFor(dataset: string, version: string): string {
  return `data/${dataset}/${version}.jsonl`;
}

/**
 * The same object, for a dataset published as bytes rather than as lines.
 *
 * The pattern-trips shards are published columnar and binary because `JSON.parse` over a
 * corridor's worth of timetable was the largest single item in a journey request's CPU. They live
 * beside the text objects under the same dataset path, with a suffix that says what they are.
 */
export function objectKeyForBytes(dataset: string, version: string): string {
  return `data/${dataset}/${version}.bin`;
}

/**
 * The suffixes a published data object can carry.
 *
 * Everything that walks the bucket — pruning by version, pruning by service date, the storage
 * inventory — recognises an object by this suffix, so a form that is not listed here is a form
 * nothing can clean up. That is not a hypothetical: this bucket already carried a 3.27 GB
 * artifact nothing pointed at, and its free allowance is account-wide.
 */
export const ARTIFACT_OBJECT_SUFFIXES = [".jsonl", ".bin"] as const;

/** `data/<dataset>/<version>.jsonl` or `.bin` — the version is the last segment, less its suffix. */
export function versionInObjectKey(key: string): string | null {
  const lastSlash = key.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const name = key.slice(lastSlash + 1);
  for (const suffix of ARTIFACT_OBJECT_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const version = name.slice(0, -suffix.length);
    return version.length > 0 ? version : null;
  }
  return null;
}

export class ArtifactStore {
  constructor(private readonly store: ObjectStore) {}

  async readManifest(dataset: string): Promise<ArtifactManifest | null> {
    const raw = await this.store.get(manifestKey(dataset));
    if (raw === null) return null;
    const parsed = ArtifactManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async readRecords<T>(manifest: ArtifactManifest): Promise<T[]> {
    const raw = await this.store.get(manifest.objectKey);
    if (raw === null) return [];
    if (contentHash(raw) !== manifest.contentHash) {
      throw new ArtifactValidationError(
        `Checksum mismatch for ${manifest.objectKey}; refusing to serve a corrupted artifact`,
        "checksum_mismatch",
      );
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  }

  /** Reads the current live records, or an empty array when nothing has been published yet. */
  async readCurrent<T>(
    dataset: string,
  ): Promise<{ manifest: ArtifactManifest | null; records: T[] }> {
    const manifest = await this.readManifest(dataset);
    if (!manifest) return { manifest: null, records: [] };
    return { manifest, records: await this.readRecords<T>(manifest) };
  }

  /**
   * Every published version of a dataset, newest first.
   *
   * The manifest names one version — the live one — which is all a reader serving traffic needs.
   * A batch that has to aggregate a *closed* window needs the others: a five-minute bucket stays
   * open for ten minutes after it ends, so the observations that can be aggregated are never the
   * ones just collected. They are in the versions before it.
   */
  async listVersions(dataset: string): Promise<string[]> {
    const keys = await this.store.list(`data/${dataset}/`);
    return [...new Set(keys.map(versionInObjectKey))]
      .filter((version): version is string => version !== null)
      .sort()
      .reverse();
  }

  /**
   * One historical version's records.
   *
   * Deliberately without the checksum comparison `readRecords` makes: a manifest describes the
   * current version only, so there is no recorded hash for an older object to be checked against.
   * The guard that matters is still in place — `readCurrent` is what serves traffic and it still
   * verifies — and a corrupted line here fails loudly on `JSON.parse` rather than silently.
   */
  async readVersionRecords<T>(dataset: string, version: string): Promise<T[]> {
    const raw = await this.store.get(objectKeyFor(dataset, version));
    if (raw === null) return [];
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  }

  /**
   * Validate, write the versioned object, then atomically swap the manifest pointer.
   * Throws before the swap when validation fails, leaving the previous version live.
   */
  async publish<T>(options: PublishOptions<T>): Promise<ArtifactManifest> {
    const {
      dataset,
      version,
      records,
      schemaVersion,
      sources = [],
      partialCoverage = false,
      notes,
      minimumRecordCount = 1,
      maximumShrinkFraction = 0.25,
      validate,
      now = () => new Date(),
    } = options;

    if (records.length === 0 && options.allowEmpty !== true) {
      throw new ArtifactValidationError(
        `Refusing to publish empty artifact for ${dataset}`,
        "empty",
      );
    }
    if (records.length < minimumRecordCount) {
      throw new ArtifactValidationError(
        `Artifact ${dataset} has ${records.length} records, below the minimum ${minimumRecordCount}`,
        "below_minimum",
      );
    }
    if (validate) {
      const invalidIndex = records.findIndex((record) => !validate(record));
      if (invalidIndex >= 0) {
        throw new ArtifactValidationError(
          `Artifact ${dataset} record ${invalidIndex} failed validation`,
          "record_invalid",
        );
      }
    }

    const previous = await this.readManifest(dataset);
    if (previous && previous.recordCount > 0) {
      const shrink = (previous.recordCount - records.length) / previous.recordCount;
      if (shrink > maximumShrinkFraction) {
        throw new ArtifactValidationError(
          `Artifact ${dataset} shrank by ${(shrink * 100).toFixed(1)}% versus version ` +
            `${previous.version}; keeping the previous good version`,
          "excessive_shrink",
        );
      }
    }

    const body = records.map((record) => JSON.stringify(record)).join("\n");
    const key = objectKeyFor(dataset, version);
    await this.store.put(key, body);

    const manifest: ArtifactManifest = {
      dataset,
      version,
      publishedAt: now().toISOString(),
      objectKey: key,
      recordCount: records.length,
      contentHash: contentHash(body),
      sizeBytes: body.length,
      schemaVersion,
      /*
       * The version this one superseded — which is not this one.
       *
       * Republishing a dataset at the version already live is an in-place correction, not a new
       * version: a departures refresh does it to `network/operators` to carry a field the build
       * had not been reading. Pointing `previousVersion` at the same string would make
       * `rollback()` for that dataset a no-op, silently costing the recoverability the pointer
       * exists for. So an in-place republish carries the existing pointer forward, because the
       * version it superseded has not changed.
       */
      previousVersion:
        previous === null
          ? null
          : previous.version === version
            ? previous.previousVersion
            : previous.version,
      sources: [...sources],
      partialCoverage,
      ...(notes === undefined ? {} : { notes }),
    };

    // The pointer swap is the only step that makes the new data live.
    await this.store.put(manifestKey(dataset), JSON.stringify(manifest));
    return manifest;
  }

  /** Restore the previous good version by pointing the manifest back at it. */
  async rollback(dataset: string): Promise<ArtifactManifest | null> {
    const current = await this.readManifest(dataset);
    if (!current?.previousVersion) return null;

    const previousKey = objectKeyFor(dataset, current.previousVersion);
    const body = await this.store.get(previousKey);
    if (body === null) return null;

    const restored: ArtifactManifest = {
      ...current,
      version: current.previousVersion,
      objectKey: previousKey,
      publishedAt: new Date().toISOString(),
      recordCount: body.split("\n").filter(Boolean).length,
      contentHash: contentHash(body),
      sizeBytes: body.length,
      previousVersion: null,
      notes: `rolled back from ${current.version}`,
    };
    await this.store.put(manifestKey(dataset), JSON.stringify(restored));
    return restored;
  }

  /** Keep a bounded number of historical versions so storage stays inside the free tier. */
  async pruneOldVersions(dataset: string, keep = 3): Promise<string[]> {
    const current = await this.readManifest(dataset);
    const keys = await this.store.list(`data/${dataset}/`);
    const protectedKeys = new Set(
      [
        current?.objectKey,
        current?.previousVersion ? objectKeyFor(dataset, current.previousVersion) : null,
      ].filter(Boolean) as string[],
    );
    const candidates = keys.filter((k) => !protectedKeys.has(k)).sort();
    const toDelete = candidates.slice(
      0,
      Math.max(0, candidates.length - Math.max(0, keep - protectedKeys.size)),
    );
    for (const key of toDelete) {
      await this.store.delete(key);
    }
    return toDelete;
  }
}
