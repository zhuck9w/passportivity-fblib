import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { env } from './env';
import { asyncRoute, errorHandler, routeParam } from './httpUtils';
import { logServer } from './logger';
import { isProxyEnabled, proxiedFetch } from './proxy';
import {
  bulkCreateCompetitors,
  bulkSetAdHidden,
  bulkSetCompetitorsEnabled,
  createCompetitor,
  deleteCompetitor,
  getAd,
  listAdLocations,
  listAds,
  listCompetitors,
  listScrapeRuns,
  setAdHidden,
  unmarkAdDuplicate,
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

const competitorBulkEnabledSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000),
  enabled: z.boolean()
});

const adUpdateSchema = z.object({
  hidden: z.boolean()
});

const adBulkHiddenSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000),
  hidden: z.boolean()
});

const adLocationsSchema = z.object({
  ids: z.array(z.string().uuid()).max(500)
});

// Image proxy: the table previews live on Facebook's CDN, which doesn't send CORS
// headers, so the browser can't read their bytes for the Excel export. We fetch them
// server-side (no CORS) and serve them same-origin. Host allowlist guards against SSRF.
const allowedImageHostSuffixes = ['fbcdn.net', 'facebook.com', 'cdninstagram.com'];
const maxProxyImageBytes = 20 * 1024 * 1024;

function isAllowedImageHost(hostname: string) {
  return allowedImageHostSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

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

app.post(
  '/api/competitors/bulk-enabled',
  asyncRoute(async (req, res) => {
    const { ids, enabled } = competitorBulkEnabledSchema.parse(req.body);
    res.json(await bulkSetCompetitorsEnabled(ids, enabled));
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

app.post(
  '/api/ads/bulk-hidden',
  asyncRoute(async (req, res) => {
    const { ids, hidden } = adBulkHiddenSchema.parse(req.body);
    res.json(await bulkSetAdHidden(ids, hidden));
  })
);

// Duplicates view: keep this creative visible and lock it against future auto-dedup.
app.post(
  '/api/ads/:id/unmark-duplicate',
  asyncRoute(async (req, res) => {
    res.json(await unmarkAdDuplicate(routeParam(req.params.id)));
  })
);

app.get(
  '/api/image-proxy',
  asyncRoute(async (req, res) => {
    let target: URL;
    try {
      target = new URL(String(req.query.url ?? ''));
    } catch {
      res.status(400).json({ error: 'Некорректный url' });
      return;
    }

    if (target.protocol !== 'https:' || !isAllowedImageHost(target.hostname)) {
      res.status(400).json({ error: 'Домен изображения не разрешен' });
      return;
    }

    const upstream = await proxiedFetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' }
    });
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !contentType.startsWith('image/')) {
      res.status(502).json({ error: `Не удалось загрузить изображение (${upstream.status})` });
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.byteLength > maxProxyImageBytes) {
      res.status(413).json({ error: 'Изображение слишком большое' });
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
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
    using_publishable_key_for_server: env.usingPublishableKeyForServer,
    proxy_enabled: isProxyEnabled()
  });
});
