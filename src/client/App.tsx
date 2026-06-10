import {
  CheckCircle2,
  CirclePause,
  Database,
  ExternalLink,
  Filter,
  Loader2,
  MapPinned,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Square,
  Trash2,
  X
} from 'lucide-react';
import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import type { Ad, AdLocation, Competitor, ScrapeJobSnapshot } from '../shared/types';
import {
  createCompetitor,
  deleteCompetitor,
  fetchAd,
  fetchAds,
  fetchCompetitors,
  fetchJob,
  fetchLog,
  fetchRuns,
  startScrape,
  stopScrape,
  updateCompetitor
} from './api';

type Filters = {
  competitorId: string;
  status: string;
  platform: string;
  q: string;
};

const statusLabels: Record<string, string> = {
  active: 'Активно',
  inactive: 'Inactive',
  unknown: 'Неизвестно',
  stopped: 'Остановлено'
};

const monthNumbers: Record<string, number> = {
  янв: 0,
  фев: 1,
  мар: 2,
  апр: 3,
  май: 4,
  мая: 4,
  июн: 5,
  июл: 6,
  авг: 7,
  сен: 8,
  сент: 8,
  окт: 9,
  ноя: 10,
  дек: 11
};

type PreviewImageCandidate = {
  src: string;
  score: number;
};

type PreviewMedia =
  | {
      type: 'image';
      src: string;
    }
  | {
      type: 'video';
      src: string;
      poster: string | null;
    };

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function scorePreviewImage(src: string, index: number, total: number, element?: Element) {
  const lower = src.toLowerCase();
  const sizeMatch = lower.match(/[sp](\d{2,4})x(\d{2,4})/);
  const width = sizeMatch ? Number(sizeMatch[1]) : 0;
  const height = sizeMatch ? Number(sizeMatch[2]) : 0;
  let score = index + total;

  if (element?.closest('a[href]')) score += 35;
  if (lower.includes('t39.35426')) score += 80;
  if (lower.includes('dst-jpg')) score += 35;
  if (lower.includes('s600x600') || lower.includes('s1080x1080')) score += 40;
  if (width && height) score += Math.min(width * height, 1_200_000) / 10_000;
  if (width <= 120 && height <= 120 && width && height) score -= 100;
  if (lower.includes('profile') || lower.includes('logo') || lower.includes('p64x64') || lower.includes('s64x64')) {
    score -= 80;
  }

  return score;
}

function extractPreviewImageCandidates(html: string | null) {
  if (!html || typeof DOMParser === 'undefined') return [];

  const document = new DOMParser().parseFromString(html, 'text/html');
  const nodes = [
    ...Array.from(document.querySelectorAll('img[src]')).map((element) => ({
      element,
      src: element.getAttribute('src') || ''
    })),
    ...Array.from(document.querySelectorAll('video[poster]')).map((element) => ({
      element,
      src: element.getAttribute('poster') || ''
    }))
  ].filter((item) => item.src && !item.src.startsWith('data:'));
  const total = nodes.length;
  const seen = new Set<string>();

  return nodes
    .map((item, index) => ({
      src: item.src,
      score: scorePreviewImage(item.src, index, total, item.element)
    }))
    .filter((item) => {
      if (seen.has(item.src)) return false;
      seen.add(item.src);
      return true;
    })
    .sort((left, right) => right.score - left.score);
}

function extractPreviewVideo(html: string | null) {
  if (!html || typeof DOMParser === 'undefined') return null;

  const document = new DOMParser().parseFromString(html, 'text/html');
  const video = document.querySelector('video');
  const source = video?.getAttribute('src') || video?.querySelector('source[src]')?.getAttribute('src') || '';

  if (!source) return null;

  return {
    src: source,
    poster: video?.getAttribute('poster') || null
  };
}

