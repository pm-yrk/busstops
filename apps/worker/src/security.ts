import type { ApiError } from "@busstops/contracts";

/**
 * Edge security controls (docs/14_SECURITY.md "Application controls").
 */

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(self), camera=(), microphone=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Resource-Policy": "same-site",
};

/**
 * Content Security Policy for the application shell. Map tiles and fonts are the only external
 * origins, and `connect-src` is limited to self so the browser never talks to a data provider
 * directly — that is the Worker's job, and it is what keeps provider keys server-side.
 */
export function contentSecurityPolicy(tileHost: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${tileHost}`,
    `connect-src 'self' ${tileHost}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function withSecurityHeaders(
  response: Response,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries({ ...SECURITY_HEADERS, ...extra })) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Same-origin by default; an explicit allowlist is required for anything else. */
export function corsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[],
): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export function errorResponse(
  code: ApiError["error"]["code"],
  message: string,
  status: number,
  retryAfterSeconds?: number,
): Response {
  const body: ApiError = {
    error: {
      code,
      message,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (retryAfterSeconds !== undefined) headers["Retry-After"] = String(retryAfterSeconds);
  return withSecurityHeaders(new Response(JSON.stringify(body), { status, headers }));
}

export interface RateLimitConfig {
  /** Requests allowed per window per client. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter over an in-isolate counter map.
 *
 * This bounds a single isolate, which is the practical protection against a burst from one
 * client; the durable protection against sustained abuse is the governor plus cache-first
 * responses, since a Worker isolate is short-lived and not shared globally.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly config: RateLimitConfig = { limit: 120, windowSeconds: 60 }) {}

  check(clientKey: string, now: number = Date.now()): RateLimitDecision {
    const window = this.windows.get(clientKey);

    if (!window || now >= window.resetAt) {
      const resetAt = now + this.config.windowSeconds * 1000;
      this.windows.set(clientKey, { count: 1, resetAt });
      this.evictExpired(now);
      return { allowed: true, remaining: this.config.limit - 1, retryAfterSeconds: 0 };
    }

    if (window.count >= this.config.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      };
    }

    window.count += 1;
    return { allowed: true, remaining: this.config.limit - window.count, retryAfterSeconds: 0 };
  }

  private evictExpired(now: number): void {
    if (this.windows.size < 5000) return;
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }
  }
}

/**
 * Client key for rate limiting. Derived from the coarse network identity the platform already
 * receives; no cookie is set and no precise location is involved.
 */
export function clientKeyFor(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
