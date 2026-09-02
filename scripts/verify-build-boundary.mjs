#!/usr/bin/env node
//
// Deterministic build-boundary verifier.
//
// Runs after `vite build` and proves that nothing derived from a local Escape
// from Tarkov installation reached `dist/`. Three independent checks, each of
// which alone is enough to fail the build:
//
//   1. path/name  — no build output may live under, or be named after, the
//                   local game-derived root, and no local payload suffix
//                   (`.f32le`, `extraction-report.json`) may appear at all.
//   2. content    — no build output may embed an absolute EFT-install path or
//                   the local package root name, in UTF-8 or UTF-16LE.
//   3. hash       — no build output may be byte-for-byte identical to a file
//                   the local package manifest accounts for.
//
// The verifier never deletes or rewrites `dist/`: a failure leaves the build
// tree in place for inspection and exits non-zero.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');

export const DEFAULT_DIST_DIR = resolve(REPOSITORY_ROOT, 'dist');
export const DEFAULT_LOCAL_ROOT = resolve(REPOSITORY_ROOT, '.local-game-derived');
/**
 * Second local root: the independently-authored Customs vegetation pack
 * (docs/plans/VEGETATION-SERVING.md). It is original authored work, not
 * game-derived data — a different threat model from `DEFAULT_LOCAL_ROOT` —
 * but the one property that matters here (it must never reach `dist/`) is
 * identical, so it is scanned by the same verifier, as a second root, not
 * folded into the first.
 */
export const DEFAULT_VEGETATION_ROOT = resolve(REPOSITORY_ROOT, '.local-candidates', 'vegetation-full-v2');
/**
 * Third local root: the offline-built vegetation texture-array set
 * (docs/plans/VEGETATION-DRAWCALLS.md, `scripts/vegetation-asset-factory/build_texture_arrays.py`) —
 * `veg-layers.json` plus the nine `veg-l{0,1,2}-{basecolor,orm,normal}.bin` blobs it declares. Same
 * threat model and same one property that matters (never reach `dist/`) as
 * `DEFAULT_VEGETATION_ROOT`, so it is scanned by the same verifier, as a third root.
 */
export const DEFAULT_VEGETATION_ARRAYTEX_ROOT =
  resolve(REPOSITORY_ROOT, '.local-candidates', 'vegetation-arraytex-v1');

/** Path segments that may never appear anywhere inside the build output. */
export const FORBIDDEN_PATH_SEGMENTS = Object.freeze([
  '.local-game-derived',
  'local-game-derived',
  '@local-game-derived',
  'local_game_derived',
  '.local-candidates',
  'local-candidates',
  '@vegetation-authored',
  'local_candidates',
  // `.local-candidates/` holds several other candidate packages that must
  // stay just as unreachable as they are today; catching the package name
  // itself (not only its parent directory name) is a second independent
  // tripwire if a future build step ever copies
  // `.local-candidates/vegetation-full-v2/…` in without preserving the
  // `.local-candidates` segment.
  'vegetation-full-v2',
  'vegetation_full_v2',
  'vegetation-full',
  'vegetation_full',
  // Same tripwire, for the third root (the texture-array set): the package directory name itself,
  // not only its `.local-candidates` parent, plus the dev-only fetch prefix's own name — mirrors
  // `vegetation-full-v2`/`@vegetation-authored` above exactly.
  'vegetation-arraytex-v1',
  'vegetation_arraytex_v1',
  'vegetation-arraytex',
  'vegetation_arraytex',
  '@vegetation-arraytex',
]);

/** File names that only a local extraction, or the vegetation pack, produces. */
export const FORBIDDEN_FILE_NAMES = Object.freeze([
  'extraction-report.json',
  'pack-index.json',
  'pack-index.receipt.json',
  'generation-manifest.json',
  // The texture-array set's own index and receipt — same status as `pack-index.json` above.
  'veg-layers.json',
  'veg-layers.receipt.json',
]);

/**
 * File suffixes that only a local extraction produces.
 *
 * Deliberately does NOT include `.glb`. `.f32le` is unique to the terrain
 * package, so forbidding it outright is free. `.glb` is not unique —
 * `public/assets/3d/customs/authored/fortress/*.glb` already ships to
 * `dist/` legitimately, so a blanket suffix ban would fail every future
 * production build on its own admitted assets. `.glb` protection for the
 * vegetation pack rests on the hash check alone (byte-for-byte identity,
 * immune to renaming or relocation) plus the path/name checks above, which
 * catch the common case of a lazy recursive copy. See
 * docs/plans/VEGETATION-SERVING.md §3 ("Why the suffix check does *not*
 * gain `.glb`") — do not "fix" this apparent gap by adding `.glb` here.
 */
