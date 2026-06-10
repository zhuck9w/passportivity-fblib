import type { Ad, AdScanObservation, Competitor, CompetitorScanRun, ScrapedAdInput, ScrapeRun } from '../shared/types';
import { reconcileScanLibraryIds, type ScanReconciliationResult } from './adStatusReconciliation';
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

export async function getLatestCompleteCompetitorScan(competitorId: string) {
  const result = await supabase
    .from('competitor_scan_runs')
    .select('*')
    .eq('competitor_id', competitorId)
    .eq('status', 'succeeded')
    .eq('complete', true)
    .order('finished_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return throwIfError<CompetitorScanRun | null>(result);
}

export async function createCompetitorScanRun(runId: string, competitorId: string) {
  const previousScan = await getLatestCompleteCompetitorScan(competitorId);
  const now = new Date().toISOString();
  const result = await supabase
    .from('competitor_scan_runs')
    .insert({
      run_id: runId,
      competitor_id: competitorId,
      previous_scan_id: previousScan?.id ?? null,
      status: 'running',
      started_at: now
    })
    .select('*')
    .single();
  return throwIfError<CompetitorScanRun>(result);
}

export async function recordAdScanObservation(input: {
  scanId: string;
  competitorId: string;
  adId: string;
  facebookLibraryId: string;
}) {
  const now = new Date().toISOString();
  const result = await supabase
    .from('ad_scan_observations')
    .upsert(
      {
        scan_id: input.scanId,
        competitor_id: input.competitorId,
        ad_id: input.adId,
        facebook_library_id: input.facebookLibraryId,
        observed_at: now
      },
      { onConflict: 'scan_id,competitor_id,facebook_library_id' }
    )
    .select('*')
    .single();
  return throwIfError<AdScanObservation>(result);
}

async function listObservationLibraryIds(scanId: string) {
  const result = await supabase
    .from('ad_scan_observations')
    .select('facebook_library_id')
    .eq('scan_id', scanId);
  const rows = throwIfError<Array<Pick<AdScanObservation, 'facebook_library_id'>>>(result);
  return rows.map((row) => row.facebook_library_id);
}

async function updateAdsByLibraryIds(competitorId: string, libraryIds: string[], patch: Record<string, unknown>) {
  if (!libraryIds.length) return;
  const result = await supabase
    .from('ads')
    .update(patch)
    .eq('competitor_id', competitorId)
    .in('facebook_library_id', libraryIds);
  throwIfError<null>(result as { data: null; error: { message: string } | null });
}

async function reconcileCompetitorScan(scan: CompetitorScanRun, finishedAt: string): Promise<ScanReconciliationResult> {
  const currentIds = await listObservationLibraryIds(scan.id);
  const previousIds = scan.previous_scan_id ? await listObservationLibraryIds(scan.previous_scan_id) : [];
  const reconciliation = reconcileScanLibraryIds(previousIds, currentIds, Boolean(scan.previous_scan_id));
  const basePatch = {
    last_seen_scan_id: scan.id,
    stopped_scan_id: null,
    stopped_at: null,
    updated_at: finishedAt
  };

  await updateAdsByLibraryIds(scan.competitor_id, reconciliation.activeIds, {
    ...basePatch,
    status: 'active'
  });

  await updateAdsByLibraryIds(scan.competitor_id, reconciliation.newIds, {
    ...basePatch,
    status: 'new'
  });

  const currentReconciledIds = Array.from(new Set([...reconciliation.activeIds, ...reconciliation.newIds]));
  if (currentReconciledIds.length) {
    const result = await supabase
      .from('ads')
      .update({ first_seen_scan_id: scan.id, updated_at: finishedAt })
      .eq('competitor_id', scan.competitor_id)
      .in('facebook_library_id', currentReconciledIds)
      .is('first_seen_scan_id', null);
    throwIfError<null>(result as { data: null; error: { message: string } | null });
  }

  await updateAdsByLibraryIds(scan.competitor_id, reconciliation.stoppedIds, {
    status: 'stopped',
    stopped_scan_id: scan.id,
    stopped_at: finishedAt,
    updated_at: finishedAt
  });

  return reconciliation;
}

export async function finishCompetitorScan(input: {
  scanId: string;
  status: CompetitorScanRun['status'];
  complete: boolean;
  finishedAt?: string;
}) {
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const updateResult = await supabase
    .from('competitor_scan_runs')
    .update({
      status: input.status,
      complete: input.complete,
      finished_at: finishedAt
    })
    .eq('id', input.scanId)
    .select('*')
    .single();
  const scan = throwIfError<CompetitorScanRun>(updateResult);

  const reconciliation =
    input.status === 'succeeded' && input.complete
      ? await reconcileCompetitorScan(scan, finishedAt)
      : { activeIds: [], newIds: [], stoppedIds: [] };

  return { scan, reconciliation };
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
  if (filters.status === 'active') query = query.in('status', ['active', 'new']);
  else if (filters.status) query = query.eq('status', filters.status);
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
        media_items: input.media_items ?? existing.media_items ?? [],
        stopped_scan_id: null,
        stopped_at: null,
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
        media_items: input.media_items ?? [],
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
        media_items: input.media_items ?? [],
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
