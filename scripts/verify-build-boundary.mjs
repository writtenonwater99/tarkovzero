#!/usr/bin/env node
//
// Deterministic build-boundary verifier — layer 4 of the four documented in `src/renderer-gate.js`.
//
// WHAT CHANGED, AND WHY IT IS NOT A RELAXATION
//
// This verifier used to enforce one rule: nothing from the local roots may reach `dist/`. The
// founder has ruled that the local packages hold no extracted game assets ("there are no real
// assets from the game in there. we took measurements and designed") and approved promoting
// specific AUTHORED OUTPUTS into `public/`, to ship the way `public/assets/3d/customs/authored/
// fortress/` already does. The rule is therefore now:
//
//   * nothing from the RAW CAPTURE roots may reach `dist/` — ever, by any route, listed or not;
//   * anything else from a local package may reach `dist/` only if it is named in
//     `asset-promotion-manifest.json` by a source key from the closed registry in
//     `scripts/lib/asset-promotion.mjs`, with a receipt whose declared hashes verify against
//     git-tracked provenance documents AND against the bytes actually in `dist/`.
//
// That is strictly MORE coverage than before, not less. `.local-candidates/survey-2026-09-01/`
// (the 65 in-game photographs) and the proof/probe packages were never under any scanned root:
// a photograph renamed into `dist/assets/` passed every check this file ran. It no longer does.
//
// Checks, each of which alone is enough to fail the build:
//
//   1. path/name  — no build output may live under, or be named after, a local root, and no local
//                   payload suffix (`.f32le`, `extraction-report.json`) may appear unless the
//                   promotion manifest admits that exact file at that exact path with that exact
//                   digest.
//   2. content    — no build output may embed an absolute EFT-install path or a local package root
//                   name, in UTF-8 or UTF-16LE. NEVER clearable by the manifest.
//   3. hash       — no build output may be byte-for-byte identical to a file a local package
//                   manifest accounts for, or to any build intermediate / QA artifact, unless the
//                   promotion manifest admits it (see above).
//   4. capture    — no build output may be byte-for-byte identical to, named like, or nested under
//                   a RAW CAPTURE. This check never consults the manifest, so a capture cannot be
//                   promoted even by someone who writes it into the allow-list.
//   5. promotion  — every entry in the promotion manifest must validate against the closed
//                   registry and its receipt must verify. A bad receipt fails the build whether or
//                   not the artifact it describes is in `dist/` at all.
//
// The verifier never deletes or rewrites `dist/`: a failure leaves the build tree in place for
// inspection and exits non-zero.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_FILE_NAME_PATTERNS,
  CAPTURE_PATH_SEGMENTS,
  CAPTURE_SUBTREES,
  INTERMEDIATE_SUBTREES,
  PROMOTABLE_SOURCES,
  PROMOTION_MANIFEST_PATH,
  REPOSITORY_ROOT as PROMOTION_REPOSITORY_ROOT,
  collectSubtreeHashes,
  readPromotionManifest,
  sha256File,
  validatePromotionManifest,
  verifyPromotionEntries,
} from './lib/asset-promotion.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');

export const DEFAULT_DIST_DIR = resolve(REPOSITORY_ROOT, 'dist');
export const DEFAULT_LOCAL_ROOT = resolve(REPOSITORY_ROOT, '.local-game-derived');
/**
 * Second local root: the independently-authored Customs vegetation pack
 * (docs/plans/VEGETATION-SERVING.md). It is original authored work, not
 * game-derived data — a different threat model from `DEFAULT_LOCAL_ROOT` —
 * but the one property that matters here (it must never reach `dist/`
 * unpromoted) is identical, so it is scanned by the same verifier, as a second
 * root, not folded into the first.
 */
