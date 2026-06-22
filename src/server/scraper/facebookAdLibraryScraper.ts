import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { buildAdLibraryUrl } from '../../shared/adLibraryUrl';
import type { Competitor, ScrapedAdInput } from '../../shared/types';
import { env } from '../env';
import { logScraper } from '../logger';
import { playwrightProxy } from '../proxy';
import {
  buildSnapshotFallbackAd,
  extractCardFallbackAd,
  extractCardMediaSnapshot,
  extractCardSnapshot,
  extractDetailAd,
  type CardMediaSnapshot,
  type CardSnapshot
} from './extractors';
import { clickFirstVisible, firstVisible, loadSelectorConfig, type SelectorConfig } from './selectors';

export type ScrapeCompetitorResult = {
  ads: ScrapedAdInput[];
  errors: string[];
};

type ScrapeCompetitorOptions = {
  limit?: number;
  collectCarousels?: boolean;
  signal?: AbortSignal;
  onAd?: (ad: ScrapedAdInput) => Promise<void> | void;
};

function throwIfStopped(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('Scrape stopped by user');
  }
}

function resolveUserDataDir(userDataDir: string) {
  return path.isAbsolute(userDataDir) ? userDataDir : path.resolve(process.cwd(), userDataDir);
}

export class FacebookAdLibraryScraper {
  private readonly configPromise = loadSelectorConfig();

