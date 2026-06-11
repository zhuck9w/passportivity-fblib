/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the interface backend. Empty string = same-origin (dev proxy / Vercel). */
  readonly VITE_API_URL?: string;
  /** Absolute base URL of the scraper service. Defaults to http://localhost:4001 in dev. */
  readonly VITE_SCRAPER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
