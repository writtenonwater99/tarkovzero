#!/usr/bin/env node
//
// Promote the authored Customs vegetation into `public/assets/3d/customs/authored/vegetation/`,
// where it ships as ordinary public assets — the road `public/assets/3d/customs/authored/fortress/`
// and, since 2026-09-02, `public/assets/3d/customs/terrain/` already travel.
//
// This is the vegetation sibling of `scripts/promote-terrain-surfaces.mjs` and is deliberately the
// same shape: four artifacts have to agree, forever — the bytes in `public/`, the rows in
// `asset-promotion-manifest.json` (digest, size, receipt), the public manifest the browser reads,
// and the derived placement table it reads alongside it. All four are written from ONE read, and
// `--check` fails when they have drifted.
//
//   node scripts/promote-authored-vegetation.mjs            # copy + write manifests
//   node scripts/promote-authored-vegetation.mjs --check     # verify agreement, write nothing
//
// ── WHAT MOVES, AND ON WHOSE AUTHORITY ────────────────────────────────────────────────────────
//
// TWO promotable sources, already registered in `PROMOTABLE_SOURCES`, are copied byte-for-byte:
//
//   customs-authored-vegetation-v2   93 GLBs, ~16 MB — 31 families x LOD0/1/2
//   customs-vegetation-arraytex-v1    9 blobs, ~26 MB — the shared texture arrays
//
// Their receipt is the STRONG kind, and unlike terrain it is a real provenance chain rather than an
// integrity seal on a tool. `validation/factory-provenance-report.json` hashes the pack against the
// git-tracked `scripts/vegetation-asset-factory/vegetation_factory.py` +
// `prototype_catalog.json`, and every one of the 31 families reports
//
//     geometryEvidence: "original approximation from scalar prototype identity and fallback envelope"
//
// i.e. geometry GENERATED from a committed scalar catalogue. Re-running the committed factory
// reproduces those bytes. Terrain's receipt cites an EXTRACTOR — a tool that reads the founder's
// install and writes what it found — and proves only that the tool is unchanged. The two are not
// the same claim and the manifest rows say which is which.
//
// ── WHAT DOES NOT MOVE ────────────────────────────────────────────────────────────────────────
//
//   * `.local-game-derived/customs/terrain-NNN-vegetation.json` — the raw Unity TerrainData dump.
//     Registered as a RAW CAPTURE, refused by `classifyLocalPath`, unnameable by any registry key,
//     and refused a second time by the promoted loader if a manifest ever mentions it.
//   * the pack's `logs/`, `qa/`, `validation/`, `verification/`, `pack-index.json`,
//     `pack-index.receipt.json`, `generation-manifest.json`, and the array set's
//     `veg-layers.json` / `veg-layers.receipt.json`. Intermediates. Several of those names are on
//     `FORBIDDEN_FILE_NAMES` in the verifier, so a copy of one fails the build by name alone.
//
// ── THE PLACEMENTS: THE ONE HONEST COMPROMISE IN THIS SCRIPT, STATED PLAINLY ───────────────────
//
// The authored pack cannot draw anything without knowing WHERE. `pack-index.json`'s `placements[]`
// mirror carries identity only — `(tileId, prototypeId, assetId, instanceIndex)` — and no
// coordinates. The 8,805 coordinates exist in exactly one place in this repository: the raw capture
// above.
//
// So this script READS that capture and writes a DERIVED SCALAR EXTRACT of it,
// `veg-placements.bin` — the seven scalars per placement that `buildCustomsLocalVegetationRenderPlan`
// actually consumes, plus which of the 58 (tile, prototype) bindings the row belongs to:
//
//     worldPosition x/y/z · rotationRadians · widthScale · heightScale · instance colour
//
// and it drops `positionNormalized`, `lightmapColor`, every prototype record (`kind`, `bendFactor`,
// `navMeshLod`, ordinals), the per-tile document structure and the JSON encoding. Roughly 40% of
// the capture's scalar content, none of its shape.
//
// THIS IS A TRANSFORMED CAPTURE, and `scripts/lib/asset-promotion.mjs` states in its own header
// that a transformed capture is precisely what the byte-identity boundary CANNOT see, and that the
// control for that class is "the closed registry plus code review of the pipeline that writes
// `public/`". This script is that pipeline. It is written to be read, it names what it reads, and
// the placement table gets its own provenance block in the public manifest recording that its
// receipt is the TERRAIN class — a measurement promoted on the founder's ruling — and NOT the
// vegetation factory chain that authorises the geometry beside it. Do not let the two rows sit next
// to each other and imply one receipt.
//
// The derived table gets NO row in `asset-promotion-manifest.json`, and that is correct rather than
// an omission: a promotion row admits bytes that are byte-identical to a registered promotable
// source, and these bytes exist nowhere else. It is a generated public artifact, exactly like the
// public `terrain-manifest.json` that `promote-terrain-surfaces.mjs` writes.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
import {
  CUSTOMS_PROMOTED_PLACEMENT_FIELDS,
  CUSTOMS_PROMOTED_PLACEMENT_FORMAT,
  CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES,
  CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES,
  CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE,
  CUSTOMS_PROMOTED_VEGETATION_DISTRIBUTION,
  CUSTOMS_PROMOTED_VEGETATION_DOCUMENT_TYPE,
  CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE,
  CUSTOMS_PROMOTED_VEGETATION_SCHEMA_VERSION,
  CUSTOMS_PROMOTED_VEGETATION_SOURCE_FRAME,
  encodeCustomsPromotedVegetationPlacements,
  validateCustomsPromotedVegetationManifest,
} from '../src/customs-promoted-vegetation.js';

