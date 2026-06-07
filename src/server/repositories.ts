import type { Ad, Competitor, ScrapedAdInput, ScrapeRun } from '../shared/types';
import { supabase } from './supabase';

function throwIfError<T>(result: { data: T | null; error: { message: string } | null }) {
  if (result.error) {
    throw new Error(result.error.message);
  }
  return result.data as T;
}

async function findExistingAd(input: ScrapedAdInput) {
  const byPrimaryLibraryId = await supabase
    .from('ads')
    .select('*')
    .eq('competitor_id', input.competitor_id)
    .eq('facebook_library_id', input.facebook_library_id)
    .maybeSingle();
  return throwIfError<Ad | null>(byPrimaryLibraryId);
}

export async function listCompetitors() {
  const result = await supabase
    .from('competitors')
    .select('*')
    .order('created_at', { ascending: false });
  return throwIfError<Competitor[]>(result);
}

export async function getCompetitor(id: string) {
  const result = await supabase.from('competitors').select('*').eq('id', id).single();
  return throwIfError<Competitor>(result);
}

export async function listEnabledCompetitors() {
  const result = await supabase
    .from('competitors')
    .select('*')
    .eq('enabled', true)
    .order('created_at', { ascending: false });
  return throwIfError<Competitor[]>(result);
}

export async function createCompetitor(input: {
  name: string;
  facebook_page_id: string;
  enabled?: boolean;
  notes?: string | null;
}) {
  const result = await supabase
    .from('competitors')
    .insert({
      name: input.name,
      facebook_page_id: input.facebook_page_id,
      enabled: input.enabled ?? true,
      notes: input.notes ?? null
    })
    .select('*')
    .single();
  return throwIfError<Competitor>(result);
}

export async function updateCompetitor(
  id: string,
  input: Partial<Pick<Competitor, 'name' | 'facebook_page_id' | 'enabled' | 'notes'>>
) {
  const result = await supabase
    .from('competitors')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  return throwIfError<Competitor>(result);
}

export async function deleteCompetitor(id: string) {
  const result = await supabase.from('competitors').delete().eq('id', id);
  throwIfError<null>(result as { data: null; error: { message: string } | null });
}

