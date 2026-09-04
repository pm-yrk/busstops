import type { ObjectStore, StoredObject } from "./artifacts.js";

/**
 * Cloudflare R2 object store over the REST API.
 *
 * The REST API is used rather than the S3-compatible endpoint so that a scoped API token is
 * enough — no long-lived access key pair has to exist anywhere. Inside a Worker the native R2
 * binding is used instead; this implementation is for scheduled jobs running in CI.
 */

export interface R2StoreConfig {
  accountId: string;
  bucket: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** Requests are bounded so a hung call cannot consume the job's runtime budget. */
  timeoutMs?: number;
  /** How many times to wait out a 429 or a 5xx before giving up on a request. */
  maxRateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class R2ObjectStore implements ObjectStore {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: R2StoreConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRateLimitRetries = config.maxRateLimitRetries ?? 6;
    this.sleep = config.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  private objectUrl(key: string): string {
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    return (
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}` +
      `/r2/buckets/${encodeURIComponent(this.config.bucket)}/objects/${encoded}`
    );
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    /*
     * Cloudflare rate-limits its REST API per account, and a national publish writes thousands of
     * objects. Being told to slow down is an expected part of that conversation, not a failure:
     * without this a run gives up on hundreds of shards and publishes nothing.
     *
     * Retry-After is honoured when given, because guessing an interval the other side has already
     * told you is both rude and slower.
     */
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${this.config.apiToken}`,
          },
        });
      } finally {
        clearTimeout(timer);
      }

      /*
       * 429 is the API asking for less; 502, 503 and 504 are it being briefly unable to answer.
       * Both are transient and both are expected when a national build writes thousands of
       * objects — a run that treats either as final throws away three quarters of an hour of work
       * over a moment of load. A national publish lost 376 shards, and then its own rollback, to
       * a run of 503s. Every other status, including 413 and 404, is answered honestly and at
       * once, because retrying those would only be slower.
       */
      const transient =
        response.status === 429 || (response.status >= 502 && response.status <= 504);
      if (!transient || attempt > this.maxRateLimitRetries) return response;

      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 500 * 2 ** attempt);
      await this.sleep(waitMs);
    }
  }

  async get(key: string): Promise<string | null> {
    const response = await this.request(this.objectUrl(key), { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`R2 get failed for ${key}: ${response.status}`);
    }
    return response.text();
  }

  async put(key: string, value: string): Promise<void> {
    const response = await this.request(this.objectUrl(key), {
      method: "PUT",
      body: value,
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`R2 put failed for ${key}: ${response.status}`);
    }
  }

  async delete(key: string): Promise<void> {
    const response = await this.request(this.objectUrl(key), { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`R2 delete failed for ${key}: ${response.status}`);
    }
  }

  async list(prefix: string): Promise<string[]> {
    return (await this.listDetailed(prefix)).map((object) => object.key);
  }

  async listDetailed(prefix: string): Promise<StoredObject[]> {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}` +
        `/r2/buckets/${encodeURIComponent(this.config.bucket)}/objects`,
    );
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("per_page", "1000");

    const response = await this.request(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`R2 list failed for ${prefix}: ${response.status}`);
    }
    const body = (await response.json()) as {
      result?: Array<{ key?: string; size?: number; uploaded?: string }>;
    };
    return (body.result ?? [])
      .filter(
        (object): object is { key: string; size?: number; uploaded?: string } =>
          typeof object.key === "string",
      )
      .map((object) => ({
        key: object.key,
        sizeBytes: typeof object.size === "number" ? object.size : 0,
        uploadedAt: object.uploaded ?? new Date(0).toISOString(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}

/**
 * Builds an R2 store from the environment, or explains precisely what is missing.
 * Returning a typed failure rather than throwing lets a scheduled job report a configuration
 * gap as a clear outcome instead of a stack trace.
 */
export function r2StoreFromEnv(
  env: Record<string, string | undefined>,
): { ok: true; store: R2ObjectStore } | { ok: false; missing: string[] } {
  const required = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "R2_BUCKET_ARTIFACTS"];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    store: new R2ObjectStore({
      accountId: env.CLOUDFLARE_ACCOUNT_ID!,
      apiToken: env.CLOUDFLARE_API_TOKEN!,
      bucket: env.R2_BUCKET_ARTIFACTS!,
    }),
  };
}
