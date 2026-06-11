import type { Ad, AdLocation, Competitor, ScrapeJobSnapshot, ScrapeRun } from '../shared/types';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
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

export function fetchAds(filters: { competitorId?: string; status?: string; platform?: string; q?: string }) {
  const params = new URLSearchParams();
  if (filters.competitorId) params.set('competitor_id', filters.competitorId);
  if (filters.status) params.set('status', filters.status);
  if (filters.platform) params.set('platform', filters.platform);
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

export function fetchAdLocations(ids: string[]) {
  return api<Record<string, AdLocation[]>>('/api/ad-locations', {
    method: 'POST',
    body: JSON.stringify({ ids })
  });
}

export function startScrape(input: { competitorId?: string; limit?: number; collectCarousels?: boolean }) {
  return api<ScrapeJobSnapshot>('/api/scrape', {
    method: 'POST',
    body: JSON.stringify({
      competitor_id: input.competitorId,
      limit: input.limit,
      collect_carousels: input.collectCarousels
    })
  });
}

export function fetchJob(runId: string) {
  return api<ScrapeJobSnapshot>(`/api/jobs/${runId}`);
}

export function stopScrape(runId: string) {
  return api<ScrapeJobSnapshot>(`/api/jobs/${runId}/stop`, { method: 'POST' });
}

export function fetchRuns() {
  return api<{ persisted: Array<ScrapeRun & { competitors?: Pick<Competitor, 'name' | 'facebook_page_id'> }>; active: ScrapeJobSnapshot[] }>(
    '/api/runs'
  );
}

export function fetchLog(name: 'scraper' | 'server', lines = 120) {
  return api<{ name: string; lines: string[] }>(`/api/logs/${name}?lines=${lines}`);
}