export async function markCompetitorScraped(id: string) {
  const result = await supabase
    .from('competitors')
    .update({ last_scraped_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
  throwIfError<null>(result as { data: null; error: { message: string } | null });
}

export async function createScrapeRun(competitorId?: string | null) {
  const now = new Date().toISOString();
  const result = await supabase
    .from('scrape_runs')
    .insert({ competitor_id: competitorId ?? null, status: 'running', started_at: now })
    .select('*')
    .single();
  return throwIfError<ScrapeRun>(result);
}

export async function updateScrapeRun(
  id: string,
  input: Partial<Pick<ScrapeRun, 'status' | 'error_summary' | 'ads_found' | 'ads_saved' | 'duplicates_found'>> & {
    finished_at?: string | null;
  }
) {
  const result = await supabase.from('scrape_runs').update(input).eq('id', id).select('*').single();
  return throwIfError<ScrapeRun>(result);
}

export async function listScrapeRuns() {
  const result = await supabase
    .from('scrape_runs')
    .select('*, competitors(name, facebook_page_id)')
    .order('created_at', { ascending: false })
    .limit(25);
  return throwIfError<Array<ScrapeRun & { competitors?: Pick<Competitor, 'name' | 'facebook_page_id'> }>>(result);
}

export async function listAds(filters: {
  competitorId?: string;
  status?: string;
  platform?: string;
  q?: string;
}) {
  let query = supabase
    .from('ads')
    .select('*, competitors(id, name, facebook_page_id)')
    .order('last_seen_at', { ascending: false })
    .limit(250);

  if (filters.competitorId) query = query.eq('competitor_id', filters.competitorId);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.platform) query = query.contains('platforms', [filters.platform]);
  if (filters.q) {
    query = query.or(`title.ilike.%${filters.q}%,body_text.ilike.%${filters.q}%,preview_text.ilike.%${filters.q}%`);
  }

  const result = await query;
  return throwIfError<Ad[]>(result);
}

export async function getAd(id: string) {
  const result = await supabase
    .from('ads')
    .select('*, competitors(id, name, facebook_page_id), ad_locations(*), ad_variations(*)')
    .eq('id', id)
    .single();
  return throwIfError<Ad>(result);
}

export async function upsertScrapedAd(input: ScrapedAdInput) {
  const existing = await findExistingAd(input);

  const now = new Date().toISOString();

  let ad: Ad;
  if (existing) {
    const result = await supabase
      .from('ads')
      .update({
        facebook_library_id: input.facebook_library_id,
        facebook_library_ids: [input.facebook_library_id],
        duplicate_count: 1,
        dedupe_key: input.facebook_library_id,
        status: input.status,
        start_date_text: input.start_date_text ?? existing.start_date_text,
        end_date_text: input.end_date_text ?? existing.end_date_text,
        platforms: input.platforms.length ? input.platforms : existing.platforms,
        title: input.title ?? existing.title,
        body_text: input.body_text ?? existing.body_text,
        cta: input.cta ?? existing.cta,
        source_url: input.source_url,
        preview_html: input.preview_html ?? existing.preview_html,
        preview_text: input.preview_text ?? existing.preview_text,
        last_seen_at: now,
        updated_at: now
      })
      .eq('id', existing.id)
      .select('*')
      .single();
    ad = throwIfError<Ad>(result);
  } else {
    const result = await supabase
      .from('ads')
      .insert({
        competitor_id: input.competitor_id,
        facebook_library_id: input.facebook_library_id,
        facebook_library_ids: [input.facebook_library_id],
        source_url: input.source_url,
        status: input.status,
        start_date_text: input.start_date_text ?? null,
        end_date_text: input.end_date_text ?? null,
        platforms: input.platforms,
        title: input.title ?? null,
        body_text: input.body_text ?? null,
        cta: input.cta ?? null,
        preview_html: input.preview_html ?? null,
        preview_text: input.preview_text ?? null,
        dedupe_key: input.facebook_library_id,
        duplicate_count: 1
      })
      .select('*')
      .single();
    ad = throwIfError<Ad>(result);
  }

  const variationResult = await supabase
    .from('ad_variations')
    .upsert(
      {
        ad_id: ad.id,
        competitor_id: input.competitor_id,
        facebook_library_id: input.facebook_library_id,
        status: input.status,
        start_date_text: input.start_date_text ?? null,
        end_date_text: input.end_date_text ?? null,
        platforms: input.platforms,
        title: input.title ?? null,
        body_text: input.body_text ?? null,
        cta: input.cta ?? null,
        preview_html: input.preview_html ?? null,
        preview_text: input.preview_text ?? null,
        dedupe_key: input.facebook_library_id,
        source_url: input.source_url,
        seen_at: now,
        updated_at: now
      },
      { onConflict: 'competitor_id,facebook_library_id' }
    )
    .select('*')
    .single();
  throwIfError(variationResult);

  const deleteLocations = await supabase
    .from('ad_locations')
    .delete()
    .eq('ad_id', ad.id)
    .eq('facebook_library_id', input.facebook_library_id);
  throwIfError<null>(deleteLocations as { data: null; error: { message: string } | null });

  if (input.locations.length) {
    const insertLocations = await supabase.from('ad_locations').insert(
      input.locations.map((location) => ({
        ad_id: ad.id,
        facebook_library_id: input.facebook_library_id,
        location: location.location,
        location_type: location.location_type ?? null,
        visibility: location.visibility ?? null
      }))
    );
    throwIfError<null>(insertLocations as { data: null; error: { message: string } | null });
  }

  return { ad, isExisting: Boolean(existing) };
}
