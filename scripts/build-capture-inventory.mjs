#!/usr/bin/env node
//
// Regenerate `capture-digest-inventory.json` — the committed sha256 + size index of every raw
// capture, carrying NO payload.
//
// WHY. `scripts/verify-build-boundary.mjs`'s capture check compared `dist/` against an index built
// by walking `.local-game-derived/` and `.local-candidates/` on the build machine. Vercel builds
// from a clean checkout, where both roots are absent and git-ignored: the index came back empty,
// the comparison had nothing to compare against, and a raw capture renamed and committed under
// `public/assets/` shipped clean. This file's output is what the verifier loads instead, so the
// check has the same strength on a machine that has never seen a capture.
//
// USAGE
//   node scripts/build-capture-inventory.mjs           # write the inventory
//   node scripts/build-capture-inventory.mjs --check   # exit 1 if the file on disk is not what
//                                                      # this run would produce (CI-friendly)
//
// REPRODUCIBILITY. Subtrees in registry order, rows sorted by inventory path, two-space JSON, one
// trailing newline. Two runs over unchanged roots are byte-identical, so `--check` is a real
// staleness gate rather than a formatting argument.
//
// REDACTION. An EFT screenshot's NAME is a raid coordinate — the game writes world position and
// camera quaternion into it — and `.gitignore` already refuses `companion/survey-*.jsonl` on that
// ground. Those rows carry a digest stem instead of the real name. The digest, the size and the
// subtree are all the verifier ever needed; the name was only ever diagnostic.
//
// This script reads. It never writes to, moves, or deletes anything under a capture root.

import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_INVENTORY_PATH,
  CAPTURE_SUBTREES,
  REPOSITORY_ROOT,
  buildCaptureInventory,
  serializeCaptureInventory,
  validateCaptureInventory,
} from './lib/asset-promotion.mjs';

async function main(argv) {
  const check = argv.includes('--check');
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`unsupported argument(s): ${unknown.join(', ')}\n`);
    process.exitCode = 2;
    return;
  }

  const { document, missing } = await buildCaptureInventory({ baseDir: REPOSITORY_ROOT });

  // A subtree that is not on this machine cannot be inventoried FROM this machine. Writing a zero
  // row for it would quietly delete real digests from the index, so the generator refuses instead:
  // regenerate on the machine that holds the captures.
  if (missing.length > 0) {
    process.stderr.write(
      `cannot build the capture inventory: ${missing.length} of ${CAPTURE_SUBTREES.length} capture `
      + `subtree(s) are not on this machine (${missing.join(', ')}). Run this on the machine that `
      + 'holds the local packages; the committed inventory is the record for every machine that '
      + 'does not.\n',
    );
    process.exitCode = 2;
    return;
  }

  const validation = validateCaptureInventory(document, {
    path: relative(REPOSITORY_ROOT, CAPTURE_INVENTORY_PATH),
  });
  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      process.stderr.write(`${error.path}: ${error.message}\n`);
    }
    process.exitCode = 2;
    return;
  }

  const serialized = serializeCaptureInventory(document);
  if (check) {
    let current = null;
    try {
      current = await readFile(CAPTURE_INVENTORY_PATH, 'utf8');
    } catch (error) {
      process.stderr.write(`capture-digest-inventory.json is unreadable (${error?.code ?? error})\n`);
      process.exitCode = 1;
      return;
    }
    if (current !== serialized) {
      process.stderr.write(
        'capture-digest-inventory.json is stale: regenerate it with '
        + '`npm run build:capture-inventory` and commit the result.\n',
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({
      inventory: 'capture-digest-inventory',
      upToDate: true,
      captures: document.captures.length,
      subtrees: document.subtrees.map((entry) => `${entry.id}=${entry.fileCount}`),
    }, null, 2)}\n`);
    return;
  }

  await writeFile(CAPTURE_INVENTORY_PATH, serialized);
  process.stdout.write(`${JSON.stringify({
    inventory: 'capture-digest-inventory',
    wrote: relative(REPOSITORY_ROOT, CAPTURE_INVENTORY_PATH),
    captures: document.captures.length,
    bytesIndexed: document.subtrees.reduce((sum, entry) => sum + entry.totalBytes, 0),
    redacted: document.captures.filter((row) => row.nameRedacted === true).length,
    subtrees: document.subtrees.map((entry) => `${entry.id}=${entry.fileCount}`),
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