const PACK_SOURCE_KEY = 'customs-authored-vegetation-v2';
const ARRAY_SOURCE_KEY = 'customs-vegetation-arraytex-v1';
const OWNED_SOURCE_KEYS = new Set([PACK_SOURCE_KEY, ARRAY_SOURCE_KEY]);

const PACK_SOURCE = PROMOTABLE_SOURCES[PACK_SOURCE_KEY];
const ARRAY_SOURCE = PROMOTABLE_SOURCES[ARRAY_SOURCE_KEY];

/** The pack root, one level above the promotable `assets/` subtree the registry is anchored at. */
const PACK_ROOT = '.local-candidates/vegetation-full-v2';
const PACK_INDEX_PATH = `${PACK_ROOT}/pack-index.json`;
const ARRAY_INDEX_PATH = `${ARRAY_SOURCE.root}/veg-layers.json`;
const LOCAL_TERRAIN_ROOT = '.local-game-derived/customs';
const LOCAL_TERRAIN_MANIFEST_PATH = `${LOCAL_TERRAIN_ROOT}/manifest.json`;

export const PROMOTED_PUBLIC_DIR = 'public/assets/3d/customs/authored/vegetation';
export const PROMOTED_DIST_DIR = 'assets/3d/customs/authored/vegetation';
export const PUBLIC_VEGETATION_MANIFEST_FILE = 'vegetation-manifest.json';

/** The founder's ruling — the thing that actually authorises this, recorded as such. */
const APPROVED_BY = 'founder (explicit approval to promote the authored vegetation, 2026-09-02)';
const APPROVED_ON = '2026-09-02';

const PACK_ENTRY_NOTE =
  'Promoted on a GENERATIVE provenance chain, not only on a ruling. Every one of the 31 families '
  + 'reports geometryEvidence "original approximation from scalar prototype identity and fallback '
  + 'envelope", and validation/factory-provenance-report.json hashes the pack against the '
  + 'git-tracked factory + catalog cited in this receipt, both of which currently match the pack. '
  + 'Re-running the committed factory regenerates these bytes. Contrast the terrain rows in this '
  + 'same manifest, whose receipt cites an EXTRACTOR and therefore proves only that the tool is '
  + 'unchanged since approval. The 8,805 PLACEMENTS these families are drawn at are NOT covered by '
  + 'this receipt: they are measured scalars derived from a raw capture, shipped as a generated '
  + 'public artifact (veg-placements.bin) whose provenance is recorded separately in the public '
  + 'vegetation manifest.';

