import type { Locator, Page } from 'playwright';
import type { AdMediaItem, ScrapedAdInput, ScrapedLocationInput } from '../../shared/types';
import type { SelectorConfig } from './selectors';

export type CardSnapshot = {
  facebook_library_id: string | null;
  status: string;
  start_date_text: string | null;
  end_date_text: string | null;
  platforms: string[];
  title: string | null;
  body_text: string | null;
  cta: string | null;
  raw_text: string;
  has_multiple_versions: boolean;
};

type ExtractAdOptions = {
  collectCarousels?: boolean;
  mediaItems?: AdMediaItem[];
  previewHtml?: string | null;
};

export type CardMediaSnapshot = {
  html: string | null;
  media_items: AdMediaItem[];
};

function isLocator(root: Page | Locator): root is Locator {
  return typeof (root as Locator).page === 'function';
}

function pageFromRoot(root: Page | Locator): Page {
  return isLocator(root) ? root.page() : root;
}

async function ensureEvaluateHelpers(root: Page | Locator) {
  await pageFromRoot(root)
    .evaluate('globalThis.__name = globalThis.__name || ((target) => target)')
    .catch(() => undefined);
}

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
  /^Информация об объявлении$/,
  /^© Meta/,
  /^Meta$/,
  /^Все$/,
  /^Все объявления$/,
  /^Status system$/i
];

function matchRegex(text: string, pattern: string) {
  const regex = new RegExp(pattern, 'i');
  return text.match(regex);
}

