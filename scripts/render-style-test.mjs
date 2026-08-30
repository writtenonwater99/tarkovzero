#!/usr/bin/env node
// Unit tests for the render-style contract (src/render-style.js).
// Run: npm run test:render-style   (node --test, no test framework dependency)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKGROUND,
  FOG,
  FOG_MIN_START_M,
  FOG_START_FRACTION,
  FOG_TARGET_AT,
  KEY_AZIMUTH_DEG,
  KEY_ELEVATION_DEG,
  LIGHT,
  MATERIALS,
  MATERIAL_IDS,
  PALETTE,
  POST,
  STYLE_MODES,
  fogDensity,
  fogFor,
  isHexColor,
  keyDirection,
  materialFor,
  rgb255,
  styleFor,
} from '../src/render-style.js';

// Playable-map diagonals measured from public/data/<map>-3d.json `limit`
// bounding boxes on 2026-08-29 (metres, canonical 1x scale).
const MAP_DIAGONALS = {
  customs: 1193.0,
  reserve: 823.9,
  woods: 1962.6,
  // Synthetic: large enough that 0.12D beats the 250 m floor, so the max()
  // branch of the plan's formula is actually exercised.
  synthetic_large: 4000,
};

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
test('both style modes exist and resolve', () => {
  assert.deepEqual([...STYLE_MODES], ['realistic', 'vector']);
  for (const mode of STYLE_MODES) {
    const style = styleFor(mode);
    assert.equal(style.mode, mode);
    assert.equal(style.variant, mode === 'realistic' ? 'real' : 'vector');
    assert.ok(style.materialIds.length > 0);
  }
});

test('styleFor is pure and returns deeply frozen data', () => {
  for (const mode of STYLE_MODES) {
    const a = styleFor(mode);
    const b = styleFor(mode);
    assert.equal(a, b, 'same mode must return the same frozen object');
    assert.ok(Object.isFrozen(a));
    assert.ok(Object.isFrozen(a.materials));
    assert.ok(Object.isFrozen(a.materials[a.materialIds[0]]));
    assert.throws(() => { a.mode = 'nope'; }, TypeError);
  }
});

test('styleFor rejects unknown modes', () => {
  for (const bad of ['REALISTIC', 'realist', '', null, undefined, 3]) {
    assert.throws(() => styleFor(bad), /unknown mode/);
  }
});

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
test('every material declares both a real and a vector variant', () => {
  assert.ok(MATERIAL_IDS.length >= 20, `expected a populated material table, got ${MATERIAL_IDS.length}`);
  for (const id of MATERIAL_IDS) {
    const m = MATERIALS[id];
    assert.ok(m.real && typeof m.real === 'object', `${id} is missing its real variant`);
    assert.ok(m.vector && typeof m.vector === 'object', `${id} is missing its vector variant`);
    assert.equal(typeof m.group, 'string');
    assert.ok(m.label.length > 0, `${id} needs a human label`);
  }
});

test('every material resolves in both modes with the same id set', () => {
  const realIds = styleFor('realistic').materialIds;
  const vectorIds = styleFor('vector').materialIds;
  assert.deepEqual(realIds, MATERIAL_IDS);
  assert.deepEqual(vectorIds, MATERIAL_IDS);
  for (const id of MATERIAL_IDS) {
    assert.ok(materialFor('realistic', id), `${id} missing in realistic`);
    assert.ok(materialFor('vector', id), `${id} missing in vector`);
  }
});