export const FORBIDDEN_FILE_SUFFIXES = Object.freeze(['.f32le']);

/**
 * Literals that only appear if an absolute game-install path, or a local
 * package root, was baked into an artifact. The dev-only fetch prefixes
 * (`/@local-game-derived/`, `/@vegetation-authored/`) are deliberately
 * absent: they are loopback-gated URL constants in application source, not
 * local truth, and they resolve to nothing in production. The filesystem
 * root names (`.local-game-derived`, `.local-candidates`) ARE listed,
 * because they can only appear if build tooling touched the local
 * directory.
 */
export const FORBIDDEN_CONTENT_LITERALS = Object.freeze([
  '.local-game-derived',
  'EscapeFromTarkov_Data',
  'EscapeFromTarkov.exe',
  'Battlestate Games',
  'BsgLauncher',
  '.local-candidates',
]);

/** Absolute install paths: a drive letter or UNC prefix followed by the game. */
const GAME_DIRECTORY = String.raw`[Ee]scape[ _-]?[Ff]rom[ _-]?[Tt]arkov`;
const PATH_TAIL = String.raw`(?:[^\r\n"'<>|]{0,200}[\\/])?`;
// A single drive letter followed by one separator. The lookbehind and lookahead
// keep `https://escapefromtarkov.fandom.com/...` — a lawful reference URL the
// app legitimately ships — from reading as `s:/` + install path.
const DRIVE_ROOT = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])`;
const UNC_ROOT = String.raw`\\\\[^\r\n\\/"'<>|]{1,64}[\\/]`;

export const FORBIDDEN_CONTENT_PATTERNS = Object.freeze([
  new RegExp(String.raw`${DRIVE_ROOT}${PATH_TAIL}${GAME_DIRECTORY}`),
  new RegExp(String.raw`${DRIVE_ROOT}${PATH_TAIL}Battlestate`),
  new RegExp(String.raw`${UNC_ROOT}${PATH_TAIL}${GAME_DIRECTORY}`),
]);

const SHA256_HEX = /\b[0-9a-f]{64}\b/g;
// `pack-index.json` declares every asset's `sha256` (prefixed `sha256:…`, but
// `SHA256_HEX`'s `\b` boundary matches the same either way). `pack-index.receipt.json`
// additionally declares `catalogSha256` and `generationManifestSha256`. Scraping both
// catches a build artifact byte-identical to a *declared* hash even if the specific
// GLB were later deleted from the pack — the same belt-and-suspenders the terrain
// route already gets from `extraction-report.json`.
const HASH_MANIFEST_NAMES = Object.freeze([
  'manifest.json',
  'extraction-report.json',
  'pack-index.json',
  'pack-index.receipt.json',
  // Same belt-and-suspenders for the texture-array root: `veg-layers.json` declares each blob's
  // `sha256` per (lod, slot), and `veg-layers.receipt.json` additionally declares `packIndexSha256`
  // and its own `sha256`.
  'veg-layers.json',
  'veg-layers.receipt.json',
]);

class BuildBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BuildBoundaryError';
    this.code = code;
  }
}

function violation(check, file, detail) {
  return { check, file, detail };
}

/**
 * Depth-first list of every regular file under `dir`, as POSIX-ish relative paths, plus every
 * DIRECTORY, tagged `directory: true`.
 *
 * Directories are listed because an EMPTY one is a real finding this walk used to miss. A stale
 * `public/local-game-derived/` — the pre-migration location of the local terrain package, left
 * behind by the move documented in docs/LOCAL-THREE-POC.md — is copied into `dist/` by Vite like
 * everything else under `public/`, and carries zero bytes, so a file-only walk reported `pass:
 * true` on a build output that contained a directory named after the local root. Nothing leaked;
 * the trap is that it is inside the ONE directory Vite copies wholesale, so the day anything lands
 * in it, it ships. Naming the directory itself is what makes that a build failure instead of a
 * near miss.
 */
async function listFiles(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push({ relativePath, absolutePath, symlink: false, directory: true });
      files.push(...(await listFiles(absolutePath, relativePath) ?? []));
      continue;
    }
    if (entry.isSymbolicLink()) {
      // A symlink in build output is itself a leak channel: record it and do not
      // follow it.
      files.push({ relativePath, absolutePath, symlink: true });
      continue;
    }
    if (entry.isFile()) files.push({ relativePath, absolutePath, symlink: false });
  }
  return files;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build the set of hashes that must not appear in the build output: every
 * SHA-256 recorded by the local package manifests, plus the actual digest of
 * every file in the local root (which covers payloads the manifest does not
 * checksum, including the manifest itself).
 */
