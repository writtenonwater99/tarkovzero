#!/usr/bin/env node
// Customs-only deterministic source-to-artifact gate. This verifier first
// rebuilds both generated files in a disposable workspace from the committed
// exact JSON/SVG fixtures with networking disabled, then checks semantic
// contracts. Reserve and Woods remain read-only pinned regression sentinels.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carveWaterHeightfield, makeWaterHeightCapper } from '../src/water.js';
import {
  assertMarkerNameUniqueness, loadExactMap, normalizeMarkerName, reconcileMarkerRows, stableStringify,
} from './lib/exact-map-primitives.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = 'customs';
const OUTPUTS = [`public/data/${MAP}.json`, `public/data/${MAP}-3d.json`];
const CUSTOMS_OUTPUT_HASHES = Object.freeze({
  'public/data/customs.json': 'b9422bf895ed5a4b99fa015717893511abff3eb393e47be891ddfac728f26de6',
  'public/data/customs-3d.json': '9a6df2ad1d62371e0f139b0c017ea1fdc1426d44905042cd9a4f34a575141dad',
});
const READ_ONLY_REGRESSIONS = Object.freeze({
  reserve: {
    hashes: {
      'public/data/reserve.json': '0dc4ceeca5228ea7012f0c52f0d37aa425a32433886c0f7e28ae01a128178036',
      'public/data/reserve-3d.json': '81d67bf8a6b845e40cc8c4b4ed9d82fa70399b1096cda9338b2f0259829d1bbf',
    },
    anchors: {
      'White Pawn': -1.25, Helipad: -5.09, 'White Queen / Dome': 19.54,
      'D-2': 15.60, 'White Rook / Train Station': -6.25, 'Bunker Hermetic Door': -0.35,
    },
  },
  woods: {
    hashes: {
      'public/data/woods.json': '95dfe4fd6e67e4af980cc48c853f01f886c38b9b97d2029b9741d6b7f52dadbd',
      'public/data/woods-3d.json': '375a7359c772991b48a7b0ebeeda202fdcdf4c704993b1486750619160265702',
    },
    anchors: {
      'Sniper Mountain Summit': 77.52, 'Upper Mountain': 64.62, 'Mountain Flank': 52.27,
      'Train Depot': 9.05, 'USEC Camp': 24.57, Sawmill: -2.83,
    },
  },
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const close = (actual, expected, tolerance, message) => assert(
  Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`,
);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function usage(message) {
  const stream = message ? process.stderr : process.stdout;
  if (message) stream.write(`${message}\n`);
  stream.write('usage: node scripts/verify-map-pipeline.mjs\n');
  stream.write('       rebuilds Customs offline; checks pinned Reserve/Woods artifacts read-only\n');
  process.exit(message ? 1 : 0);
}

for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') usage();
  usage(`unknown argument: ${argument}`);
}

const NETWORK_GUARD_SOURCE = String.raw`'use strict';
const deny = () => {
  const error = new Error('network disabled by TarkovZero map-pipeline verifier');
  error.code = 'ERR_TARKOVZERO_NETWORK_DISABLED';
  throw error;
};
globalThis.fetch = deny;
const net = require('node:net');
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
const tls = require('node:tls');
tls.connect = deny;
tls.TLSSocket.prototype.connect = deny;
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.get = deny;
  module.request = deny;
}
const dgram = require('node:dgram');
dgram.Socket.prototype.bind = deny;
dgram.Socket.prototype.connect = deny;
dgram.Socket.prototype.send = deny;
const dns = require('node:dns');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) dns[name] = deny;
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) dns.promises[name] = deny;
`;

function runNode(arguments_, cwd, networkGuard) {
  try {
    return execFileSync(process.execPath, ['--require', networkGuard, ...arguments_], {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TZ: 'UTC' },
    });
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${process.execPath} ${arguments_.join(' ')} failed in isolated rebuild${output ? `:\n${output}` : ''}`);
  }
}