const ARRAY_ENTRY_NOTE =
  'The offline-built texture-array blobs the one-material vegetation path draws from: the same '
  + 'authored source textures, repacked by the git-tracked builder cited in this receipt. Same '
  + 'generative receipt class as the GLB rows. Their absence is a reported degradation, not a '
  + 'correctness failure — without them the pack draws with its own per-primitive materials.';

// The manifest's notes text, its row order and its serialization are shared with
// `promote-terrain-surfaces.mjs` (see `promotionManifestDocument` in scripts/lib/asset-promotion.mjs).
// Two scripts own disjoint rows of one document; one definition of the document is what keeps their
// `--check` modes from accusing each other of staleness.
const serialize = serializePromotionManifest;

const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function idFor(prefix, sourcePath) {
  return `${prefix}.${sourcePath.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-')}`;
}

async function readJson(repoPath) {
  return JSON.parse(await readFile(resolve(REPOSITORY_ROOT, ...repoPath.split('/')), 'utf8'));
}

async function receiptFor(source) {
  const documents = [];
  for (const document of source.receipt.documents) {
    const absolute = resolve(REPOSITORY_ROOT, ...document.repoPath.split('/'));
    documents.push({
      role: document.role,
      repoPath: document.repoPath,
      sha256: `sha256:${await sha256File(absolute)}`,
    });
  }
  return { kind: source.receipt.kind, documents };
}

/**
 * Collect the promotable files under one registry key.
 *
 * Two independent refusals, exactly as the terrain script does it and for the same reason: the
 * pattern decides what MAY be named, `classifyLocalPath` decides what a path IS. A file that fails
 * either is recorded in `refused` and never touched.
 */
async function collectSource(source, names, distSubdir) {
  const files = [];
  const refused = [];
  for (const name of names) {
    const repoPath = `${source.root}/${name}`;
    const tier = classifyLocalPath(repoPath);
    if (!source.filePattern.test(name) || tier.tier !== 'promotable') {
      refused.push({ name, tier: tier.tier });
      continue;
    }
    const absolute = resolve(REPOSITORY_ROOT, ...repoPath.split('/'));
    const bytes = await readFile(absolute);
    files.push({
      sourcePath: name,
      sourceRepoPath: repoPath,
      absolute,
      publicPath: `${distSubdir}${name}`,
      bytes: bytes.byteLength,
      sha256: digestOf(bytes),
    });
  }
  files.sort((left, right) => (left.sourcePath < right.sourcePath ? -1 : 1));
  return { files, refused };
}

/**
 * Every file that is actually sitting in the source root, whether or not an index names it.
 *
 * The terrain script's `refused` list is real evidence — it names the raw Unity dump it walked past
 * — because it enumerates the manifest's own candidates and the capture is one of them. Driving
 * this script purely off the pack and array indices would have made `refused` permanently empty:
 * a filter with nothing to reject is a filter nobody has watched work. So the roots are read, and
 * every sibling the pattern does not admit is recorded by name.
 */
async function refusedSiblings(source, { depth }) {
  const root = resolve(REPOSITORY_ROOT, ...source.root.split('/'));
  const names = [];
  const walk = async (directory, prefix, level) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const relative_ = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory() && level < depth) await walk(resolve(directory, entry.name), relative_, level + 1);
      else if (entry.isFile()) names.push(relative_);
    }
  };
  await walk(root, '', 1);
  return names
    .filter((name) => !source.filePattern.test(name))
    .map((name) => ({ name, tier: classifyLocalPath(`${source.root}/${name}`).tier }));
}

