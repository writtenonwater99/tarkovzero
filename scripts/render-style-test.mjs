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
  // R1.5
  BACKDROP,
  FOG_COOL_AMOUNT,
  FOG_COOL_TINT,
  FOG_DESATURATION,
  FOLIAGE_VARIATION,
  ROAD_RIM,
  SHADOW,
  SPECULAR,
  TERRAIN_MACRO,
  WATER,
  buildingMaterialId,
  roofMaterialId,
  specularFamilyFor,
  specularFor,
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

test('the authored palette matches the plan, value by value', () => {
  // RENDER-REALISM.md Part C pins the art direction as exact hexes. This module
  // is the reviewable source of truth for them, so "is a valid hex string" is
  // not the assertion that matters — drift from the plan is.
  assert.deepEqual({ ...PALETTE }, {
    skyFar: '#a6aeac',
    fogFar: '#979f9b',
    grass: '#586149',
    grassWet: '#46513f',
    forestLitter: '#615445',
    dirt: '#685a49',
    dirtWet: '#49433a',
    asphalt: '#4a4e4d',
    asphaltWet: '#33393a',
    concrete: '#7a7970',
    brick: '#745148',
    metalPaint: '#6d7573',
    metalRust: '#7c4a32',
    conifer: '#39483b',
    broadleafLight: '#596047',
    broadleafDark: '#756247',
    waterShallow: '#52635d',
    waterDeep: '#344a4c',
    vectorBackground: '#e9eae6',
    vectorInk: '#2d3130',
  });
});

