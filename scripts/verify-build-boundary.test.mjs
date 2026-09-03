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
import {
  CAPTURE_SUBTREES,
  INTERMEDIATE_SUBTREES,
  PROMOTABLE_SOURCES,
  classifyLocalPath,
  validatePromotionManifest,
} from './lib/asset-promotion.mjs';

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
  const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
  assert.equal(report.pass, true);
  assert.deepEqual(report.violations, []);
  assert.equal(report.fileCount, 2);
  assert.equal(report.localPackagePresent, true);
  assert.ok(report.localPackageHashCount >= 4);
  assert.ok(report.scannedBytes > 0);
});

test('THE MEASURED BLIND SPOT: an EMPTY directory named after a local root fails the build', async (t) => {
  // Found by hand-inspecting a real `dist/` while shipping the production Three renderer: a stale,
  // empty `public/local-game-derived/` from the pre-migration layout was copied into `dist/` by
  // Vite, and the verifier reported `pass: true`. It carried zero bytes, so every file-based check
  // — path segments, content literals, hashes — had nothing to look at. The hazard is that it sits
  // inside the one tree Vite copies wholesale: the day anything lands in it, it ships.
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const name of ['local-game-derived', '.local-game-derived', 'vegetation-full-v2', '.local-candidates']) {
    const empty = join(distDir, name);
    await mkdir(empty, { recursive: true });
    const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
    assert.equal(report.pass, false, `${name}: an empty local-root directory must fail`);
    assert.equal(checks(report, 'path').length, 1, name);
    assert.match(checks(report, 'path')[0].detail, /directory named after a local root/);
    assert.equal(report.fileCount, 2, `${name}: a directory is not a file`);
    assert.ok(report.directoryCount >= 1);
    await rm(empty, { recursive: true, force: true });
  }

  // A nested one is caught just the same, and a lawful directory name is not.
  await mkdir(join(distDir, 'assets', '3d', 'local-candidates'), { recursive: true });
  assert.equal((await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root })).pass, false);
  await rm(join(distDir, 'assets', '3d', 'local-candidates'), { recursive: true, force: true });
  await mkdir(join(distDir, 'assets', '3d', 'customs', 'authored'), { recursive: true });
  assert.equal((await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root })).pass, true, 'authored asset dirs still ship');
});

test('passes when no local package exists at all', async (t) => {
  const { root, distDir, localRoot } = await fixture({ localPackage: false });
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
  assert.equal(report.pass, false);
  const paths = checks(report, 'path').map((entry) => entry.file).sort();
  // The containing directories are reported alongside the files (trailing `/`) — see the
  // empty-directory test above for why a directory is a finding in its own right.
  assert.deepEqual(paths, [
    '.local-game-derived/',
    '.local-game-derived/copy.json',
    'assets/local-game-derived/',
    'assets/local-game-derived/customs/notes.json',
  ]);
});

test('rejects local extraction file names and payload suffixes', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(distDir, 'assets', 'extraction-report.json'), '{"artifact":"x"}');
  await writeFile(join(distDir, 'assets', 'height-9f2.f32le'), Buffer.from([9, 9, 9, 9]));

  const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
  assert.equal(report.pass, false);
  const names = checks(report, 'name').map((entry) => entry.file).sort();
  assert.deepEqual(names, ['assets/extraction-report.json', 'assets/height-9f2.f32le']);
});

test('rejects a symbolic link in the build output without following it', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(localRoot, 'customs', 'manifest.json'), join(distDir, 'assets', 'linked.json'));

  const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
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
  const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
  assert.deepEqual(report.violations, []);
  assert.equal(report.pass, true);
});

test('rejects a build file that is byte-for-byte a local package payload', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Renamed and re-extensioned so only the content hash can catch it.
  await writeFile(join(distDir, 'assets', 'terrain-9f2c1a.bin'), HEIGHT_BYTES);

  const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
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
  const clean = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
  assert.equal(clean.pass, true, 'unrelated bytes must not match a declared hash');

  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(declared).digest('hex');
  await writeFile(join(localRoot, 'customs', 'extraction-report.json'), JSON.stringify({
    tiles: [{ id: 'west', heightSha256: digest }],
  }));
  const report = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
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
    verifyBuildBoundary({ distDir, localRoot: join(distDir, '.local-game-derived'), repositoryRoot: root }),
    (error) => error.code === 'ERR_BUILD_BOUNDARY_ARGS',
  );
});

