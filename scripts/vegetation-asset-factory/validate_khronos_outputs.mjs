#!/usr/bin/env node
// Official Khronos validation for a bounded list of offline proof GLBs.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import validator from 'gltf-validator';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  let output = null;
  const glbs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--output' && value && output === null) {
      output = path.resolve(value);
      index += 1;
    } else if (flag === '--glb' && value) {
      glbs.push(path.resolve(value));
      index += 1;
    } else {
      fail('usage: validate_khronos_outputs.mjs --output REPORT.json --glb FILE.glb [--glb FILE.glb ...]');
    }
  }
  if (output === null || glbs.length < 1 || glbs.length > 32 || new Set(glbs).size !== glbs.length) {
    fail('one new output and 1..32 unique GLBs are required');
  }
  return { output, glbs: glbs.sort() };
}

async function requireRegular(file, label) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${file}`);
  return stat;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    await fs.lstat(args.output);
    fail(`refusing to overwrite existing report: ${args.output}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const records = [];
  for (const file of args.glbs) {
    if (path.extname(file).toLowerCase() !== '.glb') fail(`input is not GLB: ${file}`);
    const stat = await requireRegular(file, 'GLB');
    const bytes = await fs.readFile(file);
    const report = await validator.validateBytes(new Uint8Array(bytes), {
      uri: path.basename(file),
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
      fail(`${path.basename(file)} has Khronos issues: ${JSON.stringify({ counts, messages: issues.messages })}`);
    }
    records.push({
      file,
      bytes: stat.size,
      issues: counts,
      generator: report.info?.generator ?? null,
      materials: report.info?.materialCount ?? null,
      drawCalls: report.info?.drawCallCount ?? null,
      vertices: report.info?.totalVertexCount ?? null,
      triangles: report.info?.totalTriangleCount ?? null,
      textures: report.info?.hasTextures ?? null,
    });
  }
  const totals = {
    glbs: records.length,
    errors: records.reduce((sum, value) => sum + value.issues.errors, 0),
    warnings: records.reduce((sum, value) => sum + value.issues.warnings, 0),
    infos: records.reduce((sum, value) => sum + value.issues.infos, 0),
    hints: records.reduce((sum, value) => sum + value.issues.hints, 0),
    bytes: records.reduce((sum, value) => sum + value.bytes, 0),
    triangles: records.reduce((sum, value) => sum + value.triangles, 0),
    vertices: records.reduce((sum, value) => sum + value.vertices, 0),
    drawCalls: records.reduce((sum, value) => sum + value.drawCalls, 0),
  };
  const document = {
    schemaVersion: 1,
    documentType: 'tarkovzero-customs-offline-vegetation-proof-khronos-validation',
    status: 'pass-offline-only-not-live',
    validator: {
      package: 'gltf-validator',
      version: validator.version(),
      authority: 'Khronos Group glTF Validator',
      writeTimestamp: false,
    },
    counts: totals,
    records,
    admission: {
      livePromotion: false,
      collision: false,
      geometryApproximation: true,
      note: 'Conformance does not prove pine visual fidelity, alpha minification, runtime cost, or source-game equivalence.',
    },
  };
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ output: args.output, counts: totals }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`proof Khronos validation failed: ${error.message}\n`);
  process.exitCode = 1;
});
