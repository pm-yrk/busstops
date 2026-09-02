import type { ObjectStore } from "./artifacts.js";

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
}

export class R2ObjectStore implements ObjectStore {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: R2StoreConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  private objectUrl(key: string): string {
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    return (
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}` +
      `/r2/buckets/${encodeURIComponent(this.config.bucket)}/objects/${encoded}`
    );
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
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
    const body = (await response.json()) as { result?: Array<{ key?: string }> };
    return (body.result ?? [])
      .map((object) => object.key)
      .filter((key): key is string => typeof key === "string")
      .sort();
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
