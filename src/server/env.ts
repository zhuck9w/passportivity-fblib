import dotenv from 'dotenv';

dotenv.config();

function readRequired(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readOptional(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readBoolean(name: string, fallback: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

const defaultScraperLimit = readNumber('SCRAPER_MAX_ADS', 25);

const serverKey =
  process.env.SUPABASE_SECRET_KEY?.trim() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  process.env.SUPABASE_SERVICE_KEY?.trim() ||
  process.env.SECRET?.trim() ||
  process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

if (!serverKey) {
  throw new Error('Missing Supabase backend key. Set SUPABASE_SECRET_KEY or SUPABASE_PUBLISHABLE_KEY.');
}

export const env = {
  port: readNumber('PORT', 4000),
  scraperPort: readNumber('SCRAPER_PORT', 4001),
  supabaseUrl: readRequired('SUPABASE_URL'),
  supabasePublishableKey: readRequired('SUPABASE_PUBLISHABLE_KEY'),
  supabaseServerKey: serverKey,
  usingPublishableKeyForServer: serverKey === process.env.SUPABASE_PUBLISHABLE_KEY?.trim(),
  scraperHeadless: (process.env.SCRAPER_HEADLESS ?? 'false').toLowerCase() === 'true',
  // Outbound proxy for FB + OpenAI traffic (see src/server/proxy.ts). Unset = no proxy.
  proxyUrl: readOptional('PROXY_URL'),
  scraperBrowserChannel: readOptional('SCRAPER_BROWSER_CHANNEL'),
  scraperUserDataDir: readOptional('SCRAPER_USER_DATA_DIR'),
  scraperSlowMoMs: readNumber('SCRAPER_SLOW_MO_MS', 0),
  scraperLimit: readNumber('SCRAPER_LIMIT', defaultScraperLimit),
  scraperCollectCarousels: readBoolean('SCRAPER_COLLECT_CAROUSELS', true),
  openaiKey: readOptional('OPENAI_KEY') ?? readOptional('OPENAI_API_KEY'),
  openaiModel: readOptional('OPENAI_MODEL') ?? 'gpt-4o-mini',
  aiAssessmentEnabled: readBoolean('AI_ASSESSMENT_ENABLED', true),
  // Force re-assessment of already assessed ads (e.g. after changing the model or prompts).
  // Deliberately env-only, not exposed in the UI.
  aiAssessmentForce: readBoolean('AI_ASSESSMENT_FORCE', false),
  scraperMaxAds: defaultScraperLimit,
  scraperMaxScrolls: readNumber('SCRAPER_MAX_SCROLLS', 12),
  // How many consecutive "no new cards" scroll rounds counts as "reached the end" of a
  // competitor's results, and the pause (ms) between scroll steps. Raise the pause if a slow
  // proxy makes Facebook load cards slower than this, which would otherwise stop collection early.
  scraperScrollStableRounds: readNumber('SCRAPER_SCROLL_STABLE_ROUNDS', 2),
  scraperScrollPauseMs: readNumber('SCRAPER_SCROLL_PAUSE_MS', 1200),
  // Max ads the interface API returns to the dashboard per query. Supabase also caps this at
  // the project's "Max rows" setting (default 1000).
  adsFetchLimit: readNumber('ADS_FETCH_LIMIT', 1000),
  scraperNavigationTimeoutMs: readNumber('SCRAPER_NAVIGATION_TIMEOUT_MS', 45000),
  scraperActionTimeoutMs: readNumber('SCRAPER_ACTION_TIMEOUT_MS', 12000),
  // How long to wait for an opened card's detail/group panel to render before we give up and
  // save the ad from its result-card snapshot instead. The old hard-coded 1200ms was too tight
  // on a slow proxy: FB hadn't painted the detail panel yet, so the card was dropped with an
  // error and the whole competitor scan was marked incomplete (which blocks status reconciliation).
  scraperDetailWaitMs: readNumber('SCRAPER_DETAIL_WAIT_MS', 4000)
};
