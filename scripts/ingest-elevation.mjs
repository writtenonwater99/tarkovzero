#!/usr/bin/env node
// Merge real game-coordinate height evidence into one compact, deterministic dataset.
// Usage: node scripts/ingest-elevation.mjs <map> <survey.jsonl...>
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRID = 2;
const SOURCE_TYPES = ['looseLoot', 'spawn', 'survey'];
const SOURCE_PRIORITY = { looseLoot: 1, spawn: 2, survey: 3 };
const MAPS = {
  customs: {
    aliases: ['customs', 'bigmap'],
    spt: 'scripts/spt-bigmap-base.json',
    loose: 'scripts/data/customs/loose-loot-samples.json',
  },
  reserve: {
    aliases: ['reserve', 'rezervbase'],
    spt: 'scripts/data/reserve/spt-base.json',
    loose: 'scripts/data/reserve/loose-loot-samples.json',
  },
  woods: {
    aliases: ['woods'],
    spt: 'scripts/data/woods/spt-base.json',
    loose: 'scripts/data/woods/loose-loot-samples.json',
  },
};

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node scripts/ingest-elevation.mjs <customs|reserve|woods> <survey.jsonl...>');
  process.exit(message ? 1 : 0);
}
const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) usage();
const requested = String(argv.shift()).toLowerCase();
const map = Object.keys(MAPS).find((key) => MAPS[key].aliases.includes(requested));
if (!map) usage(`unknown map: ${requested}`);
const cfg = MAPS[map];

const finitePoint = (p) => p && Number.isFinite(+p.x) && Number.isFinite(+p.y) && Number.isFinite(+p.z);
const clean = (p, source) => ({ x: +p.x, y: +p.y, z: +p.z, source, zone: p.zone || '' });
const median = (values) => {
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const round3 = (n) => +n.toFixed(3);
const sourceFor = (value, fallback = 'survey') => {
  if (typeof value === 'number') return SOURCE_TYPES[value] || fallback;
  return SOURCE_TYPES.includes(value) ? value : fallback;
};
const mapMatches = (value) => !value || MAPS[map].aliases.includes(String(value).toLowerCase());

function collectJson(value, fallbackSource, out) {
  if (Array.isArray(value)) {
    for (const p of value) {
      if (Array.isArray(p) && p.length >= 3) {
        const q = { x: p[0], y: p[1], z: p[2] };
        if (finitePoint(q)) out.push(clean(q, sourceFor(p[3], fallbackSource)));
      } else if (finitePoint(p) && mapMatches(p.map)) out.push(clean(p, sourceFor(p.source, fallbackSource)));
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value.samples)) {
    const names = Array.isArray(value.sourceTypes) ? value.sourceTypes : SOURCE_TYPES;
    for (const p of value.samples) {
      if (!Array.isArray(p) || p.length < 3) continue;
      const q = { x: p[0], y: p[1], z: p[2] };
      if (finitePoint(q)) out.push(clean(q, names[p[3]] || fallbackSource));
    }
    return;
  }
  if (Array.isArray(value.points)) return collectJson(value.points, fallbackSource, out);
  if (Array.isArray(value.SpawnPointParams)) {
    for (const s of value.SpawnPointParams) {
      const p = { ...s.Position, zone: s.BotZoneName || '' };
      // Preserve every finite vertical observation. Ground/rock/floor/roof/
      // underground routing belongs to the shared 3D builder, not ingestion.
      if (finitePoint(p)) out.push(clean(p, 'spawn'));
    }
    return;
  }
  if (Array.isArray(value.spawnpoints)) {
    for (const s of [...value.spawnpoints, ...(value.spawnpointsForced || [])]) {
      const p = s?.template?.Position;
      if (finitePoint(p)) out.push(clean(p, 'looseLoot'));
    }
    return;
  }
  if (finitePoint(value) && mapMatches(value.map)) out.push(clean(value, fallbackSource));
}

async function loadJsonFile(file, fallbackSource) {
  const raw = await readFile(file, 'utf8');
  const out = [];
  try {
    collectJson(JSON.parse(raw), fallbackSource, out);
  } catch {
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try { collectJson(JSON.parse(line), fallbackSource, out); }
      catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
    }
  }
  return out;
}

const points = [];
const inputNames = [];
const looseFile = path.join(ROOT, cfg.loose);
try {
  points.push(...await loadJsonFile(looseFile, 'looseLoot'));
  inputNames.push(path.relative(ROOT, looseFile));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.warn(`${map}: no compact loose-loot samples at ${path.relative(ROOT, looseFile)}`);
}
const sptFile = path.join(ROOT, cfg.spt);
points.push(...await loadJsonFile(sptFile, 'spawn'));
inputNames.push(path.relative(ROOT, sptFile));
for (const name of argv) {
  const file = path.resolve(name);
  points.push(...await loadJsonFile(file, 'survey'));
  inputNames.push(path.relative(ROOT, file));
}

// A survey or spawn sample wins a 2 m cell over uncertain loose loot. Within the
// winning source use medians, which makes repeated one-second survey frames useful
// without weighting a place merely because the player stood still there.
const cells = new Map();
for (const p of points) {
  if (!finitePoint(p)) continue;
  const cell = `${Math.round(p.x / GRID)},${Math.round(p.z / GRID)}`;
  if (!cells.has(cell)) cells.set(cell, []);
  cells.get(cell).push(p);
}
const samples = [];
for (const bucket of cells.values()) {
  const priority = Math.max(...bucket.map((p) => SOURCE_PRIORITY[p.source] || 0));
  const chosen = bucket.filter((p) => (SOURCE_PRIORITY[p.source] || 0) === priority);
  const source = chosen[0].source;
  samples.push([round3(median(chosen.map((p) => p.x))), round3(median(chosen.map((p) => p.y))), round3(median(chosen.map((p) => p.z))), SOURCE_TYPES.indexOf(source)]);
}
samples.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[3] - b[3]);
const counts = Object.fromEntries(SOURCE_TYPES.map((name, index) => [name, samples.filter((p) => p[3] === index).length]));
const exactPoints = points.filter(finitePoint).map((point) => [point.x, point.y, point.z, SOURCE_TYPES.indexOf(point.source), point.zone || ''])
  .sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1] || a[3] - b[3] || a[4].localeCompare(b[4]));
const inputCounts = Object.fromEntries(SOURCE_TYPES.map((name, index) => [name, exactPoints.filter((point) => point[3] === index).length]));
const output = path.join(ROOT, 'scripts', 'data', map, 'elevation-samples.json');
const document = {
  version: 2,
  map,
  grid: GRID,
  sourceTypes: SOURCE_TYPES,
  inputs: inputNames,
  inputCounts,
  cellCounts: counts,
  // Full-precision observations are the auditable route input. `samples` is a
  // compact compatibility view, never the only copy of a rejected elevation.
  points: exactPoints,
  samples,
};
await writeFile(output, `${JSON.stringify(document)}\n`);
console.log(`${map}: ${points.length} input points -> ${samples.length} cells at ${GRID} m (${SOURCE_TYPES.map((name) => `${name} ${counts[name]}`).join(', ')})`);
console.log(`wrote ${path.relative(ROOT, output)}`);
