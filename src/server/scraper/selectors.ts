import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from 'playwright';

export type SelectorConfig = {
  results: {
    ready: string[];
    adCard: string;
    infoButton: string;
    errorMarkers: string[];
    libraryIdRegex: string;
    dateStartedRegex: string;
    dateRangeRegex: string;
    activeText: string;
    inactiveText: string;
    multipleVersionsText: string;
    platformTexts: string[];
  };
  group: {
    ready: string[];
    variationCard: string;
    selectedLibraryIdChip: string;
    returnToGroupButtons: string[];
  };
  detail: {
    ready: string[];
    previewContainer: string;
    locationToggle: string;
    locationRows: string;
    locationCells: string;
    closeButtons: string[];
  };
  creative: {
    adLabelTexts: string[];
    ctaCandidates: string[];
  };
};

export async function loadSelectorConfig() {
  const file = path.resolve(process.cwd(), 'config', 'selectors.json');
  return JSON.parse(await readFile(file, 'utf8')) as SelectorConfig;
}

export async function firstVisible(
  root: Page | Locator,
  selectors: string[],
  timeoutMs = 1500
): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = root.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return locator;
    } catch {
      // Try the next selector candidate.
    }
  }
  return null;
}

export async function clickFirstVisible(root: Page | Locator, selectors: string[], timeoutMs = 1500) {
  const locator = await firstVisible(root, selectors, timeoutMs);
  if (!locator) return false;
  await locator.click({ timeout: timeoutMs });
  return true;
}
