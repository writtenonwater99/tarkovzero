import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_LOCAL_ROOT,
  DEFAULT_VEGETATION_ARRAYTEX_ROOT,
  DEFAULT_VEGETATION_ROOT,
  collectLocalPackageHashes,
  verifyBuildBoundary,
} from './verify-build-boundary.mjs';

const run = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(SCRIPT_DIR, 'verify-build-boundary.mjs');
const FORTRESS_LOD2_GLB = resolve(
  SCRIPT_DIR, '..', 'public', 'assets', '3d', 'customs', 'authored', 'fortress', 'fortress-shell-lod2.glb',
);

const HEIGHT_BYTES = Buffer.from([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x40]);
const HEIGHT_SHA256 = 'f57e9b3c4b1f56f0e04fdd7ed9c6a4d9c6c6ec9e1e0a1c14e7a2ff9f22c30ee5';

const VEGETATION_LOD_BYTES = Buffer.from('glTF-fake-birch01-lod0-payload');
const VEGETATION_LOD_SHA256 = createHash('sha256').update(VEGETATION_LOD_BYTES).digest('hex');
// Declared in pack-index.receipt.json but never written as a file on disk —
// exercises the same "declared-only hash" path the terrain extraction-report
// already gets, now for pack-index.receipt.json.
const VEGETATION_DECLARED_ONLY_BYTES = Buffer.from('vegetation-declared-only-payload');
const VEGETATION_DECLARED_ONLY_SHA256 = createHash('sha256').update(VEGETATION_DECLARED_ONLY_BYTES).digest('hex');

/** Seeds a second local root — the authored vegetation pack — inside the same temp dir. */
async function vegetationFixture(root) {
  const vegetationRoot = join(root, '.local-candidates', 'vegetation-full-v2');
  await mkdir(join(vegetationRoot, 'assets', 'birch01'), { recursive: true });
  await writeFile(join(vegetationRoot, 'assets', 'birch01', 'birch01-lod0.glb'), VEGETATION_LOD_BYTES);
  await writeFile(join(vegetationRoot, 'pack-index.json'), JSON.stringify({
    schemaVersion: 1,
    documentType: 'customs-authored-vegetation-pack-index',
    authoredAssets: [{
      assetId: 'customs.vegetation.birch01',
      prototypeName: 'birch01',
      lods: [{ lod: 0, file: 'assets/birch01/birch01-lod0.glb', sha256: `sha256:${VEGETATION_LOD_SHA256}` }],
    }],
  }));
  await writeFile(join(vegetationRoot, 'pack-index.receipt.json'), JSON.stringify({
    catalogSha256: VEGETATION_DECLARED_ONLY_SHA256,
  }));
  return { vegetationRoot };
}

const ARRAYTEX_BLOB_BYTES = Buffer.from('fake-veg-l2-basecolor-blob-payload');
const ARRAYTEX_BLOB_SHA256 = createHash('sha256').update(ARRAYTEX_BLOB_BYTES).digest('hex');
// Declared in veg-layers.receipt.json but never written as a file on disk — the same
// "declared-only hash" path pack-index.receipt.json already gets, now for this root.
const ARRAYTEX_DECLARED_ONLY_BYTES = Buffer.from('vegetation-arraytex-declared-only-payload');
const ARRAYTEX_DECLARED_ONLY_SHA256 = createHash('sha256').update(ARRAYTEX_DECLARED_ONLY_BYTES).digest('hex');

/**
 * Seeds a third local root — the texture-array set (docs/plans/VEGETATION-DRAWCALLS.md) — inside
 * the same temp dir. Only one blob and a trimmed index/receipt: the verifier authorizes nothing
 * here (unlike the dev route), so a full 9-blob fixture would test nothing extra.
 */
async function arraytexFixture(root) {
  const arraytexRoot = join(root, '.local-candidates', 'vegetation-arraytex-v1');
  await mkdir(arraytexRoot, { recursive: true });
  await writeFile(join(arraytexRoot, 'veg-l2-basecolor.bin'), ARRAYTEX_BLOB_BYTES);
  await writeFile(join(arraytexRoot, 'veg-layers.json'), JSON.stringify({
    schemaVersion: 1,
    documentType: 'tarkovzero-customs-vegetation-texture-array-index',
    map: 'customs',
    arrays: [{
      lod: 2,
      blobs: { basecolor: { file: 'veg-l2-basecolor.bin', sha256: `sha256:${ARRAYTEX_BLOB_SHA256}` } },
    }],
  }));
  await writeFile(join(arraytexRoot, 'veg-layers.receipt.json'), JSON.stringify({
    documentType: 'tarkovzero-customs-vegetation-texture-array-index-receipt',
    sha256: ARRAYTEX_DECLARED_ONLY_SHA256,
  }));
  return { arraytexRoot };
}

