export type ScrapeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'stopped';

export type Competitor = {
  id: string;
  name: string;
  facebook_page_id: string;
  enabled: boolean;
  notes: string | null;
  last_scraped_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ScrapeRun = {
  id: string;
  status: ScrapeStatus;
  competitor_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_summary: string | null;
  ads_found: number;
  ads_saved: number;
  duplicates_found: number;
  created_at: string;
};

export type AdLocation = {
  id: string;
  ad_id: string;
  facebook_library_id: string;
  location: string;
  location_type: string | null;
  visibility: string | null;
  created_at: string;
};

export type AdVariation = {
  id: string;
  ad_id: string;
  competitor_id: string;
  facebook_library_id: string;
  status: string;
  start_date_text: string | null;
  end_date_text: string | null;
  platforms: string[];
  title: string | null;
  body_text: string | null;
  cta: string | null;
  preview_html: string | null;
  preview_text: string | null;
  dedupe_key: string;
  source_url: string;
  seen_at: string;
  created_at: string;
  updated_at: string;
};

export type Ad = {
  id: string;
  competitor_id: string;
  facebook_library_id: string;
  facebook_library_ids: string[];
  source_url: string;
  status: string;
  start_date_text: string | null;
  end_date_text: string | null;
  platforms: string[];
  title: string | null;
  body_text: string | null;
  cta: string | null;
  preview_html: string | null;
  preview_text: string | null;
  dedupe_key: string;
  duplicate_count: number;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  competitors?: Pick<Competitor, 'id' | 'name' | 'facebook_page_id'>;
  ad_locations?: AdLocation[];
  ad_variations?: AdVariation[];
};

export type ScrapedLocationInput = {
  location: string;
  location_type?: string | null;
  visibility?: string | null;
};

export type ScrapedAdInput = {
  competitor_id: string;
  facebook_library_id: string;
  source_url: string;
  status: string;
  start_date_text?: string | null;
  end_date_text?: string | null;
  platforms: string[];
  title?: string | null;
  body_text?: string | null;
  cta?: string | null;
  preview_html?: string | null;
  preview_text?: string | null;
  dedupe_key: string;
  locations: ScrapedLocationInput[];
};

export type ScrapeJobSnapshot = {
  run_id: string;
  status: ScrapeStatus;
  message: string;
  started_at: string;
  finished_at?: string;
  ads_found: number;
  ads_saved: number;
  duplicates_found: number;
  limit?: number;
  limit_reached?: boolean;
  errors: string[];
};