test('the pinned post and background numerics do not drift', () => {
  // fxaa false in BOTH looks: the grade pass is full-screen, so a neighbourhood blend lands on the
  // SDF label/icon/quest/live layers the plan requires to stay crisp. See the note above POST.
  assert.deepEqual({ ...POST.realistic }, {
    enabled: true, lutAsset: 'overcast-grade-lut', vignette: 0.16, grain: 0.012, fxaa: false,
  });
  assert.deepEqual({ ...POST.vector }, {
    enabled: false, lutAsset: null, vignette: 0, grain: 0, fxaa: false,
  });
  assert.deepEqual({ ...BACKGROUND.realistic }, {
    kind: 'gradient', zenith: '#9aa4a6', horizon: PALETTE.skyFar, ground: '#7d817b',
    environmentAsset: 'autumn-crossing-sky',
  });
  // The grade LUT is generated from these two exact colours by
  // scripts/prepare-render-assets.mjs; changing either changes a shipped asset.
  assert.equal(LIGHT.realistic.keyColor, '#c8c2b2');
  assert.equal(FOG.realistic.color, PALETTE.fogFar);
  assert.equal(LIGHT.realistic.ambientColor, '#a8b0ae');
  assert.equal(LIGHT.realistic.fillColor, '#8f9aa0');
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

// ---------------------------------------------------------------------------
// R1.5 — materials and atmosphere polish
// ---------------------------------------------------------------------------
test('every specular lobe is BROAD and sky-coloured, and vector has none', () => {
  const sky = rgb255(SPECULAR.realistic.skyColor);
  const families = Object.keys(SPECULAR.realistic.families);
  assert.ok(families.length >= 8, `expected a populated specular table, got ${families.length}`);
  for (const family of families) {
    const { shininess, specularColor } = specularFor('realistic', family);
    // A single directional key stands in for the whole sky dome here, so the lobe has to be as
    // wide as the dome. At a point-light exponent (~100) the wettest road in the contract returns
    // 0.02% of the sky under the fixed 21-degree key — i.e. nothing reaches the screen.
    assert.ok(shininess >= 1 && shininess <= 32, `${family}: exponent ${shininess} is a point-light lobe, not a sky dome`);
    // The lobe reflects the SKY, never a neutral grey: every channel is that fraction of skyFar.
    const k = SPECULAR.realistic.families[family].strength;
    for (let i = 0; i < 3; i++) assert.equal(specularColor[i], Math.round(sky[i] * k), `${family} channel ${i}`);
    // Vector is unlit by contract.
    const v = specularFor('vector', family);
    assert.deepEqual(v.specularColor, [0, 0, 0], `${family} must not reflect anything in vector mode`);
  }
  // Rough surfaces get a WIDER lobe than smooth ones, and a weaker one.
  assert.ok(specularFor('realistic', 'ground').shininess < specularFor('realistic', 'water').shininess);
  assert.ok(SPECULAR.realistic.families.ground.strength < SPECULAR.realistic.families.road.strength);
  assert.ok(SPECULAR.realistic.families.building.strength < SPECULAR.realistic.families.roof.strength);
  // An unknown family is a dead lobe, never a guess.
  assert.deepEqual(specularFor('realistic', 'nope'), { shininess: 1, specularColor: [0, 0, 0] });
});

test('water is depth-ordered, translucent at the bank, and reflects the sky', () => {
  assert.equal(WATER.shallow, PALETTE.waterShallow);
  assert.equal(WATER.deep, PALETTE.waterDeep);
  assert.equal(WATER.sky, PALETTE.skyFar);
  // Deep really is deeper: the blue-grey stop is darker than the tea/olive one.
  const luma = (hex) => { const [r, g, b] = rgb255(hex); return 0.299 * r + 0.587 * g + 0.114 * b; };
  assert.ok(luma(WATER.deep) < luma(WATER.shallow), 'the deep stop must be darker than the shallow one');
  assert.ok(WATER.depthMaxMeters > 0 && WATER.shallowAt < WATER.deepAt);
  // The shore is where the bed reads through; the channel is not.
  assert.ok(WATER.shoreAlpha < WATER.maxAlpha, 'water must thin toward the bank');
  assert.ok(WATER.shoreFade > 0, 'a hard alpha step at the shoreline is the shoreline stroke this replaces');
  assert.ok(WATER.reflectBase > 0 && WATER.reflectFresnel > 0 && WATER.fresnelPower >= 2);
  assert.ok(WATER.exposureLift > 1, 'the unlit water surface never sees EXPOSURE and must carry its own lift');
});

test('a building resolves a wall material and a DIFFERENT roof material, deterministically', () => {
  const cases = [
    { style: 'box', kind: 'building' },
    { style: 'gable', kind: 'building' },
    { style: 'frame', kind: 'building' },
    { style: 'tank', kind: 'tank' },
    { style: 'box', place: 'Dorms 3-Story' },
    { style: 'gable', place: 'Crackhouse' },
    { style: 'box' },
    {},
  ];
  for (const b of cases) {
    const wall = buildingMaterialId(b), roof = roofMaterialId(b);
    assert.ok(MATERIALS[wall], `wall material ${wall} is not in the table`);
    assert.ok(MATERIALS[roof], `roof material ${roof} is not in the table`);
    assert.notEqual(wall, roof, `${JSON.stringify(b)}: a roof must not be the same material as its wall`);
    assert.ok(roof.startsWith('roof-'), `${JSON.stringify(b)} resolved a non-roof material for its roof`);
    // Pure: same feature in, same class out.
    assert.equal(buildingMaterialId({ ...b }), wall);
    assert.equal(roofMaterialId({ ...b }), roof);
  }
  // The documented priority order: landmark override beats kind beats form style.
  assert.equal(buildingMaterialId({ place: 'Dorms 2-Story', kind: 'tank', style: 'gable' }), 'building-brick');
  assert.equal(buildingMaterialId({ kind: 'tank', style: 'gable' }), 'building-steel-tank');
  assert.equal(buildingMaterialId({ style: 'gable' }), 'building-corrugated');
  assert.equal(buildingMaterialId({ style: 'box' }), 'building-concrete-panel');
  // Every family the specular table knows about is reachable from a material id.
  for (const id of MATERIAL_IDS) assert.ok(typeof specularFamilyFor(id) === 'string');
  assert.equal(specularFamilyFor('roof-tar'), 'roof');
  assert.equal(specularFamilyFor('water-deep'), 'water');
  assert.equal(specularFamilyFor('foliage-conifer'), 'foliage');
  assert.equal(specularFamilyFor('bark'), 'trunk');
});

test('the contact shadow widens, fades, and is never black in either look', () => {
  for (const mode of STYLE_MODES) {
    const s = SHADOW[mode];
    assert.equal(s.rings.length, 3, `${mode}: a penumbra needs more than one step`);
    for (let i = 1; i < s.rings.length; i++) {
      assert.ok(s.rings[i].meters > s.rings[i - 1].meters, `${mode}: ring ${i} must be wider`);
      assert.ok(s.rings[i].alpha < s.rings[i - 1].alpha, `${mode}: ring ${i} must be fainter`);
    }
    // The Woods defect in one assertion: an overcast shadow is sky-lit, so it is never ink. If a
    // shadow value falls to black the vector skin's BLACK void turns it into a hole in the map.
    const [r, g, b] = rgb255(s.color);
    assert.ok(r + g + b >= 60, `${mode}: shadow ${s.color} is effectively black`);
  }
  // Realistic pushes the shadow COOL — blue-grey, not neutral, not warm.
  const [r, , b] = rgb255(SHADOW.realistic.color);
  assert.ok(b > r + 12, `realistic shadow ${SHADOW.realistic.color} is not a cool blue-grey`);
});

test('foliage drift turns broadleaves and leaves conifers the darker half', () => {
  const { conifer, broadleaf } = FOLIAGE_VARIATION;
  assert.ok(isHexColor(FOLIAGE_VARIATION.autumn) && isHexColor(FOLIAGE_VARIATION.dead));
  assert.ok(conifer.autumn < broadleaf.autumn, 'a spruce does not turn like a birch');
  assert.ok(conifer.value < broadleaf.value);
  assert.ok(conifer.darken > 0, 'conifers must stay the darker half of the canopy');
});

test('the backdrop is a ground haze under a sky, not a second sheet of the sky', () => {
  const luma = (hex) => { const [r, g, b] = rgb255(hex); return 0.299 * r + 0.587 * g + 0.114 * b; };
  const b = BACKDROP.realistic;
  // Darker than the far fog, or the frame is one flat value again and the diorama floats.
  assert.ok(luma(b.voidColor) < luma(FOG.realistic.color) - 8, 'the void plane must read darker than the fog it fades into');
  // The skirt ramps INTO the backdrop. The bottom of the ramp is the colour of the plane the
  // bottom of the skirt sits on, or the "feather" is a ramp away from it and the cut edge is
  // still a cut edge — which is what `#42403a` under a `#7d817b` plane was.
  assert.equal(b.skirtBottom, b.voidColor, 'the skirt must ramp to the colour of the void it meets');
  assert.ok(Math.abs(luma(b.skirtBottom) - luma(b.voidColor)) < Math.abs(luma(b.skirtTop) - luma(b.voidColor)),
    'the ramp must move the skirt toward the backdrop, not away from it');
  assert.ok(b.skirtFeather > 0 && b.skirtFeather <= 1);
  assert.ok(b.voidMarginFactor >= 1, 'the haze must outrun the fog ramp, not stop 60 m past the limit');
  // The sky ramp comes from the contract's own gradient, and an overcast zenith is DARKER.
  assert.equal(b.skyZenith, BACKGROUND.realistic.zenith);
  assert.equal(b.skyHorizon, BACKGROUND.realistic.horizon);
  assert.ok(luma(b.skyZenith) < luma(b.skyHorizon), 'an overcast sky darkens upward');
  assert.ok(b.skyTolerance > 0 && b.skyStrength > 0);
  // Vector keeps its black void and takes no ramp at all.
  assert.equal(BACKDROP.vector.skyStrength, 0);
  assert.ok(luma(BACKDROP.vector.voidColor) < 20, 'the vector skin keeps its black void');
});

test('the fog mixes COLOUR — desaturate, cool, then wash', () => {
  assert.ok(FOG_DESATURATION > 0 && FOG_DESATURATION <= 1);
  assert.ok(FOG_COOL_AMOUNT > 0 && FOG_COOL_AMOUNT <= 1);
  assert.ok(isHexColor(FOG_COOL_TINT));
  const [r, , b] = rgb255(FOG_COOL_TINT);
  assert.ok(b > r, 'the aerial-perspective tint has to be COOL to shift anything');
});

test('the terrain macro patches break up the field without reading elevation', () => {
  assert.ok(TERRAIN_MACRO.patches.length >= 3, 'one splotch field is a pattern, not a breakup');
  const seen = new Set();
  for (const p of TERRAIN_MACRO.patches) {
    assert.ok(isHexColor(p.color), `patch colour ${p.color}`);
    assert.ok(p.wavelength >= 40, `${p.color}: ${p.wavelength} m is detail, not MACRO variation`);
    assert.ok(p.threshold > 0 && p.threshold < 1 && p.gain > 0);
    assert.ok(p.strength > 0 && p.strength <= 0.5, `${p.color} strength ${p.strength} would repaint the land cover`);
    assert.equal(seen.has(p.wavelength), false, 'two patches at one wavelength beat in step');
    seen.add(p.wavelength);
    assert.equal(p.seed.length, 2);
  }
  // The dirt rim darkens ground the road already touches; it never widens the road itself.
  assert.ok(isHexColor(ROAD_RIM.color));
  assert.ok(ROAD_RIM.passes >= 2, 'one pass is a second hard edge, not a gradient');
  assert.ok(ROAD_RIM.widthMeters > 0 && ROAD_RIM.alpha > 0 && ROAD_RIM.alpha < 1);
});
