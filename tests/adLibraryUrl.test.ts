import { describe, expect, it } from 'vitest';
import { buildAdArchiveIdUrl, buildAdLibraryUrl } from '../src/shared/adLibraryUrl';

describe('buildAdLibraryUrl', () => {
  it('builds the worldwide active page search url by default', () => {
    const url = new URL(buildAdLibraryUrl('1543779709167826'));

    expect(url.origin + url.pathname).toBe('https://www.facebook.com/ads/library/');
    expect(url.searchParams.get('active_status')).toBe('active');
    expect(url.searchParams.get('ad_type')).toBe('all');
    expect(url.searchParams.get('country')).toBe('ALL');
    expect(url.searchParams.get('is_targeted_country')).toBe('false');
    expect(url.searchParams.get('media_type')).toBe('all');
    expect(url.searchParams.get('search_type')).toBe('page');
    expect(url.searchParams.get('view_all_page_id')).toBe('1543779709167826');
  });

  it('can still build an all-status URL explicitly', () => {
    const url = new URL(buildAdLibraryUrl('1543779709167826', 'all'));

    expect(url.searchParams.get('active_status')).toBe('all');
  });

  it('builds a direct ad archive link', () => {
    expect(buildAdArchiveIdUrl('2450836535428545')).toBe(
      'https://www.facebook.com/ads/library/?id=2450836535428545'
    );
  });
});