function expectNodeFailure(arguments_, cwd, networkGuard, pattern) {
  let failure;
  try {
    execFileSync(process.execPath, ['--require', networkGuard, ...arguments_], {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) { failure = error; }
  assert(failure, `${process.execPath} ${arguments_.join(' ')} unexpectedly succeeded without a required fixture`);
  const output = [failure.stdout, failure.stderr].filter(Boolean).join('\n');
  assert(pattern.test(output), `${process.execPath} ${arguments_.join(' ')} failed for the wrong reason:\n${output}`);
}

function assertNetworkGuard(cwd, networkGuard) {
  const probe = `
    const probes = [
      () => fetch('https://example.invalid/'),
      () => require('node:net').connect(9, '192.0.2.1'),
    ];
    for (const probe of probes) {
      let blocked = false;
      try { probe(); } catch (error) { blocked = error?.code === 'ERR_TARKOVZERO_NETWORK_DISABLED'; }
      if (!blocked) process.exit(2);
    }
  `;
  try {
    execFileSync(process.execPath, ['--require', networkGuard, '-e', probe], {
      cwd, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n');
    throw new Error(`isolated rebuild network guard is not active${output ? `:\n${output}` : ''}`);
  }
}

async function copyProjectFiles(destination) {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT, maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8').split('\0').filter(Boolean);
  for (const relative of listed) {
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'), `unsafe project path from git: ${relative}`);
    const source = path.join(ROOT, relative);
    let stat;
    try { stat = await lstat(source); }
    catch (error) { if (error?.code === 'ENOENT') continue; else throw error; }
    if (!stat.isFile()) continue;
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

async function assertIsolatedRebuild() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'tarkovzero-customs-rebuild-'));
  try {
    await copyProjectFiles(workspace);
    const networkGuard = path.join(workspace, '.map-pipeline-network-disabled.cjs');
    await writeFile(networkGuard, NETWORK_GUARD_SOURCE);
    assertNetworkGuard(workspace, networkGuard);
    runNode(['scripts/build-community-data.mjs', MAP], workspace, networkGuard);
    runNode(['scripts/build-3d.mjs', MAP], workspace, networkGuard);
    const rows = [];
    for (const relative of OUTPUTS) {
      const [expected, rebuilt] = await Promise.all([
        readFile(path.join(ROOT, relative)),
        readFile(path.join(workspace, relative)),
      ]);
      const expectedHash = sha256(expected), rebuiltHash = sha256(rebuilt);
      assert(expectedHash === CUSTOMS_OUTPUT_HASHES[relative], `${relative} pinned hash drifted\n`
        + `expected ${CUSTOMS_OUTPUT_HASHES[relative]}\nworktree ${expectedHash}`);
      assert(expected.equals(rebuilt), `${relative} is stale relative to its pinned inputs/builders\n`
        + `worktree ${expectedHash}\nrebuilt  ${rebuiltHash}\n`
        + `regenerate with: node scripts/build-community-data.mjs customs && node scripts/build-3d.mjs customs`);
      rows.push([relative, rebuiltHash]);
    }

    const manifest = JSON.parse(await readFile(path.join(workspace, 'scripts/data/tarkov-dev-exact-manifest.json'), 'utf8'));
    const exactRelative = manifest.maps?.[MAP]?.cachePath;
    const svgRelative = manifest.maps?.[MAP]?.svg?.cachePath;
    for (const relative of [exactRelative, svgRelative]) {
      assert(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.split('/').includes('..'),
        `unsafe fixture path in isolated manifest: ${relative}`);
    }
    const svgFixture = path.join(workspace, svgRelative);
    const tamperedSvg = Buffer.from(await readFile(svgFixture));
    tamperedSvg[Math.floor(tamperedSvg.length / 2)] ^= 0x01;
    await writeFile(svgFixture, tamperedSvg);
    expectNodeFailure(['scripts/build-3d.mjs', MAP], workspace, networkGuard, /SVG customs fixture hash mismatch/);
    await rm(svgFixture);
    expectNodeFailure(['scripts/build-3d.mjs', MAP], workspace, networkGuard, /SVG customs fixture is missing/);
    await rm(path.join(workspace, exactRelative));
    expectNodeFailure(['scripts/build-community-data.mjs', MAP], workspace, networkGuard, /exact tarkov\.dev customs fixture is missing/);
    return rows;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const inPoly = ([x, z], poly) => {
  let inside = false;
  for (let index = 0, previous = poly.length - 1; index < poly.length; previous = index++) {
    const [xi, zi] = poly[index], [xj, zj] = poly[previous];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

const catmullRom = (p0, p1, p2, p3, unit) => {
  const unit2 = unit * unit, unit3 = unit2 * unit;
  return p0 * (-0.5 * unit3 + unit2 - 0.5 * unit) + p1 * (1.5 * unit3 - 2.5 * unit2 + 1)
    + p2 * (-1.5 * unit3 + 2 * unit2 + 0.5 * unit) + p3 * (0.5 * unit3 - 0.5 * unit2);
};

function gaussianOnce(heights, columns, rows) {
  const kernel = [1, 4, 6, 4, 1];
  const source = Float32Array.from(heights), temporary = new Float32Array(source.length), output = new Float32Array(source.length);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    let sum = 0;
    for (let offset = -2; offset <= 2; offset++) sum += source[row * columns + clamp(column + offset, 0, columns - 1)] * kernel[offset + 2];
    temporary[row * columns + column] = sum / 16;
  }
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    let sum = 0;
    for (let offset = -2; offset <= 2; offset++) sum += temporary[clamp(row + offset, 0, rows - 1) * columns + column] * kernel[offset + 2];
    output[row * columns + column] = sum / 16;
  }
  return output;
}

function canonicalTerrainSampler(document) {
  const terrain = document.terrain;
  const { x0, z0, step, cols, rows } = terrain;
  const grid = carveWaterHeightfield(gaussianOnce(terrain.heights, cols, rows), terrain, document.water || []);
  const at = (column, row) => grid[clamp(row, 0, rows - 1) * cols + clamp(column, 0, cols - 1)];
  const bicubic = (x, z) => {
    const horizontal = (x - x0) / step, vertical = (z - z0) / step;
    const column = Math.floor(horizontal), row = Math.floor(vertical);
    const unitX = horizontal - column, unitZ = vertical - row;
    return catmullRom(
      catmullRom(at(column - 1, row - 1), at(column, row - 1), at(column + 1, row - 1), at(column + 2, row - 1), unitX),
      catmullRom(at(column - 1, row), at(column, row), at(column + 1, row), at(column + 2, row), unitX),
      catmullRom(at(column - 1, row + 1), at(column, row + 1), at(column + 1, row + 1), at(column + 2, row + 1), unitX),
      catmullRom(at(column - 1, row + 2), at(column, row + 2), at(column + 1, row + 2), at(column + 2, row + 2), unitX),
      unitZ,
    );
  };
  const capWater = makeWaterHeightCapper(document.water || [], 1);
  return (x, z) => capWater(bicubic(x, z), x, z);
}

function surfaceSampler(document, relief = 1) {
  const canonical = canonicalTerrainSampler(document);
  return (x, z) => {
    const base = canonical(x, z) * relief;
    return Math.max(base, ...(document.hardRocks || []).filter((rock) => inPoly([x, z], rock.poly))
      .map((rock) => Number.isFinite(rock.surfaceY) ? rock.surfaceY * relief : base + rock.height * relief));
  };
}

function reliefPaths(value, objectPath = '', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => reliefPaths(item, `${objectPath}[${index}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/relief/i.test(key)) found.push(`${objectPath}.${key}`);
      reliefPaths(child, `${objectPath}.${key}`, found);
    }
  }
  return found;
}

async function assertReadOnlyRegressionMaps() {
  const hashes = [];
  for (const [map, expected] of Object.entries(READ_ONLY_REGRESSIONS)) {
    const markerPath = `public/data/${map}.json`;
    const geometryPath = `public/data/${map}-3d.json`;
    const [markerBytes, geometryBytes] = await Promise.all([
      readFile(path.join(ROOT, markerPath)),
      readFile(path.join(ROOT, geometryPath)),
    ]);
    for (const [file, bytes] of [[markerPath, markerBytes], [geometryPath, geometryBytes]]) {
      const actual = sha256(bytes);
      assert(actual === expected.hashes[file], `${map}: pinned ${file} hash drifted: expected ${expected.hashes[file]}, got ${actual}`);
      hashes.push([file, actual]);
    }

    const markers = JSON.parse(markerBytes);
    const document = JSON.parse(geometryBytes);
    assert(Array.isArray(markers.extracts) && Array.isArray(markers.spawns) && markers.extracts.length > 0 && markers.spawns.length > 0,
      `${map}: canonical marker collections are missing`);
    assert(document.canonicalScale === 1 && document.terrain?.units?.scale === 1, `${map}: canonical output is not 1x`);
    const bakedRelief = reliefPaths(document);
    assert(!bakedRelief.length, `${map}: relief was baked into generated data at ${bakedRelief.join(', ')}`);

    const anchors = document.features?.anchors ?? [];
    assert(anchors.length === Object.keys(expected.anchors).length, `${map}: reviewed anchor count drifted`);
    const surface = surfaceSampler(document, 1);
    for (const anchor of anchors) {
      assert(Object.hasOwn(expected.anchors, anchor.name), `${map}/${anchor.name}: unexpected verification anchor`);
      close(surface(...anchor.position), expected.anchors[anchor.name], 0.015, `${map}/${anchor.name}: canonical anchor height drifted`);
    }

    const assignments = document.features?.assignments ?? [];
    if (map === 'reserve') {
      assert(assignments.find((item) => item.featureRoot === 'reserve.white_pawn.main')?.floors === 5,
        'reserve: White Pawn canonical floor assignment failed');
      assert(assignments.find((item) => item.featureRoot === 'reserve.helipad.service_footprint')?.heightM <= 4.5,
        'reserve: Helipad service-footprint height failed');
    } else if (map === 'woods') {
      assert(document.props.filter((item) => item.featureRoot === 'woods.train_depot.freight_cars' && item.type === 'railcar').length === 6,
        'woods: canonical freight-car count failed');
      assert(document.props.filter((item) => item.featureRoot === 'woods.train_depot.cargo' && item.type === 'container').length === 10,
        'woods: canonical depot-cargo count failed');
      assert(!assignments.some((item) => item.featureRoot?.startsWith('woods.train_depot.') && item.place === 'Railway Bridge to Tarkov'),
        'woods: Train Depot retains the incorrect Railway Bridge label');
    }
  }
  return hashes;
}

function markerRows(markers, collection) {
  const target = {
    spawns: 'spawns', extracts: 'extracts', transits: 'extracts', locks: 'locks', switches: 'switches',
    hazards: 'hazards', lootContainers: 'containers', lootLoose: 'containers', stationaryWeapons: 'stationaryWeapons',
    btrStops: 'btrStops', artilleryZones: 'artilleryZones',
  }[collection];
  return markers[target] || [];
}

const SOURCE_KIND = {
  spawns: 'spawn', extracts: 'extract', transits: 'transit', locks: 'lock', switches: 'switch', hazards: 'hazard',
  lootContainers: 'lootContainer', lootLoose: 'looseLoot', stationaryWeapons: 'stationaryWeapon', btrStops: 'btrStop', artilleryZones: 'artilleryZone',
};

const sourcePosition = (collection, raw) => collection === 'btrStops'
  ? { x: raw.x, y: raw.y, z: raw.z } : raw.position;

const semanticMarkerCollections = (markers) => [
  { rows: markers.extracts, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name, factionOf: (row) => row.faction },
  { rows: markers.locks, kindOf: (row) => row.sourceKind, nameOf: (row) => row.key?.name },
  { rows: markers.switches, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
  { rows: markers.hazards, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
  { rows: markers.containers, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
  { rows: markers.spawns, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
  { rows: markers.stationaryWeapons, kindOf: (row) => row.sourceKind, nameOf: (row) => row.stationaryWeapon?.name },
  { rows: markers.btrStops, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
];

function assertLibraryContracts() {
  const merger = reconcileMarkerRows([
    { source: 'tarkov.dev-json', sourceKind: 'extract', sourceId: 'exact', name: 'Railroad Passage (Flare)', faction: 'pmc', level: 'surface', position: { x: 1, y: 9, z: 2 } },
  ], [
    { source: 'eft-wiki', sourceKind: 'extract', sourceId: 'wiki', name: 'railroad passage', faction: 'pmc', level: 'underground', position: { x: 500, z: 500 }, description: 'Wiki description' },
  ]);
  assert(normalizeMarkerName(' Railroad Passage (Flare) ') === 'railroadpassage', 'marker-name normalization contract failed');
  assert(merger.rows.length === 1 && merger.stats[0].byName === 1, 'name-first marker reconciliation contract failed');
  assert(stableStringify(merger.rows[0].position) === stableStringify({ x: 1, y: 9, z: 2 })
    && merger.rows[0].level === 'surface' && merger.rows[0].description === 'Wiki description',
  'exact geometry / Wiki enrichment reconciliation contract failed');

  const duplicate = [{
    rows: [
      { source: 'tarkov.dev-json', sourceKind: 'extract', sourceId: 'a', name: 'Scav Checkpoint', faction: 'scav' },
      { source: 'tarkov.dev-json', sourceKind: 'extract', sourceId: 'b', name: 'Scav Checkpoint (Co-op)', faction: 'scav' },
    ],
    kindOf: (row) => row.sourceKind, nameOf: (row) => row.name, factionOf: (row) => row.faction,
  }];
  let rejected = false;
  try { assertMarkerNameUniqueness('fixture', duplicate); } catch { rejected = true; }
  assert(rejected, 'unwhitelisted duplicate marker contract failed');
}

const rebuiltHashes = await assertIsolatedRebuild();
assertLibraryContracts();
const regressionHashes = await assertReadOnlyRegressionMaps();

const [markerBytes, geometryBytes, featureBytes] = await Promise.all([
  readFile(path.join(ROOT, OUTPUTS[0])),
  readFile(path.join(ROOT, OUTPUTS[1])),
  readFile(path.join(ROOT, 'data/customs-features.json')),
]);
const markers = JSON.parse(markerBytes), document = JSON.parse(geometryBytes), featureManifest = JSON.parse(featureBytes);
const exactSource = await loadExactMap(MAP);

assert(document.canonicalScale === 1 && document.terrain.units?.scale === 1, 'customs: canonical output is not 1x');
const reliefKeys = reliefPaths(document);
assert(!reliefKeys.length, `customs: relief was baked into generated data at ${reliefKeys.join(', ')}`);

const surface1 = surfaceSampler(document, 1), surface3 = surfaceSampler(document, 3);
for (const anchor of document.features.anchors) {
  const [x, z] = anchor.position, canonical = surface1(x, z);
  assert(Number.isFinite(canonical), `customs/${anchor.name}: canonical anchor height is not finite`);
  assert(Math.abs(surface3(x, z) - canonical * 3) <= 1e-4, `customs/${anchor.name}: 3x sampler is not a pure view skin`);
}
assert(document.features.anchors.length >= 6, 'customs: reviewed verification anchors were dropped');
assert(document.features.assignments.some((item) => item.featureRoot === 'customs.dorms.two_story.main' && item.floors === 2), 'customs: Dorms 2-Story feature assignment failed');
const dormsThreeStorySourceKey = 'svg:Ground_Level/Buildings/Big_Buildings-2:element-194:subpath-0';
const dormsThreeStory = document.features.assignments.find((item) => item.featureRoot === 'customs.dorms.three_story.main');
assert(dormsThreeStory?.featureId === 'customs.dorms.three_story.main'
  && dormsThreeStory.sourceKey === dormsThreeStorySourceKey
  && dormsThreeStory.floors === 3 && dormsThreeStory.heightM === 9.5 && dormsThreeStory.emittedAs === 'building',
'customs: Dorms 3-Story reviewed shell assignment failed');
assert(document.buildings.some((building) => building.sourceKey === dormsThreeStorySourceKey
  && building.featureId === dormsThreeStory.featureId && building.floors === 3 && building.height === 9.5),
'customs: Dorms 3-Story assignment does not resolve to the emitted 3-floor/9.5m building');

assert(stableStringify(document.exact) === stableStringify(exactSource.exact), 'customs: serialized exact layer differs from verified fixture');
assert(markers.exactCache?.cacheVersion === document.exact.source.cacheVersion, 'customs: marker and geometry exact-cache versions differ');
for (const [collection, sourceItems] of Object.entries(document.exact.collections)) {
  const rendered = markerRows(markers, collection);
  for (const sourceItem of sourceItems) {
    const projected = rendered.find((row) => row.source === 'tarkov.dev-json'
      && row.sourceKind === SOURCE_KIND[collection] && row.sourceId === sourceItem.sourceId);
    assert(projected, `customs: ${collection}/${sourceItem.sourceId} was not projected into renderer markers`);
    const exactPosition = sourcePosition(collection, sourceItem.raw);
    if (exactPosition) {
      assert(projected.position, `customs: ${collection}/${sourceItem.sourceId} lost its exact position`);
      assert(projected.position.x === exactPosition.x && projected.position.y === exactPosition.y && projected.position.z === exactPosition.z,
        `customs: ${collection}/${sourceItem.sourceId} lost exact position precision`);
    }
    for (const field of ['size', 'outline']) if (sourceItem.raw[field] != null) {
      assert(stableStringify(projected[field]) === stableStringify(sourceItem.raw[field]), `customs: ${collection}/${sourceItem.sourceId} lost exact ${field}`);
    }
    if (Number.isFinite(sourceItem.raw.top)) assert(projected.top === sourceItem.raw.top, `customs: ${collection}/${sourceItem.sourceId} lost exact top`);
    if (Number.isFinite(sourceItem.raw.bottom ?? sourceItem.raw.botom)) {
      assert(projected.bottom === (sourceItem.raw.bottom ?? sourceItem.raw.botom), `customs: ${collection}/${sourceItem.sourceId} lost exact bottom`);
    }
  }
}

assertMarkerNameUniqueness(MAP, semanticMarkerCollections(markers), featureManifest.markerDuplicateWhitelist ?? []);
assert(!markers.locks.some((row) => row.source === 'eft-wiki'), 'customs: unanchored Wiki lock entered published world coordinates');
assert(markers.locks.filter((row) => row.source === 'tarkov.dev-json').length === document.exact.collections.locks.length, 'customs: exact lock set was not preserved');
const quarantinedLocks = markers.quarantinedMarkers?.locks ?? [];
assert(quarantinedLocks.length === 28, `customs: expected 28 detached-panel Wiki locks in quarantine, got ${quarantinedLocks.length}`);
for (const row of quarantinedLocks) {
  assert(row.coordinateStatus === 'unanchored-wiki-panel', `customs: quarantined lock ${row.sourceId} lacks coordinate status`);
  assert(!Object.hasOwn(row, 'position'), `customs: quarantined lock ${row.sourceId} retains a fabricated world position`);
}

const evidence = document.terrain.evidence;
assert(evidence.schemaVersion === 3, 'customs: typed surface evidence schema missing');
assert(Object.values(evidence.bucketCounts).reduce((sum, count) => sum + count, 0) === evidence.input, 'customs: evidence buckets do not account for every input');
assert(stableStringify(evidence.heightfieldBuckets) === stableStringify(['ground', 'road']), 'customs: only ground and road evidence may fit the terrain heightfield');
assert(Number.isInteger(evidence.heightfieldSamples) && evidence.heightfieldSamples > 0, 'customs: heightfield fit has no samples');
for (const [bucket, points] of Object.entries(evidence.buckets)) for (const point of points) {
  assert([point.x, point.y, point.z].every(Number.isFinite), `customs: ${bucket} contains a non-finite point`);
  assert(point.reasonCodes?.length, `customs: ${bucket}/${point.sourceId} has no reason code`);
}
const routedExactIds = new Set(Object.values(evidence.buckets).flat()
  .filter((point) => point.provider === 'tarkov.dev-json').map((point) => point.sourceId));
for (const [collection, items] of Object.entries(document.exact.collections)) for (const item of items) {
  if (sourcePosition(collection, item.raw)) assert(routedExactIds.has(`${collection}:${item.sourceId}`), `customs: exact Y ${collection}/${item.sourceId} never entered the elevation router`);
}
assert(evidence.buckets.ground.some((point) => point.provider === 'tarkov.dev-json')
  && evidence.buckets.ground.some((point) => point.provider === 'spt-4.1.2'), 'customs: exact and SPT evidence do not share the ground pipeline');
assert(document.floorSurfaces.some((surface) => surface.classification === 'underground')
  && document.floorSurfaces.some((surface) => surface.classification === 'roof'), 'customs: roof/underground evidence did not feed floor classification');
const surfaceIds = new Set();
for (const surface of document.floorSurfaces) {
  const expectedStableId = `${MAP}.surface.${sha256(Buffer.from(stableStringify([
    MAP, surface.scope, surface.classification, String(surface.floorIndex),
  ]))).slice(0, 24)}`;
  assert(surface.stableId === expectedStableId, `customs: floor surface ${surface.scope}/${surface.classification}/${surface.floorIndex} has a non-deterministic stableId`);
  assert(!surfaceIds.has(surface.stableId), `customs: duplicate floor surface stableId ${surface.stableId}`);
  surfaceIds.add(surface.stableId);
  if (surface.scope.startsWith('building:')) {
    assert(surface.buildingSourceKey && surface.scope === `building:${surface.buildingSourceKey}`,
      `customs: ${surface.stableId} has no explicit building source binding`);
    const building = document.buildings.find((candidate) => candidate.sourceKey === surface.buildingSourceKey);
    assert(building, `customs: ${surface.stableId} references a missing building ${surface.buildingSourceKey}`);
    if (surface.buildingId != null) {
      assert(surface.buildingId === building.featureId && surface.featureId === surface.buildingId,
        `customs: ${surface.stableId} has inconsistent reviewed building IDs`);
    }
  }
}
const dormsTwoFloorZero = document.floorSurfaces.find((surface) => surface.stableId === 'customs.surface.3f03ef2c6b3b917900b5f2fe');
const dormsThreeFloorZero = document.floorSurfaces.find((surface) => surface.stableId === 'customs.surface.23e45b4ca4c30541d58d5cd6');
for (const [name, surface, featureId] of [
  ['Dorms 2-Story', dormsTwoFloorZero, 'customs.dorms.two_story.main'],
  ['Dorms 3-Story', dormsThreeFloorZero, 'customs.dorms.three_story.main'],
]) {
  assert(surface?.classification === 'floor' && surface.floorIndex === 0
    && surface.buildingId === featureId && Number.isFinite(surface.surfaceY),
  `customs: ${name} floor-0 stable surface selector failed`);
}

console.log('verified Customs from committed exact JSON/SVG fixtures through an isolated two-builder rebuild with networking disabled');
for (const [file, hash] of rebuiltHashes) console.log(`${file}: ${hash}`);
console.log('verified Reserve/Woods as pinned read-only canonical/feature/anchor regressions');
for (const [file, hash] of regressionHashes) console.log(`${file}: ${hash}`);
console.log(`exact collections preserved; ${quarantinedLocks.length} detached-panel Wiki locks remain coordinate-free`);
