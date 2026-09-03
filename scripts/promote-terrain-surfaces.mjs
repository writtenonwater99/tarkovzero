#!/usr/bin/env node
//
// Promote the Customs terrain HEIGHT and CONTROL surfaces from `.local-game-derived/customs/` into
// `public/assets/3d/customs/terrain/`, where they ship as ordinary public assets — the road
// `public/assets/3d/customs/authored/fortress/` already travels.
//
// WHY THIS EXISTS AS A SCRIPT AND NOT A ONE-TIME COPY. Three artifacts have to agree, forever:
// the bytes in `public/`, the entries in `asset-promotion-manifest.json` (digest, size, receipt),
// and the public terrain manifest the browser reads. Hand-maintaining that agreement is how a
// promotion silently rots. This script writes all three from one read and has a `--check` mode
// that fails when they have drifted.
//
// WHAT IT WILL NOT MOVE. The set of promotable files is NOT decided here. It comes from
// `PROMOTABLE_SOURCES['customs-local-terrain-surfaces']` in `scripts/lib/asset-promotion.mjs`,
// whose `filePattern` admits `terrain-NNN-height-world-y.f32le` and `terrain-NNN-control-{0,1,2}.png`
// and nothing else. `terrain-NNN-vegetation.json` sits in the same directory and is a RAW CAPTURE —
// the acquisition-layer Unity dump — so `assertNotCapture`/`captureSubtreeFor` refuse it and this
// script refuses it twice more (once when filtering, once when it re-checks each file's tier).
// `manifest.json` and `extraction-report.json` stay local too.
//
// THE RECEIPT IS WEAK, AND THE MANIFEST SAYS SO. Vegetation's receipt is a factory plus a catalog:
// committed code that GENERATES the artifact, so re-running it reproduces the bytes. Terrain has
// no such thing. `scripts/extract-customs-terrain-local.py` is an EXTRACTOR — it reads the
// founder's install and writes what it found. Re-running it against the game reproduces the bytes
// only because the game has them. What makes these promotable is the founder's ruling, recorded in
// `approvedBy`/`approvedOn`; the receipt only proves the extractor has not changed since. Do not
// let the shape of the receipt field imply a provenance chain that is not there.
//
// USAGE
//   node scripts/promote-terrain-surfaces.mjs            # copy + write manifests
//   node scripts/promote-terrain-surfaces.mjs --check    # verify agreement, write nothing

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROMOTABLE_SOURCES,
  PROMOTION_MANIFEST_PATH,
  REPOSITORY_ROOT,
  classifyLocalPath,
  promotionManifestDocument,
  serializePromotionManifest,
  sha256File,
} from './lib/asset-promotion.mjs';

const SOURCE_KEY = 'customs-local-terrain-surfaces';
const SOURCE = PROMOTABLE_SOURCES[SOURCE_KEY];

/** Where the promoted surfaces live in `public/`, and therefore in `dist/`. */
export const PROMOTED_PUBLIC_DIR = 'public/assets/3d/customs/terrain';
export const PROMOTED_DIST_DIR = 'assets/3d/customs/terrain';
export const PUBLIC_TERRAIN_MANIFEST_FILE = 'terrain-manifest.json';

/** The founder's ruling — the thing that actually authorises this, recorded as such. */
const APPROVED_BY = 'founder (explicit approval to promote the terrain surfaces, twice, 2026-09-02)';
const APPROVED_ON = '2026-09-02';

const ENTRY_NOTE =
  'Promoted on the founder\'s ruling, not on a generative provenance chain. Unlike the vegetation '
  + 'families, these surfaces are MEASUREMENTS: the receipt cites scripts/extract-customs-terrain-local.py, '
  + 'an extractor that reads the install and writes what it found, so it proves the extractor is '
  + 'unchanged since approval and nothing more. It is not a factory + catalog pair that regenerates '
  + 'the bytes from committed inputs. Read the receipt as an integrity seal on the tool, not as '
  + 'evidence of authorship.';

