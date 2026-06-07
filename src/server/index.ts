import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from './env';
import { logServer, readLogTail } from './logger';
import {
  createCompetitor,
  deleteCompetitor,
  getAd,
  listAds,
  listCompetitors,
  listScrapeRuns,
  updateCompetitor
} from './repositories';
import { scrapeJobManager } from './scrapeJobManager';

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const competitorCreateSchema = z.object({
  name: z.string().trim().min(1),
  facebook_page_id: z.string().trim().regex(/^\d+$/),
  enabled: z.boolean().optional(),
  notes: z.string().trim().nullable().optional()
});

const competitorUpdateSchema = competitorCreateSchema.partial();

const scrapeStartSchema = z.object({
  competitor_id: z.string().uuid().optional(),
  limit: z.number().int().positive().max(500).optional()
});

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : (value ?? '');
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    using_publishable_key_for_server: env.usingPublishableKeyForServer,
    scraper_headless: env.scraperHeadless,
    scraper_limit: env.scraperLimit
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
  '/api/competitors',
  asyncRoute(async (_req, res) => {
    res.json(await listCompetitors());
  })
);

app.post(
  '/api/competitors',
  asyncRoute(async (req, res) => {
    const input = competitorCreateSchema.parse(req.body);
    res.status(201).json(await createCompetitor(input));
  })
);

app.patch(
  '/api/competitors/:id',
  asyncRoute(async (req, res) => {
    const input = competitorUpdateSchema.parse(req.body);
    res.json(await updateCompetitor(routeParam(req.params.id), input));
  })
);

app.delete(
  '/api/competitors/:id',
  asyncRoute(async (req, res) => {
    await deleteCompetitor(routeParam(req.params.id));
    res.status(204).end();
  })
);

app.get(
  '/api/ads',
  asyncRoute(async (req, res) => {
    res.json(
      await listAds({
        competitorId: String(req.query.competitor_id ?? '') || undefined,
        status: String(req.query.status ?? '') || undefined,
        platform: String(req.query.platform ?? '') || undefined,
        q: String(req.query.q ?? '') || undefined
      })
    );
  })
);

app.get(
  '/api/ads/:id',
  asyncRoute(async (req, res) => {
    res.json(await getAd(routeParam(req.params.id)));
  })
);

app.get(
  '/api/runs',
  asyncRoute(async (_req, res) => {
    res.json({
      persisted: await listScrapeRuns(),
      active: scrapeJobManager.list()
    });
  })
);

app.post(
  '/api/scrape',
  asyncRoute(async (req, res) => {
    const input = scrapeStartSchema.parse(req.body ?? {});
    res.status(202).json(await scrapeJobManager.start({ competitorId: input.competitor_id, limit: input.limit }));
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

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Validation error', details: error.issues });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  logServer('error', 'Request failed', { message });
  res.status(500).json({ error: message });
});

app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
  logServer('info', 'API started', {
    port: env.port,
    using_publishable_key_for_server: env.usingPublishableKeyForServer
  });
});
