import type { Ad, Competitor, ScrapeJobSnapshot, ScrapedAdInput } from '../shared/types';
import {
  assessAdCreative,
  imageUrlsFromMediaItems,
  isAiAssessmentEnabled,
  mediaContainsVideo,
  videoPlaceholderAssessment,
  type AdCreativeContext
} from './aiAssessment';
import {
  createCompetitorScanRun,
  createScrapeRun,
  finishCompetitorScan,
  getCompetitor,
  listCompetitorCanonicalImages,
  listEnabledCompetitors,
  markAdAsDuplicate,
  markCompetitorScraped,
  recordAdScanObservation,
  repointDuplicates,
  setAdImageFingerprint,
  updateAdAssessment,
  updateScrapeRun,
  upsertScrapedAd
} from './repositories';
import { env } from './env';
import { adRunDays, computeImageFingerprint, downloadImageBuffer, isImageDuplicate, primaryImageUrl } from './imageDedup';
import { logScraper } from './logger';
import { FacebookAdLibraryScraper } from './scraper/facebookAdLibraryScraper';

// In-memory canonical fingerprint tracked during a competitor's scan (mirrors DB canonicals).
type DedupCanonical = { id: string; phash: string; aspect: number; runDays: number; locked: boolean };

function upsertCanonical(list: DedupCanonical[], entry: DedupCanonical) {
  const index = list.findIndex((item) => item.id === entry.id);
  if (index >= 0) list[index] = entry;
  else list.push(entry);
}

// Promotion: the old canonical is demoted to a duplicate, so drop it from the live set and
// put the new (longer-running) canonical in its place.
function replaceCanonical(list: DedupCanonical[], oldId: string, entry: DedupCanonical) {
  const filtered = list.filter((item) => item.id !== oldId && item.id !== entry.id);
  filtered.push(entry);
  list.length = 0;
  list.push(...filtered);
}

export class ScrapeJobManager {
  private readonly jobs = new Map<string, ScrapeJobSnapshot>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly scraper = new FacebookAdLibraryScraper();

  async start(input: { competitorId?: string; limit?: number; collectCarousels?: boolean }) {
    // One run at a time: the scraper shares a single persistent browser profile, so a second
    // concurrent run would collide on the profile lock. Re-attach to the in-progress run instead
    // of starting another. Guards the API for direct callers / multiple devices, not just the UI.
    const activeJob = this.list().find((job) => job.status === 'running');
    if (activeJob) {
      logScraper('warn', 'Scrape start ignored — a run is already in progress', {
        active_run_id: activeJob.run_id
      });
      return activeJob;
    }
    const competitors = await this.resolveCompetitors(input.competitorId);
    const runLimit = Math.max(1, input.limit ?? env.scraperLimit);
    const collectCarousels = input.collectCarousels ?? env.scraperCollectCarousels;
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
      collect_carousels: collectCarousels,
      errors: []
    };
    this.jobs.set(run.id, snapshot);
    this.controllers.set(run.id, controller);
    logScraper('info', 'Scrape run started', {
      run_id: run.id,
      competitors: competitors.map((competitor) => competitor.name),
      limit: runLimit,
      collect_carousels: collectCarousels
    });