test('reports a missing build directory as a usage failure', async (t) => {
  const { root, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    verifyBuildBoundary({ distDir: join(root, 'absent-dist'), localRoot, repositoryRoot: root }),
    (error) => error.code === 'ERR_BUILD_BOUNDARY_NO_DIST',
  );
});

test('the CLI exits 0 on a clean build and 1 on a violation, leaving dist in place', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const argv = ['--dist-dir', distDir, '--local-root', localRoot, '--repository-root', root];

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
  const after = await verifyBuildBoundary({ distDir, localRoot, repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot], repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot], repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot], repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot], repositoryRoot: root });
  assert.equal(report.pass, false);
  const paths = checks(report, 'path').map((entry) => entry.file).sort();
  assert.deepEqual(paths, [
    'assets/.local-candidates/',
    'assets/.local-candidates/copy.json',
    'assets/@vegetation-authored/',
    'assets/@vegetation-authored/birch01-lod0.glb',
    'assets/local-candidates/',
    'assets/local-candidates/copy.json',
    'assets/vegetation-full-v2/',
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot], repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot], repositoryRoot: root });
  assert.deepEqual(report.violations, []);
  assert.equal(report.pass, true);
});

// --- Third local root: the texture-array set (docs/plans/VEGETATION-DRAWCALLS.md) ---

test('a clean build passes with all three local roots present', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vegetationRoot } = await vegetationFixture(root);
  const { arraytexRoot } = await arraytexFixture(root);

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot], repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot], repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot], repositoryRoot: root });
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot], repositoryRoot: root });
  assert.equal(report.pass, false);
  const paths = checks(report, 'path').map((entry) => entry.file).sort();
  assert.deepEqual(paths, [
    'assets/@vegetation-arraytex/',
    'assets/@vegetation-arraytex/veg-l0-basecolor.bin',
    'assets/vegetation-arraytex-v1/',
    'assets/vegetation-arraytex-v1/veg-l0-basecolor.bin',
    'assets/vegetation-arraytex/',
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

  const report = await verifyBuildBoundary({ distDir, localRoots: [localRoot, vegetationRoot, arraytexRoot], repositoryRoot: root });
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
    '--repository-root', root,
  ]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pass, true);
  assert.deepEqual(report.localRoots, [resolve(localRoot), resolve(vegetationRoot)]);
});

