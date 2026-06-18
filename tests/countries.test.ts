import { describe, expect, it } from 'vitest';
import { GEO_UNKNOWN, normalizeGeo, splitGeoValues } from '../src/shared/countries';

describe('normalizeGeo', () => {
  it('snaps spelling/hyphen variants to one canonical name', () => {
    expect(normalizeGeo('Сан Томе и Принсипи')).toBe('Сан-Томе и Принсипи');
    expect(normalizeGeo('сан-томе и принсипи')).toBe('Сан-Томе и Принсипи');
  });

  it('collapses abbreviations and «ё» into the full canonical name', () => {
    expect(normalizeGeo('США')).toBe('Соединенные Штаты Америки');
    expect(normalizeGeo('USA')).toBe('Соединенные Штаты Америки');
    expect(normalizeGeo('Соединённые Штаты Америки')).toBe('Соединенные Штаты Америки');
    expect(normalizeGeo('оаэ')).toBe('Объединенные Арабские Эмираты');
  });

  it('maps English names of common citizenship markets', () => {
    expect(normalizeGeo('Saint Kitts and Nevis')).toBe('Сент-Китс и Невис');
    expect(normalizeGeo('United Arab Emirates')).toBe('Объединенные Арабские Эмираты');
  });

  it('drops special symbols (apostrophes) in favour of an all-Cyrillic name', () => {
    expect(normalizeGeo('Кот-д’Ивуар')).toBe('Берег Слоновой Кости');
  });

  it('keeps « и » inside multi-word names and only splits real lists', () => {
    expect(normalizeGeo('Антигуа и Барбуда')).toBe('Антигуа и Барбуда');
    expect(normalizeGeo('Турция, Мальта')).toBe('Турция, Мальта');
    expect(normalizeGeo('Вануату; Гренада / Доминика')).toBe('Вануату, Гренада, Доминика');
  });

  it('falls back to «Не определено» for empty input', () => {
    expect(normalizeGeo('')).toBe(GEO_UNKNOWN);
    expect(normalizeGeo(null)).toBe(GEO_UNKNOWN);
  });
});

describe('splitGeoValues', () => {
  it('splits a stored value into country tokens without breaking on « и »', () => {
    expect(splitGeoValues('Турция, Мальта')).toEqual(['Турция', 'Мальта']);
    expect(splitGeoValues('Антигуа и Барбуда')).toEqual(['Антигуа и Барбуда']);
    expect(splitGeoValues(null)).toEqual([]);
  });
});
