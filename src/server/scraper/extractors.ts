import type { Locator, Page } from 'playwright';
import { buildAdArchiveIdUrl } from '../../shared/adLibraryUrl';
import { createDedupeKey } from '../../shared/dedupe';
import type { ScrapedAdInput, ScrapedLocationInput } from '../../shared/types';
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

  const primaryLooksLikePage = Boolean(
    primaryText &&
      (primaryText.includes('Библиотека рекламы') ||
        primaryText.includes('Результаты:') ||
        primaryText.split('Информация об объявлении').length > 2)
  );

  const sourceText =
    primaryLines.length > 0 && !primaryLooksLikePage && primaryLines.length <= Math.max(fallbackLines.length + 8, 18)
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

async function resolvePreview(page: Page, config: SelectorConfig, fallback: CardSnapshot) {
  await page
    .locator(config.detail.previewContainer)
    .first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => undefined);

  const containers = page.locator(config.detail.previewContainer);
  const count = await containers.count().catch(() => 0);
  let best: { html: string | null; text: string | null; score: number } = { html: null, text: null, score: -1 };

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
    const creativeText = formattedText || text;
    let score = 0;
    if (fallback.body_text && text.includes(fallback.body_text.slice(0, 40))) score += 4;
    if (fallback.title && text.includes(fallback.title)) score += 2;
    if (text.includes('Библиотека рекламы') || text.includes('Результаты:')) score -= 6;
    if (creativeText.trim().length > 20) score += 1;

    if (score > best.score) best = { html, text: creativeText, score };
  }

  return best;
}

export async function extractDetailAd(
  page: Page,
  config: SelectorConfig,
  competitorId: string,
  sourceUrl: string,
  fallback: CardSnapshot
): Promise<ScrapedAdInput> {
  const preview = await resolvePreview(page, config, fallback);
  const facebookLibraryId =
    fallback.facebook_library_id ?? matchRegex(preview.text || '', config.results.libraryIdRegex)?.[1] ?? 'unknown';
  const creative = preferCleanCreative(preview.text, fallback, config);
  const bodyText = creative.body_text ?? fallback.body_text;
  const title = creative.title ?? fallback.title;
  const cta = creative.cta ?? fallback.cta;

  return {
    competitor_id: competitorId,
    facebook_library_id: facebookLibraryId,
    source_url: facebookLibraryId === 'unknown' ? sourceUrl : buildAdArchiveIdUrl(facebookLibraryId),
    status: fallback.status,
    start_date_text: fallback.start_date_text,
    end_date_text: fallback.end_date_text,
    platforms: fallback.platforms,
    title,
    body_text: bodyText,
    cta,
    preview_html: preview.html,
    preview_text: preview.text,
    dedupe_key: createDedupeKey([title, bodyText, cta], facebookLibraryId),
    locations: await extractLocations(page, config)
  };
}
