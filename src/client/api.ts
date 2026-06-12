import type { Ad, AdLocation, Competitor, ScrapeJobSnapshot, ScrapeRun } from '../shared/types';

// Interface backend (competitors, ads, geo). Same-origin by default — proxied to the
// interface server in dev (see vite.config.ts), same domain when deployed to Vercel.
const API_BASE = import.meta.env.VITE_API_URL ?? '';

// Scraper service (start/stop/status of scraping). Runs as a separate long-lived process,
// so it lives on its own origin. Defaults to the local scraper port in dev.
const SCRAPER_BASE = import.meta.env.VITE_SCRAPER_URL ?? 'http://localhost:4001';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function api<T>(path: string, init?: RequestInit) {
  return request<T>(`${API_BASE}${path}`, init);
}

function scraperApi<T>(path: string, init?: RequestInit) {
  return request<T>(`${SCRAPER_BASE}${path}`, init);
}

export function fetchCompetitors() {
  return api<Competitor[]>('/api/competitors');
}

export function createCompetitor(input: {
  name: string;
  facebook_page_id: string;
  enabled: boolean;
  visible?: boolean;
  notes?: string | null;
}) {
  return api<Competitor>('/api/competitors', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export type BulkCompetitorInput = {
  name: string;
  facebook_page_id: string;
  enabled?: boolean;
  notes?: string | null;
};

export type BulkCompetitorResult = {
  created: Competitor[];
  errors: Array<{ index: number; name: string; facebook_page_id: string; message: string }>;
};

export function bulkCreateCompetitors(items: BulkCompetitorInput[]) {
  return api<BulkCompetitorResult>('/api/competitors/bulk', {
    method: 'POST',
    body: JSON.stringify({ items })
  });
}

export function updateCompetitor(
  id: string,
  input: Partial<Pick<Competitor, 'name' | 'facebook_page_id' | 'enabled' | 'visible' | 'notes'>>
) {
  return api<Competitor>(`/api/competitors/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
}

export function deleteCompetitor(id: string) {
  return api<void>(`/api/competitors/${id}`, { method: 'DELETE' });
}

export function fetchAds(filters: { competitorIds?: string[]; status?: string; q?: string }) {
  const params = new URLSearchParams();
  if (filters.competitorIds?.length) params.set('competitor_ids', filters.competitorIds.join(','));
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  return api<Ad[]>(`/api/ads?${params.toString()}`);
}

export function fetchAd(id: string) {
  return api<Ad>(`/api/ads/${id}`);
}

export function setAdHidden(id: string, hidden: boolean) {
  return api<Ad>(`/api/ads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ hidden })
  });
}

export function bulkSetAdHidden(ids: string[], hidden: boolean) {
  return api<{ updated: number; ids: string[] }>('/api/ads/bulk-hidden', {
    method: 'POST',
    body: JSON.stringify({ ids, hidden })
  });
}

// URL of the same-origin image proxy (see interface.ts). Used by the Excel export to
// pull Facebook CDN previews as same-origin bytes (no CORS / no tainted canvas).
export function imageProxyUrl(url: string) {
  return `${API_BASE}/api/image-proxy?url=${encodeURIComponent(url)}`;
}

export function fetchAdLocations(ids: string[]) {
  return api<Record<string, AdLocation[]>>('/api/ad-locations', {
    method: 'POST',
    body: JSON.stringify({ ids })
  });
}

export function fetchScrapeRuns() {
  return api<{ persisted: ScrapeRun[] }>('/api/runs');
}

// --- Scraper service (separate origin) ---

export function startScrape(input: { competitorId?: string; limit?: number; collectCarousels?: boolean }) {
  return scraperApi<ScrapeJobSnapshot>('/api/scrape', {
    method: 'POST',
    body: JSON.stringify({
      competitor_id: input.competitorId,
      limit: input.limit,
      collect_carousels: input.collectCarousels
    })
  });
}

export function fetchJob(runId: string) {
  return scraperApi<ScrapeJobSnapshot>(`/api/jobs/${runId}`);
}

export function stopScrape(runId: string) {
  return scraperApi<ScrapeJobSnapshot>(`/api/jobs/${runId}/stop`, { method: 'POST' });
}
