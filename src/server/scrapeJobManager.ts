import type { Competitor, ScrapeJobSnapshot } from '../shared/types';
import {
  createScrapeRun,
  getCompetitor,
  listEnabledCompetitors,
  markCompetitorScraped,
  updateScrapeRun,
  upsertScrapedAd
} from './repositories';
import { env } from './env';
import { logScraper } from './logger';
import { FacebookAdLibraryScraper } from './scraper/facebookAdLibraryScraper';

export class ScrapeJobManager {
  private readonly jobs = new Map<string, ScrapeJobSnapshot>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly scraper = new FacebookAdLibraryScraper();

  async start(input: { competitorId?: string; limit?: number }) {
    const competitors = await this.resolveCompetitors(input.competitorId);
    const runLimit = Math.max(1, input.limit ?? env.scraperLimit);
    const run = await createScrapeRun(input.competitorId ?? null);
    const controller = new AbortController();
    const snapshot: ScrapeJobSnapshot = {
      run_id: run.id,
      status: 'running',
      message: `Запущен сбор: ${competitors.length} конкурент(ов)`,
      started_at: new Date().toISOString(),
      ads_found: 0,
      ads_saved: 0,
      duplicates_found: 0,
      limit: runLimit,
      limit_reached: false,
      errors: []
    };
    this.jobs.set(run.id, snapshot);
    this.controllers.set(run.id, controller);
    logScraper('info', 'Scrape run started', {
      run_id: run.id,
      competitors: competitors.map((competitor) => competitor.name),
      limit: runLimit
    });

    void this.run(run.id, competitors, controller, runLimit).catch((error) => {
      const current = this.jobs.get(run.id);
      const message = error instanceof Error ? error.message : String(error);
      logScraper('error', 'Scrape run crashed', { run_id: run.id, error: message });
      if (current) {
        this.jobs.set(run.id, {
          ...current,
          status: 'failed',
          message: 'Сбор остановился с ошибкой',
          finished_at: new Date().toISOString(),
          errors: [...current.errors, message]
        });
      }
    });

    return snapshot;
  }

  stop(runId: string) {
    const current = this.jobs.get(runId);
    if (!current) return null;

    const controller = this.controllers.get(runId);
    if (current.status !== 'running') return current;

    controller?.abort();
    const stopped = this.patch(runId, { message: 'Остановка запрошена. Сохраняю уже успешно собранное.' });
    logScraper('warn', 'Scrape stop requested', { run_id: runId });
    return stopped;
  }

  get(runId: string) {
    return this.jobs.get(runId) ?? null;
  }

  list() {
    return Array.from(this.jobs.values()).sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  private async resolveCompetitors(competitorId?: string) {
    if (competitorId) {
      return [await getCompetitor(competitorId)];
    }
    const competitors = await listEnabledCompetitors();
    if (!competitors.length) {
      throw new Error('Нет включенных конкурентов для сбора');
    }
    return competitors;
  }

  private async run(runId: string, competitors: Competitor[], controller: AbortController, limit: number) {
    const snapshot = this.jobs.get(runId);
    if (!snapshot) return;

    let adsFound = 0;
    let adsSaved = 0;
    let duplicatesFound = 0;
    let limitReached = false;
    const errors: string[] = [];

    for (const competitor of competitors) {
      if (limitReached) break;
      if (controller.signal.aborted) break;
      this.patch(runId, { message: `Собираю ${competitor.name}` });
      logScraper('info', 'Competitor scrape started', {
        run_id: runId,
        competitor: competitor.name,
        page_id: competitor.facebook_page_id
      });
      try {
        const result = await this.scraper.scrapeCompetitor(competitor, {
          limit: Math.max(1, limit - adsSaved),
          signal: controller.signal,
          onAd: async (ad) => {
            if (limitReached) return;
            adsFound += 1;
            try {
              const saved = await upsertScrapedAd(ad);
              adsSaved += 1;
              if (saved.isDuplicate) duplicatesFound += 1;
              logScraper('info', 'Ad saved', {
                run_id: runId,
                competitor: competitor.name,
                library_id: ad.facebook_library_id,
                duplicate: saved.isDuplicate
              });
              this.patch(runId, { ads_found: adsFound, ads_saved: adsSaved, duplicates_found: duplicatesFound });
              if (adsSaved >= limit) {
                limitReached = true;
                logScraper('info', 'Scrape limit reached', {
                  run_id: runId,
                  limit,
                  ads_saved: adsSaved
                });
                controller.abort();
              }
            } catch (error) {
              const message = `${competitor.name} / ${ad.facebook_library_id}: ${
                error instanceof Error ? error.message : String(error)
              }`;
              errors.push(message);
              logScraper('error', 'Ad save failed', { run_id: runId, error: message });
            }
          }
        });
        errors.push(...result.errors.map((error) => `${competitor.name}: ${error}`));
        logScraper('info', 'Competitor scrape extracted ads', {
          run_id: runId,
          competitor: competitor.name,
          extracted_ads: result.ads.length,
          extractor_errors: result.errors.length
        });

        if (!controller.signal.aborted) {
          await markCompetitorScraped(competitor.id);
        }
      } catch (error) {
        if (limitReached) break;
        const message = controller.signal.aborted
          ? `${competitor.name}: остановлено пользователем`
          : `${competitor.name}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        logScraper(controller.signal.aborted ? 'warn' : 'error', 'Competitor scrape failed', { run_id: runId, error: message });
      }
    }

    const status = limitReached
      ? 'succeeded'
      : controller.signal.aborted
        ? 'stopped'
        : errors.length && adsSaved === 0
          ? 'failed'
          : 'succeeded';
    const finishedAt = new Date().toISOString();
    const errorSummary = errors.length ? errors.slice(0, 20).join('\n') : null;

    await updateScrapeRun(runId, {
      status,
      finished_at: finishedAt,
      ads_found: adsFound,
      ads_saved: adsSaved,
      duplicates_found: duplicatesFound,
      error_summary: errorSummary
    }).catch(() => undefined);

    this.patch(runId, {
      status,
      message:
        limitReached
          ? `Сбор завершен по лимиту: ${adsSaved}/${limit}`
          : status === 'stopped'
          ? 'Сбор остановлен. Успешно собранное сохранено.'
          : status === 'succeeded'
            ? 'Сбор завершен'
            : 'Сбор завершился с ошибками',
      finished_at: finishedAt,
      ads_found: adsFound,
      ads_saved: adsSaved,
      limit,
      limit_reached: limitReached,
      duplicates_found: duplicatesFound,
      errors
    });
    logScraper(status === 'succeeded' ? 'info' : status === 'stopped' ? 'warn' : 'error', 'Scrape run finished', {
      run_id: runId,
      status,
      ads_found: adsFound,
      ads_saved: adsSaved,
      duplicates_found: duplicatesFound,
      errors: errors.length
    });
    this.controllers.delete(runId);
  }

  private patch(runId: string, patch: Partial<ScrapeJobSnapshot>) {
    const current = this.jobs.get(runId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.jobs.set(runId, next);
    return next;
  }
}

export const scrapeJobManager = new ScrapeJobManager();