test('omitting --local-root entirely still defaults to scanning DEFAULT_LOCAL_ROOT, DEFAULT_VEGETATION_ROOT, and DEFAULT_VEGETATION_ARRAYTEX_ROOT', async (t) => {
  const { root, distDir, localRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await run(process.execPath, [SCRIPT, '--dist-dir', distDir, '--repository-root', root]);
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

  const report = await verifyBuildBoundary({ distDir, repositoryRoot: root });
  assert.deepEqual(report.localRoots, [DEFAULT_LOCAL_ROOT, DEFAULT_VEGETATION_ROOT, DEFAULT_VEGETATION_ARRAYTEX_ROOT]);
});

// ---------------------------------------------------------------------------
// PROMOTION AND CAPTURE (2026-09-02)
//
// The founder ruled that the local packages hold no extracted game assets and approved promoting
// specific authored outputs into `public/`. These tests fix the two halves of that:
//
//   * a promotion is admitted ONLY through the manifest, and only with a receipt that verifies;
//   * a RAW CAPTURE is admitted by nothing, manifest or no manifest.
//
// Every assertion below was proven to discriminate by mutation: each "FAILS" case was first run
// with the offending byte removed and observed to pass, then re-run with it present and observed
// to fail on the named check.

const FACTS_BYTES = Buffer.from('{"artifact":"customs-unity-facts","objects":[{"path":"terrain"}]}');
const PHOTO_BYTES = Buffer.from('\x89PNG\r\n\x1a\n fake survey photograph payload bytes');
const SCREENSHOT_NAME =
  '2026-09-01[08-37]_164.35, 0.74, 39.99_-0.06659, -0.70777, 0.06928, -0.69988_16.39 (0).png';
const PROOF_BYTES = Buffer.from('glTF-fake-crackhouse-shell-lod0-proof-package-payload');

const FACTORY_BYTES = Buffer.from('# fake vegetation_factory.py\ndef build(): return 1\n');
const CATALOG_BYTES = Buffer.from('{"prototypes":[{"name":"birch01"}]}');
const FACTORY_SHA = `sha256:${createHash('sha256').update(FACTORY_BYTES).digest('hex')}`;
const CATALOG_SHA = `sha256:${createHash('sha256').update(CATALOG_BYTES).digest('hex')}`;

const PROMOTED_DIST_PATH = 'assets/3d/customs/authored/vegetation/birch01/birch01-lod0.glb';
const FACTORY_REPO_PATH = 'scripts/vegetation-asset-factory/vegetation_factory.py';
const CATALOG_REPO_PATH = 'scripts/vegetation-asset-factory/prototype_catalog.json';

/** The raw captures, laid out under a fixture root exactly as they sit in the real repo. */
async function captureFixture(root) {
  await mkdir(join(root, '.local-game-derived', 'unity-facts'), { recursive: true });
  await writeFile(join(root, '.local-game-derived', 'unity-facts', 'customs-unity-facts.json'), FACTS_BYTES);
  await mkdir(join(root, '.local-candidates', 'survey-2026-09-01'), { recursive: true });
  await writeFile(join(root, '.local-candidates', 'survey-2026-09-01', SCREENSHOT_NAME), PHOTO_BYTES);
  await mkdir(join(root, '.local-candidates', 'crackhouse-final4'), { recursive: true });
  await writeFile(join(root, '.local-candidates', 'crackhouse-final4', 'crackhouse-shell-lod0.glb'), PROOF_BYTES);
}

/** The git-tracked provenance documents a vegetation receipt must cite. */
async function receiptFixture(root) {
  await mkdir(join(root, 'scripts', 'vegetation-asset-factory'), { recursive: true });
  await writeFile(join(root, ...FACTORY_REPO_PATH.split('/')), FACTORY_BYTES);
  await writeFile(join(root, ...CATALOG_REPO_PATH.split('/')), CATALOG_BYTES);
}

async function writePromotionManifest(root, promotions) {
  await writeFile(join(root, 'asset-promotion-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    documentType: 'tarkovzero-asset-promotion-manifest',
    promotions,
  }));
}

function vegetationPromotion(overrides = {}) {
  return {
    id: 'customs.vegetation.birch01.lod0',
    source: 'customs-authored-vegetation-v2',
    sourcePath: 'birch01/birch01-lod0.glb',
    distPath: PROMOTED_DIST_PATH,
    sha256: `sha256:${VEGETATION_LOD_SHA256}`,
    bytes: VEGETATION_LOD_BYTES.byteLength,
    approvedBy: 'founder',
    approvedOn: '2026-09-02',
    receipt: {
      kind: 'vegetation-factory',
      documents: [
        { role: 'factory', repoPath: FACTORY_REPO_PATH, sha256: FACTORY_SHA },
        { role: 'catalog', repoPath: CATALOG_REPO_PATH, sha256: CATALOG_SHA },
      ],
    },
    ...overrides,
  };
}

/** Put the promoted GLB in dist at the path the manifest declares. */
async function shipPromotedGlb(distDir, bytes = VEGETATION_LOD_BYTES) {
  await mkdir(join(distDir, ...PROMOTED_DIST_PATH.split('/').slice(0, -1)), { recursive: true });
  await writeFile(join(distDir, ...PROMOTED_DIST_PATH.split('/')), bytes);
}

async function promotionFixture() {
  const base = await fixture();
  const { vegetationRoot } = await vegetationFixture(base.root);
  await captureFixture(base.root);
  await receiptFixture(base.root);
  return { ...base, vegetationRoot };
}

function verifyPromotionScenario({ root, distDir, localRoot, vegetationRoot }) {
  return verifyBuildBoundary({
    distDir,
    localRoots: [localRoot, vegetationRoot],
    repositoryRoot: root,
  });
}

test('CONTROL: the promotion fixture with an empty manifest passes, so every failure below is the mutation', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, []);

  const report = await verifyPromotionScenario(scenario);
  assert.deepEqual(report.violations, []);
  assert.equal(report.pass, true);
  assert.equal(report.promotion.manifestPresent, true);
  assert.equal(report.promotion.entries, 0);
  assert.equal(report.promotion.verified, 0);
  assert.equal(report.promotion.appliedInDist, 0);
  // The capture and intermediate subtrees are SEEN even though nothing is hashed: the size filter
  // is what keeps them free, and `filesSeen > filesHashed` is the observable proof it is on.
  assert.ok(report.capture.filesSeen >= 2, JSON.stringify(report.capture));
  assert.equal(report.capture.filesHashed, 0);
  assert.ok(report.intermediate.filesSeen >= 1);
});