/**
 * Read the raw Unity vegetation dumps and build the derived placement table.
 *
 * The ORDER is load-bearing and is the local path's order exactly: tiles in local-manifest order,
 * and inside a tile, instances by their own `index` ascending. `buildInstancingIndex()` assigns
 * `flatIndex` by walking the same two loops, and the promoted decoder takes `flatIndex` to be the
 * row ordinal — so a plan built from this table has the same flat-index space as a plan built on
 * localhost, and the two are comparable placement by placement rather than only in aggregate.
 */
async function buildPlacements(bindings) {
  const manifest = await readJson(LOCAL_TERRAIN_MANIFEST_PATH);
  const bindingIndexByKey = new Map(bindings.map((binding, index) => [
    `${binding.tileId} ${binding.prototypeId}`,
    index,
  ]));

  const instances = [];
  const readTiles = [];
  for (const tile of manifest.tiles) {
    if (!tile.vegetation?.file) continue;
    const repoPath = `${LOCAL_TERRAIN_ROOT}/${tile.vegetation.file}`;
    // Belt to the braces: this file IS a registered raw capture and this script must be the only
    // place in the repository that opens it deliberately. Assert that it still classifies as one,
    // so a future widening of the registry that accidentally made it "promotable" fails here.
    const tier = classifyLocalPath(repoPath);
    if (tier.tier !== 'raw-capture') {
      throw new Error(
        `${repoPath} is classified ${tier.tier}, not raw-capture. The raw Unity vegetation dump must `
        + 'stay a capture; refusing to derive placements from a path whose tier has changed.',
      );
    }
    const payload = await readJson(repoPath);
    if (payload.tileId !== tile.id) throw new Error(`${repoPath} declares tile ${payload.tileId}, not ${tile.id}`);
    if (payload.localOnly !== true) throw new Error(`${repoPath} is not the local-only capture`);
    if (payload.sourceFrame !== CUSTOMS_PROMOTED_VEGETATION_SOURCE_FRAME) {
      throw new Error(`${repoPath} is in frame ${payload.sourceFrame}`);
    }
    if (payload.instances.length !== tile.vegetation.count) {
      throw new Error(`${repoPath} holds ${payload.instances.length} instances; the manifest declares ${tile.vegetation.count}`);
    }
    const rows = [...payload.instances].sort((left, right) => left.index - right.index);
    for (const row of rows) {
      instances.push({ ...row, tileId: tile.id });
    }
    readTiles.push({
      tileId: tile.id,
      instances: rows.length,
      // The capture's own digest, so the derived table can be traced back to the exact bytes it
      // came from without those bytes ever travelling. The same digest is in the committed
      // capture-digest inventory.
      captureSha256: digestOf(await readFile(resolve(REPOSITORY_ROOT, ...repoPath.split('/')))),
      capture: tile.vegetation.file,
    });
  }

  const bytes = encodeCustomsPromotedVegetationPlacements(instances, (instance, row) => {
    const index = bindingIndexByKey.get(`${instance.tileId} ${instance.prototypeId}`);
    if (index === undefined) {
      throw new Error(
        `placement ${row} (${instance.tileId}/${instance.prototypeId}) has no authored prototype `
        + 'binding; the pack does not cover it and a partial table would silently thin the forest',
      );
    }
    return index;
  });

  return { bytes, count: instances.length, tiles: readTiles };
}

/**
 * The PUBLIC array index: a regenerated subset of `veg-layers.json`, never a copy of it.
 *
 * `veg-layers.json` is on the verifier's `FORBIDDEN_FILE_NAMES`, and shipping its bytes under any
 * name would trip the hash check as a local-package file with no promotable source. The fields
 * dropped here are the ones that describe where it was BUILT rather than what it means: `packRoot`,
 * `builder`, `builderSha256`, `copyrightBoundary` and the offline `status`.
 */
