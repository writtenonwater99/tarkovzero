import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectLocalPackageHashes, verifyBuildBoundary } from './verify-build-boundary.mjs';

const run = promisify(execFile);
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'verify-build-boundary.mjs');

const HEIGHT_BYTES = Buffer.from([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x40]);
const HEIGHT_SHA256 = 'f57e9b3c4b1f56f0e04fdd7ed9c6a4d9c6c6ec9e1e0a1c14e7a2ff9f22c30ee5';

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
