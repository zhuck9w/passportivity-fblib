import sharp from 'sharp';
import phash from 'sharp-phash';
import type { Ad, AdMediaItem } from '../shared/types';
import { proxiedFetch } from './proxy';

// ─────────────────────────────────────────────────────────────────────────────
//  IMAGE DEDUP — perceptual hashing, no AI. Single source of truth for the logic;
//  the scraper just calls these. Tune the threshold with the read-only calibration
//  tool: `npx tsx src/server/scripts/dedupePrototype.ts --t=<n>`.
// ─────────────────────────────────────────────────────────────────────────────

// Max Hamming distance (out of 64) for two creatives to count as the same image.
// Calibrated on real ads: exact dupes = 0, same-image-different-language = 1–7,
// distinct creatives well above (a wide gap up to 14+) — 10 catches cross-language
// variants with margin while staying clear of false merges.
export const DEDUP_HAMMING_THRESHOLD = 10;

// pHash squashes every image to a square before hashing, so a 1:1 and a 9:16 crop of
// the SAME design can hash alike. This aspect guard keeps different formats apart, so
// e.g. a square and a vertical version are both kept and both sent to AI.
const ASPECT_LOG_TOLERANCE = 0.12;

export type ImageFingerprint = { phash: string; aspect: number };

export async function computeImageFingerprint(buffer: Buffer): Promise<ImageFingerprint | null> {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return null;
    return { phash: await phash(buffer), aspect: meta.width / meta.height };
  } catch {
    return null;
  }
}

export function hammingDistance(a: string, b: string): number {
  let distance = Math.abs(a.length - b.length);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) if (a[i] !== b[i]) distance += 1;
  return distance;
}

export function aspectClose(r1: number, r2: number): boolean {
  if (r1 <= 0 || r2 <= 0) return false;
  return Math.abs(Math.log(r1 / r2)) < ASPECT_LOG_TOLERANCE;
}

export function isImageDuplicate(a: ImageFingerprint, b: ImageFingerprint): boolean {
  return aspectClose(a.aspect, b.aspect) && hammingDistance(a.phash, b.phash) <= DEDUP_HAMMING_THRESHOLD;
}

// First real image creative of an ad. Videos return null — they don't participate in
// dedup (and already skip AI), since a poster frame isn't the creative.
export function primaryImageUrl(mediaItems: AdMediaItem[] | null | undefined): string | null {
  const image = (mediaItems ?? []).find((item) => item.type === 'image' && item.src && /^https?:\/\//i.test(item.src));
  return image?.src ?? null;
}

export async function downloadImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const response = await proxiedFetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*'
      }
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength ? buffer : null;
  } catch {
    return null;
  }
}

const monthNumbers: Record<string, number> = {
  янв: 0, фев: 1, мар: 2, апр: 3, май: 4, мая: 4, июн: 5, июл: 6, авг: 7, сен: 8, сент: 8, окт: 9, ноя: 10, дек: 11
};

// Whitespace handling: the matcher uses \s+, which already matches nbsp/narrow-nbsp that
// Facebook puts in RU dates, and String.trim() strips them at the edges — so no explicit
// nbsp replacement is needed here.
function parseRuDate(value: string | null): Date | null {
  if (!value) return null;
  const normalized = value.replace(/\./g, '').trim().toLowerCase();
  const match = normalized.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
  if (!match) return null;
  const monthKey = match[2].slice(0, 4).replace(/[^а-яё]/g, '');
  const month = monthNumbers[monthKey] ?? monthNumbers[monthKey.slice(0, 3)];
  if (month === undefined) return null;
  const date = new Date(Number(match[3]), month, Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date;
}

// Run length in days; among duplicates the longest-running ad becomes the canonical we keep.
// Mirrors the dashboard's `daysActive` so "kept" matches what the user sees on screen.
export function adRunDays(ad: Pick<Ad, 'status' | 'start_date_text' | 'end_date_text' | 'stopped_at'>): number {
  const start = parseRuDate(ad.start_date_text);
  if (!start) return 0;
  const stop =
    ad.status === 'active' || ad.status === 'new'
      ? new Date()
      : (parseRuDate(ad.end_date_text) ?? (ad.stopped_at ? new Date(ad.stopped_at) : new Date()));
  return Math.max(0, (stop.getTime() - start.getTime()) / 86_400_000);
}
