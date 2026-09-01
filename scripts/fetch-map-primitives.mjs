#!/usr/bin/env node
// Explicitly refresh a compact, content-addressed tarkov.dev exact-map fixture.
// Builders never use the network: they consume only the committed fixture and
// verify both its compressed and decoded SHA-256 values via the manifest.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'scripts/data/tarkov-dev-exact-manifest.json');
const CACHE_DIR = path.join(ROOT, 'scripts/data/tarkov-dev-exact');
const SOURCES = [
  { name: 'maps', url: 'https://json.tarkov.dev/regular/maps' },
  { name: 'maps_en', url: 'https://json.tarkov.dev/regular/maps_en' },
];
// Production refresh scope stays on Customs until its accuracy contract passes.
// Adding a map here is an explicit scope-opening decision, not a best-effort URL guess.
const SVG_NAMES = Object.freeze({ customs: 'Customs' });

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

const stableStringify = (value) => JSON.stringify(stableValue(value));

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node scripts/fetch-map-primitives.mjs [--date YYYY-MM-DD] [--map customs]');
  console.error('       refreshes the exact JSON and SVG fixtures; builders never use the network');
  process.exit(message ? 1 : 0);
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function parseArguments(argv) {
  const maps = [];
  let fetchedDate;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') usage();
    if (argument === '--date') {
      fetchedDate = argv[++index];
      if (!fetchedDate) usage('--date requires a value');
      continue;
    }
    if (argument === '--map') {
      const map = argv[++index]?.toLowerCase();
      if (!map) usage('--map requires a value');
      if (!Object.hasOwn(SVG_NAMES, map)) usage(`unsupported map: ${map}; current refresh scope is customs`);
      maps.push(map);
      continue;
    }
    usage(`unknown argument: ${argument}`);
  }
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  fetchedDate ??= localDate;
  if (!validCalendarDate(fetchedDate)) usage('--date must be a real calendar date in YYYY-MM-DD form');
  return { fetchedDate, maps: [...new Set(maps.length ? maps : ['customs'])].sort() };
}

async function existingManifest() {
  try {
    const value = JSON.parse(await readFile(MANIFEST, 'utf8'));
    if (value.schemaVersion !== 3 || !value.maps || typeof value.maps !== 'object' || Array.isArray(value.maps)) {
      throw new Error(`refusing to overwrite unsupported exact-cache manifest schema ${value.schemaVersion}`);
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 3, maps: {} };
    throw error;
  }
}

function pickLookups(values, ids) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => ids.has(id)));
}

function exactMapInput(map) {
  return Object.fromEntries([
    'id', 'normalizedName', 'nameId', 'name',
    'spawns', 'extracts', 'transits', 'locks', 'switches', 'hazards',
    'lootContainers', 'lootLoose', 'stationaryWeapons', 'btrStops', 'artillery',
  ].filter((key) => Object.hasOwn(map, key)).map((key) => [key, map[key]]));
}

const { fetchedDate, maps: requestedMaps } = parseArguments(process.argv.slice(2));
await mkdir(CACHE_DIR, { recursive: true });