test('an absent promotion manifest is not an error: it means nothing is promoted', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, true);
  assert.equal(report.promotion.manifestPresent, false);
  assert.equal(report.promotion.entries, 0);
});

// --- the promotion road actually works ------------------------------------------------------

test('a promoted artifact with a verifying receipt ships', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, [vegetationPromotion()]);
  await shipPromotedGlb(scenario.distDir);

  const report = await verifyPromotionScenario(scenario);
  assert.deepEqual(report.violations, []);
  assert.equal(report.pass, true);
  assert.equal(report.promotion.verified, 1);
  assert.equal(report.promotion.appliedInDist, 1);
  assert.deepEqual(report.promotion.promoted, [{
    file: PROMOTED_DIST_PATH,
    promotion: 'customs.vegetation.birch01.lod0',
    sha256: `sha256:${VEGETATION_LOD_SHA256}`,
  }]);
  assert.deepEqual(report.promotion.records[0].sourcePresent, true);
});

// --- a promoted artifact with NO manifest entry FAILS -----------------------------------------

test('DISCRIMINATION: the same artifact with NO manifest entry fails the hash check', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, []);
  await shipPromotedGlb(scenario.distDir);

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  const hashHits = checks(report, 'hash');
  assert.equal(hashHits.length, 1);
  assert.equal(hashHits[0].file, PROMOTED_DIST_PATH);
  assert.match(hashHits[0].detail, /matches local package .*vegetation-full-v2/);
  assert.equal(report.promotion.appliedInDist, 0);
});

test('an entry for a DIFFERENT dist path does not clear this one', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, [
    vegetationPromotion({ distPath: 'assets/3d/customs/authored/vegetation/elsewhere.glb' }),
  ]);
  await shipPromotedGlb(scenario.distDir);

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  assert.deepEqual(checks(report, 'hash').map((entry) => entry.file), [PROMOTED_DIST_PATH]);
});

// --- a promoted artifact with a WRONG receipt hash FAILS --------------------------------------

test('DISCRIMINATION: a promotion whose receipt hash is wrong fails, and admits nothing', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, [vegetationPromotion({
    receipt: {
      kind: 'vegetation-factory',
      documents: [
        // One hex digit off: the shape is valid, the claim is false.
        { role: 'factory', repoPath: FACTORY_REPO_PATH, sha256: `sha256:${'0'.repeat(64)}` },
        { role: 'catalog', repoPath: CATALOG_REPO_PATH, sha256: CATALOG_SHA },
      ],
    },
  })]);
  await shipPromotedGlb(scenario.distDir);

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  const promotionHits = checks(report, 'promotion');
  assert.equal(promotionHits.length, 1);
  assert.match(promotionHits[0].detail, /ERR_PROMOTION_RECEIPT_HASH/);
  assert.match(promotionHits[0].detail, /vegetation_factory\.py declares sha256:0{64} but hashes to sha256:[0-9a-f]{64}/);
  // The artifact it described is NOT cleared: a failed receipt admits nothing.
  assert.deepEqual(checks(report, 'hash').map((entry) => entry.file), [PROMOTED_DIST_PATH]);
  assert.equal(report.promotion.verified, 0);
});

test('a receipt that renames the provenance document is refused before any hash is read', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  // The forgery this shape exists to stop: cite a file you control instead of the factory.
  await writeFile(join(scenario.root, 'scripts', 'vegetation-asset-factory', 'friendly.py'), FACTORY_BYTES);
  await writePromotionManifest(scenario.root, [vegetationPromotion({
    receipt: {
      kind: 'vegetation-factory',
      documents: [
        { role: 'factory', repoPath: 'scripts/vegetation-asset-factory/friendly.py', sha256: FACTORY_SHA },
        { role: 'catalog', repoPath: CATALOG_REPO_PATH, sha256: CATALOG_SHA },
      ],
    },
  })]);
  await shipPromotedGlb(scenario.distDir);

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  assert.match(checks(report, 'promotion')[0].detail, /ERR_PROMOTION_RECEIPT_SHAPE/);
  assert.match(checks(report, 'promotion')[0].detail, /must be role factory at scripts\/vegetation-asset-factory\/vegetation_factory\.py/);
});

