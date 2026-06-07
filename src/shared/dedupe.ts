import { createHash } from 'node:crypto';

export function normalizeCreativeText(parts: Array<string | null | undefined>) {
  return parts
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createDedupeKey(parts: Array<string | null | undefined>, fallbackId: string) {
  const normalized = normalizeCreativeText(parts) || fallbackId;
  return createHash('sha256').update(normalized).digest('hex');
}
