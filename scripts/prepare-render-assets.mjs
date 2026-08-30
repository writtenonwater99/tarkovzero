#!/usr/bin/env node
// Deterministic fetcher + processor for the Stage 1 render assets.
//
//   npm run prepare-render-assets                 fetch (cached) and rebuild
//   node scripts/prepare-render-assets.mjs --check        verify, write nothing
//   node scripts/prepare-render-assets.mjs --offline      fail on a cache miss
//   node scripts/prepare-render-assets.mjs --verify-licenses
//   node scripts/prepare-render-assets.mjs --ktx2-report [dir]
//
// Contract:
//   * Raw downloads land in a git-ignored cache and are never shipped.
//   * Every processed byte written under public/assets/3d is a pure function of
//     (cached source bytes, this script, src/render-style.js). No timestamps,
//     no randomness, no locale- or path-dependent output.
//   * scripts/data/render-assets-manifest.json is rewritten in place with the
//     source and derivative hashes, so `git status` after a second run is the
//     determinism gate.
//   * Nothing is written unless every declared output was produced, every
//     source hash matched, and the shipped total is inside the budget. Every one
//     of those gates runs while the outputs are still only in memory, so a run
//     that fails any of them leaves the working tree exactly as it found it.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  decodeHdr,
  decodePng,
  deflateSettings,
  encodePng,
  packChannels,
  readZip,
  resizeTo,
  takeChannels,
} from './lib/imageio.mjs';
import { gradeLut, macroNoise } from './lib/imagegen.mjs';
import { SH_LAMBERT_A, analyzeEquirect, autoExposure, linearToHex, skyGradientStrip, tonemapToSrgb } from './lib/skylight.mjs';
import { LIGHT, PALETTE } from '../src/render-style.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/data/render-assets-manifest.json');
const USER_AGENT = 'tarkovzero-render-assets/1 (+https://tarkovzero.com)';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
if (flag('--help') || flag('-h')) {
  console.log(`usage: node scripts/prepare-render-assets.mjs [options]

  --check             rebuild in memory and compare against what is on disk;
                      write nothing and exit non-zero on any drift
  --offline           never touch the network; fail if a source is not cached
  --verify-licenses   re-fetch every licence page and assert it still says CC0
  --ktx2-report [dir] additionally encode the material set to KTX2 and report
                      sizes (needs \`npm i -D ktx2-encoder\`); measurement only,
                      nothing under public/ changes
`);
  process.exit(0);
}
const CHECK = flag('--check');
const OFFLINE = flag('--offline');
const VERIFY_LICENSES = flag('--verify-licenses');
const KTX2_REPORT = flag('--ktx2-report');
const KTX2_DIR = KTX2_REPORT
  ? path.resolve(ROOT, argv[argv.indexOf('--ktx2-report') + 1] ?? '.cache/render-assets/ktx2-report')
  : null;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const round = (v, places = 6) => {
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;

function fail(message) {
  console.error(`\nerror: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const CACHE_DIR = path.join(ROOT, manifest.cacheRoot);
const OUT_DIR = path.join(ROOT, manifest.outputRoot);
const DETAIL = manifest.detailSize;
const SKY_W = manifest.skyPreviewWidth;
const sourceById = new Map(manifest.sources.map((s) => [s.id, s]));
const outputById = new Map(manifest.outputs.map((o) => [o.id, o]));

// ---------------------------------------------------------------------------
// Licence verification
// ---------------------------------------------------------------------------
async function verifyLicenses() {
  console.log('licence pages');
  let bad = 0;
  for (const check of manifest.licenseChecks) {
    let text = '';
    try {
      const res = await fetch(check.pageUrl, { headers: { 'user-agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      console.log(`  FAIL ${check.source.padEnd(11)} ${check.pageUrl} (${err.message})`);
      bad++;
      continue;
    }
    // Accept either the licence identifier or its spelled-out name; both appear
    // across these four sites and both are unambiguous.
    const flat = text.replace(/\s+/g, ' ');
    const ok = /CC0/i.test(flat) || /Creative Commons Zero/i.test(flat);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${check.source.padEnd(11)} ${check.pageUrl}`);
    if (!ok) bad++;
  }
  if (bad) fail(`${bad} licence page(s) no longer state CC0 — do not ship until this is resolved`);
  console.log('  all four sources still publish CC0\n');
}

