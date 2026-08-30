#!/usr/bin/env node
// Explicitly refresh the versioned tarkov.dev exact-map cache. Builders never
// fetch these endpoints: they require the local files and verify every byte via
// the committed manifest before parsing them.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'scripts/data/tarkov-dev-exact-manifest.json');
const SOURCES = [
  { name: 'maps', url: 'https://json.tarkov.dev/regular/maps' },
  { name: 'maps_en', url: 'https://json.tarkov.dev/regular/maps_en' },
];

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node scripts/fetch-map-primitives.mjs [--date YYYY-MM-DD]');
  process.exit(message ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage();
const dateAt = argv.indexOf('--date');
const localDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const fetchedDate = dateAt >= 0 ? argv[dateAt + 1] : localDate;
if (!/^\d{4}-\d{2}-\d{2}$/.test(fetchedDate || '')) usage('--date must be YYYY-MM-DD');
if (argv.some((value, index) => value !== '--date' && index !== dateAt + 1)) usage(`unknown argument: ${argv.find((value, index) => value !== '--date' && index !== dateAt + 1)}`);

const cacheDir = path.join(ROOT, 'scripts/data/tarkov-dev-exact', fetchedDate);
await mkdir(cacheDir, { recursive: true });

const fetched = await Promise.all(SOURCES.map(async (source) => {
  const response = await fetch(source.url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  try { JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${source.url}: invalid JSON (${error.message})`); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  const filename = `${source.name}-${digest.slice(0, 16)}.json`;
  const file = path.join(cacheDir, filename);
  await writeFile(file, bytes);
  return {
    name: source.name,
    url: source.url,
    cachePath: path.relative(ROOT, file).split(path.sep).join('/'),
    sha256: digest,
    bytes: bytes.length,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  };
}));

const manifest = {
  schemaVersion: 1,
  cacheVersion: `${fetchedDate}-${fetched.map((source) => source.sha256.slice(0, 12)).join('-')}`,
  fetchedDate,
  sources: fetched,
};
await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
for (const source of fetched) console.log(`${source.name}: ${source.bytes} bytes sha256 ${source.sha256}`);
console.log(`wrote ${path.relative(ROOT, MANIFEST)} (raw cache stays git-ignored)`);