  async scrapeCompetitor(competitor: Competitor, options: ScrapeCompetitorOptions = {}): Promise<ScrapeCompetitorResult> {
    const config = await this.configPromise;
    const limit = options.limit ?? env.scraperMaxAds;
    const collectCarousels = options.collectCarousels ?? env.scraperCollectCarousels;
    const sourceUrl = buildAdLibraryUrl(competitor.facebook_page_id);
    let browser: Browser | null = null;
    let context: BrowserContext;
    const launchOptions = {
      headless: env.scraperHeadless,
      slowMo: env.scraperSlowMoMs,
      channel: env.scraperBrowserChannel,
      // Routes all browser traffic (FB pages + fbcdn media) through the proxy when set.
      proxy: playwrightProxy()
    };

    if (env.scraperUserDataDir) {
      const userDataDir = resolveUserDataDir(env.scraperUserDataDir);
      logScraper('info', 'Using persistent browser profile', {
        user_data_dir: userDataDir,
        channel: env.scraperBrowserChannel ?? 'playwright-chromium'
      });
      context = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        locale: 'ru-RU',
        viewport: { width: 1440, height: 1000 }
      });
    } else {
      browser = await chromium.launch(launchOptions);
      context = await browser.newContext({
        locale: 'ru-RU',
        viewport: { width: 1440, height: 1000 }
      });
    }
    const stopHandler = () => {
      void context.close().catch(() => undefined);
      void browser?.close().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', stopHandler, { once: true });
    const page = await context.newPage();
    await page.addInitScript('globalThis.__name = globalThis.__name || ((target) => target)');
    await page.evaluate('globalThis.__name = globalThis.__name || ((target) => target)').catch(() => undefined);
    const ads: ScrapedAdInput[] = [];
    const errors: string[] = [];

    try {
      throwIfStopped(options.signal);
      logScraper('info', 'Opening Ad Library page', {
        competitor: competitor.name,
        page_id: competitor.facebook_page_id,
        limit,
        collect_carousels: collectCarousels
      });
      await this.openResults(page, sourceUrl, config);
      await this.logLoginState(context, page, competitor.name);
      await this.scrollResults(page, config, limit);

      const totalCards = await this.resultActionButtons(page, config).count();
      const cardsToProcess = Math.min(totalCards, limit);
      logScraper('info', 'Result cards discovered', {
        competitor: competitor.name,
        total_cards: totalCards,
        cards_to_process: cardsToProcess
      });

      for (let index = 0; index < cardsToProcess; index += 1) {
        // Hoisted so the catch block can fall back to the card snapshot we already captured.
        let snapshot: CardSnapshot | null = null;
        let cardMedia: CardMediaSnapshot | null = null;
        try {
          throwIfStopped(options.signal);
          logScraper('info', 'Processing result card', {
            competitor: competitor.name,
            card_number: index + 1,
            cards_to_process: cardsToProcess
          });
          await this.openResults(page, sourceUrl, config);
          throwIfStopped(options.signal);
          await this.scrollToCard(page, config, index);
          const actionButton = this.resultActionButtons(page, config).nth(index);
          const card = this.cardFromActionButton(actionButton);
          snapshot = await extractCardSnapshot(card, config);
          cardMedia = await extractCardMediaSnapshot(card, options.collectCarousels ?? env.scraperCollectCarousels);
          logScraper('info', 'Result card media extracted', {
            competitor: competitor.name,
            card_number: index + 1,
            library_id: snapshot.facebook_library_id,
            card_media_items: cardMedia.media_items.length
          });
          const extracted = await this.processResultCard(
            page,
            config,
            competitor.id,
            sourceUrl,
            snapshot,
            cardMedia,
            index,
            options
          );
          ads.push(...extracted);
          logScraper('info', 'Card processed', {
            competitor: competitor.name,
            card_number: index + 1,
            variations_saved_from_card: extracted.length
          });
        } catch (error) {
          if (options.signal?.aborted) throw error;
          const message = `Card ${index + 1}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(message);
          logScraper('error', 'Card processing failed', { competitor: competitor.name, error: message });

          // Safety net for status reconciliation: reaching here means this card's ad was NOT
          // saved (every success path returns before the throw). If we nonetheless identified the
          // card — i.e. we have its library id from the snapshot — persist it from that snapshot so
          // it's still recorded as observed in this scan. Without it, a still-active ad that merely
          // failed to open would be absent from the current scan and reconciled to "stopped".
          if (snapshot?.facebook_library_id) {
            try {
              const fallbackAd = buildSnapshotFallbackAd(snapshot, competitor.id, sourceUrl, {
                mediaItems: cardMedia?.media_items,
                previewHtml: cardMedia?.html
              });
              await options.onAd?.(fallbackAd);
              logScraper('warn', 'Errored card saved from snapshot to preserve observation', {
                competitor: competitor.name,
                card_number: index + 1,
                library_id: snapshot.facebook_library_id
              });
            } catch (fallbackError) {
              logScraper('error', 'Snapshot safety-net save failed', {
                competitor: competitor.name,
                library_id: snapshot.facebook_library_id,
                error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
              });
            }
          }
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', stopHandler);
      await context.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }

    return { ads, errors };
  }

  private async openResults(page: Page, sourceUrl: string, config: SelectorConfig) {
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: env.scraperNavigationTimeoutMs });
    const state = await this.waitForResultsOrError(page, config);
    if (state === 'error') {
      logScraper('warn', 'Meta returned an error state, reloading once');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: env.scraperNavigationTimeoutMs });
      await this.waitForResultsOrError(page, config, true);
    }
  }

  // Logs whether the persistent profile is still authenticated with Facebook. FB sets the
  // `c_user` cookie (= the account id) only while logged in, so its presence is a reliable,
  // locale-independent signal — far more robust than scraping the DOM for a "Log in" button.
  // A `warn` here on the VPS means the copied profile's session expired and needs a re-login.
  private async logLoginState(context: BrowserContext, page: Page, competitorName: string) {
    try {
      const cookies = await context.cookies('https://www.facebook.com');
      const accountId = cookies.find((cookie) => cookie.name === 'c_user')?.value ?? null;
      const loggedIn = Boolean(accountId);
      logScraper(
        loggedIn ? 'info' : 'warn',
        loggedIn ? 'Facebook login active' : 'Facebook login MISSING — session expired or profile not logged in',
        {
          competitor: competitorName,
          logged_in: loggedIn,
          fb_account_id: accountId,
          url: page.url()
        }
      );
    } catch (error) {
      logScraper('warn', 'Facebook login check failed', {
        competitor: competitorName,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async waitForResultsOrError(page: Page, config: SelectorConfig, throwOnError = false) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < env.scraperNavigationTimeoutMs) {
      if ((await this.resultActionButtons(page, config).count().catch(() => 0)) > 0) return 'results';
      if ((await page.locator(config.results.adCard).count().catch(() => 0)) > 0) return 'results';
      if (await firstVisible(page, config.results.errorMarkers, 250)) {
        if (throwOnError) throw new Error('Meta returned an error page after reload');
        return 'error';
      }
      if (await firstVisible(page, config.results.ready, 250)) return 'ready';
      await page.waitForTimeout(500);
    }
    throw new Error('Timed out waiting for Ad Library results');
  }

  private async scrollResults(page: Page, config: SelectorConfig, limit: number) {
    let previousCount = 0;
    let stableRounds = 0;

    for (let round = 0; round < env.scraperMaxScrolls; round += 1) {
      const count = await this.resultActionButtons(page, config).count();
      if (count >= limit) return;
      if (count === previousCount) stableRounds += 1;
      else stableRounds = 0;
      if (stableRounds >= env.scraperScrollStableRounds) return;

      previousCount = count;
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(env.scraperScrollPauseMs);
    }
  }

  private async scrollToCard(page: Page, config: SelectorConfig, index: number) {
    for (let round = 0; round <= env.scraperMaxScrolls; round += 1) {
      const actionButton = this.resultActionButtons(page, config).nth(index);
      if ((await actionButton.count()) > 0) {
        await actionButton.scrollIntoViewIfNeeded({ timeout: env.scraperActionTimeoutMs }).catch(() => undefined);
        return;
      }
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(700);
    }
    throw new Error(`Could not find card ${index + 1}`);
  }

  private async processResultCard(
    page: Page,
    config: SelectorConfig,
    competitorId: string,
    sourceUrl: string,
    snapshot: CardSnapshot,
    cardMedia: CardMediaSnapshot,
    index: number,
    options: ScrapeCompetitorOptions
  ) {
    throwIfStopped(options.signal);
    const actionButton = this.resultActionButtons(page, config).nth(index);
    const actionText = await actionButton.innerText({ timeout: 1000 }).catch(() => '');
    const isSummaryAction = this.isSummaryActionText(actionText, config);
    await this.clickActionButton(actionButton);
    await page.waitForTimeout(1200);

    if (isSummaryAction) {
      logScraper('info', 'Opened summary group', { library_id: snapshot.facebook_library_id });
      return this.processGroupedTargetAd(page, config, competitorId, sourceUrl, snapshot, options, cardMedia);
    }

    if (await this.isDetailVisible(page, config, snapshot)) {
      logScraper('info', 'Opened single ad detail', { library_id: snapshot.facebook_library_id });
      const ad = await extractDetailAd(page, config, competitorId, sourceUrl, snapshot, {
        collectCarousels: options.collectCarousels ?? env.scraperCollectCarousels,
        mediaItems: cardMedia.media_items,
        previewHtml: cardMedia.html
      });
      await options.onAd?.(ad);
      return [ad];
    }

    if (await firstVisible(page, config.group.ready, env.scraperDetailWaitMs)) {
      logScraper('info', 'Opened grouped ad detail', { library_id: snapshot.facebook_library_id });
      return this.processGroupedTargetAd(page, config, competitorId, sourceUrl, snapshot, options, cardMedia);
    }

    // The card opened but FB never rendered the detail or group panel (common on a slow proxy, or
    // when FB tweaks the panel markup). Rather than dropping the card — which would both lose the
    // creative AND mark the whole competitor scan incomplete, freezing status reconciliation — fall
    // back to what the result card itself already gave us. We still record an observation for this
    // library id, so reconciliation keeps treating the ad as currently-active instead of "stopped".
    if (snapshot.facebook_library_id) {
      logScraper('warn', 'Card detail/group did not appear; saving from card snapshot', {
        library_id: snapshot.facebook_library_id,
        card_media_items: cardMedia.media_items.length
      });
      const ad = buildSnapshotFallbackAd(snapshot, competitorId, sourceUrl, {
        mediaItems: cardMedia.media_items,
        previewHtml: cardMedia.html
      });
      await options.onAd?.(ad);
      return [ad];
    }

    throw new Error('Opened card, but neither detail preview nor group view appeared');
  }

  private async processGroup(
    page: Page,
    config: SelectorConfig,
    competitorId: string,
    sourceUrl: string,
    options: ScrapeCompetitorOptions
  ) {
    await firstVisible(page, config.group.ready, env.scraperActionTimeoutMs);
    const ads: ScrapedAdInput[] = [];
    const variationButtons = this.resultInfoButtons(page, config);
    const count = await variationButtons.count();
    logScraper('info', 'Group variations discovered', { variation_count: count });

    for (let index = 0; index < count; index += 1) {
      throwIfStopped(options.signal);
      const infoButton = variationButtons.nth(index);
      const variationCard = this.cardFromInfoButton(infoButton);
      const snapshot = await extractCardSnapshot(variationCard, config);
      const cardMedia = await extractCardMediaSnapshot(variationCard, options.collectCarousels ?? env.scraperCollectCarousels);
      await variationCard.scrollIntoViewIfNeeded({ timeout: env.scraperActionTimeoutMs }).catch(() => undefined);
      await this.clickActionButton(infoButton);
      await page.waitForTimeout(1000);

      if (await this.isDetailVisible(page, config, snapshot)) {
        const ad = await extractDetailAd(page, config, competitorId, sourceUrl, snapshot, {
          collectCarousels: options.collectCarousels ?? env.scraperCollectCarousels,
          mediaItems: cardMedia.media_items,
          previewHtml: cardMedia.html
        });
        ads.push(ad);
        await options.onAd?.(ad);
        logScraper('info', 'Variation extracted', {
          variation_number: index + 1,
          library_id: snapshot.facebook_library_id
        });
        await this.returnToGroup(page, config);
      }
    }

    return ads;
  }

  private async processGroupedTargetAd(
    page: Page,
    config: SelectorConfig,
    competitorId: string,
    sourceUrl: string,
    parentSnapshot: CardSnapshot,
    options: ScrapeCompetitorOptions,
    sourceCardMedia?: CardMediaSnapshot
  ) {
    await firstVisible(page, config.group.ready, env.scraperActionTimeoutMs);
    const targetLibraryId = parentSnapshot.facebook_library_id;
    if (!targetLibraryId) {
      throw new Error('Summary group opened, but source card has no library id');
    }

    const target = await this.findGroupVariationByLibraryId(page, config, targetLibraryId, options.signal);
    if (!target) {
      throw new Error(`Summary group opened, but variation ${targetLibraryId} was not found`);
    }

    await target.card.scrollIntoViewIfNeeded({ timeout: env.scraperActionTimeoutMs }).catch(() => undefined);
    const targetCardMedia = await extractCardMediaSnapshot(target.card, options.collectCarousels ?? env.scraperCollectCarousels);
    const cardMedia = targetCardMedia.media_items.length ? targetCardMedia : sourceCardMedia;
    logScraper('info', 'Target card media extracted', {
      library_id: targetLibraryId,
      card_media_items: cardMedia?.media_items.length ?? 0
    });
    await this.clickActionButton(target.infoButton);
    await page.waitForTimeout(1000);

    if (!(await this.isDetailVisible(page, config, target.snapshot))) {
      logScraper('warn', 'Target variation detail did not appear; using card fallback', { library_id: targetLibraryId });
      const ad = await extractCardFallbackAd(target.card, config, competitorId, sourceUrl, target.snapshot, {
        collectCarousels: options.collectCarousels ?? env.scraperCollectCarousels,
        mediaItems: cardMedia?.media_items,
        previewHtml: cardMedia?.html
      });
      await options.onAd?.(ad);
      return [ad];
    }

    const ad = await extractDetailAd(page, config, competitorId, sourceUrl, target.snapshot, {
      collectCarousels: options.collectCarousels ?? env.scraperCollectCarousels,
      mediaItems: cardMedia?.media_items,
      previewHtml: cardMedia?.html
    });
    await options.onAd?.(ad);
    logScraper('info', 'Summary target variation extracted', { library_id: targetLibraryId });
    return [ad];
  }

  private async findGroupVariationByLibraryId(
    page: Page,
    config: SelectorConfig,
    libraryId: string,
    signal?: AbortSignal
  ) {
    let previousCount = 0;
    let stableRounds = 0;

    for (let round = 0; round <= env.scraperMaxScrolls; round += 1) {
      throwIfStopped(signal);
      const buttons = this.resultInfoButtons(page, config);
      const count = await buttons.count();

      for (let index = 0; index < count; index += 1) {
        const infoButton = buttons.nth(index);
        const card = this.cardFromInfoButton(infoButton);
        const snapshot = await extractCardSnapshot(card, config);
        if (snapshot.facebook_library_id === libraryId) {
          return { infoButton, card, snapshot };
        }
      }

      logScraper('info', 'Summary group target not visible yet', {
        library_id: libraryId,
        visible_variations: count,
        scroll_round: round + 1
      });

      if (count === previousCount) stableRounds += 1;
      else stableRounds = 0;
      if (stableRounds >= env.scraperScrollStableRounds) return null;

      previousCount = count;
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(800);
    }

    return null;
  }

  private async isDetailVisible(page: Page, config: SelectorConfig, snapshot?: CardSnapshot) {
    if (await firstVisible(page, config.detail.ready, env.scraperDetailWaitMs)) return true;
    if (!snapshot) return false;
    return this.hasVisiblePreviewForSnapshot(page, config, snapshot);
  }

  private async returnToGroup(page: Page, config: SelectorConfig) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(350);
    if (await firstVisible(page, config.group.ready, 500)) return;

    if (await clickFirstVisible(page, [...config.detail.closeButtons, ...config.group.returnToGroupButtons], 1000)) {
      await page.waitForTimeout(700);
      if (await firstVisible(page, config.group.ready, 1000)) return;
    }

    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 3000 }).catch(() => undefined);
    await firstVisible(page, config.group.ready, 2000);
  }

  private resultInfoButtons(page: Page, config: SelectorConfig) {
    return page.locator(config.results.infoButton).filter({ visible: true });
  }

  private resultSummaryButtons(page: Page, config: SelectorConfig) {
    return config.results.summaryButtons
      .map((selector) => page.locator(selector))
      .reduce((merged, locator) => merged.or(locator))
      .filter({ visible: true });
  }

  private resultActionButtons(page: Page, config: SelectorConfig) {
    return this.resultInfoButtons(page, config).or(this.resultSummaryButtons(page, config)).filter({ visible: true });
  }

  private async clickActionButton(actionButton: Locator) {
    await actionButton.scrollIntoViewIfNeeded({ timeout: env.scraperActionTimeoutMs }).catch(() => undefined);

    try {
      await actionButton.click({ timeout: 4000 });
      return;
    } catch {
      // Meta often paints a visual preview layer over the button while the card is still clickable.
    }

    try {
      await actionButton.click({ timeout: 4000, force: true });
      return;
    } catch {
      // Fall back to a DOM click on the text node's nearest clickable parent.
    }

    await actionButton.evaluate((node) => {
      const element = node instanceof HTMLElement ? node : node.parentElement;
      const button = element?.closest('[role="button"]') ?? element;
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
  }

  private async hasVisiblePreviewForSnapshot(page: Page, config: SelectorConfig, snapshot: CardSnapshot) {
    const candidates = [snapshot.title, ...(snapshot.body_text ?? '').split('\n')]
      .map((line) => this.matchSnippet(line))
      .filter((line) => line.length >= 20)
      .slice(0, 4);

    if (!candidates.length) return false;

    const containers = page.locator(config.detail.previewContainer);
    const count = await containers.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const container = containers.nth(index);
      if (!(await container.isVisible().catch(() => false))) continue;
      const text = await container.innerText({ timeout: 1000 }).catch(() => '');
      const normalized = this.matchSnippet(text, 4000);
      if (candidates.some((candidate) => normalized.includes(candidate))) return true;
    }

    return false;
  }

  private matchSnippet(text: string | null | undefined, maxLength = 90) {
    const normalized = (text ?? '')
      .replace(/\u200b/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .toLowerCase();
    return normalized.length > maxLength ? normalized.slice(0, maxLength).trim() : normalized;
  }

  private isSummaryActionText(text: string, config: SelectorConfig) {
    const normalized = text.trim().toLowerCase();
    return config.results.summaryButtonLabels.some((label) => normalized.includes(label.toLowerCase()));
  }

  private cardFromInfoButton(infoButton: Locator) {
    return infoButton.locator('xpath=ancestor::div[contains(., "ID Библиотеки:")][1]');
  }

  private cardFromActionButton(actionButton: Locator) {
    return this.cardFromInfoButton(actionButton);
  }
}