test('material real-variant numerics stay inside their contract ranges', () => {
  for (const id of MATERIAL_IDS) {
    const r = MATERIALS[id].real;
    for (const key of ['roughnessFactor', 'metallicFactor', 'wetness', 'macroVariation', 'contactAO', 'alphaCutoff']) {
      assert.ok(r[key] >= 0 && r[key] <= 1, `${id}.${key} = ${r[key]} outside 0..1`);
    }
    assert.ok(r.normalScale >= 0 && r.normalScale <= 2, `${id}.normalScale = ${r.normalScale}`);
    assert.ok(Array.isArray(r.uvMeters) && r.uvMeters.length === 2, `${id}.uvMeters must be [u, v] metres`);
    assert.ok(r.uvMeters.every((v) => v > 0), `${id}.uvMeters must be positive`);
    assert.ok(['opaque', 'mask', 'blend'].includes(r.alphaMode), `${id}.alphaMode = ${r.alphaMode}`);
    const v = MATERIALS[id].vector;
    assert.ok(v.outlineWidthPx > 0 && v.outlineWidthPx <= 2, `${id}.outlineWidthPx = ${v.outlineWidthPx}`);
    assert.ok(v.opacity > 0 && v.opacity <= 1, `${id}.opacity = ${v.opacity}`);
  }
});

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------
test('isHexColor accepts only lowercase #rrggbb', () => {
  assert.ok(isHexColor('#a6aeac'));
  for (const bad of ['#A6AEAC', '#fff', 'a6aeac', '#a6aeacff', 'rgb(1,2,3)', '', null, 0x123456]) {
    assert.equal(isHexColor(bad), false, `${String(bad)} should be rejected`);
  }
});

test('every authored colour is a valid hex string', () => {
  for (const [key, value] of Object.entries(PALETTE)) {
    assert.ok(isHexColor(value), `PALETTE.${key} = ${value}`);
  }
  for (const id of MATERIAL_IDS) {
    const { real, vector } = MATERIALS[id];
    assert.ok(isHexColor(real.baseColor), `${id}.real.baseColor = ${real.baseColor}`);
    assert.ok(isHexColor(vector.fill), `${id}.vector.fill = ${vector.fill}`);
    assert.ok(isHexColor(vector.outline), `${id}.vector.outline = ${vector.outline}`);
  }
  for (const mode of STYLE_MODES) {
    for (const key of ['ambientColor', 'keyColor', 'fillColor']) {
      assert.ok(isHexColor(LIGHT[mode][key]), `LIGHT.${mode}.${key}`);
    }
    for (const key of ['zenith', 'horizon', 'ground']) {
      assert.ok(isHexColor(BACKGROUND[mode][key]), `BACKGROUND.${mode}.${key}`);
    }
    assert.ok(isHexColor(FOG[mode].color), `FOG.${mode}.color`);
  }
});

test('rgb255 converts hex to 0..255 triples', () => {
  assert.deepEqual(rgb255('#000000'), [0, 0, 0]);
  assert.deepEqual(rgb255('#ffffff'), [255, 255, 255]);
  assert.deepEqual(rgb255(PALETTE.skyFar), [0xa6, 0xae, 0xac]);
  assert.throws(() => rgb255('#GGGGGG'), /invalid hex/);
});

// ---------------------------------------------------------------------------
// Fog — RENDER-REALISM.md Part C
// "start near max(250 m, 0.12D), reach approximately 65-75% by 0.65D,
//  and add a mild near-ground height term"
// ---------------------------------------------------------------------------
test('fog start follows max(250 m, 0.12 * diagonal)', () => {
  for (const [map, D] of Object.entries(MAP_DIAGONALS)) {
    const p = fogFor('realistic', D);
    const expected = Math.max(FOG_MIN_START_M, FOG_START_FRACTION * D);
    assert.equal(p.startMeters, expected, `${map}: start ${p.startMeters} != ${expected}`);
    assert.equal(p.targetMeters, FOG_TARGET_AT * D, `${map}: target distance`);
  }
  // The floor binds on all three real maps; the synthetic case must not.
  assert.equal(fogFor('realistic', MAP_DIAGONALS.customs).startMeters, 250);
  assert.equal(fogFor('realistic', MAP_DIAGONALS.woods).startMeters, 250);
  assert.equal(fogFor('realistic', MAP_DIAGONALS.synthetic_large).startMeters, 480);
});

test('fog reaches 65-75% density at 0.65 * diagonal on every map', () => {
  for (const [map, D] of Object.entries(MAP_DIAGONALS)) {
    const d = fogDensity('realistic', D, FOG_TARGET_AT * D);
    assert.ok(d >= 0.65 && d <= 0.75, `${map}: density ${d.toFixed(4)} outside the plan's 65-75% band`);
    assert.ok(Math.abs(d - 0.7) < 1e-9, `${map}: density ${d} should hit the pinned 0.70 target exactly`);
  }
});

