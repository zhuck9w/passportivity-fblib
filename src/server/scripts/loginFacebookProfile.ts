import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { playwrightProxy } from '../proxy';

dotenv.config();

function readOptional(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function resolveUserDataDir(userDataDir: string) {
  return path.isAbsolute(userDataDir) ? userDataDir : path.resolve(process.cwd(), userDataDir);
}

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const userDataDir = resolveUserDataDir(readOptional('SCRAPER_USER_DATA_DIR') ?? '.playwright-profile');
const channel = readOptional('SCRAPER_BROWSER_CHANNEL');
const url = argValue('url') ?? 'https://www.facebook.com/ads/library/';

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  channel,
  locale: 'ru-RU',
  viewport: null,
  // Log in through the same proxy the scraper uses, so the saved session matches the
  // egress IP/country FB will later see during scraping.
  proxy: playwrightProxy()
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

console.log(`Opened Facebook profile browser.`);
console.log(`Profile directory: ${userDataDir}`);
console.log(`Browser channel: ${channel ?? 'playwright-chromium'}`);
console.log('Log in to Facebook/Meta in the opened window, then return here and press Enter.');

const rl = readline.createInterface({ input, output });
await rl.question('Press Enter after login is complete...');
rl.close();

await context.close();
console.log('Profile saved. Future scraper runs will reuse this session.');