function publicArrayIndex(arrayIndex) {
  return {
    schemaVersion: arrayIndex.schemaVersion,
    documentType: arrayIndex.documentType,
    map: arrayIndex.map,
    localOnly: false,
    distribution: CUSTOMS_PROMOTED_VEGETATION_DISTRIBUTION,
    status: 'promoted-public',
    packIndexSha256: arrayIndex.packIndexSha256,
    layerAttribute: arrayIndex.layerAttribute,
    layout: arrayIndex.layout,
    mipMode: arrayIndex.mipMode,
    slotColorSpace: arrayIndex.slotColorSpace,
    slots: arrayIndex.slots,
    alphaCutoffByLod: arrayIndex.alphaCutoffByLod,
    alphaModeCounts: arrayIndex.alphaModeCounts,
    counts: arrayIndex.counts,
    totalBytes: arrayIndex.totalBytes,
    uploadBytesLevel0: arrayIndex.uploadBytesLevel0,
    arrays: arrayIndex.arrays,
    layers: arrayIndex.layers,
    primitives: arrayIndex.primitives,
  };
}

async function collect() {
  const packIndex = await readJson(PACK_INDEX_PATH);
  const arrayIndex = await readJson(ARRAY_INDEX_PATH);

  const lodNames = [];
  for (const asset of packIndex.authoredAssets) {
    for (const lod of asset.lods) {
      // `pack-index.json` names files relative to the PACK root (`assets/birch01/…`); the registry
      // key is rooted at `<pack>/assets`, so strip the one segment the registry already owns.
      if (!lod.file.startsWith('assets/')) throw new Error(`pack index LOD file ${lod.file} is not under assets/`);
      lodNames.push(lod.file.slice('assets/'.length));
    }
  }
  const blobNames = [];
  for (const array of arrayIndex.arrays) {
    for (const slot of arrayIndex.slots) blobNames.push(array.blobs[slot].file);
  }

  const pack = await collectSource(PACK_SOURCE, lodNames, 'assets/');
  const arrays = await collectSource(ARRAY_SOURCE, blobNames, 'arrays/');
  pack.refused.push(...await refusedSiblings(PACK_SOURCE, { depth: 2 }));
  arrays.refused.push(...await refusedSiblings(ARRAY_SOURCE, { depth: 1 }));
  const packReceipt = await receiptFor(PACK_SOURCE);
  const arrayReceipt = await receiptFor(ARRAY_SOURCE);

  // Every GLB the pack index declares must have arrived, at the digest the index declares. A pack
  // that lost a family here would otherwise ship a manifest naming 93 files and 90 bytes.
  const digestByFile = new Map(pack.files.map((file) => [`assets/${file.sourcePath}`, file.sha256]));
  for (const asset of packIndex.authoredAssets) {
    for (const lod of asset.lods) {
      const digest = digestByFile.get(lod.file);
      if (digest === undefined) throw new Error(`pack index declares ${lod.file}, which was refused or is absent`);
      if (digest !== lod.sha256) {
        throw new Error(`${lod.file} hashes to ${digest}; the pack index declares ${lod.sha256}`);
      }
    }
  }
  const blobDigest = new Map(arrays.files.map((file) => [file.sourcePath, file.sha256]));
  for (const array of arrayIndex.arrays) {
    for (const slot of arrayIndex.slots) {
      const blob = array.blobs[slot];
      if (blobDigest.get(blob.file) !== blob.sha256) {
        throw new Error(`${blob.file} does not match the sha256 the array index declares`);
      }
    }
  }

  const bindings = [...packIndex.prototypeBindings]
    .map((binding) => ({
      tileId: binding.tileId,
      prototypeId: binding.prototypeId,
      prototypeName: binding.prototypeName,
      assetId: binding.assetId,
    }))
    .sort((left, right) => (left.tileId === right.tileId
      ? left.prototypeId.localeCompare(right.prototypeId)
      : left.tileId.localeCompare(right.tileId)));

  const placements = await buildPlacements(bindings);
  const placementSha256 = digestOf(placements.bytes);

  const publicManifest = {
    schemaVersion: CUSTOMS_PROMOTED_VEGETATION_SCHEMA_VERSION,
    documentType: CUSTOMS_PROMOTED_VEGETATION_DOCUMENT_TYPE,
    map: 'customs',
    // FALSE, and asserted by the loader. The local vegetation payloads declare `localOnly: true`
    // and `loadCustomsLocalVegetation()` requires it, so neither loader accepts the other's package.
    localOnly: false,
    distribution: CUSTOMS_PROMOTED_VEGETATION_DISTRIBUTION,
    status: 'promoted-public-live',
    sourceFrame: CUSTOMS_PROMOTED_VEGETATION_SOURCE_FRAME,
    approvedBy: APPROVED_BY,
    approvedOn: APPROVED_ON,
    runtimeContract: {
      ...packIndex.runtimeContract,
      // It IS live now. The offline pack declared `false` because nothing shipped it.
      livePromotion: true,
    },
    counts: {
      authoredAssets: packIndex.counts.authoredAssets,
      lodFiles: packIndex.counts.lodFiles,
      placements: placements.count,
      tilePrototypeBindings: bindings.length,
    },
    // The two provenance stories, separated on purpose. Reading them as one is the mistake this
    // block exists to prevent.
    provenance: {
      geometry: {
        receipt: 'vegetation-factory',
        class: 'generative',
        statement: 'Every family reports geometryEvidence "original approximation from scalar '
          + 'prototype identity and fallback envelope"; the git-tracked factory and catalog cited in '
          + 'asset-promotion-manifest.json regenerate these bytes.',
        documents: packReceipt.documents.map((document) => ({ role: document.role, repoPath: document.repoPath })),
      },
      textureArrays: {
        receipt: 'vegetation-texture-array',
        class: 'generative',
        statement: 'The same authored source textures, repacked by the git-tracked builder cited in '
          + 'asset-promotion-manifest.json.',
        documents: arrayReceipt.documents.map((document) => ({ role: document.role, repoPath: document.repoPath })),
      },
      placements: {
        receipt: 'derived-scalar-extract',
        class: 'measurement',
        statement: 'NOT covered by the factory receipt above. These are measured scalars: the '
          + 'authored pack carries no coordinates, and the coordinates exist only in the raw Unity '
          + 'TerrainData dump, which is a registered raw capture and never ships. '
          + 'scripts/promote-authored-vegetation.mjs reads that capture and writes this table as a '
          + 'derived subset — position, rotation, the two scale factors, the instance colour and the '
          + 'prototype binding, and nothing else. What authorises it is the founder\'s ruling, '
          + 'recorded in approvedBy, exactly as with the promoted terrain surfaces. Read it as a '
          + 'measurement promoted by decision, never as authored geometry.',
        generator: 'scripts/promote-authored-vegetation.mjs',
        dropped: ['positionNormalized', 'lightmapColor', 'prototype records (kind, bendFactor, navMeshLod, ordinals)', 'per-tile document structure'],
        derivedFrom: placements.tiles.map((tile) => ({
          tileId: tile.tileId,
          instances: tile.instances,
          // The digest only. The capture itself stays in `.local-game-derived/` and its digest is
          // already in the committed capture-digest inventory, so this is traceable without being
          // reproducible from what ships.
          captureSha256: tile.captureSha256,
        })),
      },
    },
    placements: {
      file: CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE,
      format: CUSTOMS_PROMOTED_PLACEMENT_FORMAT,
      stride: CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES,
      headerBytes: CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES,
      count: placements.count,
      bytes: placements.bytes.byteLength,
      sha256: placementSha256,
      fields: CUSTOMS_PROMOTED_PLACEMENT_FIELDS.map((field) => ({ ...field })),
      flatIndex: 'the row ordinal; the rows are in the local package\'s own flat order (tile order, then per-tile instance index ascending)',
    },
    arrays: { indexFile: CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE },
    authoredAssets: packIndex.authoredAssets,
    prototypeBindings: bindings,
  };

  // The document this script writes must pass the validator the browser runs on it. Catching a
  // shape error here rather than in a browser three deploys later is the entire point.
  validateCustomsPromotedVegetationManifest(publicManifest);

  return {
    pack,
    arrays,
    packReceipt,
    arrayReceipt,
    placements: { ...placements, sha256: placementSha256 },
    publicManifest,
    publicArrays: publicArrayIndex(arrayIndex),
  };
}

