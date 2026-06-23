import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { isAiAssessmentEnabled } from './aiAssessment';
import { aiAssessmentJobManager } from './aiAssessmentJobManager';
import { env } from './env';
import { asyncRoute, errorHandler, routeParam } from './httpUtils';
import { logServer, readLogTail } from './logger';
import { isProxyEnabled } from './proxy';
import { scrapeJobManager } from './scrapeJobManager';

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const scrapeStartSchema = z.object({
  competitor_id: z.string().uuid().optional(),
  competitor_ids: z.array(z.string().uuid()).min(1).max(500).optional(),
  limit: z.number().int().positive().max(500).optional(),
  collect_carousels: z.boolean().optional()
});

const assessStartSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500)
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'scraper',
    scraper_headless: env.scraperHeadless,
    scraper_limit: env.scraperLimit,
    scraper_collect_carousels: env.scraperCollectCarousels,
    ai_assessment_enabled: isAiAssessmentEnabled(),
    ai_assessment_force: env.aiAssessmentForce,
    proxy_enabled: isProxyEnabled(),
    active_jobs: scrapeJobManager.list().filter((job) => job.status === 'running').length
  });
});

app.get(
  '/api/logs/:name',
  asyncRoute(async (req, res) => {
    const name = routeParam(req.params.name);
    if (name !== 'scraper' && name !== 'server') {
      res.status(404).json({ error: 'Unknown log name' });
      return;
    }

    const rawLines = Number(req.query.lines ?? 200);
    res.json({ name, lines: await readLogTail(name, Number.isFinite(rawLines) ? rawLines : 200) });
  })
);

app.get(
  '/api/runs',
  asyncRoute(async (_req, res) => {
    res.json({ active: scrapeJobManager.list() });
  })
);

app.post(
  '/api/scrape',
  asyncRoute(async (req, res) => {
    const input = scrapeStartSchema.parse(req.body ?? {});
    res.status(202).json(
      await scrapeJobManager.start({
        competitorId: input.competitor_id,
        competitorIds: input.competitor_ids,
        limit: input.limit,
        collectCarousels: input.collect_carousels
      })
    );
  })
);

app.get('/api/jobs/:runId', (req, res) => {
  const job = scrapeJobManager.get(routeParam(req.params.runId));
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

app.post('/api/jobs/:runId/stop', (req, res) => {
  const job = scrapeJobManager.stop(routeParam(req.params.runId));
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

// On-demand AI assessment of a hand-picked set of ad ids (selection toolbar). Runs as a polled
// job because assessing many creatives via OpenAI is slow. Re-assesses everything asked for,
// including duplicates that the scrape-time pass deliberately skips.
app.post(
  '/api/assess',
  asyncRoute(async (req, res) => {
    const { ids } = assessStartSchema.parse(req.body ?? {});
    if (!isAiAssessmentEnabled()) {
      res.status(400).json({ error: 'AI-анализ выключен или не задан OPENAI_KEY' });
      return;
    }
    res.status(202).json(aiAssessmentJobManager.start(ids));
  })
);

app.get('/api/assess/:jobId', (req, res) => {
  const job = aiAssessmentJobManager.get(routeParam(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

app.use(errorHandler);

app.listen(env.scraperPort, () => {
  console.log(`Scraper API listening on http://localhost:${env.scraperPort}`);
  logServer('info', 'Scraper API started', {
    port: env.scraperPort,
    headless: env.scraperHeadless,
    proxy_enabled: isProxyEnabled()
  });
});