test('a promotion whose declared digest is not the bytes in dist fails', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, [vegetationPromotion()]);
  // Same path, same length, different bytes: the entry is valid, the artifact is not the one it
  // approved. A promotion is a claim about a DIGEST, not about a path.
  await shipPromotedGlb(scenario.distDir, Buffer.from('glTF-fake-birch01-lod0-PAYLOAD'));

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  const promotionHits = checks(report, 'promotion');
  assert.equal(promotionHits.length, 1);
  assert.match(promotionHits[0].detail, /is admitted by promotion customs\.vegetation\.birch01\.lod0 as sha256:[0-9a-f]{64} but hashes to sha256:[0-9a-f]{64}/);
});

test('a promotion whose SOURCE bytes have moved under it fails', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, [vegetationPromotion()]);
  await writeFile(
    join(scenario.vegetationRoot, 'assets', 'birch01', 'birch01-lod0.glb'),
    Buffer.from('glTF-fake-birch01-lod0-regenerated'),
  );

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  assert.match(checks(report, 'promotion')[0].detail, /ERR_PROMOTION_SOURCE_(HASH|BYTES)/);
});

// --- a RAW CAPTURE reaching dist FAILS, manifest or no manifest -------------------------------

test('DISCRIMINATION: a raw capture (unity-facts) renamed into dist fails on the capture check', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, []);
  // Renamed and re-extensioned, exactly the manoeuvre the path/name checks cannot see.
  await writeFile(join(scenario.distDir, 'assets', 'facts-9f2c1a.bin'), FACTS_BYTES);

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  const captureHits = checks(report, 'capture');
  assert.equal(captureHits.length, 1);
  assert.equal(captureHits[0].file, 'assets/facts-9f2c1a.bin');
  assert.match(
    captureHits[0].detail,
    /^sha256 [0-9a-f]{64} matches raw capture \.local-game-derived\/unity-facts\/customs-unity-facts\.json \(unity-facts\); a capture is never promotable$/,
  );
});

test('THE GAP THIS CLOSES: a survey photograph renamed into dist used to pass every check', async (t) => {
  // `.local-candidates/survey-2026-09-01/` was under NO scanned root before 2026-09-02: the path
  // segment was gone, the name was gone, the bytes matched nothing indexed. It passed.
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, []);
  await writeFile(join(scenario.distDir, 'assets', 'hero-3f1.png'), PHOTO_BYTES);

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  assert.deepEqual(checks(report, 'capture').map((entry) => entry.file), ['assets/hero-3f1.png']);
  assert.match(checks(report, 'capture')[0].detail, /survey-2026-09-01/);
});

test('a capture FAILS EVEN WHEN LISTED: there is no source key that reaches one', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writeFile(join(scenario.distDir, 'assets', 'facts-9f2c1a.bin'), FACTS_BYTES);
  // Somebody tries to write the capture into the allow-list the obvious way.
  await writePromotionManifest(scenario.root, [{
    id: 'customs.unity.facts',
    source: 'customs-unity-facts',
    sourcePath: 'customs-unity-facts.json',
    distPath: 'assets/facts-9f2c1a.bin',
    sha256: `sha256:${createHash('sha256').update(FACTS_BYTES).digest('hex')}`,
    bytes: FACTS_BYTES.byteLength,
    approvedBy: 'founder',
    approvedOn: '2026-09-02',
    receipt: {
      kind: 'vegetation-factory',
      documents: [
        { role: 'factory', repoPath: FACTORY_REPO_PATH, sha256: FACTORY_SHA },
        { role: 'catalog', repoPath: CATALOG_REPO_PATH, sha256: CATALOG_SHA },
      ],
    },
  }]);

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  assert.match(checks(report, 'promotion')[0].detail, /ERR_PROMOTION_UNKNOWN_SOURCE/);
  assert.match(checks(report, 'promotion')[0].detail, /"customs-unity-facts" is not a promotable source/);
  // And the capture violation stands on its own, from an index the manifest never touched.
  assert.deepEqual(checks(report, 'capture').map((entry) => entry.file), ['assets/facts-9f2c1a.bin']);
  assert.equal(report.promotion.verified, 0);
});

