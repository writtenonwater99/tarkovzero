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

/** Path segments that may never appear anywhere inside the build output. */
export const FORBIDDEN_PATH_SEGMENTS = Object.freeze([
  '.local-game-derived',
  'local-game-derived',
  '@local-game-derived',
  'local_game_derived',
]);

/** File names that only a local extraction produces. */
export const FORBIDDEN_FILE_NAMES = Object.freeze(['extraction-report.json']);

/** File suffixes that only a local extraction produces. */
export const FORBIDDEN_FILE_SUFFIXES = Object.freeze(['.f32le']);

/**
 * Literals that only appear if an absolute game-install path, or the local
 * package root, was baked into an artifact. The dev-only fetch prefix
 * (`/@local-game-derived/`) is deliberately absent: it is a loopback-gated URL
 * constant in application source, not local truth, and it resolves to nothing
 * in production. The filesystem root name (`.local-game-derived`) IS listed,
 * because it can only appear if build tooling touched the local directory.
 */
export const FORBIDDEN_CONTENT_LITERALS = Object.freeze([
  '.local-game-derived',
  'EscapeFromTarkov_Data',
  'EscapeFromTarkov.exe',
  'Battlestate Games',
  'BsgLauncher',
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
const HASH_MANIFEST_NAMES = Object.freeze(['manifest.json', 'extraction-report.json']);

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

/** Depth-first list of every regular file under `dir`, as POSIX-ish relative paths. */
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
    if (file.symlink) continue;
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
 * Verify that `distDir` contains no local game-derived truth.
 *
 * Pure with respect to the filesystem: it only reads. Callers (including tests)
 * may point it at temporary fixture directories.
 */
export async function verifyBuildBoundary({
  distDir = DEFAULT_DIST_DIR,
  localRoot = DEFAULT_LOCAL_ROOT,
} = {}) {
  const dist = resolve(distDir);
  const local = resolve(localRoot);
  if (dist === local || local.startsWith(dist + sep) || dist.startsWith(local + sep)) {
    throw new BuildBoundaryError(
      'ERR_BUILD_BOUNDARY_ARGS',
      'the build output directory and the local game-derived root must not contain each other',
    );
  }

  const files = await listFiles(dist);
  if (files === null) {
    throw new BuildBoundaryError(
      'ERR_BUILD_BOUNDARY_NO_DIST',
      `build output directory does not exist: ${dist}`,
    );
  }

  const localPackage = await collectLocalPackageHashes(local);
  const violations = [];
  let scannedBytes = 0;

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
    const source = localPackage.hashes.get(digest);
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
    localRoot: local,
    localPackagePresent: localPackage.present,
    localPackageHashCount: localPackage.hashes.size,
    fileCount: files.length,
    scannedBytes,
    violations,
  };
}

function parseArguments(argv) {
  const options = { distDir: DEFAULT_DIST_DIR, localRoot: DEFAULT_LOCAL_ROOT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const key = argument === '--dist-dir' ? 'distDir' : argument === '--local-root' ? 'localRoot' : null;
    if (key === null) {
      throw new BuildBoundaryError('ERR_BUILD_BOUNDARY_ARGS', `unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new BuildBoundaryError('ERR_BUILD_BOUNDARY_ARGS', `${argument} requires a path`);
    }
    options[key] = resolve(process.cwd(), value);
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
      usage: 'node scripts/verify-build-boundary.mjs [--dist-dir PATH] [--local-root PATH]',
      defaultDistDir: relative(REPOSITORY_ROOT, DEFAULT_DIST_DIR),
      defaultLocalRoot: relative(REPOSITORY_ROOT, DEFAULT_LOCAL_ROOT),
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
