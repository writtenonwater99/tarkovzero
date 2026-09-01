// Guards against silent divergence between the two independent copies of the disproven
// nine-proxy industrial landmark mapping (featureId -> {family, variant}):
//
//   scripts/industrial-prop-asset-factory/build_proof.py       LANDMARK_MAPPING
//   scripts/customs-industrial-admission-plan.mjs               INDUSTRIAL_LANDMARK_MAPPING
//
// Today they agree by hand-maintenance only — nothing imports one from the other, and
// nothing previously compared them. When Phase 1 rewrites both from real extracted evidence,
// a partial edit (one file updated, the other forgotten) must fail loudly here instead of
// shipping a mismatch between the QA proof and the admission planner.
//
// This test does NOT execute Python and does NOT import build_proof.py (which is
// Blender-dependent). It parses both source files as text and compares the parsed data.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PY_PATH = new URL('./industrial-prop-asset-factory/build_proof.py', import.meta.url);
const JS_PATH = new URL('./customs-industrial-admission-plan.mjs', import.meta.url);

/**
 * Given source text and the index of an assignment's `=`, return the substring spanning the
 * first balanced `{ ... }` block starting at or after that index (brace-depth counting; the
 * mapping literals never contain a brace inside a quoted string, so this is exact here).
 */
function extractBracedBlock(source, fromIndex, label) {
  const openIndex = source.indexOf('{', fromIndex);
  if (openIndex === -1) {
    throw new Error(`${label}: could not find an opening '{' after the assignment`);
  }
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(openIndex, i + 1);
      }
    }
  }
  throw new Error(`${label}: brace block starting at index ${openIndex} never closed`);
}

/**
 * Parse `key: { family: ..., variant: ... }` (or `key: Object.freeze({ family: ..., variant:
 * ... })`) entries out of a braced block, quote style (single/double) and key-quoting
 * (Python always quotes `family`/`variant`, JS does not) agnostic.
 */
function parseEntries(block, label) {
  const entryRe =
    /(['"])((?:(?!\1)[\s\S])+?)\1\s*:\s*(?:Object\.freeze\(\s*)?\{\s*['"]?family['"]?\s*:\s*(['"])((?:(?!\3)[\s\S])+?)\3\s*,\s*['"]?variant['"]?\s*:\s*(['"])((?:(?!\5)[\s\S])+?)\5\s*\}\s*\)?/g;
  const entries = new Map();
  let match;
  let count = 0;
  while ((match = entryRe.exec(block)) !== null) {
    count++;
    const [, , key, , family, , variant] = match;
    if (entries.has(key)) {
      throw new Error(`${label}: duplicate key "${key}" parsed from source`);
    }
    entries.set(key, { family, variant });
  }
  if (count === 0) {
    throw new Error(`${label}: parsed zero entries — the entry regex no longer matches this file's literal syntax`);
  }
  return entries;
}

function parsePythonMapping(source) {
  const marker = 'LANDMARK_MAPPING = {';
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex !== -1, 'build_proof.py: could not find "LANDMARK_MAPPING = {"');
  const block = extractBracedBlock(source, markerIndex + marker.length - 1, 'build_proof.py LANDMARK_MAPPING');
  return parseEntries(block, 'build_proof.py LANDMARK_MAPPING');
}

function parseJsMapping(source) {
  const marker = 'INDUSTRIAL_LANDMARK_MAPPING = Object.freeze({';
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex !== -1, 'customs-industrial-admission-plan.mjs: could not find "INDUSTRIAL_LANDMARK_MAPPING = Object.freeze({"');
  const block = extractBracedBlock(source, markerIndex + marker.length - 1, 'customs-industrial-admission-plan.mjs INDUSTRIAL_LANDMARK_MAPPING');
  return parseEntries(block, 'customs-industrial-admission-plan.mjs INDUSTRIAL_LANDMARK_MAPPING');
}

/** Build an actionable, per-key diff between the two parsed mappings. Empty array = identical. */
function diffMappings(pyMap, jsMap) {
  const lines = [];
  const pyOnly = [...pyMap.keys()].filter((k) => !jsMap.has(k)).sort();
  const jsOnly = [...jsMap.keys()].filter((k) => !pyMap.has(k)).sort();
  for (const key of pyOnly) {
    lines.push(`"${key}" present in build_proof.py LANDMARK_MAPPING but MISSING from customs-industrial-admission-plan.mjs INDUSTRIAL_LANDMARK_MAPPING`);
  }
  for (const key of jsOnly) {
    lines.push(`"${key}" present in customs-industrial-admission-plan.mjs INDUSTRIAL_LANDMARK_MAPPING but MISSING from build_proof.py LANDMARK_MAPPING`);
  }
  const shared = [...pyMap.keys()].filter((k) => jsMap.has(k)).sort();
  for (const key of shared) {
    const py = pyMap.get(key);
    const js = jsMap.get(key);
    if (py.family !== js.family || py.variant !== js.variant) {
      lines.push(
        `"${key}" diverges: build_proof.py has {family: "${py.family}", variant: "${py.variant}"}, ` +
        `customs-industrial-admission-plan.mjs has {family: "${js.family}", variant: "${js.variant}"}`
      );
    }
  }
  return lines;
}

test('LANDMARK_MAPPING (build_proof.py) and INDUSTRIAL_LANDMARK_MAPPING (customs-industrial-admission-plan.mjs) describe the identical featureId -> {family, variant} mapping', async () => {
  const [pySource, jsSource] = await Promise.all([
    readFile(PY_PATH, 'utf8'),
    readFile(JS_PATH, 'utf8'),
  ]);

  const pyMap = parsePythonMapping(pySource);
  const jsMap = parseJsMapping(jsSource);

  const divergences = diffMappings(pyMap, jsMap);
  assert.deepEqual(
    divergences,
    [],
    `industrial landmark mapping divergence between the two independent literals:\n  ${divergences.join('\n  ')}`
  );

  // Sanity: both parses actually found the known nine-proxy set, not an empty/partial match.
  assert.equal(pyMap.size, 9, `expected build_proof.py LANDMARK_MAPPING to parse 9 entries, got ${pyMap.size}`);
  assert.equal(jsMap.size, 9, `expected customs-industrial-admission-plan.mjs INDUSTRIAL_LANDMARK_MAPPING to parse 9 entries, got ${jsMap.size}`);
});