export const DEFAULT_VEGETATION_ROOT = resolve(REPOSITORY_ROOT, '.local-candidates', 'vegetation-full-v2');
/**
 * Third local root: the offline-built vegetation texture-array set
 * (docs/plans/VEGETATION-DRAWCALLS.md, `scripts/vegetation-asset-factory/build_texture_arrays.py`) —
 * `veg-layers.json` plus the nine `veg-l{0,1,2}-{basecolor,orm,normal}.bin` blobs it declares. Same
 * threat model and same one property that matters as `DEFAULT_VEGETATION_ROOT`, so it is scanned by
 * the same verifier, as a third root.
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
 * package, so forbidding it outright is nearly free — and it is now
 * *clearable*, because the founder approved promoting the terrain height
 * surfaces, which carry exactly that suffix. Clearing still requires a manifest
 * entry naming that dist path with that digest and a receipt that verifies;
 * an unlisted `.f32le` in `dist/` fails exactly as it did before.
 *
 * `.glb` is not unique — `public/assets/3d/customs/authored/fortress/*.glb`
 * already ships to `dist/` legitimately, so a blanket suffix ban would fail
 * every production build on its own admitted assets. `.glb` protection for the
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
 *
 * A `content` violation is NEVER cleared by a promotion. A promoted artifact is
 * geometry or a surface map; if it embeds an install path, the thing to fix is
 * the artifact.
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

/** Only these two checks may ever be cleared by a verified promotion. */
const CLEARABLE_CHECKS = Object.freeze(new Set(['hash', 'name']));

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
 *
 * Payload digests are STREAMED (`sha256File`), never buffered: `.local-game-derived/unity-facts/
 * customs-unity-facts.json` is 460 MB on a drvfs mount and `readFile` allocated all of it. The
 * digests, and therefore this function's output, are identical either way. Only the small
 * manifest documents named by `HASH_MANIFEST_NAMES` are read into memory, because their TEXT has
 * to be scraped for declared hashes.
 */
