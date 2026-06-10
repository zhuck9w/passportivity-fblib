import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractCardMediaSnapshot } from '../src/server/scraper/extractors';

describe('card carousel media extraction', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it('extracts every hscroll child from a result card preview', async () => {
    const html = fs.readFileSync(path.resolve('sql/sample/sample_carousel.html'), 'utf8');
    const page = await browser.newPage();
    await page.setContent(html);

    const snapshot = await extractCardMediaSnapshot(page.locator('body'), true);
    await page.close();

    expect(snapshot.html).toContain('data-type="hscroll-child"');
    expect(snapshot.media_items).toHaveLength(4);
    expect(snapshot.media_items.map((item) => item.source)).toEqual(['carousel', 'carousel', 'carousel', 'carousel']);
    expect(snapshot.media_items.map((item) => item.position)).toEqual([0, 1, 2, 3]);
    expect(snapshot.media_items.every((item) => item.src.includes('dst-jpg_s600x600'))).toBe(true);
  });
});