test('a capture cannot be reached by traversal out of a legitimate source either', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  for (const [sourcePath, expected] of [
    // Refused by the path-shape gate: a `sourcePath` may not even begin with a dot.
    ['../../../.local-game-derived/unity-facts/customs-unity-facts.json', /must be a safe relative path/],
    // Shaped legally enough to reach the segment gate, and still refused there.
    ['birch01/../../../unity-facts/customs-unity-facts.json', /must not contain empty or traversal segments/],
    // Legal path, wrong file for this source: the registry's own pattern refuses it.
    ['birch01/customs-unity-facts.json', /is not a file customs-authored-vegetation-v2 may promote/],
  ]) {
    await writePromotionManifest(scenario.root, [vegetationPromotion({ sourcePath })]);
    const report = await verifyPromotionScenario(scenario);
    assert.equal(report.pass, false, sourcePath);
    const detail = checks(report, 'promotion')[0].detail;
    assert.match(detail, /ERR_PROMOTION_(PATH|SOURCE_PATH)/, sourcePath);
    assert.match(detail, expected, sourcePath);
  }
});

test('a capture cannot be laundered through a legitimate source key by declaring its digest', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writeFile(join(scenario.distDir, 'assets', 'facts-9f2c1a.bin'), FACTS_BYTES);
  // Correct source key, correct receipt, correct-looking file name — and the capture's digest.
  await writePromotionManifest(scenario.root, [vegetationPromotion({
    distPath: 'assets/facts-9f2c1a.bin',
    sha256: `sha256:${createHash('sha256').update(FACTS_BYTES).digest('hex')}`,
    bytes: FACTS_BYTES.byteLength,
  })]);

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  const promotionDetails = checks(report, 'promotion').map((entry) => entry.detail).join('\n');
  assert.match(promotionDetails, /ERR_PROMOTION_CAPTURE/);
  assert.match(promotionDetails, /declares the digest of a raw capture/);
  assert.deepEqual(checks(report, 'capture').map((entry) => entry.file), ['assets/facts-9f2c1a.bin']);
  assert.equal(report.promotion.verified, 0);
});

test('a capture directory name and an EFT screenshot file name fail on their own', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, []);
  await mkdir(join(scenario.distDir, 'assets', 'unity-facts'), { recursive: true });
  await mkdir(join(scenario.distDir, 'assets', 'survey-2026-09-01'), { recursive: true });
  // Unrelated bytes: this is a name/path finding, not incidentally caught by hashing.
  await writeFile(join(scenario.distDir, 'assets', SCREENSHOT_NAME), 'unrelated bytes');

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  assert.deepEqual(checks(report, 'hash'), []);
  const captureFiles = checks(report, 'capture').map((entry) => entry.file).sort();
  assert.deepEqual(captureFiles, [
    `assets/${SCREENSHOT_NAME}`,
    'assets/survey-2026-09-01/',
    'assets/unity-facts/',
  ]);
});

// --- build intermediates: the other half of the gap -------------------------------------------

test('a proof-package artifact renamed into dist now fails the hash check', async (t) => {
  const scenario = await promotionFixture();
  t.after(() => rm(scenario.root, { recursive: true, force: true }));
  await writePromotionManifest(scenario.root, []);
  await writeFile(join(scenario.distDir, 'assets', 'shell-a1b2.glb'), PROOF_BYTES);

  const report = await verifyPromotionScenario(scenario);
  assert.equal(report.pass, false);
  assert.deepEqual(checks(report, 'hash').map((entry) => entry.file), ['assets/shell-a1b2.glb']);
  assert.match(checks(report, 'hash')[0].detail, /crackhouse-final4/);
});

// --- the registry itself ----------------------------------------------------------------------

test('every promotable source cites git-tracked provenance documents that exist and hash', async () => {
  const tracked = new Set(
    (await run('git', ['ls-files'], { cwd: resolve(SCRIPT_DIR, '..'), maxBuffer: 64 * 1024 * 1024 }))
      .stdout.split('\n').filter(Boolean),
  );
  assert.ok(tracked.size > 0, 'git ls-files must return the tracked set');
  for (const [key, source] of Object.entries(PROMOTABLE_SOURCES)) {
    assert.ok(source.receipt.documents.length > 0, `${key} must require at least one receipt document`);
    for (const document of source.receipt.documents) {
      assert.ok(
        tracked.has(document.repoPath),
        `${key}: receipt document ${document.repoPath} must be git-tracked, or its receipt proves nothing`,
      );
      const bytes = await readFile(resolve(SCRIPT_DIR, '..', document.repoPath));
      assert.ok(bytes.byteLength > 0, `${key}: ${document.repoPath} must not be empty`);
    }
  }
});

