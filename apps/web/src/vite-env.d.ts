/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the Bus Stops edge API, baked in at build time.
   *
   * The web app is served from Cloudflare Pages and the API is a separate Worker, so there is no
   * same-origin path to call. Routing through a Pages Function would restore one, but every
   * request would then run two Workers — the Function and the API — to answer one question, for
   * no benefit beyond a tidier URL.
   *
   * Left unset (local development) the client falls back to `/api`, which the dev server proxies
   * to a local `wrangler dev`.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