export async function collectLocalPackageHashes(localRoot) {
  const files = await listFiles(localRoot);
  if (files === null) return { present: false, hashes: new Map() };
  const hashes = new Map();
  for (const file of files) {
    if (file.symlink || file.directory) continue;
    const isManifest = HASH_MANIFEST_NAMES.includes(file.relativePath.split('/').pop());
    let digest;
    let bytes = null;
    try {
      if (isManifest) {
        bytes = await readFile(file.absolutePath);
        digest = sha256(bytes);
      } else {
        digest = await sha256File(file.absolutePath);
      }
    } catch {
      continue;
    }
    hashes.set(digest, `${file.relativePath} (file bytes)`);
    if (!isManifest) continue;
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
    // A capture package's own directory name, reported under the non-clearable `capture` check.
    if (CAPTURE_PATH_SEGMENTS.some((forbidden) => lower.includes(forbidden))) {
      found.push(violation('capture', file.relativePath, `path segment "${segment}" names a raw capture package`));
    }
  }
  const name = segments[segments.length - 1].toLowerCase();
  const rawName = segments[segments.length - 1];
  if (FORBIDDEN_FILE_NAMES.includes(name)) {
    found.push(violation('name', file.relativePath, `"${name}" is a local extraction artifact`));
  }
  for (const suffix of FORBIDDEN_FILE_SUFFIXES) {
    if (name.endsWith(suffix)) {
      found.push(violation('name', file.relativePath, `"${suffix}" is a local extraction payload suffix`));
    }
  }
  for (const { pattern, detail } of CAPTURE_FILE_NAME_PATTERNS) {
    if (pattern.test(rawName)) {
      found.push(violation('capture', file.relativePath, `"${rawName}" ${detail}`));
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
 * unshipped) truth that the promotion manifest has not explicitly admitted, and
 * no raw capture under any circumstances.
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
 *
 * `repositoryRoot` anchors the capture subtrees, the intermediate subtrees, the promotion manifest
 * and every receipt's `repoPath`. It exists so a test can stand up a whole fixture repository in a
 * temp directory; production never passes it.
 */
export async function verifyBuildBoundary({
  distDir = DEFAULT_DIST_DIR,
  localRoot,
  localRoots,
  repositoryRoot = PROMOTION_REPOSITORY_ROOT,
  promotionManifestPath,
} = {}) {
  const dist = resolve(distDir);
  const repoRoot = resolve(repositoryRoot);
  const manifestPath = promotionManifestPath === undefined
    ? (repoRoot === PROMOTION_REPOSITORY_ROOT
      ? PROMOTION_MANIFEST_PATH
      : resolve(repoRoot, 'asset-promotion-manifest.json'))
    : resolve(promotionManifestPath);
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

  // --- the promotion manifest, part 1: parse and validate. Pure; no filesystem beyond the read.
  const manifestDocument = await readPromotionManifest(manifestPath);
  const manifestRelative = relative(repoRoot, manifestPath).split(sep).join('/');
  const violations = [];
  let promotionEntries = [];
  const manifestValid = manifestDocument.present && manifestDocument.parseError === null;
  if (manifestDocument.present && manifestDocument.parseError !== null) {
    violations.push(violation('promotion', manifestRelative, `is not valid JSON: ${manifestDocument.parseError}`));
  } else if (manifestDocument.present) {
    const validation = validatePromotionManifest(manifestDocument.value, { path: manifestRelative });
    for (const error of validation.errors) {
      violations.push(violation('promotion', error.path ?? manifestRelative, `${error.code}: ${error.message}`));
    }
    promotionEntries = validation.entries;
  }

  // Sizes. A build artifact can only be BYTE-IDENTICAL to a local file of the same length, so the
  // capture and intermediate sweeps hash only the files whose size some build artifact shares —
  // plus every size a promotion entry DECLARES, so that "this entry's approved digest is a
  // capture's digest" is answerable without reading the whole capture set. That is what makes it
  // affordable to cover 284 MB of screenshots and a 460 MB facts dump on every build: on a normal
  // build neither is read at all.
  const candidateSizes = new Set();
  for (const file of files) {
    try {
      candidateSizes.add((await stat(file.absolutePath)).size);
    } catch {
      // An unreadable artifact is reported by the read below; nothing to size-match against.
    }
  }
  for (const entry of promotionEntries) candidateSizes.add(entry.bytes);

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

  const captureIndex = await collectSubtreeHashes(CAPTURE_SUBTREES, {
    baseDir: repoRoot,
    candidateSizes,
  });
  const intermediateIndex = await collectSubtreeHashes(INTERMEDIATE_SUBTREES, {
    baseDir: repoRoot,
    candidateSizes,
  });
  // Intermediates join the ordinary hash sweep. They are not captures, so in principle a promotion
  // could clear one — but no registry key is rooted at an intermediate, so the only way that can
  // happen is if a promoted artifact is byte-identical to an intermediate copy of itself, which is
  // the correct outcome rather than a hole.
  for (const [digest, source] of intermediateIndex.hashes) {
    if (!hashes.has(digest)) hashes.set(digest, source);
  }

  // --- the promotion manifest, part 2: prove every receipt against disk -----------------------
  let promotionVerification = { verified: new Map(), errors: [], records: [] };
  if (manifestValid) {
    promotionVerification = await verifyPromotionEntries(promotionEntries, {
      repositoryRoot: repoRoot,
      captureHashes: captureIndex.hashes,
    });
    for (const error of promotionVerification.errors) {
      violations.push(violation('promotion', `${manifestRelative}#${error.path}`, `${error.code}: ${error.message}`));
    }
  }
  const verifiedPromotions = promotionVerification.verified;

  let scannedBytes = 0;
  const promotedFiles = [];

  // Directories first: an EMPTY directory named after a local root carries no bytes and so is
  // invisible to every file-based check, but it sits inside the tree Vite copies wholesale.
  for (const directory of directories) {
    const segments = directory.relativePath.split('/');
    const rawName = segments[segments.length - 1];
    const name = rawName.toLowerCase();
    if (FORBIDDEN_PATH_SEGMENTS.some((forbidden) => name.includes(forbidden))) {
      violations.push(violation(
        'path',
        `${directory.relativePath}/`,
        `build output contains a directory named after a local root ("${rawName}")`,
      ));
    }
    if (CAPTURE_PATH_SEGMENTS.some((forbidden) => name.includes(forbidden))) {
      violations.push(violation(
        'capture',
        `${directory.relativePath}/`,
        `build output contains a directory named after a raw capture package ("${rawName}")`,
      ));
    }
  }

  for (const file of files) {
    const found = pathViolations(file);
    if (file.symlink) {
      // A symlink is never read and therefore never has a digest to match a promotion against:
      // it can never be cleared, which is the intended answer.
      violations.push(...found);
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(file.absolutePath);
    } catch (error) {
      violations.push(violation('read', file.relativePath, `unreadable build artifact: ${error?.code ?? error}`));
      continue;
    }
    scannedBytes += bytes.byteLength;
    found.push(...contentViolations(file, bytes));
    const digest = sha256(bytes);

    // The capture check runs against its own index and does not see the promotion manifest at all.
    const captureSource = captureIndex.hashes.get(digest);
    if (captureSource !== undefined) {
      found.push(violation(
        'capture',
        file.relativePath,
        `sha256 ${digest} matches raw capture ${captureSource}; a capture is never promotable`,
      ));
    }
    const source = hashes.get(digest);
    if (source !== undefined) {
      found.push(violation(
        'hash',
        file.relativePath,
        `sha256 ${digest} matches local package ${source}`,
      ));
    }

    const promotion = verifiedPromotions.get(file.relativePath);
    const cleared = promotion !== undefined && promotion.sha256 === `sha256:${digest}`;
    if (!cleared) {
      violations.push(...found);
      if (promotion !== undefined) {
        violations.push(violation(
          'promotion',
          file.relativePath,
          `is admitted by promotion ${promotion.id} as ${promotion.sha256} but hashes to sha256:${digest}`,
        ));
      }
      continue;
    }
    promotedFiles.push({ file: file.relativePath, promotion: promotion.id, sha256: promotion.sha256 });
    // `path`, `content` and `read` findings survive a promotion. A promoted asset lives under
    // `public/assets/…`; if it also carries a local-root path segment or an install string, the
    // promotion is not what is wrong with it.
    violations.push(...found.filter((entry) => !CLEARABLE_CHECKS.has(entry.check)));
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
    promotion: {
      manifest: manifestRelative,
      manifestPresent: manifestDocument.present,
      entries: promotionEntries.length,
      verified: verifiedPromotions.size,
      appliedInDist: promotedFiles.length,
      promoted: promotedFiles,
      records: promotionVerification.records,
    },
    capture: {
      subtreesPresent: captureIndex.present,
      filesSeen: captureIndex.filesSeen,
      filesHashed: captureIndex.filesIndexed,
      bytesHashed: captureIndex.bytesRead,
    },
    intermediate: {
      subtreesPresent: intermediateIndex.present,
      filesSeen: intermediateIndex.filesSeen,
      filesHashed: intermediateIndex.filesIndexed,
      bytesHashed: intermediateIndex.bytesRead,
    },
  };
}

/**
 * `--local-root PATH` is repeatable: pass it more than once to scan more than
 * one local root (collected into `localRoots`, in the order given). Omitting
 * it entirely leaves `localRoots` undefined, so `verifyBuildBoundary()` falls
 * through to its own default — `DEFAULT_LOCAL_ROOT`, `DEFAULT_VEGETATION_ROOT`,
 * and `DEFAULT_VEGETATION_ARRAYTEX_ROOT` — which is what keeps `npm run build`
 * (no arguments) protecting all three roots without any `package.json` change.
 *
 * `--repository-root PATH` re-anchors the capture/intermediate registry and the promotion
 * manifest. It exists for fixture-driven tests; a build never passes it.
 */
function parseArguments(argv) {
  const options = {
    distDir: DEFAULT_DIST_DIR, localRoots: undefined, repositoryRoot: undefined, help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument !== '--dist-dir' && argument !== '--local-root' && argument !== '--repository-root') {
      throw new BuildBoundaryError('ERR_BUILD_BOUNDARY_ARGS', `unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new BuildBoundaryError('ERR_BUILD_BOUNDARY_ARGS', `${argument} requires a path`);
    }
    const resolved = resolve(process.cwd(), value);
    if (argument === '--dist-dir') {
      options.distDir = resolved;
    } else if (argument === '--repository-root') {
      options.repositoryRoot = resolved;
    } else {
      options.localRoots = [...(options.localRoots ?? []), resolved];
    }
    index += 1;
  }
  if (options.repositoryRoot === undefined) delete options.repositoryRoot;
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
      usage: 'node scripts/verify-build-boundary.mjs [--dist-dir PATH] [--local-root PATH ...repeatable]'
        + ' [--repository-root PATH]',
      defaultDistDir: relative(REPOSITORY_ROOT, DEFAULT_DIST_DIR),
      defaultLocalRoots: [DEFAULT_LOCAL_ROOT, DEFAULT_VEGETATION_ROOT, DEFAULT_VEGETATION_ARRAYTEX_ROOT]
        .map((root) => relative(REPOSITORY_ROOT, root)),
      promotionManifest: relative(REPOSITORY_ROOT, PROMOTION_MANIFEST_PATH),
      // `filePattern` marks a MIXED directory: only the files it names are captures, the rest of
      // that directory belongs to another tier. Printing it keeps `--help` from reading as though
      // `.local-game-derived/customs/` were a capture wholesale — it is not; its terrain height
      // and control surfaces are a promotable source.
      captureSubtrees: CAPTURE_SUBTREES.map((entry) => (entry.filePattern
        ? `${entry.path}/${entry.filePattern.source}`
        : entry.path)),
      intermediateSubtrees: INTERMEDIATE_SUBTREES.map((entry) => entry.path),
      promotableSources: Object.fromEntries(
        Object.entries(PROMOTABLE_SOURCES).map(([key, source]) => [key, {
          root: source.root,
          files: source.filePattern.source,
          receipt: source.receipt.documents.map((document) => `${document.role}=${document.repoPath}`),
        }]),
      ),
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
