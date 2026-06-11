import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { env } from './env';
import { asyncRoute, errorHandler, routeParam } from './httpUtils';
import { logServer } from './logger';
import {
  bulkCreateCompetitors,
  createCompetitor,
  deleteCompetitor,
  getAd,
  listAdLocations,
  listAds,
  listCompetitors,
  listScrapeRuns,
  setAdHidden,
  updateCompetitor
} from './repositories';

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const competitorCreateSchema = z.object({
  name: z.string().trim().min(1),
  facebook_page_id: z.string().trim().regex(/^\d+$/),
  enabled: z.boolean().optional(),
  visible: z.boolean().optional(),
  notes: z.string().trim().nullable().optional()
});

const competitorUpdateSchema = competitorCreateSchema.partial();

const competitorBulkSchema = z.object({
  items: z.array(competitorCreateSchema).min(1).max(500)
});

const adUpdateSchema = z.object({
  hidden: z.boolean()
});

const adLocationsSchema = z.object({
  ids: z.array(z.string().uuid()).max(500)
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'interface',
    using_publishable_key_for_server: env.usingPublishableKeyForServer
  });
});

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

app.post(
  '/api/competitors/bulk',
  asyncRoute(async (req, res) => {
    const { items } = competitorBulkSchema.parse(req.body);
    res.status(201).json(await bulkCreateCompetitors(items));
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
    const competitorIds = String(req.query.competitor_ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    res.json(
      await listAds({
        competitorIds: competitorIds.length ? competitorIds : undefined,
        status: String(req.query.status ?? '') || undefined,
        platform: String(req.query.platform ?? '') || undefined,
        q: String(req.query.q ?? '') || undefined
      })
    );
  })
);

app.post(
  '/api/ad-locations',
  asyncRoute(async (req, res) => {
    const { ids } = adLocationsSchema.parse(req.body ?? {});
    res.json(await listAdLocations(ids));
  })
);

app.get(
  '/api/ads/:id',
  asyncRoute(async (req, res) => {
    res.json(await getAd(routeParam(req.params.id)));
  })
);

app.patch(
  '/api/ads/:id',
  asyncRoute(async (req, res) => {
    const input = adUpdateSchema.parse(req.body);
    res.json(await setAdHidden(routeParam(req.params.id), input.hidden));
  })
);

app.get(
  '/api/runs',
  asyncRoute(async (_req, res) => {
    res.json({ persisted: await listScrapeRuns() });
  })
);

app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`Interface API listening on http://localhost:${env.port}`);
  logServer('info', 'Interface API started', {
    port: env.port,
    using_publishable_key_for_server: env.usingPublishableKeyForServer
  });
});
