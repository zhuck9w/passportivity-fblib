import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { adAiAssessmentKeys, type AdAiAssessment, type AdMediaItem } from '../shared/types';
import { env } from './env';
import { proxiedFetch } from './proxy';

const promptsPath = path.resolve(process.cwd(), 'config', 'aiPrompts.json');
const maxFieldLength = 300;
const maxImagesPerRequest = 10;
const maxImageBytes = 8 * 1024 * 1024;
const requestTimeoutMs = 120_000;

type AiPromptsConfig = {
  system: string;
  task: string;
  singleNote: string;
  carouselNote: string;
  fields: Record<string, string>;
};

export type AdCreativeContext = {
  companyName?: string | null;
  title?: string | null;
  bodyText?: string | null;
  cta?: string | null;
};

let promptsPromise: Promise<AiPromptsConfig> | null = null;

function loadPrompts() {
  promptsPromise ??= readFile(promptsPath, 'utf8').then((raw) => JSON.parse(raw) as AiPromptsConfig);
  return promptsPromise;
}

export function isAiAssessmentEnabled() {
  return env.aiAssessmentEnabled && Boolean(env.openaiKey);
}

// Video creatives are not analyzed: a poster frame says nothing about the video itself,
// so every ai_* slot just gets this placeholder.
export const videoAssessmentPlaceholder = 'Видео';

export function mediaContainsVideo(items: AdMediaItem[] | null | undefined) {
  return (items ?? []).some((item) => item.type === 'video');
}

export function videoPlaceholderAssessment(): AdAiAssessment {
  return Object.fromEntries(adAiAssessmentKeys.map((key) => [key, videoAssessmentPlaceholder])) as AdAiAssessment;
}

export function imageUrlsFromMediaItems(items: AdMediaItem[] | null | undefined) {
  const urls: string[] = [];
  for (const item of items ?? []) {
    if (item.type !== 'image') continue;
    const candidate = item.src;
    if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
    if (!urls.includes(candidate)) urls.push(candidate);
  }
  return urls.slice(0, maxImagesPerRequest);
}

function clampField(value: unknown) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxFieldLength) return text;
  return `${text.slice(0, maxFieldLength - 1).trimEnd()}…`;
}

function fillTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function buildUserText(config: AiPromptsConfig, imageCount: number, context: AdCreativeContext) {
  const task = fillTemplate(config.task, {
    company: context.companyName?.trim() || 'не указана',
    title: context.title?.trim() || 'не указан',
    body: context.bodyText?.trim().slice(0, 1500) || 'не указан',
    cta: context.cta?.trim() || 'не указана'
  });
  const note =
    imageCount > 1 ? fillTemplate(config.carouselNote, { count: String(imageCount) }) : config.singleNote;
  const fieldLines = adAiAssessmentKeys
    .map((key) => `- ${key}: ${config.fields[key] ?? key}`)
    .join('\n');

  return `${task}\n\n${note}\n\nПоля для заполнения:\n${fieldLines}`;
}

function responseSchema(config: AiPromptsConfig) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'ad_creative_assessment',
      strict: true,
      schema: {
        type: 'object',
        properties: Object.fromEntries(
          adAiAssessmentKeys.map((key) => [key, { type: 'string', description: config.fields[key] ?? key }])
        ),
        required: [...adAiAssessmentKeys],
        additionalProperties: false
      }
    }
  };
}

async function callOpenAi(body: Record<string, unknown>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await proxiedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openaiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 1200);
      const error = new Error(`OpenAI HTTP ${response.status}: ${detail}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }

    return (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  } finally {
    clearTimeout(timer);
  }
}

// fbcdn blocks OpenAI's own image downloader, so we download each creative ourselves
// (the scraper machine fetches fbcdn fine) and pass the image inline as a base64 data URL.
async function downloadImageAsDataUrl(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await proxiedFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
    if (!mime.startsWith('image/')) throw new Error(`Unexpected content-type: ${mime}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxImageBytes) throw new Error(`Image too large: ${buffer.byteLength} bytes`);
    if (!buffer.byteLength) throw new Error('Empty image response');

    return `data:${mime};base64,${buffer.toString('base64')}`;
  } finally {
    clearTimeout(timer);
  }
}

export async function assessAdCreative(input: { imageUrls: string[]; context: AdCreativeContext }): Promise<AdAiAssessment> {
  if (!env.openaiKey) throw new Error('OPENAI_KEY is not set');
  if (!input.imageUrls.length) throw new Error('No image URLs to assess');

  const config = await loadPrompts();
  const downloads = await Promise.allSettled(input.imageUrls.map((url) => downloadImageAsDataUrl(url)));
  const dataUrls = downloads
    .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
    .map((result) => result.value);

  if (!dataUrls.length) {
    const firstError = downloads.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )?.reason;
    throw new Error(
      `Failed to download any creative image: ${firstError instanceof Error ? firstError.message : String(firstError)}`
    );
  }

  const body = {
    model: env.openaiModel,
    temperature: 0.4,
    max_tokens: 1800,
    messages: [
      { role: 'system', content: config.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserText(config, dataUrls.length, input.context) },
          ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'auto' } }))
        ]
      }
    ],
    response_format: responseSchema(config)
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await callOpenAi(body);
      const content = result.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenAI returned empty content');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return Object.fromEntries(
        adAiAssessmentKeys.map((key) => [key, clampField(parsed[key])])
      ) as AdAiAssessment;
    } catch (error) {
      lastError = error;
      const status = (error as Error & { status?: number }).status;
      const retryable = status === undefined || status === 429 || (typeof status === 'number' && status >= 500);
      if (!retryable || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
