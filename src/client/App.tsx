import {
  Check,
  CheckCircle2,
  ChevronDown,
  CirclePause,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Filter,
  Info,
  ListChecks,
  Loader2,
  MapPinned,
  Menu,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  X
} from 'lucide-react';
import {
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { buildAdLibraryUrl } from '../shared/adLibraryUrl';
import { nonCountryGeoValues, splitGeoValues } from '../shared/countries';
import { adAiAssessmentKeys } from '../shared/types';
import type {
  Ad,
  AdLocation,
  AdMediaItem,
  AiAssessmentJobSnapshot,
  Competitor,
  ScrapeJobSnapshot,
  ScrapeRun
} from '../shared/types';
import {
  bulkCreateCompetitors,
  bulkSetAdHidden,
  bulkSetCompetitorsEnabled,
  createCompetitor,
  deleteCompetitor,
  fetchAd,
  fetchAdAssessmentJob,
  fetchAdLocations,
  fetchAds,
  fetchCompetitors,
  fetchJob,
  fetchScrapeRuns,
  imageProxyUrl,
  setAdHidden,
  startAdAssessment,
  startScrape,
  stopScrape,
  unmarkAdDuplicate,
  updateCompetitor
} from './api';
import { type XlsxColumn, type XlsxRow, exportToXlsx } from './excelExport';

type DaysActiveOp = '>' | '<' | '=';

type Filters = {
  competitorIds: string[];
  geos: string[];
  status: string;
  q: string;
  daysActiveOp: DaysActiveOp | '';
  daysActiveValue: string;
};

const filtersStorageKey = 'ad-library-filters-v1';

function loadFilters(): Filters {
  const fallback: Filters = { competitorIds: [], geos: [], status: '', q: '', daysActiveOp: '', daysActiveValue: '' };
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(filtersStorageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Filters> & { competitorId?: string };
    return {
      competitorIds: Array.isArray(parsed.competitorIds)
        ? parsed.competitorIds.filter((id): id is string => typeof id === 'string')
        : parsed.competitorId
          ? [parsed.competitorId]
          : [],
      geos: Array.isArray(parsed.geos) ? parsed.geos.filter((geo): geo is string => typeof geo === 'string') : [],
      status: typeof parsed.status === 'string' ? parsed.status : '',
      q: typeof parsed.q === 'string' ? parsed.q : '',
      daysActiveOp:
        parsed.daysActiveOp === '>' || parsed.daysActiveOp === '<' || parsed.daysActiveOp === '='
          ? parsed.daysActiveOp
          : '',
      daysActiveValue: typeof parsed.daysActiveValue === 'string' ? parsed.daysActiveValue : ''
    };
  } catch {
    return fallback;
  }
}

type TableColumn = {
  key: string;
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
};

type ColumnResizeEdge = 'left' | 'right';

type SortMode = 'company' | 'new-first';

// Row callbacks passed to memoized AdRow through a stable wrapper (latest-ref pattern),
// so scrolling re-renders only mount/unmount edge rows instead of every visible row.
type RowHandlers = {
  onColumnHandleEnter: (columnKey: string, edge: ColumnResizeEdge) => void;
  onColumnHandleLeave: (columnKey: string, edge: ColumnResizeEdge) => void;
  onColumnResizeStart: (event: ReactMouseEvent, column: TableColumn, edge: ColumnResizeEdge) => void;
  onRowHandleEnter: (adId: string) => void;
  onRowHandleLeave: (adId: string) => void;
  onRowResizeStart: (event: ReactMouseEvent, ad: Ad) => void;
  onToggleHidden: (ad: Ad, hidden: boolean) => void;
  onToggleSelect: (ad: Ad, index: number, shiftKey: boolean) => void;
  onUnmarkDuplicate: (ad: Ad) => void;
  onOpenPreview: (ad: Ad) => void;
  onOpenGeo: (ad: Ad) => void;
  onAspectRatio: (adId: string, aspectRatio: number | null) => void;
};

// Rows shown initially and added per "Показать ещё" click. Override at build time with
// VITE_ADS_PAGE_SIZE (e.g. a Cloudflare build variable); falls back to 250.
const adsPageSize = Math.max(1, Number(import.meta.env.VITE_ADS_PAGE_SIZE) || 250);

const sortModeStorageKey = 'ad-library-sort-mode';

function loadSortMode(): SortMode {
  if (typeof window === 'undefined') return 'company';
  return window.localStorage.getItem(sortModeStorageKey) === 'new-first' ? 'new-first' : 'company';
}

type TableLayout = {
  columnWidths: Record<string, number>;
  rowHeights: Record<string, number>;
  pinnedColumnKey: string | null;
};

const tableLayoutStorageKey = 'ad-library-table-layout-v2';
const previewThumbWidth = 108;
const tableCellVerticalPadding = 20;
const defaultRowBottomGap = 10;
const resizeHoverDelayMs = 300;
const defaultPreviewAspectRatio = 1;
const defaultRowHeight = previewThumbWidth + tableCellVerticalPadding + defaultRowBottomGap;
const minRowHeight = 54;
const maxRowHeight = 520;
const controlColumnWidth = 44;

const tableColumns: TableColumn[] = [
  { key: 'ad_archive_id', label: 'ad_archive_id', width: 125, minWidth: 96, maxWidth: 260 },
  { key: 'company_name', label: 'company_name', width: 170, minWidth: 120, maxWidth: 360 },
  { key: 'preview', label: 'preview', width: 138, minWidth: 96, maxWidth: 320 },
  { key: 'status', label: 'status', width: 110, minWidth: 86, maxWidth: 180 },
  { key: 'link_url', label: 'link_url', width: 110, minWidth: 86, maxWidth: 220 },
  { key: 'start_day', label: 'start_day', width: 120, minWidth: 96, maxWidth: 240 },
  { key: 'stop_day', label: 'stop_day', width: 120, minWidth: 96, maxWidth: 240 },
  { key: 'days_active', label: 'days_active', width: 90, minWidth: 76, maxWidth: 180 },
  { key: 'cta', label: 'cta', width: 110, minWidth: 90, maxWidth: 260 },
  { key: 'body_text', label: 'body_text', width: 470, minWidth: 220, maxWidth: 900 },
  { key: 'geo', label: 'geo', width: 170, minWidth: 120, maxWidth: 360 },
  { key: 'last_seen_at', label: 'last_seen_at', width: 150, minWidth: 120, maxWidth: 260 },
  ...adAiAssessmentKeys.map((key) => ({
    key,
    label: key,
    width: key === 'ai_geo' ? 150 : 230,
    minWidth: key === 'ai_geo' ? 110 : 150,
    maxWidth: 600
  }))
];

const tableColumnByKey = Object.fromEntries(tableColumns.map((column) => [column.key, column])) as Record<
  string,
  TableColumn
>;

// Columns from the first one through body_text can act as a freeze boundary (Excel-style).
const pinnableMaxColumnIndex = tableColumns.findIndex((column) => column.key === 'body_text');

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function columnWidth(layout: TableLayout, column: TableColumn) {
  return layout.columnWidths[column.key] ?? column.width;
}

function normalizeTableLayout(layout: TableLayout): TableLayout {
  return {
    columnWidths: Object.fromEntries(
      tableColumns.map((column) => [
        column.key,
        Math.max(layout.columnWidths[column.key] ?? column.width, column.minWidth)
      ])
    ),
    rowHeights: layout.rowHeights,
    pinnedColumnKey: layout.pinnedColumnKey ?? null
  };
}

function defaultTableLayout(): TableLayout {
  return {
    columnWidths: Object.fromEntries(tableColumns.map((column) => [column.key, column.width])),
    rowHeights: {},
    pinnedColumnKey: null
  };
}

function loadTableLayout(): TableLayout {
  const fallback = defaultTableLayout();
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(tableLayoutStorageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<TableLayout>;
    const columnWidths = { ...fallback.columnWidths };
    const rowHeights: Record<string, number> = {};

    for (const column of tableColumns) {
      const width = parsed.columnWidths?.[column.key];
      if (Number.isFinite(width)) {
        columnWidths[column.key] = Math.max(Number(width), column.minWidth);
      }
    }

    for (const [rowId, height] of Object.entries(parsed.rowHeights ?? {})) {
      if (Number.isFinite(height)) {
        rowHeights[rowId] = clampNumber(Number(height), minRowHeight, maxRowHeight);
      }
    }

    const pinnedColumnKey =
      typeof parsed.pinnedColumnKey === 'string' &&
      tableColumns.findIndex((column) => column.key === parsed.pinnedColumnKey) >= 0 &&
      tableColumns.findIndex((column) => column.key === parsed.pinnedColumnKey) <= pinnableMaxColumnIndex
        ? parsed.pinnedColumnKey
        : null;

    return { columnWidths, rowHeights, pinnedColumnKey };
  } catch {
    return fallback;
  }
}

function saveTableLayout(layout: TableLayout) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(tableLayoutStorageKey, JSON.stringify(normalizeTableLayout(layout)));
}

const statusLabels: Record<string, string> = {
  active: 'Активно',
  new: 'NEW',
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

type PreviewMediaItem =
  | {
      type: 'image';
      src: string;
      poster?: string | null;
      link_url?: string | null;
      source?: 'preview' | 'carousel';
      position: number;
    }
  | {
      type: 'video';
      src: string;
      poster: string | null;
      link_url?: string | null;
      source?: 'preview' | 'carousel';
      position: number;
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

function isUsableMediaSrc(src: string | null | undefined) {
  return Boolean(src && !src.startsWith('data:') && !src.startsWith('blob:'));
}

function linkFromElement(element: Element) {
  return element.querySelector<HTMLAnchorElement>('a[href]')?.href ?? null;
}

function uniqueMediaItems(items: PreviewMediaItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.src)) return false;
    seen.add(item.src);
    return true;
  });
}

function normalizeStoredMediaItems(items: AdMediaItem[] | null | undefined) {
  return uniqueMediaItems(
    (items ?? [])
      .filter((item) => isUsableMediaSrc(item.src))
      .map((item, index) => ({
        type: item.type,
        src: item.src,
        poster: item.poster ?? null,
        link_url: item.link_url ?? null,
        source: item.source ?? 'preview',
        position: item.position ?? index
      }))
  );
}

function extractVideoItem(scope: Element, position: number, source: 'preview' | 'carousel'): PreviewMediaItem | null {
  const video = Array.from(scope.querySelectorAll<HTMLVideoElement>('video')).find((element) =>
    isUsableMediaSrc(element.getAttribute('src') || element.querySelector('source[src]')?.getAttribute('src'))
  );
  const src = video?.getAttribute('src') || video?.querySelector('source[src]')?.getAttribute('src') || '';
  if (!isUsableMediaSrc(src)) return null;

  return {
    type: 'video',
    src,
    poster: video?.getAttribute('poster') || null,
    link_url: linkFromElement(scope),
    source,
    position
  };
}

function extractImageItem(scope: Element, position: number, source: 'preview' | 'carousel'): PreviewMediaItem | null {
  const images = Array.from(scope.querySelectorAll<HTMLImageElement>('img[src]'))
    .map((element, index, all) => ({
      element,
      src: element.getAttribute('src') || '',
      score: scorePreviewImage(element.getAttribute('src') || '', index, all.length, element)
    }))
    .filter((item) => isUsableMediaSrc(item.src))
    .sort((left, right) => right.score - left.score);
  const best = images[0];
  if (!best) return null;

  return {
    type: 'image',
    src: best.src,
    poster: null,
    link_url: linkFromElement(scope),
    source,
    position
  };
}

function extractMediaItem(scope: Element, position: number, source: 'preview' | 'carousel') {
  return extractVideoItem(scope, position, source) ?? extractImageItem(scope, position, source);
}