async function fixture({ localPackage = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tz-build-boundary-'));
  const distDir = join(root, 'dist');
  const localRoot = join(root, '.local-game-derived');
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>TarkovZero</title>');
  await writeFile(
    join(distDir, 'assets', 'index-abc123.js'),
    // The dev-only loopback URL constant is legitimately bundled and must not trip the verifier.
    'const p="/@local-game-derived/customs/manifest.json";export{p};',
  );
  if (localPackage) {
    await mkdir(join(localRoot, 'customs', 'tiles', 'west'), { recursive: true });
    await writeFile(join(localRoot, 'customs', 'tiles', 'west', 'height.f32le'), HEIGHT_BYTES);
    await writeFile(join(localRoot, 'customs', 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      map: 'customs',
      localOnly: true,
      tiles: [{ id: 'west', heightFile: 'tiles/west/height.f32le' }],
    }));
    await writeFile(join(localRoot, 'customs', 'extraction-report.json'), JSON.stringify({
      artifact: 'customs-terrain-local-extraction-report',
      tiles: [{ id: 'west', heightSha256: HEIGHT_SHA256 }],
    }));
  }
  return { root, distDir, localRoot };
}

function checks(report, name) {
  return report.violations.filter((entry) => entry.check === name);
}

test('a clean build passes and reports what it scanned', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(report.pass, true);
  assert.deepEqual(report.violations, []);
  assert.equal(report.fileCount, 2);
  assert.equal(report.localPackagePresent, true);
  assert.ok(report.localPackageHashCount >= 4);
  assert.ok(report.scannedBytes > 0);
});

test('passes when no local package exists at all', async (t) => {
  const { root, distDir, localRoot } = await fixture({ localPackage: false });
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(report.pass, true);
  assert.equal(report.localPackagePresent, false);
  assert.equal(report.localPackageHashCount, 0);
});

test('rejects a copied local root, at any depth, by path segment', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(distDir, 'assets', 'local-game-derived', 'customs'), { recursive: true });
  await writeFile(join(distDir, 'assets', 'local-game-derived', 'customs', 'notes.json'), '{}');
  await mkdir(join(distDir, '.local-game-derived'), { recursive: true });
  await writeFile(join(distDir, '.local-game-derived', 'copy.json'), '{"a":1}');

  const report = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(report.pass, false);
  const paths = checks(report, 'path').map((entry) => entry.file).sort();
  assert.deepEqual(paths, [
    '.local-game-derived/copy.json',
    'assets/local-game-derived/customs/notes.json',
  ]);
});

test('rejects local extraction file names and payload suffixes', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(distDir, 'assets', 'extraction-report.json'), '{"artifact":"x"}');
  await writeFile(join(distDir, 'assets', 'height-9f2.f32le'), Buffer.from([9, 9, 9, 9]));

  const report = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(report.pass, false);
  const names = checks(report, 'name').map((entry) => entry.file).sort();
  assert.deepEqual(names, ['assets/extraction-report.json', 'assets/height-9f2.f32le']);
});

test('rejects a symbolic link in the build output without following it', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(localRoot, 'customs', 'manifest.json'), join(distDir, 'assets', 'linked.json'));

  const report = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(report.pass, false);
  assert.deepEqual(
    checks(report, 'name').map((entry) => entry.detail),
    ['build output contains a symbolic link'],
  );
  assert.deepEqual(checks(report, 'hash'), []);
});

test('rejects absolute EFT-install strings in UTF-8 and UTF-16LE', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ['drive-path.js', Buffer.from('const s="C:\\\\Battlestate Games\\\\EFT\\\\EscapeFromTarkov_Data";', 'utf8')],
    ['spaced-path.js', Buffer.from('// D:/Games/Escape From Tarkov/EscapeFromTarkov.exe', 'utf8')],
    ['unc-path.js', Buffer.from('\\\\gamebox\\share\\Escape from Tarkov\\live', 'utf8')],
    ['wide.bin', Buffer.from('E:\\Escape from Tarkov\\EscapeFromTarkov_Data', 'utf16le')],
    ['local-root.js', Buffer.from('readFileSync(".local-game-derived/customs/manifest.json")', 'utf8')],
  ];
  for (const [name, bytes] of cases) await writeFile(join(distDir, 'assets', name), bytes);

  const report = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(report.pass, false);
  const flagged = new Set(checks(report, 'content').map((entry) => entry.file));
  for (const [name] of cases) assert.ok(flagged.has(`assets/${name}`), name);
});

