import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { env } from './env';
import { logServer } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
//  OUTBOUND HTTP PROXY — single source of truth.
//
//  Why this file exists: when the backend runs on a VPS inside RU, Facebook and
//  OpenAI are unreachable directly. Set PROXY_URL to a proxy whose exit node is
//  outside RU, and every piece of blocked traffic is routed through it:
//
//    • Playwright browser → facebook.com / *.fbcdn.net  →  playwrightProxy()
//    • fetch() to OpenAI + fbcdn image downloads (AI)    →  proxiedFetch()
//    • fetch() in the Excel export image-proxy           →  proxiedFetch()
//
//  Supabase deliberately keeps plain fetch() — it's reachable from RU and we don't
//  want every DB query bouncing through the proxy. If you need to proxy something
//  new, route it through proxiedFetch() — THIS is the only file to edit.
//
//  PROXY_URL format:  http://user:pass@host:port   (https:// also works)
//  Leave it unset to disable the proxy entirely (everything goes direct).
// ─────────────────────────────────────────────────────────────────────────────

// ┌─ FLAG ─────────────────────────────────────────────────────────────────────┐
// │ Route Supabase (the DB) through the proxy too?                             │
// │ Default false: Supabase is reachable from RU, so DB queries go direct and  │
// │ don't pay the proxy's latency. Flip to true if Supabase ever gets blocked  │
// │ from RU as well — then (and only when PROXY_URL is set) supabase-js is      │
// │ routed through the same proxy.                                             │
// └────────────────────────────────────────────────────────────────────────────┘
export const PROXY_SUPABASE = true;

// null = checked, no proxy configured. undefined = not yet initialised.
let dispatcher: Dispatcher | null | undefined;

function getDispatcher(): Dispatcher | null {
  if (dispatcher !== undefined) return dispatcher;
  dispatcher = env.proxyUrl ? new ProxyAgent(env.proxyUrl) : null;
  logServer('info', dispatcher ? 'Outbound proxy enabled' : 'Outbound proxy disabled', {
    proxy: env.proxyUrl ? redactProxyUrl(env.proxyUrl) : undefined
  });
  return dispatcher;
}

export function isProxyEnabled() {
  return Boolean(getDispatcher());
}

/**
 * Playwright `proxy` launch option (browser → Facebook). Credentials are passed in
 * the dedicated username/password fields, not inline in `server`. Returns undefined
 * when no proxy is configured — Playwright treats that as "no proxy".
 */
export function playwrightProxy(): { server: string; username?: string; password?: string } | undefined {
  if (!env.proxyUrl) return undefined;
  const url = new URL(env.proxyUrl);
  return {
    server: `${url.protocol}//${url.host}`,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined
  };
}

/**
 * Drop-in fetch() replacement: routes through the proxy when PROXY_URL is set, and
 * behaves exactly like fetch() otherwise. Use it for any host blocked from RU.
 */
export function proxiedFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): ReturnType<typeof fetch> {
  const proxy = getDispatcher();
  if (!proxy) return fetch(input, init);
  // Must use undici's OWN fetch here: Node's global fetch is backed by Node's bundled
  // undici, and passing a dispatcher built by the installed `undici` package into it
  // throws UND_ERR_INVALID_ARG (version mismatch). Same-package fetch + dispatcher match.
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: proxy
  }) as unknown as ReturnType<typeof fetch>;
}

/**
 * Custom fetch for the supabase-js client. Returns undefined (→ supabase uses its own
 * default fetch, i.e. a direct connection) unless PROXY_SUPABASE is on AND a proxy is
 * configured, in which case DB traffic is routed through the proxy too.
 */
export function supabaseFetch(): typeof fetch | undefined {
  return PROXY_SUPABASE && isProxyEnabled() ? (proxiedFetch as typeof fetch) : undefined;
}

function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return 'invalid PROXY_URL';
  }
}
