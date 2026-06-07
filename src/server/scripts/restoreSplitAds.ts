import { supabase } from '../supabase';
import type { Ad, AdVariation } from '../../shared/types';

type RestoreStats = {
  variations: number;
  adsCreated: number;
  adsUpdated: number;
  variationsRewired: number;
  locationRowsRewired: number;
};

function throwIfError<T>(result: { data: T | null; error: { message: string } | null }) {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

async function fetchAll<T>(table: string, select: string) {
  const rows: T[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const result = await (supabase.from(table) as ReturnType<typeof supabase.from>)
      .select(select)
      .range(from, from + pageSize - 1);
    const page = throwIfError<T[]>(result as { data: T[] | null; error: { message: string } | null });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function findAd(competitorId: string, facebookLibraryId: string) {
  const result = await supabase
    .from('ads')
    .select('*')
    .eq('competitor_id', competitorId)
    .eq('facebook_library_id', facebookLibraryId)
    .maybeSingle();
  return throwIfError<Ad | null>(result);
}

async function restoreVariation(variation: AdVariation) {
  const now = new Date().toISOString();
  const existing = await findAd(variation.competitor_id, variation.facebook_library_id);
  const payload = {
    competitor_id: variation.competitor_id,
    facebook_library_id: variation.facebook_library_id,
    facebook_library_ids: [variation.facebook_library_id],
    source_url: variation.source_url,
    status: variation.status,
    start_date_text: variation.start_date_text,
    end_date_text: variation.end_date_text,
    platforms: variation.platforms,
    title: variation.title,
    body_text: variation.body_text,
    cta: variation.cta,
    preview_html: variation.preview_html,
    preview_text: variation.preview_text,
    dedupe_key: variation.facebook_library_id,
    duplicate_count: 1,
    last_seen_at: variation.seen_at ?? now,
    updated_at: now
  };

  if (existing) {
    const result = await supabase
      .from('ads')
      .update(payload)
      .eq('id', existing.id)
      .select('*')
      .single();
    return { ad: throwIfError<Ad>(result), created: false };
  }

  const result = await supabase
    .from('ads')
    .insert({
      ...payload,
      first_seen_at: variation.created_at ?? now
    })
    .select('*')
    .single();
  return { ad: throwIfError<Ad>(result), created: true };
}

async function main() {
  const variations = await fetchAll<AdVariation>('ad_variations', '*');
  const stats: RestoreStats = {
    variations: variations.length,
    adsCreated: 0,
    adsUpdated: 0,
    variationsRewired: 0,
    locationRowsRewired: 0
  };

  for (const variation of variations) {
    const restored = await restoreVariation(variation);
    if (restored.created) stats.adsCreated += 1;
    else stats.adsUpdated += 1;

    const variationUpdate = await supabase
      .from('ad_variations')
      .update({
        ad_id: restored.ad.id,
        dedupe_key: variation.facebook_library_id,
        updated_at: new Date().toISOString()
      })
      .eq('id', variation.id);
    throwIfError<null>(variationUpdate as { data: null; error: { message: string } | null });
    stats.variationsRewired += 1;

    const locationUpdate = await supabase
      .from('ad_locations')
      .update({ ad_id: restored.ad.id })
      .eq('facebook_library_id', variation.facebook_library_id);
    throwIfError<null>(locationUpdate as { data: null; error: { message: string } | null });
    stats.locationRowsRewired += 1;
  }

  const ads = await fetchAll<Ad>('ads', '*');
  for (const ad of ads) {
    if (ad.facebook_library_ids.length === 1 && ad.facebook_library_ids[0] === ad.facebook_library_id && ad.duplicate_count === 1) {
      continue;
    }

    const normalize = await supabase
      .from('ads')
      .update({
        facebook_library_ids: [ad.facebook_library_id],
        dedupe_key: ad.facebook_library_id,
        duplicate_count: 1,
        updated_at: new Date().toISOString()
      })
      .eq('id', ad.id);
    throwIfError<null>(normalize as { data: null; error: { message: string } | null });
  }

  const restoredAds = await fetchAll<Ad>('ads', 'id, facebook_library_id, facebook_library_ids, duplicate_count');
  console.log(
    JSON.stringify(
      {
        ...stats,
        adsAfter: restoredAds.length,
        stillCollapsed: restoredAds.filter((ad) => ad.facebook_library_ids.length > 1 || ad.duplicate_count > 1).length
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