test('no promotable source is rooted inside a capture or intermediate subtree', async () => {
  // A subtree entry with NO `filePattern` claims the whole directory: nothing promotable may be
  // rooted at or under it. An entry WITH a `filePattern` claims named files inside a shared
  // directory, which is the mixed case asserted immediately below.
  const blocked = [...CAPTURE_SUBTREES, ...INTERMEDIATE_SUBTREES].filter((entry) => !entry.filePattern);
  for (const [key, source] of Object.entries(PROMOTABLE_SOURCES)) {
    for (const subtree of blocked) {
      assert.ok(
        source.root !== subtree.path && !source.root.startsWith(`${subtree.path}/`),
        `${key} is rooted inside ${subtree.path}`,
      );
    }
  }
  // Where a capture and a promotable source DO share a directory, their patterns must be
  // disjoint, and the capture must win regardless — `classifyLocalPath` checks captures first.
  const mixed = CAPTURE_SUBTREES.filter((entry) => entry.filePattern);
  assert.equal(mixed.length, 1, 'only .local-game-derived/customs is a mixed directory today');
  for (const capture of mixed) {
    for (const [key, source] of Object.entries(PROMOTABLE_SOURCES)) {
      if (source.root !== capture.path) continue;
      for (const name of ['terrain-000-vegetation.json', 'terrain-999-vegetation.json']) {
        assert.ok(capture.filePattern.test(name), `${capture.id} must claim ${name}`);
        assert.ok(!source.filePattern.test(name), `${key} must not be able to name ${name}`);
      }
    }
  }
  // The mixed directory: `.local-game-derived/customs/` holds approved terrain surfaces AND the
  // raw Unity vegetation dump. The dump must stay a capture even though a source key lives there.
  assert.equal(classifyLocalPath('.local-game-derived/customs/terrain-000-vegetation.json').tier, 'raw-capture');
  assert.equal(classifyLocalPath('.local-game-derived/customs/terrain-000-height-world-y.f32le').tier, 'promotable');
  assert.equal(classifyLocalPath('.local-game-derived/customs/terrain-000-control-0.png').tier, 'promotable');
  assert.equal(classifyLocalPath('.local-game-derived/customs/extraction-report.json').tier, 'other');
  assert.equal(classifyLocalPath('.local-game-derived/unity-facts/customs-unity-facts.json').tier, 'raw-capture');
  assert.equal(classifyLocalPath(`.local-candidates/survey-2026-09-01/${SCREENSHOT_NAME}`).tier, 'raw-capture');
  assert.equal(classifyLocalPath('.local-candidates/reviews/tarkovzero-claude-fortress-review.md').tier, 'intermediate');
  assert.equal(
    classifyLocalPath('.local-candidates/vegetation-full-v2/assets/birch01/birch01-lod0.glb').tier,
    'promotable',
  );
  assert.equal(classifyLocalPath('.local-candidates/vegetation-full-v2/pack-index.json').tier, 'other');
});

test('THE SHIPPED TREE: the real manifest validates, is empty, and the real build has 0 violations', async (t) => {
  const shipped = JSON.parse(await readFile(resolve(SCRIPT_DIR, '..', 'asset-promotion-manifest.json'), 'utf8'));
  const validation = validatePromotionManifest(shipped);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.entries, [], 'the manifest ships empty: promotion is a mechanism, not a state');

  // The live build output, when there is one. Skipped rather than failed on a tree that has not
  // been built, so `npm run test:local-boundary` stands alone.
  const distDir = resolve(SCRIPT_DIR, '..', 'dist');
  try {
    await readFile(join(distDir, 'index.html'));
  } catch {
    t.skip('dist/ has not been built');
    return;
  }
  const report = await verifyBuildBoundary();
  assert.deepEqual(report.violations, []);
  assert.equal(report.pass, true);
  assert.equal(report.promotion.manifestPresent, true);
  assert.equal(report.promotion.entries, 0);
  assert.equal(report.capture.filesHashed, 0, 'the size filter must keep the 460 MB dump unread');
});