// ---------------------------------------------------------------------------
// Cached downloads
// ---------------------------------------------------------------------------
/**
 * Download one source into the cache.
 *
 * The bytes land in a sibling `.part` file and are renamed into place, so an
 * interrupted run, a dropped connection or a full disk can never leave a
 * truncated file that the next run mistakes for a complete download.
 */
async function download(source) {
  const cached = path.join(CACHE_DIR, source.cacheFile);
  const partial = `${cached}.part`;
  console.log(`  fetching ${source.sourceUrl}`);
  const res = await fetch(source.sourceUrl, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) fail(`download failed for ${source.id}: HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(partial, buf);
  await rename(partial, cached);
  return buf;
}

async function fetchSource(source) {
  const cached = path.join(CACHE_DIR, source.cacheFile);
  const shown = path.relative(ROOT, cached);
  let buf = null;
  let fresh = false;
  try {
    buf = await readFile(cached);
  } catch {
    if (OFFLINE) fail(`${source.id} is not cached at ${shown} and --offline was given`);
    buf = await download(source);
    fresh = true;
  }

  let hash = sha256(buf);
  if (source.sourceSha256 && source.sourceSha256 !== hash) {
    // A mismatch on a CACHED file is far more likely to be a damaged local copy
    // than a changed upstream, and the old code sent the operator into a licence
    // review for what is usually a disk problem — then failed the same way on
    // every re-run, because it never discarded the bad entry. Re-fetch once and
    // let the network decide which of the two it actually is.
    if (!fresh && !OFFLINE) {
      console.log(`  ${source.id} cached copy does not match its recorded hash — discarding it and re-fetching`);
      await rm(cached, { force: true });
      buf = await download(source);
      fresh = true;
      hash = sha256(buf);
    }
    if (source.sourceSha256 !== hash) {
      fail(
        `${source.id} hash mismatch\n` +
          `  manifest: ${source.sourceSha256}\n` +
          `  ${(fresh ? 'download' : 'cached  ')}: ${hash}\n` +
          (fresh
            ? '  these bytes came off the network this run, so the upstream file changed.\n' +
              '  Review the new file and its licence before updating the manifest.'
            : `  these bytes came from ${shown}, most likely a truncated or partial download.\n` +
              '  Delete that file and re-run without --offline; the fetcher will replace it.'),
      );
    }
  }
  source.sourceSha256 = hash;
  source.sourceBytes = buf.length;
  console.log(`  ${source.id.padEnd(16)} ${mib(buf.length).padStart(9)}  ${hash.slice(0, 16)}...  ${fresh ? 'fetched' : 'cached'}`);
  return buf;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------
const produced = new Map(); // id -> Buffer
const shapes = new Map(); // id -> { width, height } for image outputs

/**
 * Record one produced output.
 *
 * `image` is the decoded image the buffer was encoded from, and `nominalSize` is
 * the number that the declared filename is allowed to advertise (the texture
 * width for a plain map, the cube size for a LUT). Both exist because the
 * resolution knobs (`detailSize`, `skyPreviewWidth`) live in the manifest while
 * the output paths are literal strings in the same file: without this check,
 * bumping `detailSize` to 1024 silently ships 1024px content inside a file
 * called `-512.png`, and `--check` then reports the tree as green.
 */
function emit(id, buf, image = null, nominalSize = null) {
  if (!outputById.has(id)) fail(`recipe produced undeclared output "${id}"`);
  const decl = outputById.get(id);
  const named = /-(\d+)\.[a-z0-9]+$/.exec(decl.path);
  if (named && nominalSize === null) {
    fail(`${decl.path} advertises a size in its filename but the recipe declares none`);
  }
  if (named && Number(named[1]) !== nominalSize) {
    fail(
      `${decl.path} is named for ${named[1]} but the recipe produced ${nominalSize}.\n` +
        '  Changing a resolution knob means renaming its outputs too — the filename must not lie.',
    );
  }
  if (image) shapes.set(id, { width: image.width, height: image.height });
  produced.set(id, buf);
}

function zipEntry(zip, name) {
  if (zip.has(name)) return zip.read(name);
  fail(`zip entry "${name}" not found. Available: ${zip.names().join(', ')}`);
}

function buildGroundDetail(zipBuf) {
  const zip = readZip(zipBuf);
  const decl = (id) => outputById.get(id);

  const color = decodePng(zipEntry(zip, decl('ground106-albedo').zipEntry));
  const normal = decodePng(zipEntry(zip, decl('ground106-normal').zipEntry));
  const [aoName, roughName] = decl('ground106-orm').zipEntry.split('+');
  const ao = decodePng(zipEntry(zip, aoName));
  const rough = decodePng(zipEntry(zip, roughName));

  for (const [name, img] of [['color', color], ['normal', normal], ['ao', ao], ['roughness', rough]]) {
    if (img.width !== img.height) fail(`${name} map is not square (${img.width}x${img.height})`);
    if (img.width % DETAIL) fail(`${name} map ${img.width}px has no integer box ratio to ${DETAIL}px`);
  }

  const albedo = takeChannels(resizeTo(color, DETAIL, 'srgb'), 3);
  const normalOut = takeChannels(resizeTo(normal, DETAIL, 'normal'), 3);
  const orm = packChannels([
    { img: resizeTo(ao, DETAIL, 'linear'), channel: 0 },
    { img: resizeTo(rough, DETAIL, 'linear'), channel: 0 },
    { constant: 0 }, // ground is never metallic
  ]);
  emit('ground106-albedo', encodePng(albedo, { srgbChunk: true }), albedo, DETAIL);
  emit('ground106-normal', encodePng(normalOut), normalOut, DETAIL);
  emit('ground106-orm', encodePng(orm), orm, DETAIL);

  return {
    sourceSize: color.width,
    detailSize: DETAIL,
  };
}

function buildEnvironment(hdrBuf) {
  const hdr = decodeHdr(hdrBuf);
  const analysis = analyzeEquirect(hdr);
  const exposure = autoExposure(analysis.meanLuminance);

  if (hdr.width % SKY_W) fail(`HDRI width ${hdr.width} has no integer box ratio to ${SKY_W}px`);
  const preview = tonemapToSrgb(resizeTo(hdr, SKY_W, 'linear'), exposure);
  const gradient = skyGradientStrip(hdr, { width: 8, height: 128, exposure });
  emit('autumn-crossing-sky', encodePng(preview, { srgbChunk: true }), preview, SKY_W);
  emit('autumn-crossing-gradient', encodePng(gradient, { srgbChunk: true }), gradient);

  const light = {
    note:
      'Derived from the Autumn Crossing 1K HDRI (Poly Haven, CC0). Ambient/environment reference only — ' +
      'the key light direction is pinned by src/render-style.js, not by this file. The source HDRI is a ' +
      'forest path with an obstructed sky view, so the upper-hemisphere average already includes canopy.',
    source: 'autumn-crossing',
    conventions: {
      basis: 'x east, y up, z south (game map space)',
      azimuth: 'degrees clockwise from +Z',
      elevation: 'degrees above the horizon',
      equirect: 'row 0 = zenith; theta = polar angle from +Y; phi = azimuth',
      shBasis: 'real SH, bands 0..2, order [0, y, z, x, xy, yz, 3y^2-1, xz, x^2-z^2]',
      units: 'linear radiance from the HDRI, before tone mapping',
      shConvolution:
        'shRadiance holds the UNCONVOLVED projection L_lm. For a Lambertian ' +
        'irradiance environment multiply band l by A_l = [pi, 2pi/3, pi/4] ' +
        '(Ramamoorthi/Hanrahan) — i.e. coefficient 0 by A_0, coefficients 1..3 ' +
        'by A_1, coefficients 4..8 by A_2. Skipping this makes the ambient both ' +
        'too dark and too directional.',
      shLambertA: SH_LAMBERT_A.map((v) => round(v)),
    },
    sourceSize: [hdr.width, hdr.height],
    meanLuminance: round(analysis.meanLuminance),
    previewExposure: round(exposure),
    shRadiance: analysis.shRadiance.map((c) => c.map((v) => round(v))),
    upperHemisphere: analysis.upperHemisphere.map((v) => round(v)),
    lowerHemisphere: analysis.lowerHemisphere.map((v) => round(v)),
    zenith: analysis.zenith.map((v) => round(v)),
    horizon: analysis.horizon.map((v) => round(v)),
    dominant: analysis.dominant
      ? {
          direction: analysis.dominant.direction.map((v) => round(v)),
          azimuthDeg: round(analysis.dominant.azimuthDeg, 3),
          elevationDeg: round(analysis.dominant.elevationDeg, 3),
        }
      : null,
    displayReferred: {
      upperHemisphere: linearToHex(analysis.upperHemisphere, exposure),
      lowerHemisphere: linearToHex(analysis.lowerHemisphere, exposure),
      zenith: linearToHex(analysis.zenith, exposure),
      horizon: linearToHex(analysis.horizon, exposure),
    },
  };
  emit('autumn-crossing-light', Buffer.from(`${JSON.stringify(light, null, 2)}\n`, 'utf8'));
  return { exposure, analysis, light };
}

function buildGenerated() {
  const NOISE = 256;
  const LUT = 16;
  const noise = macroNoise({ size: NOISE, seed: 20260829 });
  // A cube LUT ships as a horizontal strip, so its filename advertises the cube
  // size (16), not the 256px image width.
  const lut = gradeLut({ shadowTint: PALETTE.fogFar, highlightTint: LIGHT.realistic.keyColor }, { size: LUT });
  emit('macro-noise', encodePng(noise), noise, NOISE);
  emit('overcast-grade-lut', encodePng(lut, { srgbChunk: true }), lut, LUT);
}

// ---------------------------------------------------------------------------
// Optional KTX2 measurement pass (never touches public/)
// ---------------------------------------------------------------------------
async function ktx2Report() {
  let encodeToKTX2;
  try {
    ({ encodeToKTX2 } = await import('ktx2-encoder'));
  } catch {
    fail('--ktx2-report needs the encoder: npm i -D ktx2-encoder (pure wasm, no native build)');
  }
  await mkdir(KTX2_DIR, { recursive: true });
  console.log(`\nKTX2 measurement pass -> ${path.relative(ROOT, KTX2_DIR)}`);
  const jobs = [
    ['ground106-albedo', { isUASTC: false, qualityLevel: 190, compressionLevel: 2, isPerceptual: true, isSetKTX2SRGBTransferFunc: true }],
    ['ground106-normal', { isUASTC: true, uastcLDRQualityLevel: 2, needSupercompression: true, isNormalMap: true, isPerceptual: false }],
    ['ground106-orm', { isUASTC: false, qualityLevel: 190, compressionLevel: 2, isPerceptual: false }],
  ];
  let png = 0;
  let ktx = 0;
  for (const [id, opts] of jobs) {
    const source = produced.get(id);
    const img = decodePng(source);
    const rgba = new Uint8Array(img.width * img.height * 4);
    for (let i = 0, n = img.width * img.height; i < n; i++) {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(img.data[i * img.channels + c] * 255);
      rgba[i * 4 + 3] = 255;
    }
    const out = Buffer.from(
      await encodeToKTX2(new Uint8Array(0), {
        imageDecoder: async () => ({ width: img.width, height: img.height, data: rgba }),
        isKTX2File: true,
        generateMipmap: true,
        ...opts,
      }),
    );
    await writeFile(path.join(KTX2_DIR, `${id}.ktx2`), out);
    png += source.length;
    ktx += out.length;
    const mode = opts.isUASTC ? 'UASTC+zstd' : 'ETC1S';
    console.log(`  ${id.padEnd(18)} png ${kib(source.length).padStart(10)} -> ${mode.padEnd(10)} ${kib(out.length).padStart(10)}`);
  }
  console.log(`  ${'total'.padEnd(18)} png ${kib(png).padStart(10)} -> ${' '.repeat(10)} ${kib(ktx).padStart(10)}  (${((1 - ktx / png) * 100).toFixed(0)}% smaller)`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
if (VERIFY_LICENSES) await verifyLicenses();

console.log('sources');
const groundZip = await fetchSource(sourceById.get('ground106'));
const hdrBuf = await fetchSource(sourceById.get('autumn-crossing'));

console.log('\nprocessing');
const ground = buildGroundDetail(groundZip);
console.log(`  ground detail   ${ground.sourceSize}px source -> ${ground.detailSize}px, box-filtered in the correct space`);
const env = buildEnvironment(hdrBuf);
console.log(`  environment     ${env.light.sourceSize.join('x')} HDRI -> SH9 radiance + ${SKY_W}px preview, exposure ${env.light.previewExposure}`);
buildGenerated();
console.log('  generated       macro-noise 256px tile, 16^3 overcast grade LUT');

// Every declared output must exist, and nothing may appear that is not declared.
const missing = manifest.outputs.filter((o) => !produced.has(o.id)).map((o) => o.id);
if (missing.length) fail(`declared outputs never produced: ${missing.join(', ')}`);

// ---------------------------------------------------------------------------
// Size / hash everything IN MEMORY first.
//
// Nothing below this point may touch the filesystem until every gate has passed:
// the header contract promises that a run which busts the budget leaves the
// working tree exactly as it found it.
// ---------------------------------------------------------------------------
let shipped = 0;
const rows = [];
for (const decl of manifest.outputs) {
  const buf = produced.get(decl.id);
  const shape = shapes.get(decl.id) ?? null;
  decl.bytes = buf.length;
  decl.sha256 = sha256(buf);
  // Dimensions travel with the asset so the filename is no longer the only
  // signal a consumer has for how big the thing actually is.
  decl.width = shape ? shape.width : null;
  decl.height = shape ? shape.height : null;
  shipped += buf.length;
  rows.push([decl.id, decl.path, decl.bytes, decl.sha256]);
}

// Attribution + asset index that actually ships next to the assets.
const attribution = {
  note: 'Generated by scripts/prepare-render-assets.mjs — do not edit by hand.',
  plan: manifest.plan,
  stage: manifest.stage,
  assets: manifest.outputs.map((o) => {
    const src = o.from === 'generated' ? null : sourceById.get(o.from);
    return {
      id: o.id,
      path: o.path,
      kind: o.kind,
      colorSpace: o.colorSpace,
      channels: o.channels,
      width: o.width,
      height: o.height,
      bytes: o.bytes,
      sha256: o.sha256,
      source: src
        ? { provider: src.provider, author: src.author, license: src.license, assetPage: src.assetPage, licensePage: src.licensePage }
        : { provider: 'TarkovZero', author: 'TarkovZero', license: 'CC0-1.0', assetPage: null, licensePage: null },
    };
  }),
};
const attributionBuf = Buffer.from(`${JSON.stringify(attribution, null, 2)}\n`, 'utf8');
const attributionPath = path.join(OUT_DIR, 'render-assets.json');
shipped += attributionBuf.length;

// Toolchain record. Deliberately holds no timestamp: reruns must be byte-identical.
manifest.toolchain = {
  node: process.versions.node,
  zlib: process.versions.zlib,
  zlibVernum: deflateSettings().zlibVersion,
  deflateLevel: deflateSettings().level,
  encoder: 'scripts/lib/imageio.mjs (dependency-free PNG/ZIP/HDR codecs)',
  textureFormat: 'PNG',
  textureFormatTodo:
    'TODO(stage-1-renderer): switch the material set to KTX2/Basis once the renderer carries a transcoder. ' +
    'Measured with `--ktx2-report` using ktx2-encoder@0.6.0 (pure wasm, no native build, byte-identical ' +
    'across runs): the three 512px ground maps drop from 1.43 MiB PNG to 0.45 MiB KTX2 (69% smaller) — ' +
    'albedo 487->72 KiB ETC1S, normal 542->323 KiB UASTC+zstd, ORM 435->66 KiB ETC1S. Not shipped now ' +
    'because nothing in this checkout can decode KTX2 at runtime; wiring @loaders.gl/textures plus a basis ' +
    'transcoder is a renderer change owned by the Stage 1 renderer branch, not by the asset pipeline.',
};
manifest.totals = {
  sourceBytes: manifest.sources.reduce((n, s) => n + s.sourceBytes, 0),
  shippedBytes: shipped,
  shippedBudgetBytes: manifest.shippedBudgetBytes,
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('\nshipped');
for (const [id, p, bytes, hash] of rows) {
  console.log(`  ${id.padEnd(26)} ${kib(bytes).padStart(10)}  ${hash.slice(0, 16)}...  ${p}`);
}
console.log(`  ${'render-assets.json'.padEnd(26)} ${kib(attributionBuf.length).padStart(10)}  ${sha256(attributionBuf).slice(0, 16)}...`);
console.log(
  `\n  source workspace ${mib(manifest.totals.sourceBytes)}  ->  shipped ${mib(shipped)} ` +
    `of ${mib(manifest.shippedBudgetBytes)} budget (${((shipped / manifest.shippedBudgetBytes) * 100).toFixed(1)}%)`,
);

// ---------------------------------------------------------------------------
// Gate, THEN write
// ---------------------------------------------------------------------------
if (shipped > manifest.shippedBudgetBytes) {
  fail(
    `shipped weight ${mib(shipped)} exceeds the Stage 1 budget of ${mib(manifest.shippedBudgetBytes)}\n` +
      '  nothing was written; the working tree is unchanged.',
  );
}

// Undeclared files under the output root ship in dist/ verbatim and count
// against nobody's budget, so a retired or renamed output has to be loud rather
// than silently left behind. This runs before the writes for the same reason the
// budget gate does.
async function walk(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // nothing shipped yet
  }
  const found = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await walk(path.join(dir, entry.name), rel)));
    else found.push(rel);
  }
  return found;
}
const declaredPaths = new Set([...manifest.outputs.map((o) => o.path), 'render-assets.json']);
const orphans = (await walk(OUT_DIR)).filter((p) => !declaredPaths.has(p));
if (orphans.length) {
  fail(
    `${orphans.length} file(s) under ${manifest.outputRoot} are not declared in the manifest:\n` +
      orphans.map((p) => `    ${p}`).join('\n') +
      '\n  They would still be copied into dist/. Delete them or declare them.\n' +
      '  Nothing was written; the working tree is unchanged.',
  );
}

let drift = 0;
for (const decl of manifest.outputs) {
  const buf = produced.get(decl.id);
  const abs = path.join(OUT_DIR, decl.path);
  let existing = null;
  try {
    existing = await readFile(abs);
  } catch { /* not written yet */ }

  if (CHECK) {
    if (!existing || !existing.equals(buf)) {
      drift++;
      console.log(`  DRIFT ${decl.path} (${existing ? 'differs' : 'missing'})`);
    }
  } else {
    await mkdir(path.dirname(abs), { recursive: true });
    if (!existing || !existing.equals(buf)) await writeFile(abs, buf);
  }
}
{
  let existing = null;
  try {
    existing = await readFile(attributionPath);
  } catch { /* not written yet */ }
  if (CHECK) {
    if (!existing || !existing.equals(attributionBuf)) {
      drift++;
      console.log(`  DRIFT render-assets.json (${existing ? 'differs' : 'missing'})`);
    }
  } else {
    await mkdir(OUT_DIR, { recursive: true });
    if (!existing || !existing.equals(attributionBuf)) await writeFile(attributionPath, attributionBuf);
  }
}

if (!CHECK) {
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (KTX2_REPORT) await ktx2Report();

if (CHECK) {
  if (drift) fail(`${drift} output(s) drifted from the committed tree`);
  console.log('\ncheck: every shipped byte matches the committed tree');
}