test('accepts the lawful public EFT reference URLs the app already ships', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(distDir, 'data'), { recursive: true });
  await writeFile(join(distDir, 'data', 'quests.json'), JSON.stringify({
    wiki: 'https://escapefromtarkov.fandom.com/wiki/Customs',
    image: 'https://static.wikia.nocookie.net/escapefromtarkov_gamepedia/images/a.png',
    api: 'https://api.tarkov.dev/graphql',
  }), { flag: 'w' });
  const report = await verifyBuildBoundary({ distDir, localRoot });
  assert.deepEqual(report.violations, []);
  assert.equal(report.pass, true);
});

test('rejects a build file that is byte-for-byte a local package payload', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Renamed and re-extensioned so only the content hash can catch it.
  await writeFile(join(distDir, 'assets', 'terrain-9f2c1a.bin'), HEIGHT_BYTES);

  const report = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(report.pass, false);
  const hashHits = checks(report, 'hash');
  assert.equal(hashHits.length, 1);
  assert.equal(hashHits[0].file, 'assets/terrain-9f2c1a.bin');
  assert.match(hashHits[0].detail, /^sha256 [0-9a-f]{64} matches local package /);
});

test('indexes both declared manifest hashes and real local file bytes', async (t) => {
  const { root, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { present, hashes } = await collectLocalPackageHashes(localRoot);
  assert.equal(present, true);
  assert.equal(hashes.get(HEIGHT_SHA256), 'customs/extraction-report.json (declared hash)');
  const heightDigest = [...hashes].find(([, source]) => source.startsWith('customs/tiles/west/height.f32le'));
  assert.ok(heightDigest);
  assert.equal(heightDigest[1], 'customs/tiles/west/height.f32le (file bytes)');
});

test('a declared-only hash still fails even when the local file is gone', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(join(localRoot, 'customs', 'tiles'), { recursive: true, force: true });
  // The bytes whose sha256 the extraction report declares.
  const declared = Buffer.from('declared-payload');
  await writeFile(join(localRoot, 'customs', 'extraction-report.json'), JSON.stringify({
    tiles: [{
      id: 'west',
      heightSha256: '2e2bb5e0aebbfe1eb2d3d1a97ef9b4d1d0dcb1a3b6b3d2a70ad0a0a1e5c5a1b0',
    }],
  }));
  await writeFile(join(distDir, 'assets', 'payload.bin'), declared);
  const clean = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(clean.pass, true, 'unrelated bytes must not match a declared hash');

  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(declared).digest('hex');
  await writeFile(join(localRoot, 'customs', 'extraction-report.json'), JSON.stringify({
    tiles: [{ id: 'west', heightSha256: digest }],
  }));
  const report = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(report.pass, false);
  assert.deepEqual(
    checks(report, 'hash').map((entry) => entry.file),
    ['assets/payload.bin'],
  );
});

test('refuses a dist and local root that contain each other', async (t) => {
  const { root, distDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    verifyBuildBoundary({ distDir, localRoot: join(distDir, '.local-game-derived') }),
    (error) => error.code === 'ERR_BUILD_BOUNDARY_ARGS',
  );
});

test('reports a missing build directory as a usage failure', async (t) => {
  const { root, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    verifyBuildBoundary({ distDir: join(root, 'absent-dist'), localRoot }),
    (error) => error.code === 'ERR_BUILD_BOUNDARY_NO_DIST',
  );
});

test('the CLI exits 0 on a clean build and 1 on a violation, leaving dist in place', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const argv = ['--dist-dir', distDir, '--local-root', localRoot];

  const clean = await run(process.execPath, [SCRIPT, ...argv]);
  assert.equal(JSON.parse(clean.stdout).pass, true);

  const offender = join(distDir, 'assets', 'terrain.f32le');
  await writeFile(offender, HEIGHT_BYTES);
  const failure = await run(process.execPath, [SCRIPT, ...argv]).then(
    () => null,
    (error) => error,
  );
  assert.ok(failure, 'the CLI must exit non-zero on a violation');
  assert.equal(failure.code, 1);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.pass, false);
  assert.ok(report.violations.length >= 2);
  // A failed verifier must not clean up after itself.
  const after = await verifyBuildBoundary({ distDir, localRoot });
  assert.equal(after.fileCount, 3);
});

test('the CLI exits 2 on unsupported arguments and a missing dist', async (t) => {
  const { root, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const argv of [
    ['--nope'],
    ['--dist-dir'],
    ['--dist-dir', join(root, 'absent-dist'), '--local-root', localRoot],
  ]) {
    const failure = await run(process.execPath, [SCRIPT, ...argv]).then(() => null, (error) => error);
    assert.ok(failure, JSON.stringify(argv));
    assert.equal(failure.code, 2, JSON.stringify(argv));
  }
});