export async function collectLocalPackageHashes(localRoot) {
  const files = await listFiles(localRoot);
  if (files === null) return { present: false, hashes: new Map() };
  const hashes = new Map();
  for (const file of files) {
    if (file.symlink || file.directory) continue;
    let bytes;
    try {
      bytes = await readFile(file.absolutePath);
    } catch {
      continue;
    }
    hashes.set(sha256(bytes), `${file.relativePath} (file bytes)`);
    if (!HASH_MANIFEST_NAMES.includes(file.relativePath.split('/').pop())) continue;
    for (const match of bytes.toString('utf8').matchAll(SHA256_HEX)) {
      if (!hashes.has(match[0])) hashes.set(match[0], `${file.relativePath} (declared hash)`);
    }
  }
  return { present: true, hashes };
}

function pathViolations(file) {
  const found = [];
  const segments = file.relativePath.split('/');
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (FORBIDDEN_PATH_SEGMENTS.some((forbidden) => lower.includes(forbidden))) {
      found.push(violation('path', file.relativePath, `path segment "${segment}" is local-derived`));
    }
  }
  const name = segments[segments.length - 1].toLowerCase();
  if (FORBIDDEN_FILE_NAMES.includes(name)) {
    found.push(violation('name', file.relativePath, `"${name}" is a local extraction artifact`));
  }
  for (const suffix of FORBIDDEN_FILE_SUFFIXES) {
    if (name.endsWith(suffix)) {
      found.push(violation('name', file.relativePath, `"${suffix}" is a local extraction payload suffix`));
    }
  }
  if (file.symlink) {
    found.push(violation('name', file.relativePath, 'build output contains a symbolic link'));
  }
  return found;
}

/**
 * Scan raw bytes for install strings. Latin-1 keeps every byte addressable and
 * makes the scan encoding-stable; the NUL-stripped copy catches the UTF-16LE
 * strings that Unity-derived tooling emits.
 */
function contentViolations(file, bytes) {
  const found = [];
  const latin1 = bytes.toString('latin1');
  const wide = latin1.includes('\0') ? latin1.replaceAll('\0', '') : null;
  const haystacks = wide === null ? [latin1] : [latin1, wide];
  for (const literal of FORBIDDEN_CONTENT_LITERALS) {
    if (haystacks.some((haystack) => haystack.includes(literal))) {
      found.push(violation('content', file.relativePath, `embeds forbidden literal "${literal}"`));
    }
  }
  for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
    const match = haystacks.map((haystack) => pattern.exec(haystack)).find(Boolean);
    if (match) {
      found.push(violation('content', file.relativePath, `embeds absolute game-install path "${match[0]}"`));
    }
  }
  return found;
}

/**
 * Verify that `distDir` contains no local game-derived (or locally-authored,
 * unshipped) truth.
 *
 * Pure with respect to the filesystem: it only reads. Callers (including tests)
 * may point it at temporary fixture directories.
 *
 * Accepts either the legacy singular `localRoot` (normalized to a one-element
 * array, so every existing call site keeps working unchanged) or `localRoots`
 * (an array, for scanning more than one root at once). When neither is given,
 * defaults to `[DEFAULT_LOCAL_ROOT, DEFAULT_VEGETATION_ROOT, DEFAULT_VEGETATION_ARRAYTEX_ROOT]` —
 * the common case, since `npm run build` invokes this with no arguments and must keep
 * protecting all three roots.
 */
