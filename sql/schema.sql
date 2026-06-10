create extension if not exists pgcrypto;

create table if not exists public.competitors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  facebook_page_id text not null unique,
  enabled boolean not null default true,
  notes text,
  last_scraped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scrape_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'stopped')),
  competitor_id uuid references public.competitors(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  error_summary text,
  ads_found integer not null default 0,
  ads_saved integer not null default 0,
  duplicates_found integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.ads (
  id uuid primary key default gen_random_uuid(),
  competitor_id uuid not null references public.competitors(id) on delete cascade,
  facebook_library_id text not null,
  facebook_library_ids text[] not null default '{}',
  source_url text not null,
  status text not null default 'unknown',
  start_date_text text,
  end_date_text text,
  platforms text[] not null default '{}',
  title text,
  body_text text,
  cta text,
  preview_html text,
  preview_text text,
  media_items jsonb not null default '[]'::jsonb,
  dedupe_key text not null,
  duplicate_count integer not null default 1,
  first_seen_scan_id uuid,
  last_seen_scan_id uuid,
  stopped_scan_id uuid,
  stopped_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (competitor_id, facebook_library_id)
);

create table if not exists public.competitor_scan_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.scrape_runs(id) on delete cascade,
  competitor_id uuid not null references public.competitors(id) on delete cascade,
  previous_scan_id uuid references public.competitor_scan_runs(id) on delete set null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'stopped')),
  complete boolean not null default false,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.ad_scan_observations (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.competitor_scan_runs(id) on delete cascade,
  competitor_id uuid not null references public.competitors(id) on delete cascade,
  ad_id uuid not null references public.ads(id) on delete cascade,
  facebook_library_id text not null,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (scan_id, competitor_id, facebook_library_id)
);

create table if not exists public.ad_variations (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid not null references public.ads(id) on delete cascade,
  competitor_id uuid not null references public.competitors(id) on delete cascade,
  facebook_library_id text not null,
  status text not null default 'unknown',
  start_date_text text,
  end_date_text text,
  platforms text[] not null default '{}',
  title text,
  body_text text,
  cta text,
  preview_html text,
  preview_text text,
  media_items jsonb not null default '[]'::jsonb,
  dedupe_key text not null,
  source_url text not null,
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (competitor_id, facebook_library_id)
);

create table if not exists public.ad_locations (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid not null references public.ads(id) on delete cascade,
  facebook_library_id text not null,
  location text not null,
  location_type text,
  visibility text,
  created_at timestamptz not null default now()
);

create index if not exists competitors_enabled_idx on public.competitors(enabled);
create index if not exists ads_competitor_idx on public.ads(competitor_id);
create index if not exists ads_last_seen_idx on public.ads(last_seen_at desc);
create index if not exists ads_status_idx on public.ads(status);
create index if not exists ads_platforms_idx on public.ads using gin(platforms);
create index if not exists competitor_scan_runs_competitor_finished_idx
  on public.competitor_scan_runs(competitor_id, finished_at desc);
create index if not exists ad_scan_observations_scan_idx on public.ad_scan_observations(scan_id);
create index if not exists ad_scan_observations_competitor_library_idx
  on public.ad_scan_observations(competitor_id, facebook_library_id);
create index if not exists ad_variations_ad_idx on public.ad_variations(ad_id);
create index if not exists ad_locations_ad_idx on public.ad_locations(ad_id);

alter table public.ads drop constraint if exists ads_competitor_id_dedupe_key_key;
alter table public.ads drop constraint if exists ads_competitor_facebook_library_id_key;
alter table public.ads add constraint ads_competitor_facebook_library_id_key
  unique (competitor_id, facebook_library_id);

alter table public.scrape_runs drop constraint if exists scrape_runs_status_check;
alter table public.scrape_runs add constraint scrape_runs_status_check
  check (status in ('pending', 'running', 'succeeded', 'failed', 'stopped'));

alter table public.ads add column if not exists media_items jsonb not null default '[]'::jsonb;
alter table public.ad_variations add column if not exists media_items jsonb not null default '[]'::jsonb;
alter table public.ads add column if not exists first_seen_scan_id uuid;
alter table public.ads add column if not exists last_seen_scan_id uuid;
alter table public.ads add column if not exists stopped_scan_id uuid;
alter table public.ads add column if not exists stopped_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ads_first_seen_scan_id_fkey'
      and conrelid = 'public.ads'::regclass
  ) then
    alter table public.ads
      add constraint ads_first_seen_scan_id_fkey
      foreign key (first_seen_scan_id) references public.competitor_scan_runs(id) on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'ads_last_seen_scan_id_fkey'
      and conrelid = 'public.ads'::regclass
  ) then
    alter table public.ads
      add constraint ads_last_seen_scan_id_fkey
      foreign key (last_seen_scan_id) references public.competitor_scan_runs(id) on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'ads_stopped_scan_id_fkey'
      and conrelid = 'public.ads'::regclass
  ) then
    alter table public.ads
      add constraint ads_stopped_scan_id_fkey
      foreign key (stopped_scan_id) references public.competitor_scan_runs(id) on delete set null;
  end if;
end $$;

alter table public.competitors enable row level security;
alter table public.scrape_runs enable row level security;
alter table public.ads enable row level security;
alter table public.competitor_scan_runs enable row level security;
alter table public.ad_scan_observations enable row level security;
alter table public.ad_variations enable row level security;
alter table public.ad_locations enable row level security;

drop policy if exists "local_mvp_competitors_all" on public.competitors;
drop policy if exists "local_mvp_scrape_runs_all" on public.scrape_runs;
drop policy if exists "local_mvp_ads_all" on public.ads;
drop policy if exists "local_mvp_competitor_scan_runs_all" on public.competitor_scan_runs;
drop policy if exists "local_mvp_ad_scan_observations_all" on public.ad_scan_observations;
drop policy if exists "local_mvp_ad_variations_all" on public.ad_variations;
drop policy if exists "local_mvp_ad_locations_all" on public.ad_locations;

-- MVP policy: the app is local and private. Tighten this before public deployment.
create policy "local_mvp_competitors_all" on public.competitors
  for all to anon, authenticated using (true) with check (true);

create policy "local_mvp_scrape_runs_all" on public.scrape_runs
  for all to anon, authenticated using (true) with check (true);

create policy "local_mvp_ads_all" on public.ads
  for all to anon, authenticated using (true) with check (true);

create policy "local_mvp_competitor_scan_runs_all" on public.competitor_scan_runs
  for all to anon, authenticated using (true) with check (true);

create policy "local_mvp_ad_scan_observations_all" on public.ad_scan_observations
  for all to anon, authenticated using (true) with check (true);

create policy "local_mvp_ad_variations_all" on public.ad_variations
  for all to anon, authenticated using (true) with check (true);

create policy "local_mvp_ad_locations_all" on public.ad_locations
  for all to anon, authenticated using (true) with check (true);

grant all on table public.competitor_scan_runs to anon, authenticated;
grant all on table public.ad_scan_observations to anon, authenticated;
