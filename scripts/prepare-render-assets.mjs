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
//     source hash matched, and the shipped total is inside the budget.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
async function fetchSource(source) {
  const cached = path.join(CACHE_DIR, source.cacheFile);
  let buf = null;
  try {
    buf = await readFile(cached);
  } catch {
    if (OFFLINE) fail(`${source.id} is not cached at ${path.relative(ROOT, cached)} and --offline was given`);
    console.log(`  fetching ${source.sourceUrl}`);
    const res = await fetch(source.sourceUrl, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) fail(`download failed for ${source.id}: HTTP ${res.status} ${res.statusText}`);
    buf = Buffer.from(await res.arrayBuffer());
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cached, buf);
  }

  const hash = sha256(buf);
  if (source.sourceSha256 && source.sourceSha256 !== hash) {
    fail(
      `${source.id} hash mismatch\n` +
        `  manifest: ${source.sourceSha256}\n` +
        `  download: ${hash}\n` +
        `  the upstream file changed. Review the new file and its licence before updating the manifest.`,
    );
  }
  source.sourceSha256 = hash;
  source.sourceBytes = buf.length;
  console.log(`  ${source.id.padEnd(16)} ${mib(buf.length).padStart(9)}  ${hash.slice(0, 16)}...  cached`);
  return buf;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------
const produced = new Map(); // id -> Buffer

function emit(id, buf) {
  if (!outputById.has(id)) fail(`recipe produced undeclared output "${id}"`);
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

  emit('ground106-albedo', encodePng(takeChannels(resizeTo(color, DETAIL, 'srgb'), 3), { srgbChunk: true }));
  emit('ground106-normal', encodePng(takeChannels(resizeTo(normal, DETAIL, 'normal'), 3)));
  emit(
    'ground106-orm',
    encodePng(
      packChannels([
        { img: resizeTo(ao, DETAIL, 'linear'), channel: 0 },
        { img: resizeTo(rough, DETAIL, 'linear'), channel: 0 },
        { constant: 0 }, // ground is never metallic
      ]),
    ),
  );

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
  const preview = resizeTo(hdr, SKY_W, 'linear');
  emit('autumn-crossing-sky', encodePng(tonemapToSrgb(preview, exposure), { srgbChunk: true }));
  emit('autumn-crossing-gradient', encodePng(skyGradientStrip(hdr, { width: 8, height: 128, exposure }), { srgbChunk: true }));

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
  emit('macro-noise', encodePng(macroNoise({ size: 256, seed: 20260829 })));
  emit(
    'overcast-grade-lut',
    encodePng(
      gradeLut({ shadowTint: PALETTE.fogFar, highlightTint: LIGHT.realistic.keyColor }, { size: 16 }),
      { srgbChunk: true },
    ),
  );
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
// Write / verify
// ---------------------------------------------------------------------------
let drift = 0;
let shipped = 0;
const rows = [];
for (const decl of manifest.outputs) {
  const buf = produced.get(decl.id);
  const abs = path.join(OUT_DIR, decl.path);
  const hash = sha256(buf);
  shipped += buf.length;

  let existing = null;
  try {
    existing = await readFile(abs);
  } catch { /* not written yet */ }

  if (CHECK) {
    const same = existing && existing.equals(buf);
    if (!same) {
      drift++;
      console.log(`  DRIFT ${decl.path} (${existing ? 'differs' : 'missing'})`);
    }
  } else {
    await mkdir(path.dirname(abs), { recursive: true });
    if (!existing || !existing.equals(buf)) await writeFile(abs, buf);
  }

  decl.bytes = buf.length;
  decl.sha256 = hash;
  rows.push([decl.id, decl.path, buf.length, hash]);
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

if (!CHECK) {
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

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

if (shipped > manifest.shippedBudgetBytes) {
  fail(`shipped weight ${mib(shipped)} exceeds the Stage 1 budget of ${mib(manifest.shippedBudgetBytes)}`);
}

if (KTX2_REPORT) await ktx2Report();

if (CHECK) {
  if (drift) fail(`${drift} output(s) drifted from the committed tree`);
  console.log('\ncheck: every shipped byte matches the committed tree');
}
