import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { env } from './env';
import { asyncRoute, errorHandler, routeParam } from './httpUtils';
import { logServer, readLogTail } from './logger';
import { scrapeJobManager } from './scrapeJobManager';

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const scrapeStartSchema = z.object({
  competitor_id: z.string().uuid().optional(),
  limit: z.number().int().positive().max(500).optional(),
  collect_carousels: z.boolean().optional()
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'scraper',
    scraper_headless: env.scraperHeadless,
    scraper_limit: env.scraperLimit,
    scraper_collect_carousels: env.scraperCollectCarousels,
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

app.use(errorHandler);

app.listen(env.scraperPort, () => {
  console.log(`Scraper API listening on http://localhost:${env.scraperPort}`);
  logServer('info', 'Scraper API started', { port: env.scraperPort, headless: env.scraperHeadless });
});