// --- Second local root: the authored vegetation pack (docs/plans/VEGETATION-SERVING.md §3) ---

test('a clean build passes with both local roots present', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot] });
  assert.equal(report.pass, true);
  assert.deepEqual(report.violations, []);
  assert.equal(report.localPackagePresent, true);
  assert.deepEqual(report.localRoots, [resolve(localRoot), resolve(vegetationRoot)]);
  // Both roots' file bytes are indexed, not just the first: at least the terrain
  // fixture's four files plus the vegetation fixture's three (glb + two pack-index files).
  assert.ok(report.localPackageHashCount >= 7, report.localPackageHashCount);
});

test('a build file byte-identical to a real vegetation-pack GLB fails the hash check, naming the vegetation root', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  // Renamed and re-extensioned so only the content hash can catch it — proves
  // the union of hash maps works against the SECOND root, not just the first.
  await writeFile(join(distDir, 'assets', 'leaked-birch.bin'), VEGETATION_LOD_BYTES);

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot] });
  assert.equal(report.pass, false);
  const hashHits = checks(report, 'hash');
  assert.equal(hashHits.length, 1);
  assert.equal(hashHits[0].file, 'assets/leaked-birch.bin');
  assert.match(hashHits[0].detail, /vegetation-full-v2/);
});

test('a build file matching a pack-index.receipt.json-declared (but not directly present) sha256 fails', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  await writeFile(join(distDir, 'assets', 'declared-only.bin'), VEGETATION_DECLARED_ONLY_BYTES);

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot] });
  assert.equal(report.pass, false);
  assert.deepEqual(checks(report, 'hash').map((entry) => entry.file), ['assets/declared-only.bin']);
});

test('rejects a copied vegetation root, at any depth, by path segment', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  for (const [segments, name] of [
    [['assets', '.local-candidates', 'copy.json'], '.local-candidates'],
    [['assets', 'local-candidates', 'copy.json'], 'local-candidates'],
    [['assets', 'vegetation-full-v2', 'birch01-lod0.glb'], 'vegetation-full-v2'],
    [['assets', '@vegetation-authored', 'birch01-lod0.glb'], '@vegetation-authored'],
  ]) {
    await mkdir(join(distDir, ...segments.slice(0, -1)), { recursive: true });
    await writeFile(join(distDir, ...segments), 'x', { flag: 'w' });
  }

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot] });
  assert.equal(report.pass, false);
  const paths = checks(report, 'path').map((entry) => entry.file).sort();
  assert.deepEqual(paths, [
    'assets/.local-candidates/copy.json',
    'assets/@vegetation-authored/birch01-lod0.glb',
    'assets/local-candidates/copy.json',
    'assets/vegetation-full-v2/birch01-lod0.glb',
  ]);
});

test('rejects a build output file literally named after a vegetation pack-index file', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  for (const name of ['pack-index.json', 'pack-index.receipt.json', 'generation-manifest.json']) {
    // Unrelated bytes: proves this is a name check, not incidentally caught by hashing.
    await writeFile(join(distDir, 'assets', name), `unrelated content for ${name}`);
  }

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot] });
  assert.equal(report.pass, false);
  assert.deepEqual(checks(report, 'hash'), []);
  const names = checks(report, 'name').map((entry) => entry.file).sort();
  assert.deepEqual(names, [
    'assets/generation-manifest.json',
    'assets/pack-index.json',
    'assets/pack-index.receipt.json',
  ]);
});

test('a fortress-shaped .glb — same bytes as a real, currently-committed fortress GLB — still passes', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  const fortressBytes = await readFile(FORTRESS_LOD2_GLB);
  await mkdir(join(distDir, 'assets', '3d', 'customs', 'authored', 'fortress'), { recursive: true });
  await writeFile(
    join(distDir, 'assets', '3d', 'customs', 'authored', 'fortress', 'fortress-shell-lod2.glb'),
    fortressBytes,
  );

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot] });
  assert.deepEqual(report.violations, []);
  assert.equal(report.pass, true);
});

// --- Third local root: the texture-array set (docs/plans/VEGETATION-DRAWCALLS.md) ---

test('a clean build passes with all three local roots present', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  const { arraytexRoot } = await arraytexFixture(root);

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot] });
  assert.equal(report.pass, true);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.localRoots, [resolve(localRoot), resolve(vegetationRoot), resolve(arraytexRoot)]);
});