function cleanLine(line: string) {
  return line.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeForMatch(text: string | null | undefined) {
  return cleanLine(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function meaningfulSnippet(line: string) {
  const normalized = normalizeForMatch(line);
  if (normalized.length <= 90) return normalized;
  return normalized.slice(0, 90).trim();
}

function fallbackMatchScore(text: string | null | undefined, fallback: CardSnapshot) {
  const normalizedText = normalizeForMatch(text);
  if (!normalizedText) return 0;

  let score = 0;
  const candidates = [
    fallback.title,
    ...(fallback.body_text ?? '')
      .split('\n')
      .map(cleanLine)
      .filter((line) => line.length >= 25)
      .slice(0, 4)
  ]
    .map((line) => meaningfulSnippet(line ?? ''))
    .filter((line) => line.length >= 20);

  for (const candidate of candidates) {
    if (normalizedText.includes(candidate)) score += candidate.length > 50 ? 4 : 2;
  }

  return score;
}

function isPageChromeLine(line: string, config: SelectorConfig) {
  if (!line) return true;
  if (pageChromePatterns.some((pattern) => pattern.test(line))) return true;
  if (line.startsWith('ID Библиотеки:')) return true;
  if (line.startsWith('Показ начат')) return true;
  if (line.startsWith('С ') && line.includes(' по ')) return true;
  if (line === 'Платформы') return true;
  if (line === config.results.activeText || line === config.results.inactiveText) return true;
  if (line.includes(config.results.multipleVersionsText)) return true;
  if (line.includes('Статус "Активно"')) return true;
  return false;
}

function compactLines(text: string, config: SelectorConfig, preserveBlankLines = false) {
  const lines: string[] = [];

  for (const rawLine of text.split('\n')) {
    const line = cleanLine(rawLine);

    if (!line) {
      if (preserveBlankLines && lines.length > 0 && lines[lines.length - 1] !== '') {
        lines.push('');
      }
      continue;
    }

    if (!isPageChromeLine(line, config)) {
      lines.push(line);
    }
  }

  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }

  while (deduped[0] === '') deduped.shift();
  while (deduped[deduped.length - 1] === '') deduped.pop();

  return deduped;
}

function extractCreativeParts(text: string, config: SelectorConfig) {
  const lines = compactLines(text, config, true);
  const adLabelIndex = lines.findIndex((line) =>
    config.creative.adLabelTexts.some((label) => line.toLowerCase() === label.toLowerCase())
  );
  const cta = [...lines]
    .reverse()
    .find((line) => config.creative.ctaCandidates.some((candidate) => line.toLowerCase() === candidate.toLowerCase()));

  const brandLine = adLabelIndex > 0 ? lines[adLabelIndex - 1] : null;
  const bodyStart = adLabelIndex >= 0 ? adLabelIndex + 1 : brandLine ? 2 : 0;
  const bodyLines = lines
    .slice(bodyStart)
    .filter((line) => line !== brandLine)
    .filter((line) => line !== cta)
    .filter((line) => !config.creative.adLabelTexts.includes(line))
    .filter((line) => line === '' || line.length > 1);

  while (bodyLines[0] === '') bodyLines.shift();
  while (bodyLines[bodyLines.length - 1] === '') bodyLines.pop();

  const title = bodyLines.find(Boolean) ?? brandLine ?? null;

  return {
    title,
    body_text: bodyLines.join('\n') || null,
    cta: cta ?? null
  };
}

function preferCleanCreative(primaryText: string | null, fallback: CardSnapshot, config: SelectorConfig) {
  const primaryLines = primaryText ? compactLines(primaryText, config) : [];
  const fallbackLines = compactLines(fallback.raw_text, config);
  const hasFallbackCreative = Boolean(fallback.title || fallback.body_text);
  const primaryMatchesFallback = !hasFallbackCreative || fallbackMatchScore(primaryText, fallback) > 0;

  const primaryLooksLikePage = Boolean(
    primaryText &&
      (primaryText.includes('Библиотека рекламы') ||
        primaryText.includes('Результаты:') ||
        primaryText.split('Информация об объявлении').length > 2)
  );

  const sourceText =
    primaryLines.length > 0 &&
    primaryMatchesFallback &&
    !primaryLooksLikePage &&
    primaryLines.length <= Math.max(fallbackLines.length + 8, 18)
      ? primaryLines.join('\n')
      : fallbackLines.join('\n');

  const creative = extractCreativeParts(sourceText, config);
  return {
    title: creative.title ?? fallback.title,
    body_text: creative.body_text ?? fallback.body_text,
    cta: creative.cta ?? fallback.cta
  };
}

export async function extractCardSnapshot(card: Locator, config: SelectorConfig): Promise<CardSnapshot> {
  const rawText = await card.innerText({ timeout: 4000 }).catch(() => '');
  const libraryId = matchRegex(rawText, config.results.libraryIdRegex)?.[1] ?? null;
  const dateStarted = matchRegex(rawText, config.results.dateStartedRegex)?.[1] ?? null;
  const dateRange = matchRegex(rawText, config.results.dateRangeRegex);
  const platforms = config.results.platformTexts.filter((platform) =>
    rawText.toLowerCase().includes(platform.toLowerCase())
  );
  const creative = extractCreativeParts(rawText, config);

  return {
    facebook_library_id: libraryId,
    status: rawText.includes(config.results.activeText)
      ? 'active'
      : rawText.includes(config.results.inactiveText)
        ? 'inactive'
        : 'unknown',
    start_date_text: dateStarted ?? dateRange?.[1] ?? null,
    end_date_text: dateRange?.[2] ?? null,
    platforms,
    ...creative,
    raw_text: rawText,
    has_multiple_versions: rawText.toLowerCase().includes(config.results.multipleVersionsText.toLowerCase())
  };
}

async function extractLocations(page: Page, config: SelectorConfig): Promise<ScrapedLocationInput[]> {
  const toggle = page.locator(config.detail.locationToggle).first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }

  const rows = page.locator(config.detail.locationRows);
  const count = await rows.count().catch(() => 0);
  const locations: ScrapedLocationInput[] = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const cells = await row
      .locator(config.detail.locationCells)
      .allInnerTexts()
      .catch(() => []);
    const normalized = cells.map(cleanLine).filter(Boolean);
    if (normalized.length < 2) continue;
    if (normalized.some((cell) => ['Местоположение', 'Location'].includes(cell))) continue;

    locations.push({
      location: normalized[0],
      location_type: normalized[1] ?? null,
      visibility: normalized[2] ?? null
    });
  }

  return locations;
}

