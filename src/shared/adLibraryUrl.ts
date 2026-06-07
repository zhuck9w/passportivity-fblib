export type AdLibraryActiveStatus = 'active' | 'all' | 'inactive';

export function buildAdLibraryUrl(pageId: string, activeStatus: AdLibraryActiveStatus = 'active') {
  const url = new URL('https://www.facebook.com/ads/library/');
  url.searchParams.set('active_status', activeStatus);
  url.searchParams.set('ad_type', 'all');
  url.searchParams.set('country', 'ALL');
  url.searchParams.set('is_targeted_country', 'false');
  url.searchParams.set('media_type', 'all');
  url.searchParams.set('search_type', 'page');
  url.searchParams.set('sort_data[mode]', 'total_impressions');
  url.searchParams.set('sort_data[direction]', 'desc');
  url.searchParams.set('view_all_page_id', pageId);
  return url.toString();
}

export function buildAdArchiveIdUrl(adArchiveId: string) {
  const url = new URL('https://www.facebook.com/ads/library/');
  url.searchParams.set('id', adArchiveId);
  return url.toString();
}
