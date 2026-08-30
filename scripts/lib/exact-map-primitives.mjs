import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/data/tarkov-dev-exact-manifest.json');

export const EXACT_LAYER_SCHEMA_VERSION = 1;
export const EXACT_COLLECTIONS = Object.freeze([
  ['spawns', 'spawn'],
  ['extracts', 'extract'],
  ['transits', 'transit'],
  ['locks', 'lock'],
  ['switches', 'switch'],
  ['hazards', 'hazard'],
  ['lootContainers', 'lootContainer'],
  ['lootLoose', 'looseLoot'],
  ['stationaryWeapons', 'stationaryWeapon'],
  ['btrStops', 'btrStop'],
  ['artilleryZones', 'artilleryZone'],
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export const stableStringify = (value) => JSON.stringify(stableValue(value));

function cacheError(message) {
  return new Error(`${message}. Run: node scripts/fetch-map-primitives.mjs --date YYYY-MM-DD`);
}

async function loadManifest() {
  let raw;
  try {
    raw = await readFile(MANIFEST_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw cacheError('exact tarkov.dev cache manifest is missing');
    throw error;
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (error) { throw cacheError(`exact tarkov.dev cache manifest is invalid JSON (${error.message})`); }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources)) {
    throw cacheError(`unsupported exact tarkov.dev cache manifest schema ${manifest.schemaVersion}`);
  }
  return manifest;
}

async function loadSource(manifest, name) {
  const source = manifest.sources.find((candidate) => candidate.name === name);
  if (!source?.cachePath || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) {
    throw cacheError(`exact tarkov.dev cache manifest has no valid ${name} source`);
  }
  const file = path.resolve(ROOT, source.cachePath);
  const cacheRoot = path.join(ROOT, 'scripts/data/tarkov-dev-exact') + path.sep;
  if (!file.startsWith(cacheRoot)) throw cacheError(`exact tarkov.dev ${name} cache path escapes scripts/data/tarkov-dev-exact`);
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) {
    if (error?.code === 'ENOENT') throw cacheError(`exact tarkov.dev ${name} cache is missing at ${path.relative(ROOT, file)}`);
    throw error;
  }
  const actual = sha256(bytes);
  if (actual !== source.sha256) {
    throw cacheError(`exact tarkov.dev ${name} cache hash mismatch: expected ${source.sha256}, got ${actual}`);
  }
  let json;
  try { json = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw cacheError(`exact tarkov.dev ${name} cache is invalid JSON (${error.message})`); }
  return { source, json };
}

function rawRecords(map, collection) {
  if (collection === 'artilleryZones') return map.artillery?.zones ?? [];
  return map[collection] ?? [];
}

function identityId(collection, raw) {
  if (raw?.id != null) return String(raw.id);
  if (collection === 'lootContainers' && raw?.lootContainer) return String(raw.lootContainer);
  if (collection === 'stationaryWeapons' && raw?.stationaryWeapon) return String(raw.stationaryWeapon);
  if (collection === 'btrStops' && raw?.name) return String(raw.name);
  return null;
}

function wrapRecords(collection, rows) {
  if (!Array.isArray(rows)) throw new Error(`exact tarkov.dev collection ${collection} is not an array`);
  const seen = new Map();
  return rows.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`exact tarkov.dev ${collection} contains a non-object record`);
    const rawId = raw.id == null ? null : String(raw.id);
    const generated = sha256(stableStringify(raw)).slice(0, 24);
    const base = rawId ?? `generated:${generated}`;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    return {
      sourceId: ordinal === 1 ? base : `${base}#${ordinal}`,
      ...(identityId(collection, raw) ? { identityId: identityId(collection, raw) } : {}),
      // `raw` is intentionally untouched: source spelling (including artillery's
      // current `botom` typo), precision, arrays and identity tokens stay verbatim.
      raw,
    };
  });
}

export function exactPosition(raw) {
  const position = raw?.position ?? raw;
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return null;
  return { x: position.x, y: position.y, z: position.z };
}

export function translateExact(value, translations, suffix = '') {
  if (value == null || value === false) return '';
  const token = String(value);
  return translations?.[token + suffix] ?? translations?.[token] ?? token;
}

export function primitiveRows(exactLayer) {
  const out = [];
  for (const [collection, kind] of EXACT_COLLECTIONS) {
    for (const item of exactLayer.collections[collection] ?? []) out.push({ collection, kind, ...item });
  }
  return out;
}

export async function loadExactMap(mapKey) {
  const manifest = await loadManifest();
  const [{ source: mapsSource, json: mapsJson }, { source: namesSource, json: namesJson }] = await Promise.all([
    loadSource(manifest, 'maps'),
    loadSource(manifest, 'maps_en'),
  ]);
  const maps = mapsJson?.data?.maps;
  const translations = namesJson?.data;
  if (!maps || typeof maps !== 'object' || Array.isArray(maps)) throw cacheError('exact tarkov.dev maps cache has no data.maps object');
  if (!translations || typeof translations !== 'object' || Array.isArray(translations)) throw cacheError('exact tarkov.dev maps_en cache has no translation object');
  const map = Object.values(maps).find((candidate) => candidate?.normalizedName === mapKey);
  if (!map) throw new Error(`exact tarkov.dev cache has no map ${mapKey}`);

  const collections = {};
  for (const [collection] of EXACT_COLLECTIONS) collections[collection] = wrapRecords(collection, rawRecords(map, collection));
  const exact = {
    schemaVersion: EXACT_LAYER_SCHEMA_VERSION,
    source: {
      provider: 'tarkov.dev-json',
      cacheVersion: manifest.cacheVersion,
      fetchedDate: manifest.fetchedDate,
      urls: [mapsSource.url, namesSource.url],
      sha256: { maps: mapsSource.sha256, maps_en: namesSource.sha256 },
    },
    map: {
      id: map.id,
      normalizedName: map.normalizedName,
      nameId: map.nameId,
      name: translateExact(map.name, translations),
    },
    collections,
  };
  return {
    exact,
    map,
    translations,
    lookups: {
      lootContainers: mapsJson.data.lootContainers ?? {},
      stationaryWeapons: mapsJson.data.stationaryWeapons ?? {},
    },
  };
}
