#!/usr/bin/env node
// Copy Three's pinned Basis Universal transcoder into the public localhost asset tree.
// KTX2Loader cannot consume node_modules URLs in a browser; this makes compressed authored
// textures deterministic and offline without checking an opaque CDN dependency into the app.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const threeEntry = fileURLToPath(import.meta.resolve('three'));
const threeRoot = path.resolve(path.dirname(threeEntry), '..');
const sourceRoot = path.join(threeRoot, 'examples/jsm/libs/basis');
const destination = path.join(ROOT, 'public/assets/3d/vendor/basis');
// README.md carries the upstream source and Apache-2.0 attribution beside the runtime files.
const names = ['basis_transcoder.js', 'basis_transcoder.wasm', 'README.md'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

await mkdir(destination, { recursive: true });
const files = [];
for (const name of names) {
  const source = path.join(sourceRoot, name);
  const target = path.join(destination, name);
  await copyFile(source, target);
  const bytes = await readFile(target);
  files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
}
await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  package: 'three',
  version: '0.185.1',
  upstreamPath: 'examples/jsm/libs/basis',
  files,
}, null, 2)}\n`);
console.log(`prepared ${files.length} Basis files in ${path.relative(ROOT, destination)}`);