function idFor(sourcePath) {
  return `customs.terrain.${sourcePath.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-')}`;
}

async function collect() {
  const localManifestPath = resolve(REPOSITORY_ROOT, ...SOURCE.root.split('/'), 'manifest.json');
  const localManifest = JSON.parse(await readFile(localManifestPath, 'utf8'));

  const files = [];
  const refused = [];
  for (const tile of localManifest.tiles) {
    const candidates = [tile.heightFile, ...tile.controlMaps.map((control) => control.file)];
    if (tile.vegetation?.file) candidates.push(tile.vegetation.file);
    for (const name of candidates) {
      const repoPath = `${SOURCE.root}/${name}`;
      const tier = classifyLocalPath(repoPath);
      // Two independent refusals, on purpose. The pattern decides what MAY be named; the tier
      // decides what a path IS. `terrain-NNN-vegetation.json` fails both.
      if (!SOURCE.filePattern.test(name) || tier.tier !== 'promotable') {
        refused.push({ name, tier: tier.tier });
        continue;
      }
      const absolute = resolve(REPOSITORY_ROOT, ...repoPath.split('/'));
      const bytes = await readFile(absolute);
      files.push({
        sourcePath: name,
        sourceRepoPath: repoPath,
        absolute,
        bytes: bytes.byteLength,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      });
    }
  }
  files.sort((left, right) => (left.sourcePath < right.sourcePath ? -1 : 1));

  const receipt = {
    kind: SOURCE.receipt.kind,
    documents: [],
  };
  for (const document of SOURCE.receipt.documents) {
    const absolute = resolve(REPOSITORY_ROOT, ...document.repoPath.split('/'));
    receipt.documents.push({
      role: document.role,
      repoPath: document.repoPath,
      sha256: `sha256:${await sha256File(absolute)}`,
    });
  }

  // The PUBLIC terrain manifest. Same schema the loopback package uses, with two deliberate
  // differences: `localOnly` is FALSE (this package ships; saying otherwise would be a document
  // that lies about itself) and no tile carries `vegetation`, because the vegetation dump is a raw
  // capture and stays where it is. Both are asserted by `loadCustomsPromotedTerrainPackage()`.
  const publicManifest = {
    schemaVersion: localManifest.schemaVersion,
    map: localManifest.map,
    localOnly: false,
    sourceFrame: localManifest.sourceFrame,
    reliefOriginYM: localManifest.reliefOriginYM,
    tiles: localManifest.tiles.map((tile) => {
      const { vegetation, ...rest } = tile;
      return rest;
    }),
  };

  return { files, refused, receipt, publicManifest };
}

function promotionEntries(files, receipt) {
  return files.map((file) => ({
    id: idFor(file.sourcePath),
    source: SOURCE_KEY,
    sourcePath: file.sourcePath,
    distPath: `${PROMOTED_DIST_DIR}/${file.sourcePath}`,
    sha256: file.sha256,
    bytes: file.bytes,
    approvedBy: APPROVED_BY,
    approvedOn: APPROVED_ON,
    receipt,
    notes: ENTRY_NOTE,
  }));
}

// The document assembly and its serialization live in `scripts/lib/asset-promotion.mjs`, shared
// with `promote-authored-vegetation.mjs`. Two scripts own disjoint rows of one file; when each also
// owned its own notes text and row order, whichever ran second made the other's `--check` report a
// stale manifest that was not stale. One writer of the document shape fixes that by construction.
const promotionDocument = promotionManifestDocument;
const serialize = serializePromotionManifest;

