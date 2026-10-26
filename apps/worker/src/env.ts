import type { ObjectStore } from "@busstops/pipeline-core";

/**
 * Worker environment bindings. Credentials exist only here, server-side: nothing in this file
 * is ever serialised into a response (docs/14_SECURITY.md).
 */

export interface R2BucketLike {
  /**
   * `body` alongside `text()` because the large reads take the stream.
   *
   * The native R2 object has always had both; this interface only ever declared `text()`, which
   * is how every serving read came to buffer a whole object into one string. Optional on the type
   * so a test double may omit it, and the readers check before using it.
   */
  get(key: string): Promise<{
    text(): Promise<string>;
    body?: ReadableStream<Uint8Array> | null;
  } | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(options?: { prefix?: string }): Promise<{ objects: Array<{ key: string }> }>;
}

export interface WorkerEnv {
  ARTIFACTS?: R2BucketLike;
  BODS_API_KEY?: string;
  TFL_APP_KEY?: string;
  VEHICLE_SALT_SECRET?: string;
  /** Remote kill switches, so optional features can be disabled without redeploying. */
  FEATURE_FLAGS_JSON?: string;
  /** Forces a governor state for drills and incident response. */
  GOVERNOR_MODE?: string;
  PUBLIC_BASE_URL?: string;
  /** Secret behind Daily Brief unsubscribe tokens. Only token hashes are ever stored. */
  UNSUBSCRIBE_SECRET?: string;
}

/** Adapts the native R2 binding to the shared ObjectStore interface used by the artifact store. */
export class R2BindingStore implements ObjectStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async get(key: string): Promise<string | null> {
    const object = await this.bucket.get(key);
    return object ? object.text() : null;
  }

  /**
   * The object's body, for a reader that wants its lines rather than the whole string.
   *
   * This is the one line of code that decides whether a pattern tile arrives as a
   * three-megabyte allocation or as a sequence of chunks. Cloudflare's own first remedy for a
   * Worker that exceeds its 128 MB isolate is to stream large payloads rather than buffer them,
   * and until this existed there was nothing underneath the readers that could.
   *
   * Null when the object is absent. A `get` that produced an object with no body is not an
   * absence and must not be reported as one — the caller would record "no rows here", which is a
   * claim about the network rather than about the read.
   */
  async getStream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const object = await this.bucket.get(key);
    if (object === null) return null;
    const body = object.body;
    if (body === null || body === undefined) {
      throw new Error(`R2 object ${key} has no body to stream`);
    }
    return body;
  }
  async put(key: string, value: string): Promise<void> {
    await this.bucket.put(key, value);
  }
  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    const result = await this.bucket.list({ prefix });
    return result.objects.map((o) => o.key).sort();
  }
}

export interface FeatureFlags {
  liveVehicles: boolean;
  congestionLayer: boolean;
  journeyPlanner: boolean;
  proDemo: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  liveVehicles: true,
  congestionLayer: true,
  journeyPlanner: true,
  proDemo: true,
};

export function readFeatureFlags(env: WorkerEnv): FeatureFlags {
  if (!env.FEATURE_FLAGS_JSON) return DEFAULT_FLAGS;
  try {
    const parsed = JSON.parse(env.FEATURE_FLAGS_JSON) as Partial<FeatureFlags>;
    return { ...DEFAULT_FLAGS, ...parsed };
  } catch {
    // A malformed flag blob must not disable the product; fall back to defaults.
    return DEFAULT_FLAGS;
  }
}
