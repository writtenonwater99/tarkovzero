#!/usr/bin/env node
// Khronos glTF Validator pass for every GLB in the offline vegetation pack.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import validator from 'gltf-validator';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--pack-root', '--output'].includes(flag) || !value || values.has(flag)) {
      fail('usage: validate_full_pack.mjs --pack-root DIR --output REPORT.json');
    }
    values.set(flag, value);
  }
  if (values.size !== 2) fail('both --pack-root and --output are required');
  return {
    packRoot: path.resolve(values.get('--pack-root')),
    output: path.resolve(values.get('--output')),
  };
}

async function regularFile(file, label) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a regular file: ${file}`);
  return stat;
}

async function discover(packRoot) {
  const assetsRoot = path.join(packRoot, 'assets');
  const prototypeDirs = (await fs.readdir(assetsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  if (prototypeDirs.length !== 31) fail(`expected 31 prototype directories, found ${prototypeDirs.length}`);
  const files = [];
  for (const prototype of prototypeDirs) {
    const directory = path.join(assetsRoot, prototype);
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name.endsWith('.glb'));
    if (entries.length !== 3) fail(`${prototype} must contain exactly three GLBs`);
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) fail(`${prototype}/${entry.name} is not a regular file`);
      files.push(path.join(directory, entry.name));
    }
  }
  files.sort();
  if (files.length !== 93) fail(`expected 93 GLBs, found ${files.length}`);
  return files;
}

async function validateOne(packRoot, file) {
  const stat = await regularFile(file, 'GLB');
  const relative = path.relative(packRoot, file).split(path.sep).join('/');
  const bytes = await fs.readFile(file);
  const report = await validator.validateBytes(new Uint8Array(bytes), {
    uri: relative,
    format: 'glb',
    writeTimestamp: false,
    maxIssues: 0,
  });
  const issues = report.issues ?? {};
  const counts = {
    errors: issues.numErrors ?? -1,
    warnings: issues.numWarnings ?? -1,
    infos: issues.numInfos ?? -1,
    hints: issues.numHints ?? -1,
  };
  if (Object.values(counts).some((value) => value !== 0)) {
    fail(`${relative} has Khronos issues: ${JSON.stringify({ counts, messages: issues.messages })}`);
  }
  return {
    file: relative,
    bytes: stat.size,
    issues: counts,
    generator: report.info?.generator ?? null,
    materials: report.info?.materialCount ?? null,
    drawCalls: report.info?.drawCallCount ?? null,
    vertices: report.info?.totalVertexCount ?? null,
    triangles: report.info?.totalTriangleCount ?? null,
    textures: report.info?.hasTextures ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootStat = await fs.lstat(args.packRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('--pack-root must be a regular directory');
  try {
    await fs.lstat(args.output);
    fail(`refusing to overwrite existing report: ${args.output}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  const files = await discover(args.packRoot);
  const records = [];
  // One process keeps the official validator WASM warm; sequential order makes
  // the report deterministic and avoids 93 expensive CLI startups.
  for (const file of files) {
    const record = await validateOne(args.packRoot, file);
    records.push(record);
    process.stdout.write(`Khronos pass ${record.file}\n`);
  }
  const document = {
    schemaVersion: 1,
    documentType: 'tarkovzero-customs-offline-vegetation-khronos-validation',
    status: 'pass-offline-only-not-live',
    validator: {
      package: 'gltf-validator',
      version: validator.version(),
      authority: 'Khronos Group glTF Validator',
      writeTimestamp: false,
    },
    counts: {
      glbs: records.length,
      errors: records.reduce((sum, value) => sum + value.issues.errors, 0),
      warnings: records.reduce((sum, value) => sum + value.issues.warnings, 0),
      infos: records.reduce((sum, value) => sum + value.issues.infos, 0),
      hints: records.reduce((sum, value) => sum + value.issues.hints, 0),
      bytes: records.reduce((sum, value) => sum + value.bytes, 0),
      triangles: records.reduce((sum, value) => sum + value.triangles, 0),
      vertices: records.reduce((sum, value) => sum + value.vertices, 0),
      drawCalls: records.reduce((sum, value) => sum + value.drawCalls, 0),
    },
    admission: {
      livePromotion: false,
      collision: false,
      geometryApproximation: true,
      note: 'Khronos conformance does not prove source-game geometry, visual fidelity, collision, or runtime performance.',
    },
    records,
  };
  await fs.writeFile(args.output, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ output: args.output, counts: document.counts }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`full-pack Khronos validation failed: ${error.message}\n`);
  process.exitCode = 1;
});