test('fog is clear before its start distance and monotonic after it', () => {
  const D = MAP_DIAGONALS.woods;
  const start = fogFor('realistic', D).startMeters;
  assert.equal(fogDensity('realistic', D, 0), 0);
  assert.equal(fogDensity('realistic', D, start), 0);
  assert.equal(fogDensity('realistic', D, start - 1), 0);
  let prev = 0;
  for (let d = start; d <= D; d += 25) {
    const v = fogDensity('realistic', D, d);
    assert.ok(v >= prev, `density fell from ${prev} to ${v} at ${d} m`);
    assert.ok(v <= FOG.realistic.maxDensity + 1e-12, `density ${v} exceeded maxDensity`);
    prev = v;
  }
});

test('the height term thins fog above the ground', () => {
  const D = MAP_DIAGONALS.customs;
  const d = FOG_TARGET_AT * D;
  const ground = fogDensity('realistic', D, d, 0);
  const mid = fogDensity('realistic', D, d, 60);
  const high = fogDensity('realistic', D, d, 400);
  assert.ok(mid < ground, 'fog must thin with height');
  assert.ok(high < mid, 'fog must keep thinning with height');
  assert.equal(fogDensity('realistic', D, d, -50), ground, 'below ground clamps to the ground value');
});

test('vector mode fog is off and never darkens the diagram', () => {
  for (const D of Object.values(MAP_DIAGONALS)) {
    assert.equal(FOG.vector.enabled, false);
    assert.equal(fogDensity('vector', D, D), 0);
  }
});

test('fogFor rejects a nonsensical diagonal', () => {
  for (const bad of [0, -1, NaN, Infinity, null, 'big']) {
    assert.throws(() => fogFor('realistic', bad), /positive number/);
  }
});

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------
test('the key light is pinned inside the plan\'s azimuth/elevation window', () => {
  assert.ok(KEY_AZIMUTH_DEG >= 220 && KEY_AZIMUTH_DEG <= 240);
  assert.ok(KEY_ELEVATION_DEG >= 18 && KEY_ELEVATION_DEG <= 24);
  for (const mode of STYLE_MODES) {
    const dir = LIGHT[mode].keyDirection;
    assert.equal(dir.length, 3);
    assert.ok(Math.abs(Math.hypot(...dir) - 1) < 1e-12, 'key direction must be a unit vector');
    assert.ok(dir[1] < 0, 'a key light above the horizon travels downward');
  }
});

test('keyDirection matches the documented azimuth convention', () => {
  // Azimuth 0 = +Z, clockwise toward +X; elevation 0 = horizontal.
  const north = keyDirection(0, 0);
  assert.ok(Math.abs(north[0] - 0) < 1e-12 && Math.abs(north[2] - -1) < 1e-12);
  const east = keyDirection(90, 0);
  assert.ok(Math.abs(east[0] - -1) < 1e-12 && Math.abs(east[2] - 0) < 1e-12);
  const overhead = keyDirection(0, 90);
  assert.ok(Math.abs(overhead[1] - -1) < 1e-12);
});

// ---------------------------------------------------------------------------
// The realistic <-> vector parameter flip (Part C's table)
// ---------------------------------------------------------------------------
test('vector mode disables every texture and surface-response parameter', () => {
  const vector = styleFor('vector');
  for (const id of vector.materialIds) {
    const m = vector.materials[id];
    assert.equal(m.baseColorTexture, null, `${id} must not sample a base colour texture in vector mode`);
    assert.equal(m.normalTexture, null, `${id} normal texture`);
    assert.equal(m.ormTexture, null, `${id} ORM texture`);
    assert.equal(m.normalScale, 0, `${id} normalScale`);
    assert.equal(m.roughnessFactor, 0, `${id} roughnessFactor`);
    assert.equal(m.metallicFactor, 0, `${id} metallicFactor`);
    assert.equal(m.wetness, 0, `${id} wetness`);
    assert.equal(m.macroVariation, 0, `${id} macroVariation`);
    assert.ok(isHexColor(m.fill), `${id} needs a flat semantic fill`);
  }
  assert.equal(vector.flags.geometryOutlines, true);
  assert.equal(vector.flags.imageBasedLighting, false);
  assert.equal(vector.post.enabled, false);
  assert.equal(vector.background.kind, 'flat');
});