async function main(argv) {
  const check = argv.includes('--check');
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`unsupported argument(s): ${unknown.join(', ')}\n`);
    process.exitCode = 2;
    return;
  }

  const publicDir = resolve(REPOSITORY_ROOT, ...PROMOTED_PUBLIC_DIR.split('/'));
  const manifestFile = resolve(publicDir, PUBLIC_TERRAIN_MANIFEST_FILE);

  let collected = null;
  try {
    collected = await collect();
  } catch (error) {
    if (!check) throw error;
    collected = null;
    process.stderr.write(
      `the local terrain package is not on this machine (${error?.code ?? error}); `
      + 'checking the committed artifacts against each other only.\n',
    );
  }

  if (collected === null) {
    // Without the local package we can still prove the three committed artifacts agree with each
    // other — which is what a CI checkout can check and all it can honestly claim.
    const promotion = JSON.parse(await readFile(PROMOTION_MANIFEST_PATH, 'utf8'));
    const terrainRows = promotion.promotions.filter((entry) => entry.source === SOURCE_KEY);
    for (const row of terrainRows) {
      const shipped = resolve(publicDir, row.sourcePath);
      const digest = `sha256:${await sha256File(shipped)}`;
      if (digest !== row.sha256) {
        process.stderr.write(`${row.distPath}: shipped bytes hash to ${digest}, manifest declares ${row.sha256}\n`);
        process.exitCode = 1;
        return;
      }
    }
    process.stdout.write(`${JSON.stringify({ promoted: terrainRows.length, sourcePackage: 'absent', agreed: true }, null, 2)}\n`);
    return;
  }

  const { files, refused, receipt, publicManifest } = collected;
  const entries = promotionEntries(files, receipt);

  // Anything already in the manifest from another source key survives untouched: this script owns
  // the terrain rows and nothing else.
  let existing = { promotions: [] };
  try {
    existing = JSON.parse(await readFile(PROMOTION_MANIFEST_PATH, 'utf8'));
  } catch { /* an absent manifest is "nothing promoted"; we are about to write one */ }
  const others = (existing.promotions ?? []).filter((entry) => entry.source !== SOURCE_KEY);
  const promotionText = serialize(promotionDocument([...others, ...entries]));
  const manifestText = serialize(publicManifest);

  if (check) {
    const problems = [];
    const currentPromotion = await readFile(PROMOTION_MANIFEST_PATH, 'utf8').catch(() => null);
    if (currentPromotion !== promotionText) problems.push('asset-promotion-manifest.json is stale');
    const currentManifest = await readFile(manifestFile, 'utf8').catch(() => null);
    if (currentManifest !== manifestText) problems.push(`${PROMOTED_PUBLIC_DIR}/${PUBLIC_TERRAIN_MANIFEST_FILE} is stale`);
    for (const file of files) {
      const shipped = resolve(publicDir, file.sourcePath);
      const digest = await sha256File(shipped).then((hex) => `sha256:${hex}`).catch((error) => `unreadable (${error?.code ?? error})`);
      if (digest !== file.sha256) {
        problems.push(`${PROMOTED_PUBLIC_DIR}/${file.sourcePath}: ${digest} != source ${file.sha256}`);
      }
    }
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`${problem}\n`);
      process.stderr.write('re-run `npm run promote:terrain` and commit the result.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ promoted: files.length, agreed: true }, null, 2)}\n`);
    return;
  }

  await mkdir(publicDir, { recursive: true });
  for (const file of files) await copyFile(file.absolute, resolve(publicDir, file.sourcePath));
  await writeFile(manifestFile, manifestText);
  await writeFile(PROMOTION_MANIFEST_PATH, promotionText);

  process.stdout.write(`${JSON.stringify({
    promotedTo: PROMOTED_PUBLIC_DIR,
    files: files.map((file) => ({ file: file.sourcePath, bytes: file.bytes })),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    refusedFromTheSameDirectory: refused,
    receipt: receipt.documents.map((document) => `${document.role}=${document.repoPath}`),
    promotionManifest: relative(REPOSITORY_ROOT, PROMOTION_MANIFEST_PATH),
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
