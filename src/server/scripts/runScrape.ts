import { scrapeJobManager } from '../scrapeJobManager';

const competitorId = process.argv.find((arg) => arg.startsWith('--competitor='))?.split('=')[1];
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
const limit = limitArg ? Number(limitArg) : undefined;

const job = await scrapeJobManager.start({ competitorId, limit });
console.log(`Started scrape run ${job.run_id}`);

while (true) {
  const current = scrapeJobManager.get(job.run_id);
  if (!current) break;
  console.log(
    `${current.status}: found=${current.ads_found} saved=${current.ads_saved} duplicates=${current.duplicates_found}`
  );
  if (current.status === 'succeeded' || current.status === 'failed') {
    if (current.errors.length) console.error(current.errors.join('\n'));
    process.exit(current.status === 'succeeded' ? 0 : 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
}