    void this.run(run.id, competitors, controller, runLimit, collectCarousels).catch((error) => {
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

  private async run(
    runId: string,
    competitors: Competitor[],
    controller: AbortController,
    limit: number,
    collectCarousels: boolean
  ) {
    const snapshot = this.jobs.get(runId);
    if (!snapshot) return;

    let adsFound = 0;
    let adsSaved = 0;
    let dupsHidden = 0;
    let limitReached = false;
    let aiQueued = 0;
    let aiChain: Promise<void> = Promise.resolve();
    const errors: string[] = [];

    for (const competitor of competitors) {
      if (limitReached) break;
      if (controller.signal.aborted) break;
      const competitorScan = await createCompetitorScanRun(runId, competitor.id);
      let competitorSaveErrors = 0;
      this.patch(runId, { message: `Собираю ${competitor.name}` });
      logScraper('info', 'Competitor scrape started', {
        run_id: runId,
        scan_id: competitorScan.id,
        competitor: competitor.name,
        page_id: competitor.facebook_page_id
      });
      try {
        const canonicals = await this.loadCompetitorCanonicals(competitor.id);
        const result = await this.scraper.scrapeCompetitor(competitor, {
          limit: Math.max(1, limit - adsSaved),
          collectCarousels,
          signal: controller.signal,
          onAd: async (ad) => {
            if (limitReached) return;
            adsFound += 1;
            try {
              const saved = await upsertScrapedAd(ad);
              await recordAdScanObservation({
                scanId: competitorScan.id,
                competitorId: competitor.id,
                adId: saved.ad.id,
                facebookLibraryId: ad.facebook_library_id
              });
              adsSaved += 1;
              logScraper('info', 'Ad saved', {
                run_id: runId,
                scan_id: competitorScan.id,
                competitor: competitor.name,
                library_id: ad.facebook_library_id,
                existing: saved.isExisting
              });
              const duplicateOf = await this.resolveImageDuplicate(saved.ad, ad, canonicals, runId, competitor.name);
              if (duplicateOf) dupsHidden += 1;
              // Duplicates are hidden and skip AI entirely — only the kept (canonical) creative is assessed.
              const aiEligible =
                !duplicateOf && isAiAssessmentEnabled() && (env.aiAssessmentForce || !saved.ad.ai_assessed_at);
              logScraper('info', 'AI assessment decision', {
                run_id: runId,
                library_id: ad.facebook_library_id,
                enabled: isAiAssessmentEnabled(),
                force: env.aiAssessmentForce,
                already_assessed: Boolean(saved.ad.ai_assessed_at),
                is_duplicate: Boolean(duplicateOf),
                queued: aiEligible
              });
              if (aiEligible) {
                const adId = saved.ad.id;
                const libraryId = ad.facebook_library_id;
                const mediaItems = ad.media_items ?? [];
                const context: AdCreativeContext = {
                  companyName: competitor.name,
                  title: ad.title ?? null,
                  bodyText: ad.body_text ?? ad.preview_text ?? null,
                  cta: ad.cta ?? null
                };
                aiQueued += 1;
                aiChain = aiChain.then(() => this.assessSavedAd(runId, adId, libraryId, mediaItems, context));
              }
              this.patch(runId, { ads_found: adsFound, ads_saved: adsSaved, duplicates_found: dupsHidden });
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
              competitorSaveErrors += 1;
              const message = `${competitor.name} / ${ad.facebook_library_id}: ${
                error instanceof Error ? error.message : String(error)
              }`;
              errors.push(message);
              logScraper('error', 'Ad save failed', { run_id: runId, error: message });
            }
          }
        });
        errors.push(...result.errors.map((error) => `${competitor.name}: ${error}`));
        const competitorComplete =
          !controller.signal.aborted && !limitReached && result.errors.length === 0 && competitorSaveErrors === 0;
        const competitorScanStatus = competitorComplete
          ? 'succeeded'
          : controller.signal.aborted || limitReached
            ? 'stopped'
            : 'failed';
        const { reconciliation } = await finishCompetitorScan({
          scanId: competitorScan.id,
          status: competitorScanStatus,
          complete: competitorComplete
        });
        logScraper('info', 'Competitor scrape extracted ads', {
          run_id: runId,
          scan_id: competitorScan.id,
          competitor: competitor.name,
          extracted_ads: result.ads.length,
          extractor_errors: result.errors.length,
          save_errors: competitorSaveErrors,
          scan_complete: competitorComplete,
          active_ads: reconciliation.activeIds.length,
          new_ads: reconciliation.newIds.length,
          stopped_ads: reconciliation.stoppedIds.length
        });

        if (competitorComplete) {
          await markCompetitorScraped(competitor.id);
        }
      } catch (error) {
        await finishCompetitorScan({
          scanId: competitorScan.id,
          status: controller.signal.aborted || limitReached ? 'stopped' : 'failed',
          complete: false
        }).catch(() => undefined);
        if (limitReached) break;
        const message = controller.signal.aborted
          ? `${competitor.name}: остановлено пользователем`
          : `${competitor.name}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        logScraper(controller.signal.aborted ? 'warn' : 'error', 'Competitor scrape failed', { run_id: runId, error: message });
      }
    }

    if (aiQueued > 0) {
      this.patch(runId, { message: `Жду завершения AI-анализа креативов (${aiQueued})` });
      await aiChain;
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
      duplicates_found: dupsHidden,
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
      collect_carousels: collectCarousels,
      duplicates_found: dupsHidden,
      errors
    });
    logScraper(status === 'succeeded' ? 'info' : status === 'stopped' ? 'warn' : 'error', 'Scrape run finished', {
      run_id: runId,
      status,
      ads_found: adsFound,
      ads_saved: adsSaved,
      duplicates_found: 0,
      errors: errors.length
    });
    this.controllers.delete(runId);
  }

  private async loadCompetitorCanonicals(competitorId: string): Promise<DedupCanonical[]> {
    try {
      const rows = await listCompetitorCanonicalImages(competitorId);
      return rows
        .filter((row) => row.image_phash && row.image_aspect)
        .map((row) => ({
          id: row.id,
          phash: row.image_phash as string,
          aspect: row.image_aspect as number,
          runDays: adRunDays(row),
          locked: row.dedup_locked
        }));
    } catch (error) {
      logScraper('warn', 'Image dedup: failed to load canonicals', {
        competitor_id: competitorId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  // Returns the canonical ad id when `savedAd` is a duplicate (already hidden + linked in DB),
  // or null when it's the canonical/unique creative (so AI may run). Mutates `canonicals` so the
  // rest of the competitor's scan dedups against the up-to-date set. Best-effort: any failure
  // downloading/hashing falls back to "not a duplicate" so the scrape never breaks on dedup.
  private async resolveImageDuplicate(
    savedAd: Ad,
    scraped: ScrapedAdInput,
    canonicals: DedupCanonical[],
    runId: string,
    competitorName: string
  ): Promise<string | null> {
    const imageUrl = primaryImageUrl(scraped.media_items);
    if (!imageUrl) return null; // videos / no image — not deduped

    const buffer = await downloadImageBuffer(imageUrl);
    if (!buffer) return null;
    const fingerprint = await computeImageFingerprint(buffer);
    if (!fingerprint) return null;

    await setAdImageFingerprint(savedAd.id, fingerprint.phash, fingerprint.aspect).catch(() => undefined);

    const self: DedupCanonical = {
      id: savedAd.id,
      phash: fingerprint.phash,
      aspect: fingerprint.aspect,
      runDays: adRunDays(savedAd),
      locked: savedAd.dedup_locked
    };

    const match = canonicals.find((candidate) => candidate.id !== savedAd.id && isImageDuplicate(fingerprint, candidate));

    // No match, or this ad is user-locked as visible → it's (stays) a canonical, never hidden.
    if (!match || savedAd.dedup_locked) {
      upsertCanonical(canonicals, self);
      return null;
    }

    // Longer-running than a non-locked canonical → promote this, demote the old one.
    if (!match.locked && self.runDays > match.runDays) {
      await markAdAsDuplicate(match.id, savedAd.id);
      await repointDuplicates(match.id, savedAd.id);
      replaceCanonical(canonicals, match.id, self);
      logScraper('info', 'Image dedup: kept longer-running creative', {
        run_id: runId,
        competitor: competitorName,
        kept: savedAd.facebook_library_id,
        hidden_ad_id: match.id
      });
      return null;
    }

    // Otherwise this is the duplicate: hide it and skip AI.
    await markAdAsDuplicate(savedAd.id, match.id);
    logScraper('info', 'Image dedup: hidden as duplicate', {
      run_id: runId,
      competitor: competitorName,
      library_id: savedAd.facebook_library_id,
      duplicate_of: match.id
    });
    return match.id;
  }

  private async assessSavedAd(
    runId: string,
    adId: string,
    libraryId: string,
    mediaItems: Parameters<typeof imageUrlsFromMediaItems>[0],
    context: AdCreativeContext
  ) {
    if (mediaContainsVideo(mediaItems)) {
      try {
        await updateAdAssessment(adId, videoPlaceholderAssessment());
        logScraper('info', 'AI assessment: video creative marked as «Видео»', {
          run_id: runId,
          library_id: libraryId
        });
      } catch (error) {
        logScraper('error', 'AI assessment failed', {
          run_id: runId,
          library_id: libraryId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    const imageUrls = imageUrlsFromMediaItems(mediaItems);
    if (!imageUrls.length) {
      logScraper('warn', 'AI assessment skipped: no image urls', { run_id: runId, library_id: libraryId });
      return;
    }

    try {
      const assessment = await assessAdCreative({ imageUrls, context });
      await updateAdAssessment(adId, assessment);
      logScraper('info', 'AI assessment saved', {
        run_id: runId,
        library_id: libraryId,
        images: imageUrls.length,
        model: env.openaiModel
      });
    } catch (error) {
      logScraper('error', 'AI assessment failed', {
        run_id: runId,
        library_id: libraryId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
