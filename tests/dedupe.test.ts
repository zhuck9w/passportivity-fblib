import { describe, expect, it } from 'vitest';
import { createDedupeKey, normalizeCreativeText } from '../src/shared/dedupe';

describe('dedupe helpers', () => {
  it('normalizes casing, punctuation, urls and whitespace', () => {
    expect(normalizeCreativeText([' Купить  Дом! ', 'HTTPS://EXAMPLE.COM/test', 'Подробнее'])).toBe(
      'купить дом подробнее'
    );
  });

  it('creates the same key for duplicate creative text', () => {
    const first = createDedupeKey(['Апартаменты у моря', 'Жилой комплекс', 'Подробнее'], '1');
    const second = createDedupeKey([' апартаменты у моря ', 'Жилой   комплекс!', 'подробнее'], '2');
    expect(first).toBe(second);
  });

  it('falls back to library id when creative text is empty', () => {
    expect(createDedupeKey([null, '', undefined], '123')).toBe(createDedupeKey([], '123'));
  });
});
