import { randomUUID } from 'node:crypto';
import type { AiAssessmentJobSnapshot } from '../shared/types';
import {
  assessAdCreative,
  imageUrlsFromMediaItems,
  isAiAssessmentEnabled,
  mediaContainsVideo,
  videoPlaceholderAssessment,
  type AdCreativeContext
} from './aiAssessment';
import { logScraper } from './logger';
import { listAdsForAssessment, updateAdAssessment } from './repositories';

// On-demand, in-memory AI assessment runner for a hand-picked set of creatives (the selection
// toolbar in the dashboard). Mirrors how scrape-time AI works, with two deliberate differences:
//   - it ALWAYS re-assesses every id asked for, ignoring the duplicate / already-assessed gates
//     (that gate is exactly why duplicates currently have no assessment);
//   - it runs in its own job so the UI can poll progress instead of holding one long HTTP request.
const MAX_CONCURRENCY = 3;
const MAX_TRACKED_ERRORS = 50;

class AiAssessmentJobManager {
  private readonly jobs = new Map<string, AiAssessmentJobSnapshot>();

  start(ids: string[]): AiAssessmentJobSnapshot {
    const jobId = randomUUID();
    const snapshot: AiAssessmentJobSnapshot = {
      job_id: jobId,
      status: 'running',
      total: ids.length,
      done: 0,
      assessed: 0,
      skipped: 0,
      failed: 0,
      message: `Анализирую ${ids.length} креатив(ов)…`,
      errors: []
    };
    this.jobs.set(jobId, snapshot);
    logScraper('info', 'Bulk AI assessment started', { job_id: jobId, total: ids.length });
    void this.run(snapshot, ids).catch((error) => {
      snapshot.status = 'failed';
      snapshot.message = 'AI-анализ остановился с ошибкой';
      snapshot.errors.push(error instanceof Error ? error.message : String(error));
      logScraper('error', 'Bulk AI assessment crashed', { job_id: jobId, error: snapshot.errors.at(-1) });
    });
    return snapshot;
  }

  get(jobId: string) {
    return this.jobs.get(jobId) ?? null;
  }

  private async run(snapshot: AiAssessmentJobSnapshot, ids: string[]) {
    if (!isAiAssessmentEnabled()) {
      snapshot.status = 'failed';
      snapshot.message = 'AI-анализ выключен или не задан OPENAI_KEY';
      return;
    }

    const ads = await listAdsForAssessment(ids);
    const adById = new Map(ads.map((ad) => [ad.id, ad]));
    const queue = ids.filter((id) => adById.has(id));
    // ids that no longer exist in the DB (deleted between selection and run) — count as skipped.
    const missing = ids.length - queue.length;
    snapshot.skipped += missing;
    snapshot.done += missing;

    let cursor = 0;
    const worker = async () => {
      // cursor read+increment is atomic here (no await between), so workers never collide.
      while (cursor < queue.length) {
        const ad = adById.get(queue[cursor])!;
        cursor += 1;
        try {
          const mediaItems = ad.media_items ?? [];
          if (mediaContainsVideo(mediaItems)) {
            await updateAdAssessment(ad.id, videoPlaceholderAssessment());
            snapshot.assessed += 1;
          } else {
            const imageUrls = imageUrlsFromMediaItems(mediaItems);
            if (!imageUrls.length) {
              snapshot.skipped += 1;
            } else {
              const context: AdCreativeContext = {
                companyName: ad.competitor_name,
                title: ad.title,
                bodyText: ad.body_text ?? ad.preview_text,
                cta: ad.cta
              };
              const assessment = await assessAdCreative({ imageUrls, context });
              await updateAdAssessment(ad.id, assessment);
              snapshot.assessed += 1;
            }
          }
        } catch (error) {
          snapshot.failed += 1;
          const message = `${ad.facebook_library_id || ad.id}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          if (snapshot.errors.length < MAX_TRACKED_ERRORS) snapshot.errors.push(message);
          logScraper('error', 'Bulk AI assessment failed for creative', { job_id: snapshot.job_id, error: message });
        } finally {
          snapshot.done += 1;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) || 1 }, () => worker()));

    snapshot.status = snapshot.failed > 0 && snapshot.assessed === 0 ? 'failed' : 'succeeded';
    snapshot.message = `Готово: проанализировано ${snapshot.assessed}, пропущено ${snapshot.skipped}, с ошибкой ${snapshot.failed}`;
    logScraper('info', 'Bulk AI assessment finished', {
      job_id: snapshot.job_id,
      assessed: snapshot.assessed,
      skipped: snapshot.skipped,
      failed: snapshot.failed
    });
  }
}

export const aiAssessmentJobManager = new AiAssessmentJobManager();