function promotionEntries({ pack, arrays, packReceipt, arrayReceipt }) {
  const rows = pack.files.map((file) => ({
    id: idFor('customs.vegetation.pack', file.sourcePath),
    source: PACK_SOURCE_KEY,
    sourcePath: file.sourcePath,
    distPath: `${PROMOTED_DIST_DIR}/${file.publicPath}`,
    sha256: file.sha256,
    bytes: file.bytes,
    approvedBy: APPROVED_BY,
    approvedOn: APPROVED_ON,
    receipt: packReceipt,
    notes: PACK_ENTRY_NOTE,
  }));
  rows.push(...arrays.files.map((file) => ({
    id: idFor('customs.vegetation.arrays', file.sourcePath),
    source: ARRAY_SOURCE_KEY,
    sourcePath: file.sourcePath,
    distPath: `${PROMOTED_DIST_DIR}/${file.publicPath}`,
    sha256: file.sha256,
    bytes: file.bytes,
    approvedBy: APPROVED_BY,
    approvedOn: APPROVED_ON,
    receipt: arrayReceipt,
    notes: ARRAY_ENTRY_NOTE,
  })));
  return rows;
}

const promotionDocument = promotionManifestDocument;

async function main(argv) {
  const check = argv.includes('--check');
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`unsupported argument(s): ${unknown.join(', ')}\n`);
    process.exitCode = 2;
    return;
  }

  const publicDir = resolve(REPOSITORY_ROOT, ...PROMOTED_PUBLIC_DIR.split('/'));
  const manifestFile = resolve(publicDir, PUBLIC_VEGETATION_MANIFEST_FILE);
  const placementsFile = resolve(publicDir, CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE);
  const arrayIndexFile = resolve(publicDir, ...CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE.split('/'));

  let collected = null;
  try {
    collected = await collect();
  } catch (error) {
    if (!check) throw error;
    collected = null;
    process.stderr.write(
      `the local vegetation packages are not on this machine (${error?.code ?? error}); `
      + 'checking the committed artifacts against each other only.\n',
    );
  }

  if (collected === null) {
    // Without the local packages we can still prove the shipped bytes match the rows that admit
    // them, and that the public manifest still validates and agrees with the placement table on
    // disk — which is what a CI checkout can check and all it can honestly claim.
    const promotion = JSON.parse(await readFile(PROMOTION_MANIFEST_PATH, 'utf8'));
    const rows = promotion.promotions.filter((entry) => OWNED_SOURCE_KEYS.has(entry.source));
    for (const row of rows) {
      const shipped = resolve(REPOSITORY_ROOT, 'public', ...row.distPath.split('/'));
      const digest = `sha256:${await sha256File(shipped)}`;
      if (digest !== row.sha256) {
        process.stderr.write(`${row.distPath}: shipped bytes hash to ${digest}, manifest declares ${row.sha256}\n`);
        process.exitCode = 1;
        return;
      }
    }
    const manifestValue = JSON.parse(await readFile(manifestFile, 'utf8'));
    const validated = validateCustomsPromotedVegetationManifest(manifestValue);
    const placementDigest = digestOf(await readFile(placementsFile));
    if (placementDigest !== validated.placements.sha256) {
      process.stderr.write(
        `${PROMOTED_PUBLIC_DIR}/${CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE}: hashes to `
        + `${placementDigest}, the public manifest declares ${validated.placements.sha256}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({
      promoted: rows.length, sourcePackages: 'absent', placements: validated.placements.count, agreed: true,
    }, null, 2)}\n`);
    return;
  }

  const { pack, arrays, placements, publicManifest, publicArrays } = collected;
  const entries = promotionEntries(collected);
  const files = [...pack.files, ...arrays.files];

  // Anything already in the manifest from another source key survives untouched: this script owns
  // the two vegetation keys and nothing else.
  let existing = { promotions: [] };
  try {
    existing = JSON.parse(await readFile(PROMOTION_MANIFEST_PATH, 'utf8'));
  } catch { /* an absent manifest is "nothing promoted"; we are about to write one */ }
  const others = (existing.promotions ?? []).filter((entry) => !OWNED_SOURCE_KEYS.has(entry.source));
  const promotionText = serialize(promotionDocument([...others, ...entries]));
  const manifestText = serialize(publicManifest);
  const arrayIndexText = serialize(publicArrays);

  if (check) {
    const problems = [];
    const currentPromotion = await readFile(PROMOTION_MANIFEST_PATH, 'utf8').catch(() => null);
    if (currentPromotion !== promotionText) problems.push('asset-promotion-manifest.json is stale');
    const currentManifest = await readFile(manifestFile, 'utf8').catch(() => null);
    if (currentManifest !== manifestText) problems.push(`${PROMOTED_PUBLIC_DIR}/${PUBLIC_VEGETATION_MANIFEST_FILE} is stale`);
    const currentArrays = await readFile(arrayIndexFile, 'utf8').catch(() => null);
    if (currentArrays !== arrayIndexText) problems.push(`${PROMOTED_PUBLIC_DIR}/${CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE} is stale`);
    const currentPlacements = await readFile(placementsFile).catch(() => null);
    if (currentPlacements === null || digestOf(currentPlacements) !== placements.sha256) {
      problems.push(`${PROMOTED_PUBLIC_DIR}/${CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE} is stale`);
    }
    for (const file of files) {
      const shipped = resolve(publicDir, ...file.publicPath.split('/'));
      const digest = await sha256File(shipped).then((hex) => `sha256:${hex}`).catch((error) => `unreadable (${error?.code ?? error})`);
      if (digest !== file.sha256) {
        problems.push(`${PROMOTED_PUBLIC_DIR}/${file.publicPath}: ${digest} != source ${file.sha256}`);
      }
    }
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`${problem}\n`);
      process.stderr.write('re-run `npm run promote:vegetation` and commit the result.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ promoted: files.length, placements: placements.count, agreed: true }, null, 2)}\n`);
    return;
  }

  const directories = new Set();
  for (const file of files) {
    const segments = file.publicPath.split('/');
    segments.pop();
    directories.add(segments.join('/'));
  }
  await mkdir(publicDir, { recursive: true });
  for (const directory of [...directories].sort()) {
    await mkdir(resolve(publicDir, ...directory.split('/')), { recursive: true });
  }
  for (const file of files) await copyFile(file.absolute, resolve(publicDir, ...file.publicPath.split('/')));
  await writeFile(placementsFile, placements.bytes);
  await writeFile(arrayIndexFile, arrayIndexText);
  await writeFile(manifestFile, manifestText);
  await writeFile(PROMOTION_MANIFEST_PATH, promotionText);

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0) + placements.bytes.byteLength;
  process.stdout.write(`${JSON.stringify({
    promotedTo: PROMOTED_PUBLIC_DIR,
    glbFiles: pack.files.length,
    glbBytes: pack.files.reduce((sum, file) => sum + file.bytes, 0),
    arrayBlobs: arrays.files.length,
    arrayBytes: arrays.files.reduce((sum, file) => sum + file.bytes, 0),
    placements: {
      file: CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE,
      count: placements.count,
      bytes: placements.bytes.byteLength,
      sha256: placements.sha256,
      derivedFrom: placements.tiles.map((tile) => `${tile.capture} (${tile.instances} instances)`),
    },
    generatedDocuments: [PUBLIC_VEGETATION_MANIFEST_FILE, CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE],
    refusedFromTheSameDirectories: [...pack.refused, ...arrays.refused],
    totalBytes,
    receipts: [
      ...collected.packReceipt.documents.map((document) => `${document.role}=${document.repoPath}`),
      ...collected.arrayReceipt.documents.map((document) => `${document.role}=${document.repoPath}`),
    ],
    promotionManifest: relative(REPOSITORY_ROOT, PROMOTION_MANIFEST_PATH),
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
