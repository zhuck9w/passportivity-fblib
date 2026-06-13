// Read-only calibration tool for image dedup (perceptual hashing). Reads ads from Supabase,
// downloads each primary creative through the proxy, computes a pHash, and prints near-duplicate
// clusters so we can pick a Hamming-distance threshold. Does NOT modify the database.
//
//   npx tsx src/server/scripts/dedupePrototype.ts --limit=150 --t=8
//   npx tsx src/server/scripts/dedupePrototype.ts --competitor=<uuid> --t=10
import sharp from 'sharp';
import phash from 'sharp-phash';
import type { Ad } from '../../shared/types';
import { proxiedFetch } from '../proxy';
import { listAds } from '../repositories';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const limit = Number(arg('limit') ?? 150);
const detailThreshold = Number(arg('t') ?? 8);
const competitorId = arg('competitor');

type Entry = { ad: Ad; hash: string; ratio: number };

function primaryImageUrl(ad: Ad): string | null {
  const items = ad.media_items ?? [];
  const image = items.find((item) => item.type === 'image' && item.src);
  if (image) return image.src;
  const video = items.find((item) => item.type === 'video' && item.poster);
  return video?.poster ?? null;
}

function snippet(ad: Ad): string {
  return (ad.body_text ?? ad.preview_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 64);
}

function hamming(a: string, b: string): number {
  let distance = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) distance += 1;
  return distance;
}

function aspectClose(r1: number, r2: number): boolean {
  // pHash squashes to a square, so a 1:1 and a 9:16 of the same design can hash alike —
  // the aspect guard is what keeps different formats as separate (both kept for AI).
  return Math.abs(Math.log(r1 / r2)) < 0.12;
}

async function downloadBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await proxiedFetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' }
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function mapPool<T, R>(items: T[], poolSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(poolSize, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        out[index] = await fn(items[index]);
      }
    })
  );
  return out;
}

function buildClusters(entries: Entry[], threshold: number): Entry[][] {
  const parent = entries.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (aspectClose(entries[i].ratio, entries[j].ratio) && hamming(entries[i].hash, entries[j].hash) <= threshold) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, Entry[]>();
  entries.forEach((entry, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(entry);
  });
  return [...groups.values()];
}

async function main() {
  const ads = await listAds(competitorId ? { competitorIds: [competitorId] } : {});
  const withImage = ads.filter(primaryImageUrl).slice(0, limit);
  console.log(`Ads fetched: ${ads.length} | with image: ${ads.filter(primaryImageUrl).length} | processing: ${withImage.length}\n`);

  const entries = (
    await mapPool(withImage, 8, async (ad) => {
      const buf = await downloadBuffer(primaryImageUrl(ad)!);
      if (!buf) return null;
      try {
        const meta = await sharp(buf).metadata();
        const ratio = meta.width && meta.height ? meta.width / meta.height : 1;
        return { ad, hash: await phash(buf), ratio } satisfies Entry;
      } catch {
        return null;
      }
    })
  ).filter((entry): entry is Entry => entry !== null);

  console.log(`Hashed OK: ${entries.length}\n`);
  console.log('Threshold sweep (how aggressive the dedup is):');
  for (const threshold of [2, 4, 6, 8, 10, 12, 14]) {
    const clusters = buildClusters(entries, threshold).filter((c) => c.length > 1);
    const inClusters = clusters.reduce((sum, c) => sum + c.length, 0);
    console.log(`  ≤${String(threshold).padStart(2)}  dup-groups=${clusters.length}  ads-in-groups=${inClusters}  would-hide=${inClusters - clusters.length}`);
  }

  const clusters = buildClusters(entries, detailThreshold)
    .filter((c) => c.length > 1)
    .sort((a, b) => b.length - a.length);
  console.log(`\n=== Clusters at Hamming ≤ ${detailThreshold} (aspect within 12%) — inspect language behaviour ===\n`);
  if (!clusters.length) console.log('(no duplicate clusters at this threshold)');
  for (const cluster of clusters) {
    console.log(`Cluster ×${cluster.length}  aspect≈${cluster[0].ratio.toFixed(2)}`);
    for (const entry of cluster) {
      console.log(
        `   d=${String(hamming(cluster[0].hash, entry.hash)).padStart(2)}  ${entry.ad.facebook_library_id}  ${entry.ad.competitors?.name ?? '?'}  start=${entry.ad.start_date_text ?? '?'}  "${snippet(entry.ad)}"`
      );
    }
    console.log('');
  }
}

await main();