export async function verifyBuildBoundary({
  distDir = DEFAULT_DIST_DIR,
  localRoot,
  localRoots,
} = {}) {
  const dist = resolve(distDir);
  const rawRoots = Array.isArray(localRoots)
    ? localRoots
    : localRoot !== undefined
      ? [localRoot]
      : [DEFAULT_LOCAL_ROOT, DEFAULT_VEGETATION_ROOT, DEFAULT_VEGETATION_ARRAYTEX_ROOT];
  const locals = rawRoots.map((root) => resolve(root));

  for (const local of locals) {
    if (dist === local || local.startsWith(dist + sep) || dist.startsWith(local + sep)) {
      throw new BuildBoundaryError(
        'ERR_BUILD_BOUNDARY_ARGS',
        'the build output directory and a local root must not contain each other',
      );
    }
  }

  const entries = await listFiles(dist);
  if (entries === null) {
    throw new BuildBoundaryError(
      'ERR_BUILD_BOUNDARY_NO_DIST',
      `build output directory does not exist: ${dist}`,
    );
  }
  const files = entries.filter((entry) => !entry.directory);
  const directories = entries.filter((entry) => entry.directory);

  const localResults = await Promise.all(locals.map(async (local) => ({
    root: local,
    ...(await collectLocalPackageHashes(local)),
  })));
  const localPackagePresent = localResults.some((entry) => entry.present);
  // Union the per-root hash maps. When more than one root is in play, label
  // each source with the root it came from (relative to the repo) so a hash
  // violation's `detail` names which local root the matched file lives
  // under, not just its path within that root — first root wins a rare
  // cross-root digest collision, same "first writer wins" semantics
  // `collectLocalPackageHashes` already uses within one root.
  const hashes = new Map();
  for (const entry of localResults) {
    const label = locals.length > 1 ? `${relative(REPOSITORY_ROOT, entry.root)}/` : '';
    for (const [digest, source] of entry.hashes) {
      if (!hashes.has(digest)) hashes.set(digest, `${label}${source}`);
    }
  }

  const violations = [];
  let scannedBytes = 0;

  // Directories first: an EMPTY directory named after a local root carries no bytes and so is
  // invisible to every file-based check, but it sits inside the tree Vite copies wholesale.
  for (const directory of directories) {
    const segments = directory.relativePath.split('/');
    const name = segments[segments.length - 1].toLowerCase();
    if (FORBIDDEN_PATH_SEGMENTS.some((forbidden) => name.includes(forbidden))) {
      violations.push(violation(
        'path',
        `${directory.relativePath}/`,
        `build output contains a directory named after a local root ("${segments[segments.length - 1]}")`,
      ));
    }
  }

  for (const file of files) {
    violations.push(...pathViolations(file));
    if (file.symlink) continue;
    let bytes;
    try {
      bytes = await readFile(file.absolutePath);
    } catch (error) {
      violations.push(violation('read', file.relativePath, `unreadable build artifact: ${error?.code ?? error}`));
      continue;
    }
    scannedBytes += bytes.byteLength;
    violations.push(...contentViolations(file, bytes));
    const digest = sha256(bytes);
    const source = hashes.get(digest);
    if (source !== undefined) {
      violations.push(violation(
        'hash',
        file.relativePath,
        `sha256 ${digest} matches local package ${source}`,
      ));
    }
  }

  return {
    verifier: 'build-boundary',
    pass: violations.length === 0,
    distDir: dist,
    localRoot: locals[0],
    localRoots: locals,
    localPackagePresent,
    localPackageHashCount: hashes.size,
    fileCount: files.length,
    directoryCount: directories.length,
    scannedBytes,
    violations,
  };
}

/**
 * `--local-root PATH` is repeatable: pass it more than once to scan more than
 * one local root (collected into `localRoots`, in the order given). Omitting
 * it entirely leaves `localRoots` undefined, so `verifyBuildBoundary()` falls
 * through to its own default — `DEFAULT_LOCAL_ROOT`, `DEFAULT_VEGETATION_ROOT`,
 * and `DEFAULT_VEGETATION_ARRAYTEX_ROOT` — which is what keeps `npm run build`
 * (no arguments) protecting all three roots without any `package.json` change.
 */
function parseArguments(argv) {
  const options = { distDir: DEFAULT_DIST_DIR, localRoots: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument !== '--dist-dir' && argument !== '--local-root') {
      throw new BuildBoundaryError('ERR_BUILD_BOUNDARY_ARGS', `unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new BuildBoundaryError('ERR_BUILD_BOUNDARY_ARGS', `${argument} requires a path`);
    }
    const resolved = resolve(process.cwd(), value);
    if (argument === '--dist-dir') {
      options.distDir = resolved;
    } else {
      options.localRoots = [...(options.localRoots ?? []), resolved];
    }
    index += 1;
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${JSON.stringify({
      verifier: 'build-boundary',
      usage: 'node scripts/verify-build-boundary.mjs [--dist-dir PATH] [--local-root PATH ...repeatable]',
      defaultDistDir: relative(REPOSITORY_ROOT, DEFAULT_DIST_DIR),
      defaultLocalRoots: [DEFAULT_LOCAL_ROOT, DEFAULT_VEGETATION_ROOT, DEFAULT_VEGETATION_ARRAYTEX_ROOT]
        .map((root) => relative(REPOSITORY_ROOT, root)),
      writesFiles: false,
    }, null, 2)}\n`);
    return;
  }
  let report;
  try {
    report = await verifyBuildBoundary(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // Leave dist/ untouched on failure so the offending artifact can be inspected.
  process.exitCode = report.pass ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