async function revealCarouselSlides(container: Locator) {
  const children = container.locator('[data-type="hscroll-child"]');
  const count = await children.count().catch(() => 0);
  if (count <= 1) return;

  for (let index = 0; index < count; index += 1) {
    const child = children.nth(index);
    await child
      .evaluate((node) => {
        if (!(node instanceof HTMLElement)) return;
        const findHorizontalScroller = (element: HTMLElement) => {
          let current: HTMLElement | null = element.parentElement;
          while (current) {
            if (current.scrollWidth > current.clientWidth + 4) return current;
            current = current.parentElement;
          }
          return null;
        };
        const scroller = findHorizontalScroller(node);
        if (scroller) {
          const left = node.offsetLeft - (scroller.clientWidth - node.clientWidth) / 2;
          scroller.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
        }
        node.scrollIntoView({ block: 'nearest', inline: 'center' });
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
}

async function extractPreviewMediaItems(container: Locator, collectCarousels: boolean): Promise<AdMediaItem[]> {
  await ensureEvaluateHelpers(container);

  if (collectCarousels) {
    await revealCarouselSlides(container);
  }

  const items = await container
    .evaluate((node, shouldCollectCarousels) => {
      if (!(node instanceof HTMLElement)) return [];

      type BrowserMediaItem = AdMediaItem & { score: number };

      const isUsableSrc = (src: string | null | undefined) => Boolean(src && !src.startsWith('data:') && !src.startsWith('blob:'));
      const srcFromImage = (image: HTMLImageElement) => image.currentSrc || image.src || image.getAttribute('src') || '';
      const srcFromVideo = (video: HTMLVideoElement) =>
        video.currentSrc || video.src || video.querySelector<HTMLSourceElement>('source[src]')?.src || '';
      const linkFromElement = (element: Element) => element.querySelector<HTMLAnchorElement>('a[href]')?.href ?? null;
      const imageScore = (image: HTMLImageElement, index: number, total: number) => {
        const src = srcFromImage(image).toLowerCase();
        const sizeMatch = src.match(/[sp](\d{2,4})x(\d{2,4})/);
        const width = sizeMatch ? Number(sizeMatch[1]) : image.naturalWidth || image.width || 0;
        const height = sizeMatch ? Number(sizeMatch[2]) : image.naturalHeight || image.height || 0;
        let score = index + total;

        if (image.closest('a[href]')) score += 35;
        if (src.includes('t39.35426')) score += 80;
        if (src.includes('dst-jpg')) score += 35;
        if (src.includes('s600x600') || src.includes('s1080x1080')) score += 40;
        if (width && height) score += Math.min(width * height, 1_200_000) / 10_000;
        if (width <= 120 && height <= 120 && width && height) score -= 100;
        if (src.includes('profile') || src.includes('logo') || src.includes('p64x64') || src.includes('s64x64')) {
          score -= 80;
        }

        return score;
      };
      const mediaFromScope = (scope: HTMLElement, source: 'preview' | 'carousel', position: number): BrowserMediaItem | null => {
        const video = Array.from(scope.querySelectorAll<HTMLVideoElement>('video')).find((candidate) =>
          isUsableSrc(srcFromVideo(candidate))
        );
        if (video) {
          return {
            type: 'video',
            src: srcFromVideo(video),
            poster: video.poster || null,
            link_url: linkFromElement(scope),
            source,
            position,
            score: 1_000
          };
        }

        const images = Array.from(scope.querySelectorAll<HTMLImageElement>('img'))
          .map((image, index, all) => ({ image, score: imageScore(image, index, all.length) }))
          .filter((candidate) => isUsableSrc(srcFromImage(candidate.image)))
          .sort((left, right) => right.score - left.score);
        const best = images[0];
        if (!best) return null;

        return {
          type: 'image',
          src: srcFromImage(best.image),
          poster: null,
          link_url: linkFromElement(scope),
          source,
          position,
          score: best.score
        };
      };

      const carouselChildren = shouldCollectCarousels
        ? Array.from(node.querySelectorAll<HTMLElement>('[data-type="hscroll-child"]'))
        : [];
      const scopes = carouselChildren.length > 1 ? carouselChildren : [node];
      const source = carouselChildren.length > 1 ? 'carousel' : 'preview';
      const seen = new Set<string>();

      return scopes
        .map((scope, index) => mediaFromScope(scope, source, index))
        .filter((item): item is BrowserMediaItem => Boolean(item))
        .filter((item) => {
          if (seen.has(item.src)) return false;
          seen.add(item.src);
          return true;
        })
        .map(({ score: _score, ...item }, index) => ({ ...item, position: index }));
    }, collectCarousels)
    .catch((error) => {
      throw new Error(`Failed to extract preview media: ${error instanceof Error ? error.message : String(error)}`);
    });

  return items;
}

export async function extractCardMediaSnapshot(
  card: Locator,
  collectCarousels = true
): Promise<CardMediaSnapshot> {
  const mediaItems = await extractPreviewMediaItems(card, collectCarousels);
  const html = await card.evaluate((node) => (node instanceof HTMLElement ? node.outerHTML : null)).catch(() => null);
  return { html, media_items: mediaItems };
}

async function resolvePreview(
  root: Page | Locator,
  config: SelectorConfig,
  fallback: CardSnapshot,
  options: ExtractAdOptions = {}
) {
  await ensureEvaluateHelpers(root);

  await root
    .locator(config.detail.previewContainer)
    .first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => undefined);

  const containers = root.locator(config.detail.previewContainer);
  const count = await containers.count().catch(() => 0);
  let best: { container: Locator | null; html: string | null; text: string | null; score: number; media_items: AdMediaItem[] } = {
    container: null,
    html: null,
    text: null,
    score: -1,
    media_items: []
  };

  for (let index = 0; index < count; index += 1) {
    const container = containers.nth(index);
    if (!(await container.isVisible().catch(() => false))) continue;

    const text = await container.innerText({ timeout: 3000 }).catch(() => '');
    const formattedText = await container
      .evaluate((node) => {
        if (!(node instanceof HTMLElement)) return '';
        const textWithBreaks = (element: HTMLElement) => {
          const chunks: string[] = [];
          const walk = (child: Node) => {
            if (child.nodeType === Node.TEXT_NODE) {
              chunks.push(child.textContent ?? '');
              return;
            }

            if (child instanceof HTMLBRElement) {
              chunks.push('\n');
              return;
            }

            child.childNodes.forEach(walk);
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
        const candidates = Array.from(node.querySelectorAll<HTMLElement>('[style*="white-space: pre-wrap"]'))
          .map(textWithBreaks)
          .filter(Boolean)
          .sort((left, right) => right.length - left.length);
        return candidates[0] || node.innerText || '';
      })
      .catch(() => '');
    const html = await container
      .evaluate((node) => (node instanceof HTMLElement ? node.outerHTML : null))
      .catch(() => null);
    const metrics = await container
      .evaluate((node) => {
        if (!(node instanceof HTMLElement)) return { inViewport: false, hasVideo: false };
        const rect = node.getBoundingClientRect();
        return {
          inViewport: rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth,
          hasVideo: Boolean(node.querySelector('video, [aria-label*="video" i], [aria-label*="видео" i]'))
        };
      })
      .catch(() => ({ inViewport: false, hasVideo: false }));
    const creativeText = formattedText || text;
    const matchScore = fallbackMatchScore(creativeText, fallback);
    let score = 0;
    score += matchScore;
    if ((fallback.title || fallback.body_text) && matchScore === 0) score -= 8;
    if (metrics.inViewport) score += 2;
    else score -= 2;
    if (metrics.hasVideo && /\d+:\d+/.test(fallback.raw_text)) score += 3;
    if (text.includes('Библиотека рекламы') || text.includes('Результаты:')) score -= 6;
    if (creativeText.trim().length > 20) score += 1;

    if (score > best.score) best = { container, html, text: creativeText, score, media_items: [] };
  }

  if ((fallback.title || fallback.body_text) && best.score < 1) {
    return { html: null, text: null, score: best.score, media_items: [] };
  }

  if (best.container) {
    const mediaItems = await extractPreviewMediaItems(best.container, options.collectCarousels ?? true);
    const html = await best.container.evaluate((node) => (node instanceof HTMLElement ? node.outerHTML : null)).catch(() => best.html);
    return { html, text: best.text, score: best.score, media_items: mediaItems };
  }

  return { html: best.html, text: best.text, score: best.score, media_items: [] };
}

export async function extractDetailAd(
  page: Page,
  config: SelectorConfig,
  competitorId: string,
  sourceUrl: string,
  fallback: CardSnapshot,
  options: ExtractAdOptions = {}
): Promise<ScrapedAdInput> {
  const preview = await resolvePreview(page, config, fallback, options);
  const facebookLibraryId =
    fallback.facebook_library_id ?? matchRegex(preview.text || '', config.results.libraryIdRegex)?.[1] ?? 'unknown';
  const creative = preferCleanCreative(preview.text, fallback, config);
  const bodyText = creative.body_text ?? fallback.body_text;
  const title = creative.title ?? fallback.title;
  const cta = creative.cta ?? fallback.cta;
  const mediaItems = options.mediaItems?.length ? options.mediaItems : preview.media_items;

  return {
    competitor_id: competitorId,
    facebook_library_id: facebookLibraryId,
    source_url: sourceUrl,
    status: fallback.status,
    start_date_text: fallback.start_date_text,
    end_date_text: fallback.end_date_text,
    platforms: fallback.platforms,
    title,
    body_text: bodyText,
    cta,
    preview_html: options.previewHtml ?? preview.html,
    preview_text: preview.text,
    media_items: mediaItems,
    dedupe_key: facebookLibraryId,
    locations: await extractLocations(page, config)
  };
}

// Builds an ad purely from the result-card snapshot + the media already pulled from that card,
// with no further page interaction. Used when an opened card never rendered its detail/group
// panel: instead of dropping the card (which marks the scan incomplete and blocks reconciliation),
// we persist what the card itself showed — id, status, dates, creative text, and thumbnail media.
export function buildSnapshotFallbackAd(
  snapshot: CardSnapshot,
  competitorId: string,
  sourceUrl: string,
  options: ExtractAdOptions = {}
): ScrapedAdInput {
  const facebookLibraryId = snapshot.facebook_library_id ?? 'unknown';
  return {
    competitor_id: competitorId,
    facebook_library_id: facebookLibraryId,
    source_url: sourceUrl,
    status: snapshot.status,
    start_date_text: snapshot.start_date_text,
    end_date_text: snapshot.end_date_text,
    platforms: snapshot.platforms,
    title: snapshot.title,
    body_text: snapshot.body_text,
    cta: snapshot.cta,
    preview_html: options.previewHtml ?? null,
    preview_text: snapshot.body_text,
    media_items: options.mediaItems ?? [],
    dedupe_key: facebookLibraryId,
    locations: []
  };
}

export async function extractCardFallbackAd(
  card: Locator,
  config: SelectorConfig,
  competitorId: string,
  sourceUrl: string,
  fallback: CardSnapshot,
  options: ExtractAdOptions = {}
): Promise<ScrapedAdInput> {
  const preview = await resolvePreview(card, config, fallback, options);
  const fallbackHtml = await card.evaluate((node) => (node instanceof HTMLElement ? node.outerHTML : null)).catch(() => null);
  const fallbackText = await card.innerText({ timeout: 3000 }).catch(() => fallback.raw_text);
  const previewHtml = preview.html ?? fallbackHtml;
  const previewText = preview.text ?? fallbackText;
  const facebookLibraryId = fallback.facebook_library_id ?? 'unknown';
  const creative = preferCleanCreative(previewText, fallback, config);
  const mediaItems = options.mediaItems?.length ? options.mediaItems : preview.media_items;

  return {
    competitor_id: competitorId,
    facebook_library_id: facebookLibraryId,
    source_url: sourceUrl,
    status: fallback.status,
    start_date_text: fallback.start_date_text,
    end_date_text: fallback.end_date_text,
    platforms: fallback.platforms,
    title: creative.title ?? fallback.title,
    body_text: creative.body_text ?? fallback.body_text,
    cta: creative.cta ?? fallback.cta,
    preview_html: options.previewHtml ?? previewHtml,
    preview_text: previewText,
    media_items: mediaItems,
    dedupe_key: facebookLibraryId,
    locations: []
  };
}