function extractCarouselMediaItems(html: string | null) {
  if (!html || typeof DOMParser === 'undefined') return [];

  const document = new DOMParser().parseFromString(html, 'text/html');
  const children = Array.from(document.querySelectorAll<HTMLElement>('[data-type="hscroll-child"]'));
  if (children.length <= 1) return [];

  return uniqueMediaItems(
    children
      .map((child, index) => extractMediaItem(child, index, 'carousel'))
      .filter((item): item is PreviewMediaItem => Boolean(item))
      .map((item, index) => ({ ...item, position: index }))
  );
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

function extractPreviewVideo(html: string | null): PreviewMediaItem | null {
  if (!html || typeof DOMParser === 'undefined') return null;

  const document = new DOMParser().parseFromString(html, 'text/html');
  const video = document.querySelector('video');
  const source = video?.getAttribute('src') || video?.querySelector('source[src]')?.getAttribute('src') || '';

  if (!source) return null;

  return {
    type: 'video',
    src: source,
    poster: video?.getAttribute('poster') || null,
    link_url: linkFromElement(document.body),
    source: 'preview',
    position: 0
  };
}

function mediaAspectRatioFromSrc(src: string | null | undefined) {
  if (!src) return null;
  const matches = Array.from(src.toLowerCase().matchAll(/[sp](\d{2,4})x(\d{2,4})/g))
    .map((match) => ({ width: Number(match[1]), height: Number(match[2]) }))
    .filter(({ width, height }) => width > 0 && height > 0)
    .sort((left, right) => right.width * right.height - left.width * left.height);
  const best = matches[0];
  return best ? best.width / best.height : null;
}

function primaryPreviewMediaSrc(ad: Ad) {
  const storedItems = normalizeStoredMediaItems(ad.media_items);
  const carouselItems = extractCarouselMediaItems(ad.preview_html);
  const video = extractPreviewVideo(ad.preview_html);
  const fallbackImage = extractPreviewImageCandidates(ad.preview_html)[0]?.src ?? null;
  const primary = storedItems[0] ?? (carouselItems.length > 1 ? carouselItems[0] : video);

  if (primary?.type === 'video') return primary.poster || primary.src;
  return primary?.src ?? fallbackImage;
}

function defaultRowHeightForAspectRatio(aspectRatio: number | null | undefined) {
  const safeAspectRatio = clampNumber(aspectRatio || defaultPreviewAspectRatio, 0.2, 4);
  const mediaHeight = previewThumbWidth / safeAspectRatio;
  return clampNumber(Math.ceil(mediaHeight + tableCellVerticalPadding + defaultRowBottomGap), minRowHeight, maxRowHeight);
}

function defaultRowHeightForAd(ad: Ad, measuredAspectRatio: number | null | undefined) {
  return defaultRowHeightForAspectRatio(measuredAspectRatio ?? mediaAspectRatioFromSrc(primaryPreviewMediaSrc(ad)));
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

function usePreviewMediaItems(ad: Ad): PreviewMediaItem[] {
  const storedItems = useMemo(() => normalizeStoredMediaItems(ad.media_items), [ad.media_items]);
  // When stored media items exist they win anyway — skip the expensive preview_html
  // fallbacks entirely (DOM parsing + preloading up to 8 candidate images per row).
  const fallbackHtml = storedItems.length ? null : ad.preview_html;
  const carouselItems = useMemo(() => extractCarouselMediaItems(fallbackHtml), [fallbackHtml]);
  const video = useMemo(() => extractPreviewVideo(fallbackHtml), [fallbackHtml]);
  const imageUrl = useBestPreviewImage(fallbackHtml);

  return useMemo(() => {
    if (storedItems.length) return storedItems;
    if (carouselItems.length > 1) return carouselItems;
    if (video) return [{ ...video, poster: video.poster || imageUrl }];
    return imageUrl ? [{ type: 'image', src: imageUrl, poster: null, link_url: null, source: 'preview', position: 0 }] : [];
  }, [carouselItems, imageUrl, storedItems, video]);
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

function renderMediaElement(item: PreviewMediaItem) {
  if (item.type === 'video') {
    const poster = item.poster ? ` poster="${escapeHtml(item.poster)}"` : '';
    return `<video controls playsinline preload="metadata"${poster}><source src="${escapeHtml(item.src)}" type="video/mp4"></video>`;
  }

  const image = `<img src="${escapeHtml(item.src)}" referrerpolicy="origin-when-cross-origin" alt="">`;
  return item.link_url ? `<a class="media-link" href="${escapeHtml(item.link_url)}">${image}</a>` : image;
}

function renderCarouselScript(enabled: boolean) {
  if (!enabled) return '';

  return `<script>
    (function () {
      document.querySelectorAll('[data-carousel]').forEach(function (carousel) {
        var track = carousel.querySelector('.carousel-track');
        var slides = carousel.querySelectorAll('.carousel-slide');
        var prev = carousel.querySelector('[data-prev]');
        var next = carousel.querySelector('[data-next]');
        var counter = carousel.querySelector('[data-counter]');
        var current = 0;
        function go(index) {
          if (!track || !slides.length) return;
          current = (index + slides.length) % slides.length;
          track.style.transform = 'translateX(' + (-current * 100) + '%)';
          if (counter) counter.textContent = (current + 1) + ' / ' + slides.length;
        }
        if (prev) prev.addEventListener('click', function () { go(current - 1); });
        if (next) next.addEventListener('click', function () { go(current + 1); });
        go(0);
      });
    })();
  </script>`;
}

function renderPreviewMedia(mediaItems: PreviewMediaItem[]) {
  if (!mediaItems.length) return '<div class="media-empty">Медиа не найдено</div>';
  if (mediaItems.length === 1) return renderMediaElement(mediaItems[0]);

  return `<div class="carousel" data-carousel>
    <div class="carousel-track">
      ${mediaItems.map((item) => `<div class="carousel-slide">${renderMediaElement(item)}</div>`).join('')}
    </div>
    <button class="carousel-nav carousel-prev" type="button" data-prev aria-label="Previous">‹</button>
    <button class="carousel-nav carousel-next" type="button" data-next aria-label="Next">›</button>
    <div class="carousel-counter" data-counter>1 / ${mediaItems.length}</div>
  </div>`;
}

function previewSrcDoc(ad: Ad, mediaItems: PreviewMediaItem[]) {
  const rawBody = getAdBodyText(ad);
  const body = rawBody || 'Текст объявления пока не сохранен.';
  const companyName = ad.competitors?.name ?? 'Company';
  const title = ad.title && !body.startsWith(ad.title) ? ad.title : '';
  const cta = ad.cta || '';
  const hasCarousel = mediaItems.length > 1;

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
    .media{background:#f7f8fa;border-top:1px solid #edf0f2;border-bottom:1px solid #edf0f2;overflow:hidden}
    .media img{display:block;width:100%;height:auto}
    .media video{display:block;width:100%;height:auto;max-height:70vh;background:#000}
    .media-link{display:block;color:inherit;text-decoration:none}
    .media-empty{padding:42px 14px;color:#65676b;text-align:center}
    .carousel{position:relative;overflow:hidden;background:#eef1f4}
    .carousel-track{display:flex;transition:transform .22s ease}
    .carousel-slide{min-width:100%;display:grid;place-items:center;background:#f7f8fa}
    .carousel-slide img,.carousel-slide video{max-height:70vh;object-fit:contain}
    .carousel-nav{position:absolute;top:50%;width:34px;height:44px;border:0;border-radius:6px;background:rgba(255,255,255,.92);color:#172026;font-size:30px;line-height:1;transform:translateY(-50%);box-shadow:0 4px 16px rgba(0,0,0,.18)}
    .carousel-prev{left:8px}
    .carousel-next{right:8px}
    .carousel-counter{position:absolute;right:10px;bottom:10px;border-radius:999px;background:rgba(0,0,0,.66);color:#fff;font-size:12px;font-weight:700;padding:4px 8px}
    .footer{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 12px;background:#f7f8fa}
    .domain{min-width:0;color:#65676b;font-size:12px;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .button{border:0;border-radius:6px;background:#e4e6eb;color:#050505;font-weight:700;font-size:13px;padding:8px 12px;white-space:nowrap}
  </style></head><body><div class="wrap"><article class="card">
    <header class="header">
      <div class="avatar">${escapeHtml(companyName.slice(0, 2).toUpperCase())}</div>
      <div class="brand"><strong>${escapeHtml(companyName)}</strong><span>Реклама</span></div>
    </header>
    <section class="text">${title ? `<div class="title">${escapeHtml(title)}</div>` : ''}${escapeHtml(body)}</section>
    <section class="media">${renderPreviewMedia(mediaItems)}</section>
    <footer class="footer"><div class="domain">facebook.com</div>${cta ? `<div class="button">${escapeHtml(cta)}</div>` : ''}</footer>
  </article></div>${renderCarouselScript(hasCarousel)}</body></html>`;
}

// Always link straight to the specific creative (…/ads/library/?id=<archive id>), not the
// competitor's filtered page-results URL. `source_url` is the latter (full filters), so we only
// fall back to it for the rare ad whose library id never resolved.
function directAdUrl(ad: Ad) {
  if (ad.facebook_library_id && ad.facebook_library_id !== 'unknown') {
    return `https://www.facebook.com/ads/library/?id=${encodeURIComponent(ad.facebook_library_id)}`;
  }
  return ad.source_url || 'https://www.facebook.com/ads/library/';
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

// Number of days an ad has been running, or null when it can't be computed (stopped ads,
// or no parseable start date). Shared by the days_active column and the days_active filter.
function daysActiveCount(ad: Ad): number | null {
  if (ad.status === 'stopped') return null;

  const start = parseRuDate(ad.start_date_text);
  if (!start) return null;

  const stop = ad.status === 'active' || ad.status === 'new' ? new Date() : parseRuDate(ad.end_date_text) ?? new Date();
  const diff = stop.getTime() - start.getTime();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

function daysActive(ad: Ad) {
  const count = daysActiveCount(ad);
  return count === null ? '' : count.toString();
}

function stopDay(ad: Ad) {
  if (ad.status === 'active' || ad.status === 'new') return '';
  if (ad.status === 'stopped') return formatDateTime(ad.stopped_at) || ad.end_date_text || '';
  return ad.end_date_text ?? '';
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

// Wall-clock duration of a scrape run (start → finish, AI analysis included), as 1h30m / 30m / 45s.
function formatScrapeDuration(run: Pick<ScrapeRun, 'started_at' | 'finished_at'>) {
  if (!run.started_at || !run.finished_at) return null;
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// Raw geo rows are a cross product of country × age bucket × gender. Country-level rows
// (location_type «Страна»/«Регион») carry visibility «Включено»/«Исключено»; demographic
// rows carry gender there. For display we keep unique countries split by include/exclude.
function groupGeoCountries(locations: AdLocation[] = []) {
  const all = new Set<string>();
  const excluded = new Set<string>();

  for (const location of locations) {
    const name = location.location.trim();
    if (!name) continue;
    all.add(name);
    if (location.visibility?.trim().toLowerCase() === 'исключено') excluded.add(name);
  }

  const sortRu = (values: string[]) => values.sort((left, right) => left.localeCompare(right, 'ru'));
  return {
    included: sortRu(Array.from(all).filter((name) => !excluded.has(name))),
    excluded: sortRu(Array.from(excluded))
  };
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

// Parsing 10–15KB of preview_html with DOMParser per row per render is what makes phones
// crawl (dozens of re-renders during initial load × dozens of rows). Ad objects are stable
// across renders, so a WeakMap cache turns repeat calls into lookups.
const adBodyTextCache = new WeakMap<Ad, string>();

function getAdBodyText(ad: Ad) {
  const cached = adBodyTextCache.get(ad);
  if (cached !== undefined) return cached;

  const value =
    cleanBodyTextForDisplay(extractFormattedTextFromPreviewHtml(ad.preview_html)) ||
    cleanBodyTextForDisplay(ad.body_text) ||
    cleanBodyTextForDisplay(ad.preview_text);
  adBodyTextCache.set(ad, value);
  return value;
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

type ParsedCompetitorLine =
  | { ok: true; raw: string; name: string; facebook_page_id: string; notes: string | null }
  | { ok: false; raw: string; reason: string };

function parseCompetitorLine(raw: string): ParsedCompetitorLine | null {
  const line = raw.trim();
  if (!line) return null;

  const firstComma = line.indexOf(',');
  if (firstComma === -1) {
    return { ok: false, raw, reason: 'нужен формат «Название, ID»' };
  }

  const name = line.slice(0, firstComma).trim();
  const rest = line.slice(firstComma + 1);
  const secondComma = rest.indexOf(',');
  const idPart = (secondComma === -1 ? rest : rest.slice(0, secondComma)).trim();
  const notes = (secondComma === -1 ? '' : rest.slice(secondComma + 1).trim()) || null;
  const facebook_page_id = idPart.replace(/\D/g, '');

  if (!name) return { ok: false, raw, reason: 'пустое название' };
  if (!facebook_page_id) return { ok: false, raw, reason: 'некорректный ID' };

  return { ok: true, raw, name, facebook_page_id, notes };
}

function friendlyCompetitorError(message: string) {
  if (/duplicate key|already exists|unique/i.test(message)) return 'уже добавлен (ID занят)';
  return message;
}

// Excel export mirrors the on-screen table 1:1: same columns, preview as an embedded image,
// link_url as a clickable hyperlink. px column widths are mapped to Excel's character units.
const exportColumns: XlsxColumn[] = tableColumns.map((column) => ({
  key: column.key,
  header: column.label,
  width: column.key === 'body_text' ? 64 : clampNumber(Math.round(column.width / 7), 12, 48),
  kind: column.key === 'preview' ? 'image' : column.key === 'link_url' ? 'link' : 'text'
}));

function buildAdExportRows(adsToExport: Ad[], geoByAd: Record<string, AdLocation[]>): XlsxRow[] {
  return adsToExport.map((ad) => {
    const { included, excluded } = groupGeoCountries(geoByAd[ad.id] ?? ad.ad_locations ?? []);
    const geoText = [
      included.length ? `Включено: ${included.join(', ')}` : '',
      excluded.length ? `Исключено: ${excluded.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('\n');

    const values: Record<string, string> = {
      ad_archive_id: ad.facebook_library_id,
      company_name: ad.competitors?.name ?? ad.competitor_id,
      preview: '',
      status: statusLabels[ad.status] ?? ad.status,
      link_url: 'Открыть объявление',
      start_day: ad.start_date_text ?? '',
      stop_day: stopDay(ad),
      days_active: daysActive(ad),
      cta: ad.cta ?? '',
      body_text: getAdBodyText(ad),
      geo: geoText,
      last_seen_at: formatDateTime(ad.last_seen_at)
    };
    for (const key of adAiAssessmentKeys) values[key] = ad[key] ?? '';

    return { values, imageUrl: primaryPreviewMediaSrc(ad), linkUrl: directAdUrl(ad) };
  });
}

async function fetchImageBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(imageProxyUrl(url));
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}

export function App() {
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [revealHidden, setRevealHidden] = useState(false);
  const [geoByAd, setGeoByAd] = useState<Record<string, AdLocation[]>>({});
  const [geoLoading, setGeoLoading] = useState(false);
  const [previewAd, setPreviewAd] = useState<Ad | null>(null);
  const [geoAd, setGeoAd] = useState<Ad | null>(null);
  const [filters, setFilters] = useState<Filters>(() => loadFilters());
  const [sortMode, setSortMode] = useState<SortMode>(() => loadSortMode());
  // Client-side pagination: how many of the fetched/sorted rows are currently rendered.
  const [visibleCount, setVisibleCount] = useState(adsPageSize);
  const [competitorsOpen, setCompetitorsOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collectCarousels, setCollectCarousels] = useState(true);
  const [tableLayout, setTableLayout] = useState<TableLayout>(() => loadTableLayout());
  const [hoveredColumnKey, setHoveredColumnKey] = useState<string | null>(null);
  const [hoveredColumnEdge, setHoveredColumnEdge] = useState<ColumnResizeEdge>('right');
  const [activeColumnKey, setActiveColumnKey] = useState<string | null>(null);
  const [activeColumnEdge, setActiveColumnEdge] = useState<ColumnResizeEdge>('right');
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [previewAspectRatios, setPreviewAspectRatios] = useState<Record<string, number>>({});
  const [tableShellWidth, setTableShellWidth] = useState(0);
  const [viewportTop, setViewportTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const tableShellRef = useRef<HTMLDivElement | null>(null);
  const columnHoverTimer = useRef<number | null>(null);
  const rowHoverTimer = useRef<number | null>(null);
  const pendingAspectRatios = useRef<Record<string, number>>({});
  const aspectRatioFlushTimer = useRef<number | null>(null);
  const scrollRafPending = useRef(false);
  const vIndicatorRef = useRef<HTMLDivElement | null>(null);
  const hIndicatorRef = useRef<HTMLDivElement | null>(null);
  const indicatorFadeTimer = useRef<number | null>(null);
  const [job, setJob] = useState<ScrapeJobSnapshot | null>(null);
  const [lastRun, setLastRun] = useState<ScrapeRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkHiding, setBulkHiding] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [assessJob, setAssessJob] = useState<AiAssessmentJobSnapshot | null>(null);
  // Anchor for shift-click range selection; sortedAds mirror lets stable handlers read the
  // current ordered list without re-creating the memoized row callbacks.
  const selectionAnchorRef = useRef<number | null>(null);
  const sortedAdsRef = useRef<Ad[]>([]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextCompetitors, nextAds] = await Promise.all([fetchCompetitors(), fetchAds(filters)]);
      setCompetitors(nextCompetitors);
      setAds(nextAds);
      void loadLastRun();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  }

  // Latest finished scrape — drives the "Собрано: …" badge. Non-critical: failures are ignored.
  async function loadLastRun() {
    try {
      const { persisted } = await fetchScrapeRuns();
      setLastRun(persisted.find((run) => run.finished_at) ?? persisted[0] ?? null);
    } catch {
      // ignore — the badge just stays as-is
    }
  }

  const competitorIdsKey = filters.competitorIds.join(',');

  useEffect(() => {
    void refresh();
  }, [competitorIdsKey, filters.status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 350);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  useEffect(() => {
    window.localStorage.setItem(filtersStorageKey, JSON.stringify(filters));
  }, [filters]);

  // Drop selected competitor ids that no longer exist (e.g. deleted competitors).
  useEffect(() => {
    if (!competitors.length || !filters.competitorIds.length) return;
    const existing = new Set(competitors.map((competitor) => competitor.id));
    const pruned = filters.competitorIds.filter((id) => existing.has(id));
    if (pruned.length !== filters.competitorIds.length) {
      setFilters((current) => ({ ...current, competitorIds: pruned }));
    }
  }, [competitors, competitorIdsKey]);

  useEffect(() => {
    saveTableLayout(tableLayout);
  }, [tableLayout]);

  useEffect(() => {
    window.localStorage.setItem(sortModeStorageKey, sortMode);
  }, [sortMode]);

  const adIdsKey = useMemo(() => ads.map((ad) => ad.id).join(','), [ads]);

  // Forget selected ids whose ads dropped out of the result set (refresh / filter change).
  useEffect(() => {
    setSelectedIds((current) => {
      if (!current.size) return current;
      const present = new Set(ads.map((ad) => ad.id));
      const next = new Set<string>();
      for (const id of current) if (present.has(id)) next.add(id);
      return next.size === current.size ? current : next;
    });
  }, [adIdsKey]);

  useEffect(() => {
    const ids = adIdsKey ? adIdsKey.split(',') : [];
    if (!ids.length) {
      setGeoByAd({});
      setGeoLoading(false);
      return undefined;
    }

    let cancelled = false;
    setGeoLoading(true);
    fetchAdLocations(ids)
      .then((map) => {
        if (cancelled) return;
        const next: Record<string, AdLocation[]> = {};
        for (const id of ids) next[id] = map[id] ?? [];
        setGeoByAd(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setGeoLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [adIdsKey]);

  useLayoutEffect(() => {
    const tableShell = tableShellRef.current;
    if (!tableShell) return undefined;

    const measureTableShell = () => {
      setTableShellWidth(Math.ceil(tableShell.clientWidth));
      setViewportHeight(Math.ceil(tableShell.clientHeight));
    };

    measureTableShell();

    const resizeObserver = new ResizeObserver(measureTableShell);
    resizeObserver.observe(tableShell);
    return () => resizeObserver.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!tableShellWidth) return;

    setTableLayout((current) => {
      const currentTableWidth = tableColumns.reduce((sum, column) => sum + columnWidth(current, column), 0);
      const missingWidth = tableShellWidth - currentTableWidth - controlColumnWidth;

      if (missingWidth <= 0) return current;

      const geoColumn = tableColumnByKey.geo;
      return {
        ...current,
        columnWidths: {
          ...current.columnWidths,
          [geoColumn.key]: columnWidth(current, geoColumn) + missingWidth
        }
      };
    });
  }, [tableShellWidth, tableLayout.columnWidths]);

  useEffect(
    () => () => {
      clearColumnHoverTimer();
      clearRowHoverTimer();
      if (aspectRatioFlushTimer.current !== null) window.clearTimeout(aspectRatioFlushTimer.current);
      if (indicatorFadeTimer.current !== null) window.clearTimeout(indicatorFadeTimer.current);
    },
    []
  );

  useEffect(() => {
    if (!job || job.status !== 'running') return undefined;

    const interval = window.setInterval(async () => {
      try {
        const nextJob = await fetchJob(job.run_id);
        setJob(nextJob);
        if (nextJob.status !== 'running') {
          await refresh();
        }
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    }, 2500);

    return () => window.clearInterval(interval);
  }, [job?.run_id, job?.status]);

  // Poll the on-demand AI assessment job; refresh the table when it finishes so the new ai_* values show.
  useEffect(() => {
    if (!assessJob || assessJob.status !== 'running') return undefined;

    const interval = window.setInterval(async () => {
      try {
        const nextJob = await fetchAdAssessmentJob(assessJob.job_id);
        setAssessJob(nextJob);
        if (nextJob.status !== 'running') {
          await refresh();
          if (nextJob.failed > 0) {
            setError(
              `AI-анализ: ${nextJob.assessed} готово, ${nextJob.skipped} пропущено, ${nextJob.failed} с ошибкой. ` +
                'Частая причина ошибок — устаревшие ссылки на медиа (нужен повторный сбор объявления).'
            );
          }
        }
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, [assessJob?.job_id, assessJob?.status]);

  async function handleStartScrape(competitorId?: string) {
    setError(null);
    try {
      const nextJob = await startScrape({ competitorId: competitorId || undefined, collectCarousels });
      setJob(nextJob);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  async function handleStartScrapeSelected(ids: string[]) {
    if (!ids.length) return;
    setError(null);
    try {
      const nextJob = await startScrape({ competitorIds: ids, collectCarousels });
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
    setGeoAd({ ...ad, ad_locations: geoByAd[ad.id] ?? ad.ad_locations ?? [] });
    try {
      setGeoAd(await fetchAd(ad.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  function clearColumnHoverTimer() {
    if (columnHoverTimer.current === null) return;
    window.clearTimeout(columnHoverTimer.current);
    columnHoverTimer.current = null;
  }

  function clearRowHoverTimer() {
    if (rowHoverTimer.current === null) return;
    window.clearTimeout(rowHoverTimer.current);
    rowHoverTimer.current = null;
  }

  function scheduleColumnHover(columnKey: string, edge: ColumnResizeEdge) {
    clearColumnHoverTimer();
    columnHoverTimer.current = window.setTimeout(() => {
      setHoveredColumnKey(columnKey);
      setHoveredColumnEdge(edge);
      columnHoverTimer.current = null;
    }, resizeHoverDelayMs);
  }

  function scheduleRowHover(rowId: string) {
    clearRowHoverTimer();
    rowHoverTimer.current = window.setTimeout(() => {
      setHoveredRowId(rowId);
      rowHoverTimer.current = null;
    }, resizeHoverDelayMs);
  }

  // Each loaded thumb reports its aspect ratio; flushing them one by one would re-render
  // the whole table per image (dozens of times during initial load). Buffer and flush once.
  function rememberPreviewAspectRatio(adId: string, aspectRatio: number | null) {
    if (!aspectRatio || !Number.isFinite(aspectRatio)) return;
    pendingAspectRatios.current[adId] = aspectRatio;
    if (aspectRatioFlushTimer.current !== null) return;

    aspectRatioFlushTimer.current = window.setTimeout(() => {
      aspectRatioFlushTimer.current = null;
      const pending = pendingAspectRatios.current;
      pendingAspectRatios.current = {};
      setPreviewAspectRatios((current) => {
        let changed = false;
        const next = { ...current };
        for (const [id, ratio] of Object.entries(pending)) {
          if (Math.abs((next[id] ?? 0) - ratio) < 0.001) continue;
          next[id] = ratio;
          changed = true;
        }
        return changed ? next : current;
      });
    }, 200);
  }

  function handleColumnResizeStart(event: ReactMouseEvent, column: TableColumn, edge: ColumnResizeEdge) {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = columnWidth(tableLayout, column);
    const columnIndex = tableColumns.findIndex((candidate) => candidate.key === column.key);
    const previousColumn = edge === 'left' ? tableColumns[columnIndex - 1] : null;
    const nextColumn = edge === 'right' ? tableColumns[columnIndex + 1] : null;
    const startPreviousWidth = previousColumn ? columnWidth(tableLayout, previousColumn) : 0;
    const startNextWidth = nextColumn ? columnWidth(tableLayout, nextColumn) : 0;
    const pairWidth = startWidth + (previousColumn ? startPreviousWidth : startNextWidth);
    clearColumnHoverTimer();
    setActiveColumnKey(column.key);
    setActiveColumnEdge(edge);
    setHoveredColumnKey(column.key);
    setHoveredColumnEdge(edge);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidths: Record<string, number> = {};

      if (edge === 'left' && previousColumn) {
        let nextWidth = clampNumber(startWidth - delta, column.minWidth, pairWidth - previousColumn.minWidth);
        let nextPreviousWidth = pairWidth - nextWidth;

        if (nextPreviousWidth < previousColumn.minWidth) {
          nextPreviousWidth = previousColumn.minWidth;
          nextWidth = pairWidth - nextPreviousWidth;
        }

        nextWidth = clampNumber(nextWidth, column.minWidth, pairWidth - previousColumn.minWidth);
        nextPreviousWidth = pairWidth - nextWidth;
        nextWidths[column.key] = nextWidth;
        nextWidths[previousColumn.key] = nextPreviousWidth;
      } else if (edge === 'right' && nextColumn) {
        let nextWidth = clampNumber(startWidth + delta, column.minWidth, pairWidth - nextColumn.minWidth);
        let nextNextWidth = pairWidth - nextWidth;

        if (nextNextWidth < nextColumn.minWidth) {
          nextNextWidth = nextColumn.minWidth;
          nextWidth = pairWidth - nextNextWidth;
        }

        nextWidth = clampNumber(nextWidth, column.minWidth, pairWidth - nextColumn.minWidth);
        nextNextWidth = pairWidth - nextWidth;
        nextWidths[column.key] = nextWidth;
        nextWidths[nextColumn.key] = nextNextWidth;
      } else {
        nextWidths[column.key] = Math.max(startWidth + delta, column.minWidth);
      }

      setTableLayout((current) => ({
        ...current,
        columnWidths: {
          ...current.columnWidths,
          ...nextWidths
        }
      }));
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.classList.remove('table-column-resizing');
      setActiveColumnKey(null);
      setHoveredColumnKey(null);
    };

    document.body.classList.add('table-column-resizing');
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }

  function handleRowResizeStart(event: ReactMouseEvent, ad: Ad) {
    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const startHeight = tableLayout.rowHeights[ad.id] ?? defaultRowHeightForAd(ad, previewAspectRatios[ad.id]);
    clearRowHoverTimer();
    setActiveRowId(ad.id);
    setHoveredRowId(ad.id);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextHeight = clampNumber(startHeight + moveEvent.clientY - startY, minRowHeight, maxRowHeight);
      setTableLayout((current) => ({
        ...current,
        rowHeights: {
          ...current.rowHeights,
          [ad.id]: nextHeight
        }
      }));
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.classList.remove('table-row-resizing');
      setActiveRowId(null);
      setHoveredRowId(null);
    };

    document.body.classList.add('table-row-resizing');
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }

  const hiddenCompetitorIds = useMemo(
    () => new Set(competitors.filter((competitor) => competitor.visible === false).map((competitor) => competitor.id)),
    [competitors]
  );
  const competitorVisibleAds = useMemo(
    () => ads.filter((ad) => !hiddenCompetitorIds.has(ad.competitor_id)),
    [ads, hiddenCompetitorIds]
  );
  const visibleAds = useMemo(() => competitorVisibleAds.filter((ad) => !ad.hidden), [competitorVisibleAds]);
  const hiddenCount = competitorVisibleAds.length - visibleAds.length;
  // Image dedup duplicates (hidden, with a canonical link) — shown only in the dedicated view.
  const duplicateAds = useMemo(
    () => competitorVisibleAds.filter((ad) => ad.duplicate_of),
    [competitorVisibleAds]
  );
  const revealedAds = revealHidden ? competitorVisibleAds : visibleAds;
  // Distinct ai_geo countries actually present in the data — the country filter's options.
  // Sentinels («Не определено», «Видео») and ads without an assessment are skipped.
  const geoOptions = useMemo(() => {
    const set = new Set<string>();
    for (const ad of competitorVisibleAds) {
      for (const token of splitGeoValues(ad.ai_geo)) {
        if (!nonCountryGeoValues.has(token)) set.add(token);
      }
    }
    return Array.from(set).sort((left, right) => left.localeCompare(right, 'ru'));
  }, [competitorVisibleAds]);
  // Client-side "country" filter: keep an ad if any of its ai_geo countries is selected.
  const geosKey = filters.geos.join('|');
  const geoFilter = useMemo(() => (filters.geos.length ? new Set(filters.geos) : null), [geosKey]);
  // Client-side "days active" filter (the value is computed in the browser, not on the server):
  // active only when an operator and a finite number are both set. Ads without a computable
  // days_active value (stopped / no start date) can't satisfy a numeric comparison, so they drop.
  const daysActiveFilter = useMemo(() => {
    const value = Number(filters.daysActiveValue);
    if (!filters.daysActiveOp || filters.daysActiveValue.trim() === '' || !Number.isFinite(value)) return null;
    return { op: filters.daysActiveOp, value };
  }, [filters.daysActiveOp, filters.daysActiveValue]);
  const renderedAds = useMemo(() => {
    if (showDuplicates) return duplicateAds; // dedicated review view — ignore the other filters
    if (!geoFilter && !daysActiveFilter) return revealedAds;
    return revealedAds.filter((ad) => {
      if (geoFilter && !splitGeoValues(ad.ai_geo).some((token) => geoFilter.has(token))) return false;
      if (daysActiveFilter) {
        const count = daysActiveCount(ad);
        if (count === null) return false;
        if (daysActiveFilter.op === '>') return count > daysActiveFilter.value;
        if (daysActiveFilter.op === '<') return count < daysActiveFilter.value;
        return count === daysActiveFilter.value;
      }
      return true;
    });
  }, [showDuplicates, duplicateAds, revealedAds, geoFilter, daysActiveFilter]);
  // "NEW сверху": stable partition — all new ads first (regardless of company), order inside
  // each group stays as fetched. With no new ads this is a no-op.
  const sortedAds = useMemo(() => {
    if (sortMode !== 'new-first') return renderedAds;
    const fresh = renderedAds.filter((ad) => ad.status === 'new');
    if (!fresh.length) return renderedAds;
    return [...fresh, ...renderedAds.filter((ad) => ad.status !== 'new')];
  }, [renderedAds, sortMode]);

  // Client-side pagination: render only the first `visibleCount` rows; "Показать ещё" grows it.
  // pagedAds is always a prefix of sortedAds, so row indices stay aligned with selection/export
  // (which keep operating on the full sortedAds set, not just the visible page).
  const pagedAds = useMemo(() => sortedAds.slice(0, visibleCount), [sortedAds, visibleCount]);
  // Snap back to the first page whenever the filter or sort changes.
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);
  useEffect(() => {
    setVisibleCount(adsPageSize);
  }, [filtersKey, sortMode]);

  // Mirror the current ordered list for the stable row handlers (shift-range, select-all).
  sortedAdsRef.current = sortedAds;
  const selectedCount = useMemo(
    () => sortedAds.reduce((sum, ad) => (selectedIds.has(ad.id) ? sum + 1 : sum), 0),
    [sortedAds, selectedIds]
  );
  const allRenderedSelected = sortedAds.length > 0 && selectedCount === sortedAds.length;
  const someRenderedSelected = selectedCount > 0 && !allRenderedSelected;

  // Row virtualization: only rows near the viewport are mounted; the rest is replaced by
  // two spacer rows so scroll geometry stays intact. Row heights are known up front.
  const virtualRowHeights = useMemo(
    () => pagedAds.map((ad) => tableLayout.rowHeights[ad.id] ?? defaultRowHeightForAd(ad, previewAspectRatios[ad.id])),
    [pagedAds, tableLayout.rowHeights, previewAspectRatios]
  );
  const virtualRowOffsets = useMemo(() => {
    const offsets = new Array<number>(virtualRowHeights.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < virtualRowHeights.length; index += 1) {
      offsets[index + 1] = offsets[index] + virtualRowHeights[index];
    }
    return offsets;
  }, [virtualRowHeights]);
  const virtualRange = useMemo(() => {
    const count = virtualRowHeights.length;
    if (!count) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };

    const overscan = 1000;
    const viewStart = Math.max(0, viewportTop - overscan);
    const viewEnd = viewportTop + (viewportHeight || 900) + overscan;
    let start = 0;
    while (start < count - 1 && virtualRowOffsets[start + 1] <= viewStart) start += 1;
    let end = start;
    while (end < count && virtualRowOffsets[end] < viewEnd) end += 1;

    return {
      start,
      end,
      topPad: virtualRowOffsets[start],
      bottomPad: Math.max(0, virtualRowOffsets[count] - virtualRowOffsets[end])
    };
  }, [virtualRowHeights, virtualRowOffsets, viewportTop, viewportHeight]);

  // Custom scroll indicators for touch devices (native overlay scrollbars are painted
  // under sticky cells). Updated directly through the DOM — no React re-renders.
  function updateScrollIndicators() {
    const shell = tableShellRef.current;
    const vertical = vIndicatorRef.current;
    const horizontal = hIndicatorRef.current;
    if (!shell || !vertical || !horizontal) return;

    const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = shell;

    if (scrollHeight > clientHeight + 1) {
      const track = clientHeight - 4;
      const size = Math.max(32, (clientHeight / scrollHeight) * track);
      const position = (scrollTop / (scrollHeight - clientHeight)) * (track - size);
      vertical.style.height = `${Math.round(size)}px`;
      vertical.style.transform = `translateY(${Math.round(position)}px)`;
      vertical.style.opacity = '1';
    } else {
      vertical.style.opacity = '0';
    }

    if (scrollWidth > clientWidth + 1) {
      const track = clientWidth - 4;
      const size = Math.max(32, (clientWidth / scrollWidth) * track);
      const position = (scrollLeft / (scrollWidth - clientWidth)) * (track - size);
      horizontal.style.width = `${Math.round(size)}px`;
      horizontal.style.transform = `translateX(${Math.round(position)}px)`;
      horizontal.style.opacity = '1';
    } else {
      horizontal.style.opacity = '0';
    }

    if (indicatorFadeTimer.current !== null) window.clearTimeout(indicatorFadeTimer.current);
    indicatorFadeTimer.current = window.setTimeout(() => {
      indicatorFadeTimer.current = null;
      if (vIndicatorRef.current) vIndicatorRef.current.style.opacity = '0';
      if (hIndicatorRef.current) hIndicatorRef.current.style.opacity = '0';
    }, 800);
  }

  function handleTableScroll() {
    if (scrollRafPending.current) return;
    scrollRafPending.current = true;
    requestAnimationFrame(() => {
      scrollRafPending.current = false;
      const shell = tableShellRef.current;
      if (!shell) return;
      updateScrollIndicators();
      // Quantize so horizontal scrolling and tiny moves don't trigger re-renders.
      const quantized = Math.floor(shell.scrollTop / 160) * 160;
      setViewportTop((current) => (current === quantized ? current : quantized));
    });
  }
  const counters = useMemo(
    () => ({
      competitors: competitors.length,
      enabled: competitors.filter((competitor) => competitor.enabled).length,
      ads: visibleAds.length,
      active: visibleAds.filter((ad) => ad.status === 'active' || ad.status === 'new').length
    }),
    [visibleAds, competitors]
  );
  const baseTableWidth = useMemo(
    () => tableColumns.reduce((sum, column) => sum + columnWidth(tableLayout, column), 0),
    [tableLayout.columnWidths]
  );
  const tableWidth = baseTableWidth + controlColumnWidth;
  const lastScrapeAt = lastRun?.finished_at ? formatDateTime(lastRun.finished_at) : null;
  const lastScrapeDuration = lastRun ? formatScrapeDuration(lastRun) : null;
  const activeResizeColumnKey = activeColumnKey ?? hoveredColumnKey;
  const activeResizeColumnEdge = activeColumnKey ? activeColumnEdge : hoveredColumnEdge;
  const activeResizeRowId = activeRowId ?? hoveredRowId;
  const pinnedColumnKey = tableLayout.pinnedColumnKey;
  const pinnedColumnIndex = pinnedColumnKey
    ? tableColumns.findIndex((column) => column.key === pinnedColumnKey)
    : -1;
  const pinnedLeftOffsets = useMemo(() => {
    const offsets: Record<string, number> = {};
    let left = controlColumnWidth;
    for (let index = 0; index <= pinnedColumnIndex; index += 1) {
      offsets[tableColumns[index].key] = left;
      left += columnWidth(tableLayout, tableColumns[index]);
    }
    return offsets;
  }, [pinnedColumnIndex, tableLayout.columnWidths]);

  function pinnedColumnClass(columnKey: string) {
    if (pinnedColumnIndex < 0) return '';
    const index = tableColumns.findIndex((column) => column.key === columnKey);
    if (index < 0 || index > pinnedColumnIndex) return '';
    return index === pinnedColumnIndex ? 'col-pinned col-pinned-last' : 'col-pinned';
  }

  function pinnedColumnStyle(columnKey: string): CSSProperties | undefined {
    const left = pinnedLeftOffsets[columnKey];
    return left === undefined ? undefined : { left };
  }

  function togglePinnedColumn(columnKey: string) {
    setTableLayout((current) => ({
      ...current,
      pinnedColumnKey: current.pinnedColumnKey === columnKey ? null : columnKey
    }));
  }

  function columnBoundaryClass(columnKey: string) {
    if (activeResizeColumnKey !== columnKey) return '';
    return activeResizeColumnEdge === 'left' ? 'column-boundary-left-active' : 'column-boundary-right-active';
  }

  function renderColumnResizeHandle(
    column: TableColumn,
    edge: ColumnResizeEdge = 'right',
    placement: ColumnResizeEdge = edge
  ) {
    return (
      <span
        className={`column-resize-handle ${placement}-edge`}
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        onMouseEnter={() => scheduleColumnHover(column.key, edge)}
        onMouseLeave={() => {
          clearColumnHoverTimer();
          setHoveredColumnKey((current) =>
            current === column.key && (activeColumnKey !== column.key || activeColumnEdge !== edge) ? null : current
          );
        }}
        onMouseDown={(event) => handleColumnResizeStart(event, column, edge)}
      />
    );
  }

  function renderColumnBoundaryHandle(column: TableColumn) {
    const columnIndex = tableColumns.findIndex((candidate) => candidate.key === column.key);

    if (columnIndex <= 0) return null;

    return renderColumnResizeHandle(column, 'left', 'left');
  }

  function handleToggleAdHidden(ad: Ad, hidden: boolean) {
    setAds((current) => current.map((item) => (item.id === ad.id ? { ...item, hidden } : item)));
    setAdHidden(ad.id, hidden).catch((requestError) => {
      setAds((current) => current.map((item) => (item.id === ad.id ? { ...item, hidden: !hidden } : item)));
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    });
  }

  // Restore a creative the dedup wrongly grouped: it becomes visible + locked, so it drops out
  // of the duplicates view and never gets auto-hidden again.
  function handleUnmarkDuplicate(ad: Ad) {
    const previous = { hidden: ad.hidden, duplicate_of: ad.duplicate_of, dedup_locked: ad.dedup_locked };
    setAds((current) =>
      current.map((item) =>
        item.id === ad.id ? { ...item, hidden: false, duplicate_of: null, dedup_locked: true } : item
      )
    );
    unmarkAdDuplicate(ad.id).catch((requestError) => {
      setAds((current) => current.map((item) => (item.id === ad.id ? { ...item, ...previous } : item)));
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    });
  }

  function enterSelectionMode() {
    setSelectionMode(true);
    // On mobile the controls live behind the burger — open it so the action bar is visible.
    setMobileMenuOpen(true);
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
    selectionAnchorRef.current = null;
  }

  function handleClearSelection() {
    setSelectedIds(new Set());
    selectionAnchorRef.current = null;
  }

  function handleSelectAllRendered() {
    setSelectedIds(new Set(sortedAdsRef.current.map((ad) => ad.id)));
  }

  function handleToggleSelectAll() {
    const list = sortedAdsRef.current;
    const everySelected = list.length > 0 && list.every((ad) => selectedIds.has(ad.id));
    if (everySelected) handleClearSelection();
    else handleSelectAllRendered();
  }

  // Single click toggles one row; shift-click selects the whole range from the last anchor
  // (Gmail / file-manager style), so large contiguous spans take two clicks.
  function handleToggleSelect(ad: Ad, index: number, shiftKey: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      const anchor = selectionAnchorRef.current;
      if (shiftKey && anchor !== null && anchor !== index) {
        const list = sortedAdsRef.current;
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
        for (let cursor = from; cursor <= to; cursor += 1) {
          const item = list[cursor];
          if (item) next.add(item.id);
        }
      } else if (next.has(ad.id)) {
        next.delete(ad.id);
      } else {
        next.add(ad.id);
      }
      return next;
    });
    selectionAnchorRef.current = index;
  }

  async function handleBulkHide() {
    const ids = sortedAdsRef.current.filter((ad) => selectedIds.has(ad.id)).map((ad) => ad.id);
    if (!ids.length || bulkHiding) return;
    const idSet = new Set(ids);
    setBulkHiding(true);
    setError(null);
    setAds((current) => current.map((ad) => (idSet.has(ad.id) ? { ...ad, hidden: true } : ad)));
    try {
      await bulkSetAdHidden(ids, true);
      handleClearSelection();
    } catch (requestError) {
      setAds((current) => current.map((ad) => (idSet.has(ad.id) ? { ...ad, hidden: false } : ad)));
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBulkHiding(false);
    }
  }

  async function handleBulkAssess() {
    const ids = sortedAdsRef.current.filter((ad) => selectedIds.has(ad.id)).map((ad) => ad.id);
    if (!ids.length || assessJob?.status === 'running') return;
    setError(null);
    try {
      const job = await startAdAssessment(ids);
      setAssessJob(job);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  async function handleExportSelected() {
    const adsToExport = sortedAdsRef.current.filter((ad) => selectedIds.has(ad.id));
    if (!adsToExport.length || exportProgress) return;
    setError(null);
    setExportProgress({ done: 0, total: adsToExport.length });
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await exportToXlsx({
        fileName: `ad-library-${stamp}.xlsx`,
        sheetName: 'Объявления',
        columns: exportColumns,
        rows: buildAdExportRows(adsToExport, geoByAd),
        resolveImage: fetchImageBuffer,
        onProgress: (done, total) => setExportProgress({ done, total })
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setExportProgress(null);
    }
  }

  const rowHandlersRef = useRef<RowHandlers>(null!);
  rowHandlersRef.current = {
    onColumnHandleEnter: scheduleColumnHover,
    onColumnHandleLeave: (columnKey, edge) => {
      clearColumnHoverTimer();
      setHoveredColumnKey((current) =>
        current === columnKey && (activeColumnKey !== columnKey || activeColumnEdge !== edge) ? null : current
      );
    },
    onColumnResizeStart: handleColumnResizeStart,
    onRowHandleEnter: scheduleRowHover,
    onRowHandleLeave: (adId) => {
      clearRowHoverTimer();
      setHoveredRowId((current) => (current === adId && activeRowId !== adId ? null : current));
    },
    onRowResizeStart: handleRowResizeStart,
    onToggleHidden: handleToggleAdHidden,
    onToggleSelect: handleToggleSelect,
    onUnmarkDuplicate: handleUnmarkDuplicate,
    onOpenPreview: (ad) => void openPreview(ad),
    onOpenGeo: (ad) => void openGeo(ad),
    onAspectRatio: rememberPreviewAspectRatio
  };
  const stableRowHandlers = useMemo<RowHandlers>(
    () => ({
      onColumnHandleEnter: (key, edge) => rowHandlersRef.current.onColumnHandleEnter(key, edge),
      onColumnHandleLeave: (key, edge) => rowHandlersRef.current.onColumnHandleLeave(key, edge),
      onColumnResizeStart: (event, column, edge) => rowHandlersRef.current.onColumnResizeStart(event, column, edge),
      onRowHandleEnter: (adId) => rowHandlersRef.current.onRowHandleEnter(adId),
      onRowHandleLeave: (adId) => rowHandlersRef.current.onRowHandleLeave(adId),
      onRowResizeStart: (event, ad) => rowHandlersRef.current.onRowResizeStart(event, ad),
      onToggleHidden: (ad, hidden) => rowHandlersRef.current.onToggleHidden(ad, hidden),
      onToggleSelect: (ad, index, shiftKey) => rowHandlersRef.current.onToggleSelect(ad, index, shiftKey),
      onUnmarkDuplicate: (ad) => rowHandlersRef.current.onUnmarkDuplicate(ad),
      onOpenPreview: (ad) => rowHandlersRef.current.onOpenPreview(ad),
      onOpenGeo: (ad) => rowHandlersRef.current.onOpenGeo(ad),
      onAspectRatio: (adId, ratio) => rowHandlersRef.current.onAspectRatio(adId, ratio)
    }),
    []
  );

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Facebook Ad Library</p>
          <h1>Таблица объявлений конкурентов</h1>
        </div>
        <div className="topbar-actions">
          {lastScrapeAt && (
            <div className="last-scrape desktop-only">
              <span>
                Собрано: <strong>{lastScrapeAt}</strong>
              </span>
              {lastScrapeDuration && (
                <span
                  className="last-scrape-info"
                  tabIndex={0}
                  title={`Собрано за: ${lastScrapeDuration}`}
                  aria-label={`Собрано за: ${lastScrapeDuration}`}
                >
                  <Info size={15} />
                </span>
              )}
            </div>
          )}
          <button className="icon-button desktop-only" onClick={() => void refresh()} title="Обновить">
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </button>
          <button className="secondary-button" onClick={() => setCompetitorsOpen(true)}>
            <Settings size={18} />
            Конкуренты
          </button>
          <label className="topbar-toggle desktop-only">
            <input
              type="checkbox"
              checked={collectCarousels}
              onChange={(event) => setCollectCarousels(event.target.checked)}
            />
            <span>Карусели</span>
          </label>
          <button
            className="primary-button"
            onClick={() => void handleStartScrape()}
            disabled={job?.status === 'running'}
          >
            <Play size={18} />
            {job?.status === 'running' ? 'Идёт сбор…' : 'Собрать включенных'}
          </button>
          <button
            type="button"
            className="icon-button burger-button"
            onClick={() => setMobileMenuOpen((value) => !value)}
            aria-expanded={mobileMenuOpen ? 'true' : 'false'}
            title={mobileMenuOpen ? 'Скрыть фильтры и статистику' : 'Фильтры и статистика'}
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
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

      {job && <JobPanel job={job} onStop={() => void handleStopScrape()} />}

      <div className={`collapsible-controls ${mobileMenuOpen ? 'open' : ''}`.trim()}>
        <div className="mobile-extra">
          <button type="button" className="secondary-button" onClick={() => void refresh()}>
            <RefreshCw size={17} className={loading ? 'spin' : ''} />
            Обновить
          </button>
          <label className="topbar-toggle">
            <input
              type="checkbox"
              checked={collectCarousels}
              onChange={(event) => setCollectCarousels(event.target.checked)}
            />
            <span>Карусели</span>
          </label>
        </div>

        <section className="metrics">
          <Metric icon={<Database size={18} />} label="Объявлений" value={counters.ads} />
          <Metric icon={<CheckCircle2 size={18} />} label="Включено конкурентов" value={counters.enabled} />
          <Metric icon={<CirclePause size={18} />} label="Всего конкурентов" value={counters.competitors} />
          <Metric icon={<Filter size={18} />} label="Активных в таблице" value={counters.active} />
        </section>

      {selectionMode ? (
        <section className="toolbar selection-toolbar" aria-label="Действия с выбранными объявлениями">
          <div className="selection-group">
            <SelectAllCheckbox
              checked={allRenderedSelected}
              indeterminate={someRenderedSelected}
              disabled={!sortedAds.length}
              onToggle={handleToggleSelectAll}
            />
            <span className="selection-count">
              Выбрано <strong>{selectedCount}</strong> из {sortedAds.length}
            </span>
            <button
              type="button"
              className="selection-link"
              onClick={handleSelectAllRendered}
              disabled={!sortedAds.length || allRenderedSelected}
            >
              Выбрать все
            </button>
            <button type="button" className="selection-link" onClick={handleClearSelection} disabled={!selectedCount}>
              Снять все
            </button>
          </div>
          <div className="selection-group selection-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleBulkHide()}
              disabled={!selectedCount || bulkHiding}
              title="Скрыть выбранные объявления из таблицы"
            >
              {bulkHiding ? <Loader2 size={17} className="spin" /> : <EyeOff size={17} />}
              Скрыть{selectedCount ? ` (${selectedCount})` : ''}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleBulkAssess()}
              disabled={!selectedCount || assessJob?.status === 'running'}
              title="Прогнать AI-анализ по выбранным креативам (включая те, что помечены дублями)"
            >
              {assessJob?.status === 'running' ? <Loader2 size={17} className="spin" /> : <Sparkles size={17} />}
              {assessJob?.status === 'running'
                ? `AI-анализ… ${assessJob.done}/${assessJob.total}`
                : `AI-анализ${selectedCount ? ` (${selectedCount})` : ''}`}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => void handleExportSelected()}
              disabled={!selectedCount || Boolean(exportProgress)}
              title="Выгрузить выбранные объявления в Excel (.xlsx) с превью и ссылкой"
            >
              {exportProgress ? <Loader2 size={17} className="spin" /> : <Download size={17} />}
              {exportProgress
                ? `Экспорт… ${exportProgress.done}/${exportProgress.total}`
                : `Экспорт в Excel${selectedCount ? ` (${selectedCount})` : ''}`}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={exitSelectionMode}
              title="Выйти из режима выделения"
              aria-label="Выйти из режима выделения"
            >
              <X size={18} />
            </button>
          </div>
        </section>
      ) : (
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
            value={filters.status}
            title="Фильтр по статусу"
            aria-label="Фильтр по статусу"
            onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
          >
            <option value="">Любой статус</option>
            <option value="active">Активно + new</option>
            <option value="new">NEW</option>
            <option value="stopped">Остановлено</option>
            <option value="inactive">Inactive</option>
            <option value="unknown">Неизвестно</option>
          </select>
          <FiltersMenu
            competitors={competitors}
            geoOptions={geoOptions}
            filters={filters}
            onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
          />
          <div className="sort-toggle" role="group" aria-label="Порядок строк">
            <button
              type="button"
              className={sortMode === 'company' ? 'active' : ''}
              title="Как собрано: строки идут подряд по компаниям"
              onClick={() => setSortMode('company')}
            >
              По компаниям
            </button>
            <button
              type="button"
              className={sortMode === 'new-first' ? 'active' : ''}
              title="Сначала все NEW, независимо от компании"
              onClick={() => setSortMode('new-first')}
            >
              NEW сверху
            </button>
          </div>
          <button
            type="button"
            className="secondary-button select-mode-button"
            onClick={enterSelectionMode}
            title="Режим выделения: отметить объявления и выполнить действия"
          >
            <ListChecks size={18} />
            Выделить
          </button>
          <button
            type="button"
            className={`secondary-button view-toggle-button ${showDuplicates ? 'active' : ''}`.trim()}
            onClick={() => setShowDuplicates((value) => !value)}
            title="Показать объявления, скрытые как дубли — и при необходимости вернуть в таблицу"
          >
            <Copy size={18} />
            Дубли{duplicateAds.length ? ` (${duplicateAds.length})` : ''}
          </button>
        </section>
      )}
      </div>

      <section className="table-section">
        <div className="table-shell" ref={tableShellRef} onScroll={handleTableScroll}>
          <table className="ad-table" style={{ width: tableWidth, minWidth: tableWidth }}>
            <colgroup>
              <col style={{ width: controlColumnWidth }} />
              {tableColumns.map((column) => (
                <col key={column.key} style={{ width: columnWidth(tableLayout, column) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th
                  className={`control-col ${pinnedColumnIndex >= 0 ? 'col-pinned' : ''}`.trim()}
                  style={pinnedColumnIndex >= 0 ? { width: controlColumnWidth, left: 0 } : { width: controlColumnWidth }}
                >
                  {selectionMode ? (
                    <div className="control-cell">
                      <SelectAllCheckbox
                        checked={allRenderedSelected}
                        indeterminate={someRenderedSelected}
                        disabled={!sortedAds.length}
                        onToggle={handleToggleSelectAll}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={`control-toggle ${revealHidden ? 'is-revealing' : ''}`.trim()}
                      onClick={() => setRevealHidden((value) => !value)}
                      title={
                        revealHidden
                          ? `Скрыть скрытые объявления${hiddenCount ? ` (${hiddenCount})` : ''}`
                          : `Показать скрытые объявления${hiddenCount ? ` (${hiddenCount})` : ''}`
                      }
                    >
                      {revealHidden ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  )}
                </th>
                {tableColumns.map((column, columnIndex) => (
                  <th
                    key={column.key}
                    className={
                      [columnBoundaryClass(column.key), pinnedColumnClass(column.key)].filter(Boolean).join(' ') ||
                      undefined
                    }
                    style={{ width: columnWidth(tableLayout, column), ...pinnedColumnStyle(column.key) }}
                  >
                    <span className="column-title">{column.label}</span>
                    {columnIndex <= pinnableMaxColumnIndex && (
                      <button
                        type="button"
                        className={`pin-button ${pinnedColumnKey === column.key ? 'active' : ''}`.trim()}
                        onClick={() => togglePinnedColumn(column.key)}
                        title={
                          pinnedColumnKey === column.key
                            ? 'Открепить столбцы'
                            : `Закрепить столбцы по ${column.label} включительно`
                        }
                      >
                        {pinnedColumnKey === column.key ? <PinOff size={13} /> : <Pin size={13} />}
                      </button>
                    )}
                    {renderColumnBoundaryHandle(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {virtualRange.topPad > 0 && (
                <tr className="virtual-spacer" aria-hidden="true">
                  <td colSpan={tableColumns.length + 1} style={{ height: virtualRange.topPad }} />
                </tr>
              )}
              {pagedAds.slice(virtualRange.start, virtualRange.end).map((ad, sliceIndex) => (
                <AdRow
                  key={ad.id}
                  ad={ad}
                  rowIndex={virtualRange.start + sliceIndex}
                  rowHeight={virtualRowHeights[virtualRange.start + sliceIndex]}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(ad.id)}
                  duplicatesView={showDuplicates}
                  pinnedColumnIndex={pinnedColumnIndex}
                  pinnedLeftOffsets={pinnedLeftOffsets}
                  activeResizeColumnKey={activeResizeColumnKey}
                  activeResizeColumnEdge={activeResizeColumnEdge}
                  activeResizeRowId={activeResizeRowId}
                  geoLocations={geoByAd[ad.id]}
                  geoLoading={geoLoading}
                  handlers={stableRowHandlers}
                />
              ))}
              {virtualRange.bottomPad > 0 && (
                <tr className="virtual-spacer" aria-hidden="true">
                  <td colSpan={tableColumns.length + 1} style={{ height: virtualRange.bottomPad }} />
                </tr>
              )}
            </tbody>
          </table>
          {sortedAds.length > visibleCount && (
            <div className="show-more">
              <button
                type="button"
                className="show-more-btn"
                onClick={() => setVisibleCount((current) => current + adsPageSize)}
              >
                Показать ещё {Math.min(adsPageSize, sortedAds.length - visibleCount)} (показано{' '}
                {visibleCount} из {sortedAds.length})
              </button>
            </div>
          )}
          {!renderedAds.length && (
            <div className="empty">
              {showDuplicates
                ? 'Дублей нет — все собранные креативы уникальны.'
                : ads.length === 0
                  ? 'Пока нет сохраненных объявлений. Добавьте конкурента и запустите сбор.'
                  : competitorVisibleAds.length === 0
                    ? 'Все объявления скрыты. Включите видимость конкурента (иконка «глаз») в разделе «Конкуренты».'
                    : revealedAds.length === 0
                      ? 'Все объявления скрыты вручную. Нажмите «глаз» в шапке таблицы, чтобы показать их.'
                      : 'Нет объявлений, подходящих под выбранные фильтры.'}
            </div>
          )}
        </div>
        <div className="scroll-indicator vertical" ref={vIndicatorRef} aria-hidden="true" />
        <div className="scroll-indicator horizontal" ref={hIndicatorRef} aria-hidden="true" />
      </section>

      {competitorsOpen && (
        <CompetitorsDialog
          competitors={competitors}
          onClose={() => setCompetitorsOpen(false)}
          onChanged={() => void refresh()}
          onScrape={(id) => void handleStartScrape(id)}
          onScrapeSelected={(ids) => void handleStartScrapeSelected(ids)}
          scrapeRunning={job?.status === 'running'}
        />
      )}

      {previewAd && <PreviewModal ad={previewAd} onClose={() => setPreviewAd(null)} />}
      {geoAd && <GeoDrawer ad={geoAd} onClose={() => setGeoAd(null)} />}
    </main>
  );
}

const AdRow = memo(function AdRow({
  ad,
  rowIndex,
  rowHeight,
  selectionMode,
  selected,
  duplicatesView,
  pinnedColumnIndex,
  pinnedLeftOffsets,
  activeResizeColumnKey,
  activeResizeColumnEdge,
  activeResizeRowId,
  geoLocations,
  geoLoading,
  handlers
}: {
  ad: Ad;
  rowIndex: number;
  rowHeight: number;
  selectionMode: boolean;
  selected: boolean;
  duplicatesView: boolean;
  pinnedColumnIndex: number;
  pinnedLeftOffsets: Record<string, number>;
  activeResizeColumnKey: string | null;
  activeResizeColumnEdge: ColumnResizeEdge;
  activeResizeRowId: string | null;
  geoLocations: AdLocation[] | undefined;
  geoLoading: boolean;
  handlers: RowHandlers;
}) {
  const rowStyle = { '--row-height': `${rowHeight}px` } as CSSProperties;
  const hidden = Boolean(ad.hidden);

  function columnBoundaryClass(columnKey: string) {
    if (activeResizeColumnKey !== columnKey) return '';
    return activeResizeColumnEdge === 'left' ? 'column-boundary-left-active' : 'column-boundary-right-active';
  }

  function pinnedColumnClass(columnKey: string) {
    if (pinnedColumnIndex < 0) return '';
    const index = tableColumns.findIndex((column) => column.key === columnKey);
    if (index < 0 || index > pinnedColumnIndex) return '';
    return index === pinnedColumnIndex ? 'col-pinned col-pinned-last' : 'col-pinned';
  }

  function pinnedColumnStyle(columnKey: string): CSSProperties | undefined {
    const left = pinnedLeftOffsets[columnKey];
    return left === undefined ? undefined : { left };
  }

  function cellProps(columnKey: string) {
    const className = [columnBoundaryClass(columnKey), pinnedColumnClass(columnKey)].filter(Boolean).join(' ');
    return { className: className || undefined, style: pinnedColumnStyle(columnKey) };
  }

  function boundaryHandle(column: TableColumn) {
    if (tableColumns.findIndex((candidate) => candidate.key === column.key) <= 0) return null;
    return (
      <span
        className="column-resize-handle left-edge"
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        onMouseEnter={() => handlers.onColumnHandleEnter(column.key, 'left')}
        onMouseLeave={() => handlers.onColumnHandleLeave(column.key, 'left')}
        onMouseDown={(event) => handlers.onColumnResizeStart(event, column, 'left')}
      />
    );
  }

  function rowHandle() {
    return (
      <span
        className="row-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        onMouseEnter={() => handlers.onRowHandleEnter(ad.id)}
        onMouseLeave={() => handlers.onRowHandleLeave(ad.id)}
        onMouseDown={(event) => handlers.onRowResizeStart(event, ad)}
      />
    );
  }

  function geoCell() {
    if (geoLocations === undefined) {
      return geoLoading ? (
        <span className="geo-loading">
          <Loader2 size={14} className="spin" />
        </span>
      ) : null;
    }
    if (!geoLocations.length) return null;
    return (
      <button type="button" className="geo-button" onClick={() => handlers.onOpenGeo(ad)}>
        <MapPinned size={15} />
        geo
      </button>
    );
  }

  return (
    <tr
      className={[
        'resizable-row',
        activeResizeRowId === ad.id ? 'row-boundary-active' : '',
        hidden ? 'row-hidden' : '',
        selected ? 'row-selected' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={rowStyle}
    >
      <td
        className={`control-col ${pinnedColumnIndex >= 0 ? 'col-pinned' : ''}`.trim()}
        style={pinnedColumnIndex >= 0 ? { left: 0 } : undefined}
      >
        <div className="cell-content control-cell">
          {selectionMode ? (
            <input
              type="checkbox"
              className="select-checkbox"
              checked={selected}
              readOnly
              aria-label={selected ? 'Снять выделение объявления' : 'Выделить объявление'}
              onClick={(event) => handlers.onToggleSelect(ad, rowIndex, event.shiftKey)}
            />
          ) : duplicatesView ? (
            <button
              type="button"
              className="row-hide-button"
              onClick={() => handlers.onUnmarkDuplicate(ad)}
              title="Это не дубль — вернуть в таблицу (больше не будет скрываться автоматически)"
            >
              <Eye size={16} />
            </button>
          ) : (
            <button
              type="button"
              className={`row-hide-button ${hidden ? 'is-hidden' : ''}`.trim()}
              onClick={() => handlers.onToggleHidden(ad, !hidden)}
              title={hidden ? 'Вернуть объявление в таблицу' : 'Скрыть объявление из таблицы'}
            >
              {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}
        </div>
        {rowHandle()}
      </td>
      <td {...cellProps('ad_archive_id')}>
        <div className="cell-content mono">{ad.facebook_library_id}</div>
        {boundaryHandle(tableColumnByKey.ad_archive_id)}
        {rowHandle()}
      </td>
      <td {...cellProps('company_name')}>
        <div className="cell-content">{ad.competitors?.name ?? ad.competitor_id}</div>
        {boundaryHandle(tableColumnByKey.company_name)}
        {rowHandle()}
      </td>
      <td {...cellProps('preview')}>
        <div className="cell-content">
          <PreviewThumb
            ad={ad}
            onOpen={() => handlers.onOpenPreview(ad)}
            onAspectRatio={(aspectRatio) => handlers.onAspectRatio(ad.id, aspectRatio)}
          />
        </div>
        {boundaryHandle(tableColumnByKey.preview)}
        {rowHandle()}
      </td>
      <td {...cellProps('status')}>
        <div className="cell-content">
          <span className={`status-pill ${ad.status}`}>{statusLabels[ad.status] ?? ad.status}</span>
        </div>
        {boundaryHandle(tableColumnByKey.status)}
        {rowHandle()}
      </td>
      <td {...cellProps('link_url')}>
        <div className="cell-content">
          <a className="table-link" href={directAdUrl(ad)} target="_blank" rel="noreferrer">
            ссылка
            <ExternalLink size={14} />
          </a>
        </div>
        {boundaryHandle(tableColumnByKey.link_url)}
        {rowHandle()}
      </td>
      <td {...cellProps('start_day')}>
        <div className="cell-content">{ad.start_date_text ?? ''}</div>
        {boundaryHandle(tableColumnByKey.start_day)}
        {rowHandle()}
      </td>
      <td {...cellProps('stop_day')}>
        <div className="cell-content">{stopDay(ad)}</div>
        {boundaryHandle(tableColumnByKey.stop_day)}
        {rowHandle()}
      </td>
      <td {...cellProps('days_active')}>
        <div className="cell-content number-cell">{daysActive(ad)}</div>
        {boundaryHandle(tableColumnByKey.days_active)}
        {rowHandle()}
      </td>
      <td {...cellProps('cta')}>
        <div className="cell-content">{ad.cta ?? ''}</div>
        {boundaryHandle(tableColumnByKey.cta)}
        {rowHandle()}
      </td>
      <td {...cellProps('body_text')}>
        <div className="cell-content body-cell">{getAdBodyText(ad)}</div>
        {boundaryHandle(tableColumnByKey.body_text)}
        {rowHandle()}
      </td>
      <td className={columnBoundaryClass('geo')}>
        <div className="cell-content">{geoCell()}</div>
        {boundaryHandle(tableColumnByKey.geo)}
        {rowHandle()}
      </td>
      <td className={columnBoundaryClass('last_seen_at')}>
        <div className="cell-content date-cell">{formatDateTime(ad.last_seen_at)}</div>
        {boundaryHandle(tableColumnByKey.last_seen_at)}
        {rowHandle()}
      </td>
      {adAiAssessmentKeys.map((key) => (
        <td key={key} className={columnBoundaryClass(key)}>
          <div className="cell-content body-cell ai-cell">{ad[key] ?? ''}</div>
          {boundaryHandle(tableColumnByKey[key])}
          {rowHandle()}
        </td>
      ))}
    </tr>
  );
});

// Tri-state master checkbox: checked when all rendered rows are selected, indeterminate when
// only some are. `readOnly` + onClick keeps it controlled while exposing the native click.
function SelectAllCheckbox({
  checked,
  indeterminate,
  disabled,
  onToggle,
  selectAllLabel = 'Выделить все объявления'
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onToggle: () => void;
  selectAllLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);

  const label = checked ? 'Снять выделение со всех' : selectAllLabel;
  return (
    <input
      ref={ref}
      type="checkbox"
      className="select-checkbox"
      checked={checked}
      disabled={disabled}
      readOnly
      title={label}
      aria-label={label}
      onClick={onToggle}
    />
  );
}

type FilterOption = { id: string; name: string; searchText?: string };

// Inline search + "Выбрать все/Сбросить" + scrollable checkbox list. Reused inside the
// consolidated Фильтры popover for both competitors and countries.
function CheckListFilter({
  title,
  options,
  selectedIds,
  onChange,
  searchPlaceholder,
  emptyText
}: {
  title: string;
  options: FilterOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  searchPlaceholder: string;
  emptyText: string;
}) {
  const [search, setSearch] = useState('');
  const normalizedSearch = search.trim().toLowerCase();
  const matches = normalizedSearch
    ? options.filter((option) => (option.searchText ?? option.name).toLowerCase().includes(normalizedSearch))
    : options;
  const selected = new Set(selectedIds);

  function toggle(id: string) {
    onChange(selected.has(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);
  }

  function selectAllVisible() {
    const ids = new Set(selectedIds);
    for (const option of matches) ids.add(option.id);
    onChange(Array.from(ids));
  }

  return (
    <div className="filters-section">
      <div className="filters-section-head">
        <span className="filters-section-title">{title}</span>
        {selectedIds.length > 0 && <span className="filters-section-count">{selectedIds.length}</span>}
      </div>
      <label className="multi-select-search">
        <Search size={14} />
        <input
          value={search}
          aria-label={searchPlaceholder}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={searchPlaceholder}
        />
      </label>
      <div className="multi-select-actions">
        <button type="button" onClick={selectAllVisible} disabled={!matches.length}>
          Выбрать все
        </button>
        <button type="button" onClick={() => onChange([])} disabled={!selectedIds.length}>
          Сбросить
        </button>
      </div>
      <div className="multi-select-list" role="group" aria-label={title}>
        {matches.map((option) => (
          <label key={option.id} className="multi-select-option">
            <input type="checkbox" checked={selected.has(option.id)} onChange={() => toggle(option.id)} />
            <span className="multi-select-option-name">{option.name}</span>
          </label>
        ))}
        {!matches.length && <div className="multi-select-empty">{emptyText}</div>}
      </div>
    </div>
  );
}

// Consolidated filters behind a single button: competitors + country + days-active. Status stays
// outside this menu (it's the most-used filter). The badge shows how many groups are active.
function FiltersMenu({
  competitors,
  geoOptions,
  filters,
  onChange
}: {
  competitors: Competitor[];
  geoOptions: string[];
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    const handleMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const competitorOptions = useMemo<FilterOption[]>(
    () =>
      competitors.map((competitor) => ({
        id: competitor.id,
        name: competitor.name,
        searchText: `${competitor.name} ${competitor.facebook_page_id}`
      })),
    [competitors]
  );
  const geoFilterOptions = useMemo<FilterOption[]>(
    () => geoOptions.map((name) => ({ id: name, name })),
    [geoOptions]
  );

  const daysActiveActive = Boolean(filters.daysActiveOp) && filters.daysActiveValue.trim() !== '';
  const activeCount =
    (filters.competitorIds.length ? 1 : 0) + (filters.geos.length ? 1 : 0) + (daysActiveActive ? 1 : 0);

  function resetAll() {
    onChange({ competitorIds: [], geos: [], daysActiveOp: '', daysActiveValue: '' });
  }

  return (
    <div className="multi-select filters-menu" ref={rootRef}>
      <button
        type="button"
        className={`multi-select-trigger filters-trigger ${activeCount ? 'has-value' : ''}`.trim()}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open ? 'true' : 'false'}
        aria-haspopup="dialog"
        title="Фильтры: конкуренты, страна, дни активности"
      >
        <span className="filters-trigger-label">
          <SlidersHorizontal size={16} />
          Фильтры
          {activeCount > 0 && <span className="filters-badge">{activeCount}</span>}
        </span>
        <ChevronDown size={16} className={open ? 'flip' : ''} />
      </button>
      {open && (
        <div className="multi-select-panel filters-panel">
          <CheckListFilter
            title="Конкуренты"
            options={competitorOptions}
            selectedIds={filters.competitorIds}
            onChange={(competitorIds) => onChange({ competitorIds })}
            searchPlaceholder="Поиск конкурента"
            emptyText="Ничего не найдено"
          />
          <CheckListFilter
            title="Страна (ai_geo)"
            options={geoFilterOptions}
            selectedIds={filters.geos}
            onChange={(geos) => onChange({ geos })}
            searchPlaceholder="Поиск страны"
            emptyText="Страны ещё не определены ИИ"
          />
          <div className="filters-section">
            <div className="filters-section-head">
              <span className="filters-section-title">Дни активности</span>
            </div>
            <div className="days-active-filter" role="group" aria-label="Фильтр по дням активности">
              <select
                className="days-active-op"
                value={filters.daysActiveOp}
                aria-label="Условие фильтра по дням активности"
                onChange={(event) => onChange({ daysActiveOp: event.target.value as DaysActiveOp | '' })}
              >
                <option value="">Любое</option>
                <option value=">">Больше (&gt;)</option>
                <option value="<">Меньше (&lt;)</option>
                <option value="=">Равно (=)</option>
              </select>
              <input
                type="number"
                min="0"
                inputMode="numeric"
                className="days-active-value"
                value={filters.daysActiveValue}
                disabled={!filters.daysActiveOp}
                placeholder="дней"
                aria-label="Количество дней активности"
                onChange={(event) => onChange({ daysActiveValue: event.target.value })}
              />
            </div>
          </div>
          <div className="filters-panel-footer">
            <button type="button" onClick={resetAll} disabled={!activeCount}>
              Сбросить все фильтры
            </button>
          </div>
        </div>
      )}
    </div>
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
  onScrape,
  onScrapeSelected,
  scrapeRunning
}: {
  competitors: Competitor[];
  onClose: () => void;
  onChanged: () => void;
  onScrape: (id: string) => void;
  onScrapeSelected: (ids: string[]) => void;
  scrapeRunning: boolean;
}) {
  const [name, setName] = useState('');
  const [pageId, setPageId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkFeedback, setBulkFeedback] = useState<{ added: number; problems: string[] } | null>(null);
  const [togglingEnabledId, setTogglingEnabledId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkEnabling, setBulkEnabling] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPageId, setEditPageId] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Drop selections for competitors that no longer exist (e.g. just deleted).
  useEffect(() => {
    setSelectedIds((current) => {
      if (!current.size) return current;
      const existing = new Set(competitors.map((competitor) => competitor.id));
      const next = new Set([...current].filter((id) => existing.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [competitors]);

  const allSelected = competitors.length > 0 && competitors.every((competitor) => selectedIds.has(competitor.id));
  const someSelected = selectedIds.size > 0;

  function toggleSelect(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((current) =>
      current.size === competitors.length ? new Set() : new Set(competitors.map((competitor) => competitor.id))
    );
  }

  async function handleBulkSetEnabled(enabled: boolean) {
    const ids = competitors.filter((competitor) => selectedIds.has(competitor.id)).map((competitor) => competitor.id);
    if (!ids.length || bulkEnabling) return;
    setBulkEnabling(true);
    try {
      await bulkSetCompetitorsEnabled(ids, enabled);
      setSelectedIds(new Set());
      onChanged();
    } catch (bulkError) {
      console.error(bulkError);
    } finally {
      setBulkEnabling(false);
    }
  }

  function startEdit(competitor: Competitor) {
    setEditingId(competitor.id);
    setEditName(competitor.name);
    setEditPageId(competitor.facebook_page_id);
  }

  async function saveEdit(id: string) {
    const name = editName.trim();
    if (!name || !editPageId || savingEdit) return;
    setSavingEdit(true);
    try {
      await updateCompetitor(id, { name, facebook_page_id: editPageId });
      setEditingId(null);
      onChanged();
    } catch (editError) {
      console.error(editError);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleToggleEnabled(competitor: Competitor, enabled: boolean) {
    setTogglingEnabledId(competitor.id);
    try {
      await updateCompetitor(competitor.id, { enabled });
      onChanged();
    } catch (toggleError) {
      console.error(toggleError);
    } finally {
      setTogglingEnabledId(null);
    }
  }

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

  async function handleBulkSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = bulkText
      .split('\n')
      .map(parseCompetitorLine)
      .filter((line): line is ParsedCompetitorLine => line !== null);
    const valid = parsed.filter((line): line is Extract<ParsedCompetitorLine, { ok: true }> => line.ok);
    const invalid = parsed.filter((line): line is Extract<ParsedCompetitorLine, { ok: false }> => !line.ok);
    const invalidProblems = invalid.map((line) => `«${line.raw.trim()}» — ${line.reason}`);

    if (!valid.length) {
      setBulkFeedback({ added: 0, problems: invalidProblems });
      return;
    }

    setBulkSaving(true);
    try {
      const result = await bulkCreateCompetitors(
        valid.map((line) => ({
          name: line.name,
          facebook_page_id: line.facebook_page_id,
          enabled: true,
          notes: line.notes
        }))
      );
      const problems = [
        ...invalidProblems,
        ...result.errors.map(
          (error) => `«${error.name}, ${error.facebook_page_id}» — ${friendlyCompetitorError(error.message)}`
        )
      ];
      setBulkFeedback({ added: result.created.length, problems });
      if (result.created.length) {
        setBulkText('');
        onChanged();
      }
    } catch (error) {
      setBulkFeedback({
        added: 0,
        problems: [...invalidProblems, error instanceof Error ? error.message : String(error)]
      });
    } finally {
      setBulkSaving(false);
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

        <form className="competitor-bulk" onSubmit={(event) => void handleBulkSubmit(event)}>
          <div className="competitor-bulk-head">
            <strong>Массовое добавление</strong>
            <span>Формат: «Название, ID, заметка» — по одному конкуренту на строку. Заметка необязательна.</span>
          </div>
          <textarea
            value={bulkText}
            onChange={(event) => setBulkText(event.target.value)}
            placeholder={'Astons, 123456789, премиум-клиент\nAcme Realty, 987654321,'}
            rows={4}
          />
          <div className="competitor-bulk-actions">
            <button className="secondary-button" disabled={bulkSaving || !bulkText.trim()}>
              <Plus size={16} />
              Добавить списком
            </button>
            {bulkFeedback && (
              <div className={`bulk-feedback ${bulkFeedback.problems.length ? 'warn' : 'ok'}`}>
                <span>
                  Добавлено: {bulkFeedback.added}
                  {bulkFeedback.problems.length ? `, пропущено: ${bulkFeedback.problems.length}` : ''}
                </span>
                {bulkFeedback.problems.length > 0 && (
                  <ul>
                    {bulkFeedback.problems.map((problem, index) => (
                      <li key={index}>{problem}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </form>

        {competitors.length > 0 && (
          <div className="competitor-bulk-bar">
            <label className="competitor-bulk-selectall">
              <SelectAllCheckbox
                checked={allSelected}
                indeterminate={someSelected}
                disabled={!competitors.length}
                onToggle={toggleSelectAll}
                selectAllLabel="Выделить всех конкурентов"
              />
              <span>
                Выбрано {selectedIds.size} из {competitors.length}
              </span>
            </label>
            <div className="competitor-bulk-bar-actions">
              <button
                type="button"
                className="primary-button"
                disabled={!someSelected || scrapeRunning}
                onClick={() => onScrapeSelected([...selectedIds])}
                title={scrapeRunning ? 'Сбор уже идёт' : 'Запустить сбор по выделенным конкурентам'}
              >
                {scrapeRunning ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
                Собрать{someSelected ? ` (${selectedIds.size})` : ''}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={!someSelected || bulkEnabling}
                onClick={() => void handleBulkSetEnabled(false)}
                title="Отключить выделенных конкурентов из сбора"
              >
                {bulkEnabling ? <Loader2 size={16} className="spin" /> : <CirclePause size={16} />}
                Отключить{someSelected ? ` (${selectedIds.size})` : ''}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={!someSelected || bulkEnabling}
                onClick={() => void handleBulkSetEnabled(true)}
                title="Включить выделенных конкурентов в сбор"
              >
                <CheckCircle2 size={16} />
                Включить
              </button>
              <button
                type="button"
                className="selection-link"
                disabled={!someSelected}
                onClick={() => setSelectedIds(new Set())}
              >
                Снять
              </button>
            </div>
          </div>
        )}

        <div className="competitor-list">
          {competitors.map((competitor) => {
            const isEditing = editingId === competitor.id;
            return (
              <div className={`competitor-row ${isEditing ? 'is-editing' : ''}`.trim()} key={competitor.id}>
                <input
                  type="checkbox"
                  className="competitor-select"
                  aria-label={`Выделить «${competitor.name}»`}
                  checked={selectedIds.has(competitor.id)}
                  onChange={() => toggleSelect(competitor.id)}
                />
                <div>
                  {isEditing ? (
                    <>
                      <input
                        className="competitor-edit-input"
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        placeholder="Название"
                        aria-label="Название конкурента"
                      />
                      <input
                        className="competitor-edit-input"
                        value={editPageId}
                        onChange={(event) => setEditPageId(event.target.value.replace(/\D/g, ''))}
                        placeholder="Facebook Page ID"
                        inputMode="numeric"
                        aria-label="Facebook Page ID"
                      />
                    </>
                  ) : (
                    <>
                      <strong>
                        {competitor.name}
                        <span className="competitor-count" title="Всего собрано креативов">
                          {competitor.ad_count ?? 0}
                        </span>
                      </strong>
                      <span>{competitor.facebook_page_id}</span>
                      <small>
                        последний сбор:{' '}
                        {competitor.last_scraped_at
                          ? new Date(competitor.last_scraped_at).toLocaleString('ru-RU')
                          : 'еще не было'}
                      </small>
                    </>
                  )}
                </div>
                {isEditing ? (
                  <div className="competitor-edit-actions">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void saveEdit(competitor.id)}
                      disabled={savingEdit || !editName.trim() || !editPageId}
                      title="Сохранить изменения"
                    >
                      {savingEdit ? <Loader2 size={17} className="spin" /> : <Check size={17} />}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setEditingId(null)}
                      disabled={savingEdit}
                      title="Отменить"
                    >
                      <X size={17} />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className={`switch-wrap ${togglingEnabledId === competitor.id ? 'is-toggling' : ''}`.trim()}>
                      <label
                        className="switch"
                        title={competitor.enabled ? 'Участвует в сборе — отключить' : 'Не участвует в сборе — включить'}
                      >
                        <input
                          type="checkbox"
                          aria-label={competitor.enabled ? 'Отключить конкурента из сбора' : 'Включить конкурента в сбор'}
                          checked={competitor.enabled}
                          disabled={togglingEnabledId === competitor.id}
                          onChange={(event) => void handleToggleEnabled(competitor, event.target.checked)}
                        />
                        <span />
                      </label>
                      {togglingEnabledId === competitor.id && (
                        <span className="switch-spinner">
                          <Loader2 size={14} className="spin" />
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => startEdit(competitor)}
                      title="Редактировать название и ID"
                    >
                      <Pencil size={17} />
                    </button>
                    <button
                      type="button"
                      className={`icon-button ${competitor.visible === false ? 'visibility-off' : ''}`.trim()}
                      onClick={() =>
                        updateCompetitor(competitor.id, { visible: competitor.visible === false })
                          .then(onChanged)
                          .catch(console.error)
                      }
                      title={
                        competitor.visible === false
                          ? 'Объявления скрыты из выдачи — показать'
                          : 'Объявления видны в выдаче — скрыть'
                      }
                    >
                      {competitor.visible === false ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                    <a
                      className="icon-button"
                      href={buildAdLibraryUrl(competitor.facebook_page_id)}
                      target="_blank"
                      rel="noreferrer"
                      title="Открыть страницу объявлений конкурента в Facebook Ad Library"
                    >
                      <ExternalLink size={17} />
                    </a>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => onScrape(competitor.id)}
                      title={scrapeRunning ? 'Сбор уже идёт' : 'Собрать этого конкурента'}
                      disabled={scrapeRunning}
                    >
                      <Play size={17} />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger-button"
                      onClick={() => deleteCompetitor(competitor.id).then(onChanged).catch(console.error)}
                      title="Удалить"
                    >
                      <Trash2 size={17} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function PreviewThumb({
  ad,
  onOpen,
  onAspectRatio
}: {
  ad: Ad;
  onOpen: () => void;
  onAspectRatio?: (aspectRatio: number) => void;
}) {
  const mediaItems = usePreviewMediaItems(ad);
  const primary = mediaItems[0] ?? null;
  const imageUrl = primary?.type === 'video' ? primary.poster : primary?.src;
  const aspectRatio = useMediaAspectRatio(imageUrl ?? (primary?.type === 'video' ? primary.src : null));
  const style = aspectRatio
    ? ({ '--preview-aspect-ratio': aspectRatio.toString() } as CSSProperties)
    : undefined;

  useEffect(() => {
    if (aspectRatio) onAspectRatio?.(aspectRatio);
  }, [aspectRatio]);

  return (
    <button
      className={`preview-thumb ${primary?.type === 'video' ? 'video-thumb' : ''}`}
      style={style}
      onClick={onOpen}
      title="Открыть превью"
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" referrerPolicy="origin-when-cross-origin" loading="lazy" decoding="async" />
      ) : (
        <span className="preview-placeholder">{primary?.type === 'video' ? 'video' : 'нет картинки'}</span>
      )}
      {primary?.type === 'video' && (
        <span className="play-badge" aria-hidden="true">
          <Play size={18} fill="currentColor" />
        </span>
      )}
      {mediaItems.length > 1 && <span className="carousel-badge">{mediaItems.length}</span>}
    </button>
  );
}

function PreviewModal({ ad, onClose }: { ad: Ad; onClose: () => void }) {
  const mediaItems = usePreviewMediaItems(ad);

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
          srcDoc={previewSrcDoc(ad, mediaItems)}
          allow="fullscreen; autoplay"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        />
      </section>
    </div>
  );
}

function GeoDrawer({ ad, onClose }: { ad: Ad; onClose: () => void }) {
  const { included, excluded } = groupGeoCountries(ad.ad_locations ?? []);

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
            <span>Включено стран</span>
            <strong>{included.length}</strong>
          </div>
          {excluded.length > 0 && (
            <div>
              <span>Исключено стран</span>
              <strong>{excluded.length}</strong>
            </div>
          )}
        </section>

        <section>
          <div className="locations-table">
            <div className="locations-head">
              <span>Включенные страны</span>
            </div>
            {included.map((country) => (
              <div key={country}>
                <span>{country}</span>
              </div>
            ))}
            {!included.length && <p>Гео пока не сохранено.</p>}
          </div>
          {excluded.length > 0 && (
            <div className="locations-table">
              <div className="locations-head excluded-head">
                <span>Исключенные страны</span>
              </div>
              {excluded.map((country) => (
                <div key={country}>
                  <span>{country}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