test('PROVEN LEAK, now caught: a build file byte-identical to a real arraytex blob fails the hash check, naming the arraytex root', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  const { arraytexRoot } = await arraytexFixture(root);
  // The exact manoeuvre the brief measured returning `pass: true` before
  // `DEFAULT_VEGETATION_ARRAYTEX_ROOT` existed: `veg-l2-basecolor.bin`'s bytes, renamed and
  // re-extensioned into dist so only the content hash — not the path/name checks — could catch it.
  await writeFile(join(distDir, 'assets', 'atlas-a1b2.bin'), ARRAYTEX_BLOB_BYTES);

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot] });
  assert.equal(report.pass, false);
  const hashHits = checks(report, 'hash');
  assert.equal(hashHits.length, 1);
  assert.equal(hashHits[0].file, 'assets/atlas-a1b2.bin');
  assert.match(hashHits[0].detail, /vegetation-arraytex-v1/);
});

test('a build file matching a veg-layers.receipt.json-declared (but not directly present) sha256 fails', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  const { arraytexRoot } = await arraytexFixture(root);
  await writeFile(join(distDir, 'assets', 'declared-only-arraytex.bin'), ARRAYTEX_DECLARED_ONLY_BYTES);

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot] });
  assert.equal(report.pass, false);
  assert.deepEqual(checks(report, 'hash').map((entry) => entry.file), ['assets/declared-only-arraytex.bin']);
});

test('rejects a copied vegetation-arraytex root, at any depth, by path segment', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  const { arraytexRoot } = await arraytexFixture(root);
  for (const segments of [
    ['assets', 'vegetation-arraytex-v1', 'veg-l0-basecolor.bin'],
    ['assets', 'vegetation-arraytex', 'veg-l0-basecolor.bin'],
    ['assets', '@vegetation-arraytex', 'veg-l0-basecolor.bin'],
  ]) {
    await mkdir(join(distDir, ...segments.slice(0, -1)), { recursive: true });
    await writeFile(join(distDir, ...segments), 'x', { flag: 'w' });
  }

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot] });
  assert.equal(report.pass, false);
  const paths = checks(report, 'path').map((entry) => entry.file).sort();
  assert.deepEqual(paths, [
    'assets/@vegetation-arraytex/veg-l0-basecolor.bin',
    'assets/vegetation-arraytex-v1/veg-l0-basecolor.bin',
    'assets/vegetation-arraytex/veg-l0-basecolor.bin',
  ]);
});

test('rejects a build output file literally named after a veg-layers index file', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  const { arraytexRoot } = await arraytexFixture(root);
  for (const name of ['veg-layers.json', 'veg-layers.receipt.json']) {
    // Unrelated bytes: proves this is a name check, not incidentally caught by hashing.
    await writeFile(join(distDir, 'assets', name), `unrelated content for ${name}`);
  }

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot] });
  assert.equal(report.pass, false);
  assert.deepEqual(checks(report, 'hash'), []);
  const names = checks(report, 'name').map((entry) => entry.file).sort();
  assert.deepEqual(names, ['assets/veg-layers.json', 'assets/veg-layers.receipt.json']);
});

test('the CLI --local-root flag is repeatable and reaches verifyBuildBoundary as localRoots', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);

  const result = await run(process.execPath, [
    SCRIPT, '--dist-dir', distDir, '--local-root', localRoot, '--local-root', vegetationRoot,
  ]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pass, true);
  assert.deepEqual(report.localRoots, [resolve(localRoot), resolve(vegetationRoot)]);
});

test('omitting --local-root entirely still defaults to scanning DEFAULT_LOCAL_ROOT, DEFAULT_VEGETATION_ROOT, and DEFAULT_VEGETATION_ARRAYTEX_ROOT', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await run(process.execPath, [SCRIPT, '--dist-dir', distDir]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pass, true);
  assert.deepEqual(report.localRoots, [DEFAULT_LOCAL_ROOT, DEFAULT_VEGETATION_ROOT, DEFAULT_VEGETATION_ARRAYTEX_ROOT]);
  assert.notDeepEqual(report.localRoots, [resolve(localRoot)]);
});

test('verifyBuildBoundary() called with neither localRoot nor localRoots defaults the same way', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tz-build-boundary-default-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distDir = join(root, 'dist');
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html>');

  const report = await verifyBuildBoundary({ distDir });
  assert.deepEqual(report.localRoots, [DEFAULT_LOCAL_ROOT, DEFAULT_VEGETATION_ROOT, DEFAULT_VEGETATION_ARRAYTEX_ROOT]);
});