test('the vector flip is material-only: the silhouette is invariant', () => {
  // RENDER-REALISM.md:352 — "skin changes material/style state only. Geometry
  // buffers ... are invariant", and the foliage row is "flat species colors;
  // same instance/LOD transforms". An alpha-masked leaf card that loses its
  // cutout draws as a solid opaque quad, which is a silhouette change.
  const real = styleFor('realistic');
  const vector = styleFor('vector');
  let masked = 0;
  for (const id of MATERIAL_IDS) {
    const r = real.materials[id];
    const v = vector.materials[id];
    assert.equal(v.alphaMode, r.alphaMode, `${id} alphaMode must survive the flip`);
    assert.equal(v.alphaCutoff, r.alphaCutoff, `${id} alphaCutoff must survive the flip`);
    assert.ok(['opaque', 'mask', 'blend'].includes(v.alphaMode), `${id}.vector.alphaMode = ${v.alphaMode}`);
    if (r.alphaMode === 'mask') masked++;
  }
  assert.ok(masked >= 3, `expected the alpha-masked foliage set, got ${masked} masked materials`);
  for (const id of ['foliage-conifer', 'foliage-broadleaf', 'foliage-shrub']) {
    assert.equal(vector.materials[id].alphaMode, 'mask', `${id} must stay cut out in vector mode`);
  }
});

test('vector materials declare every key a consumer reads, never undefined', () => {
  const vector = styleFor('vector');
  for (const id of MATERIAL_IDS) {
    const m = vector.materials[id];
    for (const key of ['alphaMode', 'alphaCutoff', 'fog', 'castShadow', 'receiveShadow', 'contactAO', 'opacity', 'outlineWidthPx']) {
      assert.notEqual(m[key], undefined, `${id}.${key} is undefined in vector mode`);
    }
    // Vector mode is unlit and unfogged; these are false, not merely absent.
    assert.equal(m.fog, false, `${id} fog`);
    assert.equal(m.castShadow, false, `${id} castShadow`);
    assert.equal(m.receiveShadow, false, `${id} receiveShadow`);
    assert.equal(m.contactAO, 0, `${id} contactAO`);
  }
});

test('contours and hypsometry survive as vector parameters', () => {
  // Plan, Top-look decision 1: "no contours or strong hypsometry in realistic
  // mode; preserve them as optional vector parameters."
  const vector = styleFor('vector');
  assert.equal(vector.flags.contours, true);
  assert.equal(vector.flags.hypsometry, true, 'the vector skin must keep hypsometric banding available');
});

test('realistic mode drops the diagram signals Stage 1 exists to remove', () => {
  const real = styleFor('realistic');
  assert.equal(real.flags.contours, false, 'realistic mode must not draw contours');
  assert.equal(real.flags.hypsometry, false, 'realistic mode must not band elevation by hue');
  assert.equal(real.flags.geometryOutlines, false);
  assert.equal(real.fog.enabled, true);
  assert.equal(real.background.kind, 'gradient');
  assert.equal(real.post.enabled, true);
  assert.equal(POST.realistic.lutAsset, 'overcast-grade-lut');
  assert.equal(BACKGROUND.realistic.environmentAsset, 'autumn-crossing-sky');
});

test('the Stage 1 ground detail set is wired to the shipped material assets', () => {
  const ground = MATERIALS['terrain-grass'].real;
  assert.equal(ground.baseColorTexture, 'ground106-albedo');
  assert.equal(ground.normalTexture, 'ground106-normal');
  assert.equal(ground.ormTexture, 'ground106-orm');
});