const fetched = await Promise.all(SOURCES.map(async (source) => {
  const response = await fetch(source.url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  let json;
  try { json = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${source.url}: invalid JSON (${error.message})`); }
  return {
    name: source.name,
    url: source.url,
    sha256: sha256(bytes),
    bytes: bytes.length,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    json,
  };
}));

const mapsSource = fetched.find((source) => source.name === 'maps');
const namesSource = fetched.find((source) => source.name === 'maps_en');
const sourceMaps = mapsSource.json?.data?.maps;
const translations = namesSource.json?.data;
if (!sourceMaps || typeof sourceMaps !== 'object' || Array.isArray(sourceMaps)) throw new Error('maps source has no data.maps object');
if (!translations || typeof translations !== 'object' || Array.isArray(translations)) throw new Error('maps_en source has no data translation object');

const manifest = await existingManifest();
for (const mapKey of requestedMaps) {
  const map = Object.values(sourceMaps).find((candidate) => candidate?.normalizedName === mapKey);
  if (!map) throw new Error(`maps source has no map ${mapKey}`);
  const svgUrl = `https://assets.tarkov.dev/maps/svg/${SVG_NAMES[mapKey]}.svg`;
  const svgResponse = await fetch(svgUrl, { headers: { Accept: 'image/svg+xml' } });
  if (!svgResponse.ok) throw new Error(`${svgUrl}: HTTP ${svgResponse.status}`);
  const svgBytes = Buffer.from(await svgResponse.arrayBuffer());
  if (!/<svg\b[^>]*\bviewBox=["'][^"']+["']/i.test(svgBytes.toString('utf8'))) {
    throw new Error(`${svgUrl}: response is not an SVG with a viewBox`);
  }
  const lootIds = new Set((map.lootContainers ?? []).map((row) => row?.lootContainer).filter(Boolean));
  const weaponIds = new Set((map.stationaryWeapons ?? []).map((row) => row?.stationaryWeapon).filter(Boolean));
  const fixture = {
    schemaVersion: 1,
    mapKey,
    map: exactMapInput(map),
    translations,
    lookups: {
      lootContainers: pickLookups(mapsSource.json.data.lootContainers, lootIds),
      stationaryWeapons: pickLookups(mapsSource.json.data.stationaryWeapons, weaponIds),
    },
  };
  const decodedBytes = Buffer.from(stableStringify(fixture));
  const compressedBytes = gzipSync(decodedBytes, { level: 9, mtime: 0 });
  const decodedSha256 = sha256(decodedBytes);
  const compressedSha256 = sha256(compressedBytes);
  const filename = `${mapKey}-${compressedSha256.slice(0, 16)}.json.gz`;
  const file = path.join(CACHE_DIR, filename);
  const compressedSvgBytes = gzipSync(svgBytes, { level: 9, mtime: 0 });
  const compressedSvgSha256 = sha256(compressedSvgBytes);
  const decodedSvgSha256 = sha256(svgBytes);
  const svgFilename = `${mapKey}-${compressedSvgSha256.slice(0, 16)}.svg.gz`;
  const svgFile = path.join(CACHE_DIR, svgFilename);
  await writeFile(file, compressedBytes);
  await writeFile(svgFile, compressedSvgBytes);
  manifest.maps[mapKey] = {
    cacheVersion: `${mapKey}-${decodedSha256.slice(0, 16)}`,
    fetchedDate,
    cachePath: path.relative(ROOT, file).split(path.sep).join('/'),
    sha256: compressedSha256,
    decodedSha256,
    bytes: compressedBytes.length,
    decodedBytes: decodedBytes.length,
    sources: fetched.map(({ json: _json, ...source }) => source),
    svg: {
      fetchedDate,
      cachePath: path.relative(ROOT, svgFile).split(path.sep).join('/'),
      sha256: compressedSvgSha256,
      decodedSha256: decodedSvgSha256,
      bytes: compressedSvgBytes.length,
      decodedBytes: svgBytes.length,
      source: {
        name: 'svg',
        url: svgUrl,
        sha256: decodedSvgSha256,
        bytes: svgBytes.length,
        etag: svgResponse.headers.get('etag'),
        lastModified: svgResponse.headers.get('last-modified'),
      },
    },
  };
  console.log(`${mapKey}: ${decodedBytes.length} decoded bytes -> ${compressedBytes.length} gzip bytes sha256 ${compressedSha256}`);
  console.log(`${mapKey} SVG: ${svgBytes.length} decoded bytes -> ${compressedSvgBytes.length} gzip bytes sha256 ${compressedSvgSha256}`);
}

manifest.maps = Object.fromEntries(Object.entries(manifest.maps).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${path.relative(ROOT, MANIFEST)}; builders remain offline`);