function useBestPreviewImage(html: string | null) {
  const candidates = useMemo(() => extractPreviewImageCandidates(html), [html]);
  const [imageUrl, setImageUrl] = useState(candidates[0]?.src ?? null);

  useEffect(() => {
    let cancelled = false;
    setImageUrl(candidates[0]?.src ?? null);
    if (!candidates.length || typeof Image === 'undefined') return undefined;

    Promise.all(
      candidates.slice(0, 8).map(
        (candidate) =>
          new Promise<{ src: string; score: number; area: number }>((resolve) => {
            const image = new Image();
            image.onload = () =>
              resolve({
                src: candidate.src,
                score: candidate.score,
                area: image.naturalWidth * image.naturalHeight
              });
            image.onerror = () => resolve({ src: candidate.src, score: candidate.score - 120, area: 0 });
            image.referrerPolicy = 'origin-when-cross-origin';
            image.src = candidate.src;
          })
      )
    ).then((loaded) => {
      if (cancelled) return;
      const best = loaded.sort((left, right) => {
        const leftScore = left.score + Math.min(left.area, 1_200_000) / 8_000;
        const rightScore = right.score + Math.min(right.area, 1_200_000) / 8_000;
        return rightScore - leftScore;
      })[0];
      setImageUrl(best?.src ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [candidates]);

  return imageUrl;
}

function usePreviewMedia(html: string | null): PreviewMedia | null {
  const video = useMemo(() => extractPreviewVideo(html), [html]);
  const imageUrl = useBestPreviewImage(html);

  if (video) {
    return {
      type: 'video',
      src: video.src,
      poster: video.poster || imageUrl
    };
  }

  return imageUrl ? { type: 'image', src: imageUrl } : null;
}

function useMediaAspectRatio(src: string | null | undefined) {
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAspectRatio(null);
    if (!src) return undefined;

    if (/\.mp4(?:[?#]|$)/i.test(src)) {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        if (!cancelled && video.videoWidth > 0 && video.videoHeight > 0) {
          setAspectRatio(video.videoWidth / video.videoHeight);
        }
      };
      video.onerror = () => {
        if (!cancelled) setAspectRatio(null);
      };
      video.src = src;

      return () => {
        cancelled = true;
        video.removeAttribute('src');
        video.load();
      };
    }

    const image = new Image();
    image.onload = () => {
      if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
        setAspectRatio(image.naturalWidth / image.naturalHeight);
      }
    };
    image.onerror = () => {
      if (!cancelled) setAspectRatio(null);
    };
    image.referrerPolicy = 'origin-when-cross-origin';
    image.src = src;

    return () => {
      cancelled = true;
    };
  }, [src]);

  return aspectRatio;
}

function renderPreviewMedia(media: PreviewMedia | null) {
  if (!media) return '<div class="media-empty">Медиа не найдено</div>';

  if (media.type === 'video') {
    const poster = media.poster ? ` poster="${escapeHtml(media.poster)}"` : '';
    return `<video controls playsinline preload="metadata"${poster}><source src="${escapeHtml(media.src)}" type="video/mp4"></video>`;
  }

  return `<img src="${escapeHtml(media.src)}" referrerpolicy="origin-when-cross-origin" alt="">`;
}

function previewSrcDoc(ad: Ad, media: PreviewMedia | null) {
  const rawBody = getAdBodyText(ad);
  const body = rawBody || 'Текст объявления пока не сохранен.';
  const companyName = ad.competitors?.name ?? 'Company';
  const title = ad.title && !body.startsWith(ad.title) ? ad.title : '';
  const cta = ad.cta || '';

  return `<!doctype html><html><head><base target="_blank"><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    body{margin:0;background:#f0f2f5;color:#1c1e21;font-family:Arial,Helvetica,sans-serif}
    .wrap{min-height:100vh;padding:24px;display:flex;justify-content:center;align-items:flex-start}
    .card{width:min(430px,100%);background:#fff;border:1px solid #dddfe2;border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.08)}
    .header{display:flex;gap:10px;align-items:center;padding:12px 14px 8px}
    .avatar{width:36px;height:36px;border-radius:50%;background:#eef2f5;color:#53616b;display:grid;place-items:center;font-weight:700;font-size:13px;overflow:hidden}
    .brand{display:grid;gap:2px;line-height:1.2}
    .brand strong{font-size:14px}
    .brand span{font-size:12px;color:#65676b}
    .text{padding:0 14px 12px;font-size:14px;line-height:1.38;white-space:pre-wrap}
    .title{font-weight:700;margin-bottom:6px}
    .media{background:#f7f8fa;border-top:1px solid #edf0f2;border-bottom:1px solid #edf0f2}
    .media img{display:block;width:100%;height:auto}
    .media video{display:block;width:100%;height:auto;max-height:70vh;background:#000}
    .media-empty{padding:42px 14px;color:#65676b;text-align:center}
    .footer{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 12px;background:#f7f8fa}
    .domain{min-width:0;color:#65676b;font-size:12px;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .button{border:0;border-radius:6px;background:#e4e6eb;color:#050505;font-weight:700;font-size:13px;padding:8px 12px;white-space:nowrap}
  </style></head><body><div class="wrap"><article class="card">
    <header class="header">
      <div class="avatar">${escapeHtml(companyName.slice(0, 2).toUpperCase())}</div>
      <div class="brand"><strong>${escapeHtml(companyName)}</strong><span>Реклама</span></div>
    </header>
    <section class="text">${title ? `<div class="title">${escapeHtml(title)}</div>` : ''}${escapeHtml(body)}</section>
    <section class="media">${renderPreviewMedia(media)}</section>
    <footer class="footer"><div class="domain">facebook.com</div>${cta ? `<div class="button">${escapeHtml(cta)}</div>` : ''}</footer>
  </article></div></body></html>`;
}

function directAdUrl(ad: Ad) {
  return ad.facebook_library_id
    ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(ad.facebook_library_id)}`
    : ad.source_url;
}

function parseRuDate(value: string | null) {
  if (!value) return null;
  const normalized = value.replace(/\u202f|\u00a0/g, ' ').replace(/\./g, '').trim().toLowerCase();
  const match = normalized.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
  if (!match) return null;

  const monthKey = match[2].slice(0, 4).replace(/[^а-яё]/g, '');
  const month = monthNumbers[monthKey] ?? monthNumbers[monthKey.slice(0, 3)];
  if (month === undefined) return null;

  const date = new Date(Number(match[3]), month, Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysActive(ad: Ad) {
  const start = parseRuDate(ad.start_date_text);
  if (!start) return '';

  const stop = ad.status === 'active' ? new Date() : parseRuDate(ad.end_date_text) ?? new Date();
  const diff = stop.getTime() - start.getTime();
  return Math.max(0, Math.ceil(diff / 86_400_000)).toString();
}

function stopDay(ad: Ad) {
  return ad.status === 'active' ? '' : (ad.end_date_text ?? '');
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function extractAgeGroups(locations: AdLocation[] = []) {
  const ageGroups = new Set<string>();
  const agePattern = /\b(?:1[3-9]|[2-6]\d)-(?:1[3-9]|[2-6]\d)\b|\b65\+/g;

  for (const location of locations) {
    const text = [location.location, location.location_type, location.visibility].filter(Boolean).join(' ');
    for (const match of text.matchAll(agePattern)) {
      ageGroups.add(match[0]);
    }
  }

  return Array.from(ageGroups).sort((left, right) => left.localeCompare(right, 'ru'));
}

function geoSummary(ad: Ad) {
  const locations = ad.ad_locations ?? [];
  if (!locations.length) return 'открыть';

  const ages = extractAgeGroups(locations);
  return ages.length ? `${locations.length} гео / ${ages.join(', ')}` : `${locations.length} гео`;
}

function extractFormattedTextFromPreviewHtml(html: string | null) {
  if (!html || typeof DOMParser === 'undefined') return '';

  const document = new DOMParser().parseFromString(html, 'text/html');
  const textWithBreaks = (element: HTMLElement) => {
    const chunks: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        chunks.push(node.textContent ?? '');
        return;
      }

      if (node instanceof HTMLBRElement) {
        chunks.push('\n');
        return;
      }

      node.childNodes.forEach(walk);
    };

    walk(element);
    return chunks
      .join('')
      .replace(/\r/g, '')
      .replace(/[ \t\f\v]+\n/g, '\n')
      .replace(/\n[ \t\f\v]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[style*="white-space: pre-wrap"]'))
    .map(textWithBreaks)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  return candidates[0] ?? '';
}

function getAdBodyText(ad: Ad) {
  return (
    cleanBodyTextForDisplay(extractFormattedTextFromPreviewHtml(ad.preview_html)) ||
    cleanBodyTextForDisplay(ad.body_text) ||
    cleanBodyTextForDisplay(ad.preview_text)
  );
}

function cleanBodyTextForDisplay(value: string | null) {
  if (!value) return '';

  const pageChromePatterns = [
    /^Информация$/,
    /^Войти$/,
    /^Библиотека рекламы$/,
    /^Отчет Библиотеки рекламы$/,
    /^Ad Library API$/,
    /^Брендированный контент$/,
    /^Статус системы$/,
    /^Подписаться на уведомления/i,
    /^Часто задаваемые вопросы$/,
    /^Информация о рекламе/i,
    /^Конфиденциальность$/,
    /^Условия$/,
    /^Файлы cookie$/,
    /^Результаты:/,
    /^Фильтры$/,
    /^Сортировать$/,
    /^Сортировка$/,
    /^Удалить$/,
    /^Открыть раскрывающееся меню$/,
    /^Прозрачность информации для ЕС$/,
    /^Статус "Активно"/,
    /^© Meta/
  ];
  const stopAfterCreativePatterns = [
    /^Прозрачность информации для ЕС$/,
    /^Открыть раскрывающееся меню$/,
    /^Информация об объявлении$/,
    /^Статус системы$/,
    /^Ad Library APIИнформация/i
  ];
  const lines = value.split('\n').map((line) => line.replace(/\u200b/g, '').replace(/[ \t\f\v]+/g, ' ').trim());
  const markerIndex = lines.findIndex((line) => line === 'Информация об объявлении');
  const source = markerIndex >= 0 ? lines.slice(markerIndex + 1) : lines;
  const result: string[] = [];

  for (const line of source) {
    if (!line) {
      if (result.length > 0 && result[result.length - 1] !== '') {
        result.push('');
      }
      continue;
    }
    if (result.length > 0 && stopAfterCreativePatterns.some((pattern) => pattern.test(line))) break;
    if (pageChromePatterns.some((pattern) => pattern.test(line))) continue;
    if (line.startsWith('ID Библиотеки:')) continue;
    if (line.startsWith('Показ начат')) continue;
    if (line === 'Платформы') continue;
    result.push(line);
  }

  while (result[0] === '') result.shift();
  while (result[result.length - 1] === '') result.pop();

  return result.join('\n').trim();
}

export function App() {
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [previewAd, setPreviewAd] = useState<Ad | null>(null);
  const [geoAd, setGeoAd] = useState<Ad | null>(null);
  const [filters, setFilters] = useState<Filters>({ competitorId: '', status: '', platform: '', q: '' });
  const [competitorsOpen, setCompetitorsOpen] = useState(false);
  const [job, setJob] = useState<ScrapeJobSnapshot | null>(null);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof fetchRuns>> | null>(null);
  const [scraperLog, setScraperLog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextCompetitors, nextAds, nextRuns, nextLog] = await Promise.all([
        fetchCompetitors(),
        fetchAds(filters),
        fetchRuns(),
        fetchLog('scraper', 80)
      ]);
      setCompetitors(nextCompetitors);
      setAds(nextAds);
      setRuns(nextRuns);
      setScraperLog(nextLog.lines);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [filters.competitorId, filters.status, filters.platform]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 350);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  useEffect(() => {
    if (!job || job.status !== 'running') return undefined;

    const interval = window.setInterval(async () => {
      try {
        const [nextJob, nextLog] = await Promise.all([fetchJob(job.run_id), fetchLog('scraper', 80)]);
        setJob(nextJob);
        setScraperLog(nextLog.lines);
        if (nextJob.status !== 'running') {
          await refresh();
        }
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    }, 2500);

    return () => window.clearInterval(interval);
  }, [job?.run_id, job?.status]);

  async function handleStartScrape(competitorId?: string) {
    setError(null);
    try {
      const nextJob = await startScrape({ competitorId: competitorId || undefined });
      setJob(nextJob);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  async function handleStopScrape() {
    if (!job) return;
    setError(null);
    try {
      setJob(await stopScrape(job.run_id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  async function openPreview(ad: Ad) {
    setPreviewAd(ad);
    try {
      setPreviewAd(await fetchAd(ad.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  async function openGeo(ad: Ad) {
    setGeoAd(ad);
    try {
      setGeoAd(await fetchAd(ad.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  const counters = useMemo(
    () => ({
      competitors: competitors.length,
      enabled: competitors.filter((competitor) => competitor.enabled).length,
      ads: ads.length,
      active: ads.filter((ad) => ad.status === 'active').length
    }),
    [ads, competitors]
  );

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Facebook Ad Library</p>
          <h1>Таблица объявлений конкурентов</h1>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={() => void refresh()} title="Обновить">
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </button>
          <button className="secondary-button" onClick={() => setCompetitorsOpen(true)}>
            <Settings size={18} />
            Конкуренты
          </button>
          <button className="primary-button" onClick={() => void handleStartScrape()}>
            <Play size={18} />
            Собрать включенных
          </button>
        </div>
      </header>

      {error && (
        <div className="notice danger">
          <span>{error}</span>
          <button onClick={() => setError(null)} title="Закрыть">
            <X size={16} />
          </button>
        </div>
      )}

      <section className="metrics">
        <Metric icon={<Database size={18} />} label="Объявлений" value={counters.ads} />
        <Metric icon={<CheckCircle2 size={18} />} label="Включено конкурентов" value={counters.enabled} />
        <Metric icon={<CirclePause size={18} />} label="Всего конкурентов" value={counters.competitors} />
        <Metric icon={<Filter size={18} />} label="Активных в таблице" value={counters.active} />
      </section>

      {job && <JobPanel job={job} onStop={() => void handleStopScrape()} />}

      <section className="toolbar">
        <label className="search-box">
          <Search size={17} />
          <input
            value={filters.q}
            onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
            placeholder="Поиск по body_text"
          />
        </label>
        <select
          value={filters.competitorId}
          onChange={(event) => setFilters((current) => ({ ...current, competitorId: event.target.value }))}
        >
          <option value="">Все конкуренты</option>
          {competitors.map((competitor) => (
            <option key={competitor.id} value={competitor.id}>
              {competitor.name}
            </option>
          ))}
        </select>
        <select
          value={filters.status}
          onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
        >
          <option value="">Любой статус</option>
          <option value="active">Активно</option>
          <option value="inactive">Inactive</option>
          <option value="unknown">Неизвестно</option>
        </select>
        <select
          value={filters.platform}
          onChange={(event) => setFilters((current) => ({ ...current, platform: event.target.value }))}
        >
          <option value="">Все платформы</option>
          <option value="Facebook">Facebook</option>
          <option value="Instagram">Instagram</option>
          <option value="Messenger">Messenger</option>
          <option value="Audience Network">Audience Network</option>
        </select>
      </section>

      <section className="table-section">
        <div className="table-shell">
          <table className="ad-table">
            <thead>
              <tr>
                <th>ad_archive_id</th>
                <th>company_name</th>
                <th>preview</th>
                <th>status</th>
                <th>link_url</th>
                <th>start_day</th>
                <th>stop_day</th>
                <th>days_active</th>
                <th>cta</th>
                <th>body_text</th>
                <th>geo</th>
                <th>last_seen_at</th>
              </tr>
            </thead>
            <tbody>
              {ads.map((ad) => (
                <tr key={ad.id}>
                  <td className="mono">{ad.facebook_library_id}</td>
                  <td>{ad.competitors?.name ?? ad.competitor_id}</td>
                  <td>
                    <PreviewThumb ad={ad} onOpen={() => void openPreview(ad)} />
                  </td>
                  <td>
                    <span className={`status-pill ${ad.status}`}>{statusLabels[ad.status] ?? ad.status}</span>
                  </td>
                  <td>
                    <a className="table-link" href={directAdUrl(ad)} target="_blank" rel="noreferrer">
                      ссылка
                      <ExternalLink size={14} />
                    </a>
                  </td>
                  <td>{ad.start_date_text ?? ''}</td>
                  <td>{stopDay(ad)}</td>
                  <td className="number-cell">{daysActive(ad)}</td>
                  <td>{ad.cta ?? ''}</td>
                  <td className="body-cell">{getAdBodyText(ad)}</td>
                  <td>
                    <button className="geo-button" onClick={() => void openGeo(ad)}>
                      <MapPinned size={15} />
                      {geoSummary(ad)}
                    </button>
                  </td>
                  <td className="date-cell">{formatDateTime(ad.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!ads.length && <div className="empty">Пока нет сохраненных объявлений. Добавьте конкурента и запустите сбор.</div>}
        </div>
      </section>

      <section className="bottom-grid">
        <aside className="runs">
          <h2>Последние запуски</h2>
          {(runs?.persisted ?? []).slice(0, 8).map((run) => (
            <div className="run-row" key={run.id}>
              <span className={`status-pill ${run.status}`}>{run.status}</span>
              <span>{run.competitors?.name ?? 'Все включенные'}</span>
              <small>
                найдено {run.ads_found}, сохранено {run.ads_saved}
              </small>
            </div>
          ))}
        </aside>
        <aside className="log-panel">
          <div className="log-panel-header">
            <h2>Журнал</h2>
            <button
              className="icon-button"
              onClick={() => fetchLog('scraper', 80).then((log) => setScraperLog(log.lines))}
              title="Обновить журнал"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <pre>{scraperLog.length ? scraperLog.join('\n') : 'Лог появится после запуска сбора.'}</pre>
        </aside>
      </section>

      {competitorsOpen && (
        <CompetitorsDialog
          competitors={competitors}
          onClose={() => setCompetitorsOpen(false)}
          onChanged={() => void refresh()}
          onScrape={(id) => void handleStartScrape(id)}
        />
      )}

      {previewAd && <PreviewModal ad={previewAd} onClose={() => setPreviewAd(null)} />}
      {geoAd && <GeoDrawer ad={geoAd} onClose={() => setGeoAd(null)} />}
    </main>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function JobPanel({ job, onStop }: { job: ScrapeJobSnapshot; onStop: () => void }) {
  return (
    <section className="job-panel">
      <div>
        <strong>{job.message}</strong>
        <span>
          найдено {job.ads_found}, сохранено {job.ads_saved}
          {job.limit ? `, лимит ${job.limit}` : ''}
        </span>
      </div>
      {job.status === 'running' && <Loader2 size={20} className="spin" />}
      {job.status === 'running' && (
        <button className="stop-button" onClick={onStop}>
          <Square size={15} />
          Остановить
        </button>
      )}
      <span className={`status-pill ${job.status}`}>{job.status}</span>
    </section>
  );
}

function CompetitorsDialog({
  competitors,
  onClose,
  onChanged,
  onScrape
}: {
  competitors: Competitor[];
  onClose: () => void;
  onChanged: () => void;
  onScrape: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [pageId, setPageId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await createCompetitor({ name, facebook_page_id: pageId, enabled: true, notes: notes || null });
      setName('');
      setPageId('');
      setNotes('');
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="modal competitors-modal">
        <header>
          <h2>Конкуренты</h2>
          <button className="icon-button" onClick={onClose} title="Закрыть">
            <X size={18} />
          </button>
        </header>
        <form className="competitor-form" onSubmit={(event) => void handleSubmit(event)}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Название" required />
          <input
            value={pageId}
            onChange={(event) => setPageId(event.target.value.replace(/\D/g, ''))}
            placeholder="Facebook Page ID"
            required
          />
          <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Заметка" />
          <button className="primary-button" disabled={saving}>
            <Plus size={17} />
            Добавить
          </button>
        </form>

        <div className="competitor-list">
          {competitors.map((competitor) => (
            <div className="competitor-row" key={competitor.id}>
              <div>
                <strong>{competitor.name}</strong>
                <span>{competitor.facebook_page_id}</span>
                <small>
                  последний сбор:{' '}
                  {competitor.last_scraped_at ? new Date(competitor.last_scraped_at).toLocaleString('ru-RU') : 'еще не было'}
                </small>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={competitor.enabled}
                  onChange={(event) =>
                    updateCompetitor(competitor.id, { enabled: event.target.checked }).then(onChanged).catch(console.error)
                  }
                />
                <span />
              </label>
              <button className="icon-button" onClick={() => onScrape(competitor.id)} title="Собрать этого конкурента">
                <Play size={17} />
              </button>
              <button
                className="icon-button danger-button"
                onClick={() => deleteCompetitor(competitor.id).then(onChanged).catch(console.error)}
                title="Удалить"
              >
                <Trash2 size={17} />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PreviewThumb({ ad, onOpen }: { ad: Ad; onOpen: () => void }) {
  const media = usePreviewMedia(ad.preview_html);
  const imageUrl = media?.type === 'video' ? media.poster : media?.src;
  const aspectRatio = useMediaAspectRatio(imageUrl ?? (media?.type === 'video' ? media.src : null));
  const style = aspectRatio
    ? ({ '--preview-aspect-ratio': aspectRatio.toString() } as CSSProperties)
    : undefined;

  return (
    <button
      className={`preview-thumb ${media?.type === 'video' ? 'video-thumb' : ''}`}
      style={style}
      onClick={onOpen}
      title="Открыть превью"
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" referrerPolicy="origin-when-cross-origin" loading="lazy" />
      ) : (
        <span className="preview-placeholder">{media?.type === 'video' ? 'video' : 'нет картинки'}</span>
      )}
      {media?.type === 'video' && (
        <span className="play-badge" aria-hidden="true">
          <Play size={18} fill="currentColor" />
        </span>
      )}
    </button>
  );
}

function PreviewModal({ ad, onClose }: { ad: Ad; onClose: () => void }) {
  const media = usePreviewMedia(ad.preview_html);

  return (
    <div className="modal-backdrop preview-backdrop">
      <section className="modal preview-modal">
        <header>
          <div>
            <span className={`status-pill ${ad.status}`}>{statusLabels[ad.status] ?? ad.status}</span>
            <h2>{ad.facebook_library_id}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Закрыть">
            <X size={18} />
          </button>
        </header>
        <iframe
          title={`Ad preview ${ad.facebook_library_id}`}
          className="preview-frame"
          srcDoc={previewSrcDoc(ad, media)}
          allow="fullscreen; autoplay"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </section>
    </div>
  );
}

function GeoDrawer({ ad, onClose }: { ad: Ad; onClose: () => void }) {
  const locations = ad.ad_locations ?? [];
  const ageGroups = extractAgeGroups(locations);

  return (
    <div className="drawer-backdrop">
      <aside className="drawer geo-drawer">
        <header>
          <div>
            <h2>Гео-видимость</h2>
            <p className="drawer-subtitle">ID {ad.facebook_library_id}</p>
          </div>
          <button className="icon-button" onClick={onClose} title="Закрыть">
            <X size={18} />
          </button>
        </header>

        <section className="geo-summary">
          <div>
            <span>Всего строк гео</span>
            <strong>{locations.length}</strong>
          </div>
          <div>
            <span>Возрастные группы</span>
            <strong>{ageGroups.length ? ageGroups.join(', ') : 'не найдены'}</strong>
          </div>
        </section>

        <section>
          <div className="locations-table">
            <div className="locations-head">
              <span>geo</span>
              <span>type</span>
              <span>include/exclude</span>
            </div>
            {locations.map((location) => (
              <div key={location.id}>
                <span>{location.location}</span>
                <span>{location.location_type || '-'}</span>
                <span>{location.visibility || '-'}</span>
              </div>
            ))}
            {!locations.length && <p>Гео пока не сохранено.</p>}
          </div>
        </section>
      </aside>
    </div>
  );
}
