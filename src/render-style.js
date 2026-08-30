// TarkovZero render-style contract — DATA ONLY.
//
// This module is the single source of truth for the `realistic` / `vector`
// skins described in docs/plans/RENDER-REALISM.md Part C. It renders nothing,
// imports nothing, and touches no deck.gl / luma.gl API, so it can be consumed
// by the browser renderer, by the Node asset pipeline
// (scripts/prepare-render-assets.mjs), and by tests alike.
//
// Rules this file exists to enforce:
//   * `skin` is a MATERIAL STATE, not a second scene. Every material has both a
//     `real` and a `vector` variant over identical geometry, feature IDs and
//     picking. Nothing here may change positions, transforms or LOD placement.
//   * Every colour is an authored hex string so the palette can be diffed and
//     reviewed. Numeric conversion happens at the call site via rgb255()/rgb01().
//   * Everything exported is deep-frozen; callers copy before mutating.

// ---------------------------------------------------------------------------
// Freezing + colour helpers
// ---------------------------------------------------------------------------
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  }
  return value;
}

const HEX_RE = /^#[0-9a-f]{6}$/;

/** True when `value` is a lowercase `#rrggbb` string. */
export function isHexColor(value) {
  return typeof value === 'string' && HEX_RE.test(value);
}

function hex(value) {
  if (!isHexColor(value)) throw new Error(`render-style: invalid hex colour ${JSON.stringify(value)}`);
  return value;
}

/** `#rrggbb` -> `[r, g, b]` in 0..255. */
export function rgb255(color) {
  const v = Number.parseInt(hex(color).slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** `#rrggbb` -> `[r, g, b, a]` in 0..255. */
export function rgba255(color, alpha = 255) {
  return [...rgb255(color), alpha];
}

/** `#rrggbb` -> `[r, g, b]` in 0..1, still sRGB-encoded (not linearised). */
export function rgb01(color) {
  return rgb255(color).map((c) => c / 255);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
export const STYLE_MODES = deepFreeze(['realistic', 'vector']);

export const DEFAULT_MODE = 'realistic';

/** True when `mode` names a supported skin. */
export function isStyleMode(mode) {
  return STYLE_MODES.includes(mode);
}

// ---------------------------------------------------------------------------
// Palette — RENDER-REALISM.md Part C, "Art-direction target"
// ---------------------------------------------------------------------------
export const PALETTE = deepFreeze({
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
  // Vector-skin neutrals: flat semantic fills need their own low-saturation
  // background and outline ink so the map keeps its diagram legibility.
  vectorBackground: '#e9eae6',
  vectorInk: '#2d3130',
});

// ---------------------------------------------------------------------------
// Lighting — fixed map-space key so screenshots are deterministic.
//
// Azimuth convention: degrees clockwise from +Z (map "north") toward +X, matching
// the compass used by the 3D HUD. Elevation is degrees above the ground plane.
// `direction` is the vector the light TRAVELS (light -> scene), i.e. what
// deck.gl's DirectionalLight expects, in game-space (x east, y up, z south).
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;

/**
 * Unit vector a key light travels along, from an azimuth/elevation pair.
 * Pure; the returned array is frozen.
 */
export function keyDirection(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  const horizontal = Math.cos(el);
  // Position of the light on the hemisphere, then negated to point at the scene.
  return Object.freeze([
    -(horizontal * Math.sin(az)),
    -Math.sin(el),
    -(horizontal * Math.cos(az)),
  ]);
}

// Plan: "begin around 18-24 degrees elevation and 220-240 degrees azimuth".
// The contract pins the midpoint of both ranges.
export const KEY_AZIMUTH_DEG = 230;
export const KEY_ELEVATION_DEG = 21;

export const LIGHT = deepFreeze({
  realistic: {
    ambientColor: '#a8b0ae',
    ambientIntensity: 1.18,
    keyColor: '#c8c2b2',
    keyIntensity: 0.85,
    keyAzimuthDeg: KEY_AZIMUTH_DEG,
    keyElevationDeg: KEY_ELEVATION_DEG,
    keyDirection: keyDirection(KEY_AZIMUTH_DEG, KEY_ELEVATION_DEG),
    // Broad overcast bounce; not a second shadow-casting light.
    // R1.5 raised both the sky dome and the bounce ("overcast skies act as giant softboxes"):
    // ambient 1.05 -> 1.18 with EXPOSURE dropped to match (net +4.5% on the sky term), and the cool
    // fill 0.35 -> 0.44 so the side away from the key fills with blue-grey instead of going flat.
    fillColor: '#8f9aa0',
    fillIntensity: 0.44,
    exposure: 1.0,
    shadowsEnabled: false, // gated on Stage 7
  },
  vector: {
    ambientColor: '#ffffff',
    ambientIntensity: 1.0,
    keyColor: '#ffffff',
    keyIntensity: 0.12,
    keyAzimuthDeg: KEY_AZIMUTH_DEG,
    keyElevationDeg: KEY_ELEVATION_DEG,
    keyDirection: keyDirection(KEY_AZIMUTH_DEG, KEY_ELEVATION_DEG),
    fillColor: '#ffffff',
    fillIntensity: 0.0,
    exposure: 1.0,
    shadowsEnabled: false,
  },
});

// ---------------------------------------------------------------------------
// Fog — RENDER-REALISM.md Part C:
//   "Derive it from playable-map diagonal D: start near max(250 m, 0.12D),
//    reach approximately 65-75% by 0.65D, and add a mild near-ground height term."
//
// Model: density(d) = 1 - exp(-k * (d - start)) for d > start, with k solved so
// that density(FOG_TARGET_AT * D) == FOG_TARGET_DENSITY exactly. The height term
// scales density by exp(-max(0, height - groundHeight) / heightFalloff).
//
// heightFalloff is REAL game metres. fogDensity() below takes `heightAboveGround`
// directly; the shader (src/atmosphere.js) has no terrain sampler in the vertex
// stage, so it uses the map's reference ground level in place of the ground under
// each vertex and divides deck-space Z by the relief preference to get back to real
// metres. Both readings agree wherever the ground is near that reference, which is
// the near-ground band this term exists for.
// ---------------------------------------------------------------------------
export const FOG_MIN_START_M = 250;
export const FOG_START_FRACTION = 0.12;
export const FOG_TARGET_AT = 0.65;
export const FOG_TARGET_DENSITY = 0.7; // midpoint of the plan's 65-75% band
export const FOG_HEIGHT_FALLOFF_M = 120;

// R1.5 — aerial perspective. The plan's fog is a COLOUR mix, not an alpha fade: distance first
// costs a surface its chroma, then takes the sky's cool cast, and only then does it wash toward the
// far-fog value. `FOG_COOL_TINT` is normalised to luma 1 at the call site, so it shifts hue without
// changing how bright the fogged fragment is.
export const FOG_DESATURATION = 0.62;
export const FOG_COOL_TINT = '#d6e2f0';
export const FOG_COOL_AMOUNT = 0.4;

export const FOG = deepFreeze({
  realistic: {
    enabled: true,
    color: PALETTE.fogFar,
    minStartMeters: FOG_MIN_START_M,
    startFraction: FOG_START_FRACTION,
    targetAt: FOG_TARGET_AT,
    targetDensity: FOG_TARGET_DENSITY,
    heightFalloffMeters: FOG_HEIGHT_FALLOFF_M,
    maxDensity: 0.92,
  },
  vector: {
    // Plan: "off, or a fixed 10-15% far fade only if labels need separation".
    enabled: false,
    color: PALETTE.vectorBackground,
    minStartMeters: FOG_MIN_START_M,
    startFraction: FOG_START_FRACTION,
    targetAt: FOG_TARGET_AT,
    targetDensity: 0.12,
    heightFalloffMeters: FOG_HEIGHT_FALLOFF_M,
    maxDensity: 0.12,
  },
});

/**
 * Resolve metric fog parameters for one map.
 * @param {'realistic'|'vector'} mode
 * @param {number} diagonalMeters playable-map diagonal D, in metres
 * @returns {Readonly<{startMeters:number,targetMeters:number,targetDensity:number,k:number,heightFalloffMeters:number,maxDensity:number,color:string,enabled:boolean}>}
 */
export function fogFor(mode, diagonalMeters) {
  const fog = FOG[assertMode(mode)];
  if (!Number.isFinite(diagonalMeters) || diagonalMeters <= 0) {
    throw new Error(`render-style: diagonalMeters must be a positive number, got ${diagonalMeters}`);
  }
  const startMeters = Math.max(fog.minStartMeters, fog.startFraction * diagonalMeters);
  const targetMeters = fog.targetAt * diagonalMeters;
  const span = targetMeters - startMeters;
  // A map small enough that the target sits inside the clear zone gets no fog
  // ramp at all rather than a negative or infinite coefficient.
  const k = span > 0 ? -Math.log(1 - fog.targetDensity) / span : 0;
  return deepFreeze({
    enabled: fog.enabled,
    color: fog.color,
    startMeters,
    targetMeters,
    targetDensity: fog.targetDensity,
    k,
    heightFalloffMeters: fog.heightFalloffMeters,
    maxDensity: fog.maxDensity,
  });
}

/**
 * Fog density in 0..1 at a camera distance (and optional height above ground).
 * Pure; used by the tests and by any future shader-parameter derivation.
 */
export function fogDensity(mode, diagonalMeters, distanceMeters, heightAboveGround = 0) {
  const p = fogFor(mode, diagonalMeters);
  if (!p.enabled || p.k === 0 || distanceMeters <= p.startMeters) return 0;
  const base = 1 - Math.exp(-p.k * (distanceMeters - p.startMeters));
  const height = Math.exp(-Math.max(0, heightAboveGround) / p.heightFalloffMeters);
  return Math.min(p.maxDensity, base * height);
}

// ---------------------------------------------------------------------------
// Background / post
// ---------------------------------------------------------------------------
export const BACKGROUND = deepFreeze({
  realistic: {
    kind: 'gradient',
    zenith: '#9aa4a6',
    horizon: PALETTE.skyFar,
    ground: '#7d817b',
    // Derived environment reference produced by scripts/prepare-render-assets.mjs.
    //
    // PROVENANCE, not a runtime fetch. The three colours above, LIGHT.realistic and the grade LUT
    // were all derived from this HDRI's SH9 radiance, and the manifest carries it with its licence
    // for that reason; src/atmosphere.js's `want` list deliberately does not include it, so the
    // browser never downloads it. render-assets-test asserts both halves of that — the id resolves
    // in the shipped manifest, and it is NOT in the runtime fetch list — so this line cannot quietly
    // become a lie in either direction. Painting an actual sky from it is a later stage's job.
    environmentAsset: 'autumn-crossing-sky',
  },
  vector: {
    kind: 'flat',
    zenith: PALETTE.vectorBackground,
    horizon: PALETTE.vectorBackground,
    ground: PALETTE.vectorBackground,
    environmentAsset: null,
  },
});

/*
 * FXAA is OFF, and this is the reason.
 *
 * The plan licenses it conditionally — "acceptable if it materially reduces foliage/rail shimmer" —
 * against an acceptance rule it cannot be traded off against: "labels, extracts, quests, players,
 * controls and selection highlights stay crisp". deck's PostProcessEffect is one full-screen colour
 * pass over the WHOLE framebuffer, so there is no world-only buffer to confine a spatial filter to:
 * the label, icon, quest and live layers go through it too, and a neighbourhood blend is exactly
 * what SDF glyphs at 8-13 px cannot survive. Measured at #3.2/203/-128 on Customs: "SKELETON" came
 * back with holes in its strokes, "OLD GAS STATION - UNDERGROUND" was unreadable where vector was
 * fully legible, and a cluster badge's "2" was a grey-green smear with the same 8x8 mean as the
 * crisp digit — a spatial filter, not a colour shift. Dropping only the post effect at runtime
 * restored the text, so nothing else in the pass is implicated: the LUT, vignette and grain are all
 * pointwise and cannot put a hole in a stroke.
 *
 * That also made it the thing that silently voided the D13/D16 label-legibility fixes, in the
 * DEFAULT look, for every user. If foliage/rail shimmer needs an answer later it has to be one that
 * does not touch the text: MSAA on the world pass, or a second Deck whose output is graded alone.
 */
export const POST = deepFreeze({
  realistic: {
    enabled: true,
    lutAsset: 'overcast-grade-lut',
    vignette: 0.16,
    grain: 0.012,
    fxaa: false,
  },
  vector: {
    enabled: false,
    lutAsset: null,
    vignette: 0,
    grain: 0,
    fxaa: false,
  },
});

// ---------------------------------------------------------------------------
// Materials
//
// `real` follows the contract shape in RENDER-REALISM.md Part C. Texture slots
// name asset ids from scripts/data/render-assets-manifest.json and are null
// until the stage that ships them; a null slot means "use baseColor only",
// never "skip this material".
// ---------------------------------------------------------------------------
const REAL_DEFAULTS = {
  baseColor: null,
  baseColorTexture: null,
  normalTexture: null,
  ormTexture: null,
  uvMeters: [2, 2],
  roughnessFactor: 0.85,
  metallicFactor: 0,
  normalScale: 0.6,
  wetness: 0,
  macroVariation: 0.08,
  alphaMode: 'opaque',
  alphaCutoff: 0.5,
  fog: true,
  castShadow: true,
  receiveShadow: true,
  contactAO: 0.3,
};

// `alphaMode` / `alphaCutoff` are deliberately absent here: they are SILHOUETTE
// state, not surface response, and the plan's flip is material-only ("flat
// species colors; same instance/LOD transforms"). They are inherited from the
// real variant below so an alpha-masked leaf card keeps its cutout in vector
// mode instead of drawing as a solid opaque quad.
const VECTOR_DEFAULTS = {
  fill: null,
  outline: PALETTE.vectorInk,
  outlineWidthPx: 0.9,
  opacity: 1,
  fog: false, // FOG.vector is disabled; no material opts back in
  castShadow: false,
  receiveShadow: false,
  contactAO: 0, // FLAGS.vector.bakedAO is false
};

function material(id, { group, label, real, vector }) {
  const r = { ...REAL_DEFAULTS, ...real };
  const v = { ...VECTOR_DEFAULTS, ...vector };
  // Inherited, not defaulted: whatever the realistic skin cuts out, the vector
  // skin cuts out identically.
  if (v.alphaMode === undefined) v.alphaMode = r.alphaMode;
  if (v.alphaCutoff === undefined) v.alphaCutoff = r.alphaCutoff;
  hex(r.baseColor);
  hex(v.fill);
  hex(v.outline);
  return { id, group, label, real: r, vector: v };
}

function table(entries) {
  const out = {};
  for (const [id, spec] of Object.entries(entries)) out[id] = material(id, spec);
  return deepFreeze(out);
}

// Stage 1 ships exactly one processed material set (the Ground106 detail
// subset). Later stages fill the remaining texture slots; see R1-ASSETS.md.
const GROUND_DETAIL = {
  baseColorTexture: 'ground106-albedo',
  normalTexture: 'ground106-normal',
  ormTexture: 'ground106-orm',
};

export const MATERIALS = table({
  // --- terrain ------------------------------------------------------------
  'terrain-grass': {
    group: 'terrain',
    label: 'Grass base',
    real: { baseColor: PALETTE.grass, ...GROUND_DETAIL, uvMeters: [2.5, 2.5], roughnessFactor: 0.92, normalScale: 0.5, macroVariation: 0.12, castShadow: false },
    vector: { fill: '#6e7a5c' },
  },
  'terrain-grass-wet': {
    group: 'terrain',
    label: 'Wet grass / low ground',
    real: { baseColor: PALETTE.grassWet, ...GROUND_DETAIL, uvMeters: [2.5, 2.5], roughnessFactor: 0.8, wetness: 0.25, macroVariation: 0.1, castShadow: false },
    vector: { fill: '#5c6a52' },
  },
  'terrain-forest-litter': {
    group: 'terrain',
    label: 'Forest litter',
    real: { baseColor: PALETTE.forestLitter, ...GROUND_DETAIL, uvMeters: [2, 2], roughnessFactor: 0.94, normalScale: 0.65, macroVariation: 0.14, castShadow: false },
    vector: { fill: '#7a6d59' },
  },
  'terrain-dirt': {
    group: 'terrain',
    label: 'Dirt / mud',
    real: { baseColor: PALETTE.dirt, ...GROUND_DETAIL, uvMeters: [2, 2], roughnessFactor: 0.9, normalScale: 0.7, macroVariation: 0.1, castShadow: false },
    vector: { fill: '#8a7a63' },
  },
  'terrain-dirt-wet': {
    group: 'terrain',
    label: 'Wet mud / rut',
    real: { baseColor: PALETTE.dirtWet, ...GROUND_DETAIL, uvMeters: [2, 2], roughnessFactor: 0.62, wetness: 0.45, normalScale: 0.7, castShadow: false },
    vector: { fill: '#6b6153' },
  },
  'terrain-rock': {
    group: 'terrain',
    label: 'Hard rock / steep slope',
    real: { baseColor: '#6b6a63', uvMeters: [3, 3], roughnessFactor: 0.88, normalScale: 0.8, macroVariation: 0.1, castShadow: false },
    vector: { fill: '#8b8a82' },
  },
  'terrain-asphalt': {
    group: 'terrain',
    label: 'Asphalt, dry',
    real: { baseColor: PALETTE.asphalt, uvMeters: [4, 4], roughnessFactor: 0.78, normalScale: 0.4, macroVariation: 0.06, castShadow: false },
    vector: { fill: '#6a6f6e' },
  },
  'terrain-asphalt-wet': {
    group: 'terrain',
    label: 'Asphalt, wet patch',
    real: { baseColor: PALETTE.asphaltWet, uvMeters: [4, 4], roughnessFactor: 0.34, wetness: 0.65, normalScale: 0.3, castShadow: false },
    vector: { fill: '#586060' },
  },
  'terrain-gravel': {
    group: 'terrain',
    label: 'Gravel / rail ballast',
    real: { baseColor: '#6d6a63', uvMeters: [1.5, 1.5], roughnessFactor: 0.93, normalScale: 0.75, castShadow: false },
    vector: { fill: '#8d8a83' },
  },
  'terrain-concrete': {
    group: 'terrain',
    label: 'Concrete yard / slab',
    real: { baseColor: PALETTE.concrete, uvMeters: [3, 3], roughnessFactor: 0.85, normalScale: 0.35, castShadow: false },
    vector: { fill: '#9c9b92' },
  },
  'terrain-shore-wet': {
    group: 'terrain',
    label: 'Wet bank / shore',
    real: { baseColor: '#4c463c', ...GROUND_DETAIL, uvMeters: [2, 2], roughnessFactor: 0.5, wetness: 0.7, castShadow: false },
    vector: { fill: '#6f6a5e' },
  },

  // --- water --------------------------------------------------------------
  'water-shallow': {
    group: 'water',
    label: 'Shallow water',
    real: { baseColor: PALETTE.waterShallow, uvMeters: [8, 8], roughnessFactor: 0.18, normalScale: 0.25, wetness: 1, alphaMode: 'blend', castShadow: false, contactAO: 0 },
    vector: { fill: '#7f9791', opacity: 0.85 },
  },
  'water-deep': {
    group: 'water',
    label: 'Deep water',
    real: { baseColor: PALETTE.waterDeep, uvMeters: [8, 8], roughnessFactor: 0.12, normalScale: 0.25, wetness: 1, alphaMode: 'blend', castShadow: false, contactAO: 0 },
    vector: { fill: '#5c7779', opacity: 0.85 },
  },

  // --- buildings ----------------------------------------------------------
  'building-brick': {
    group: 'building',
    label: 'Brick dorm / urban block',
    real: { baseColor: PALETTE.brick, uvMeters: [2, 2], roughnessFactor: 0.88, normalScale: 0.7, contactAO: 0.35 },
    vector: { fill: '#96706a' },
  },
  'building-concrete-panel': {
    group: 'building',
    label: 'Precast concrete panel',
    real: { baseColor: '#8b897f', uvMeters: [3, 3], roughnessFactor: 0.86, normalScale: 0.45, contactAO: 0.35 },
    vector: { fill: '#a9a79d' },
  },
  'building-corrugated': {
    group: 'building',
    label: 'Corrugated industrial metal',
    real: { baseColor: PALETTE.metalPaint, uvMeters: [2, 2], roughnessFactor: 0.72, metallicFactor: 0.35, normalScale: 0.55, wetness: 0.12, contactAO: 0.35 },
    vector: { fill: '#8d9694' },
  },
  'building-plaster-timber': {
    group: 'building',
    label: 'Plaster / timber rural gable',
    real: { baseColor: '#8d8474', uvMeters: [2, 2], roughnessFactor: 0.9, normalScale: 0.5, contactAO: 0.32 },
    vector: { fill: '#a79e8d' },
  },
  'building-bunker': {
    group: 'building',
    label: 'Concrete bunker / plinth',
    real: { baseColor: '#6f6e67', uvMeters: [3, 3], roughnessFactor: 0.9, normalScale: 0.4, contactAO: 0.42 },
    vector: { fill: '#8f8e86' },
  },
  'building-steel-tank': {
    group: 'building',
    label: 'Painted / rusted tank and frame',
    real: { baseColor: PALETTE.metalRust, uvMeters: [2, 2], roughnessFactor: 0.68, metallicFactor: 0.45, normalScale: 0.6, contactAO: 0.3 },
    vector: { fill: '#9a6c55' },
  },
  'roof-tar': {
    group: 'building',
    label: 'Tar / felt roof',
    real: { baseColor: '#43443f', uvMeters: [3, 3], roughnessFactor: 0.9, normalScale: 0.35, contactAO: 0.2 },
    vector: { fill: '#63645e' },
  },
  'roof-corrugated': {
    group: 'building',
    label: 'Corrugated roof',
    real: { baseColor: '#5f6664', uvMeters: [2, 2], roughnessFactor: 0.7, metallicFactor: 0.35, normalScale: 0.6, wetness: 0.15, contactAO: 0.2 },
    vector: { fill: '#7f8684' },
  },
  'roof-tile': {
    group: 'building',
    label: 'Weathered tile roof',
    real: { baseColor: '#6c5044', uvMeters: [1.5, 1.5], roughnessFactor: 0.87, normalScale: 0.7, contactAO: 0.22 },
    vector: { fill: '#8c7064' },
  },
  'roof-concrete': {
    group: 'building',
    label: 'Concrete roof deck',
    real: { baseColor: '#77766d', uvMeters: [3, 3], roughnessFactor: 0.88, normalScale: 0.35, contactAO: 0.22 },
    vector: { fill: '#97968d' },
  },

  // --- vegetation ---------------------------------------------------------
  'foliage-conifer': {
    group: 'vegetation',
    label: 'Conifer foliage',
    real: { baseColor: PALETTE.conifer, uvMeters: [1, 1], roughnessFactor: 0.95, normalScale: 0.4, alphaMode: 'mask', macroVariation: 0.16, contactAO: 0.25 },
    vector: { fill: '#4d6151' },
  },
  'foliage-broadleaf': {
    group: 'vegetation',
    label: 'Broadleaf autumn foliage',
    real: { baseColor: PALETTE.broadleafLight, uvMeters: [1, 1], roughnessFactor: 0.95, normalScale: 0.4, alphaMode: 'mask', macroVariation: 0.2, contactAO: 0.25 },
    vector: { fill: '#7d845f' },
  },
  'foliage-shrub': {
    group: 'vegetation',
    label: 'Shrub / sapling',
    real: { baseColor: PALETTE.broadleafDark, uvMeters: [1, 1], roughnessFactor: 0.95, normalScale: 0.4, alphaMode: 'mask', macroVariation: 0.18, contactAO: 0.2 },
    vector: { fill: '#93825f' },
  },
  'bark': {
    group: 'vegetation',
    label: 'Bark',
    real: { baseColor: '#4f4639', uvMeters: [0.6, 1.2], roughnessFactor: 0.93, normalScale: 0.8, contactAO: 0.3 },
    vector: { fill: '#6d6353' },
  },

  // --- props --------------------------------------------------------------
  'prop-rusted-metal': {
    group: 'prop',
    label: 'Rusted metal prop',
    real: { baseColor: PALETTE.metalRust, uvMeters: [1.5, 1.5], roughnessFactor: 0.75, metallicFactor: 0.4, normalScale: 0.6, contactAO: 0.35 },
    vector: { fill: '#9a6c55' },
  },
  'prop-container': {
    group: 'prop',
    label: 'Freight container steel',
    real: { baseColor: '#5c6a63', uvMeters: [2, 2], roughnessFactor: 0.7, metallicFactor: 0.4, normalScale: 0.6, contactAO: 0.35 },
    vector: { fill: '#7d8a83' },
  },
  'prop-unresolved': {
    group: 'prop',
    label: 'Unresolved archetype (development fallback)',
    // Deliberately loud: the plan forbids silent random inference, so an
    // unmapped archetype must be visible in development, never plausible.
    real: { baseColor: '#b0179b', uvMeters: [1, 1], roughnessFactor: 1, macroVariation: 0, contactAO: 0 },
    vector: { fill: '#b0179b' },
  },
});

export const MATERIAL_IDS = deepFreeze(Object.keys(MATERIALS));

// ---------------------------------------------------------------------------
// R1.5 — specular response
//
// The plan (Part C, "One material contract") wants surface RESPONSE, not just albedo: "Roads and
// terrain need a broad, low-roughness specular lobe to reflect the overcast sky, while concrete
// needs high roughness."
//
// deck's Phong material is `{ambient, diffuse, shininess, specularColor}`; there is no roughness
// input, so a material's `roughnessFactor` above is turned into the two numbers deck does take:
//   shininess = 1 + SPECULAR_EXPONENT_MAX * (1 - roughness)^2
//   specularColor = skyColor * strength                    (an overcast lobe is SKY-coloured)
// The strengths are authored per family rather than derived, because a family's lobe also carries
// how much of the sky the surface actually sees (a road lies flat under the whole dome, a wall does
// not). Vector is unlit by contract: every family is zero there.
//
// EXPONENT_MAX is 24, not the ~100 a point-light Phong lobe would want, and that is the whole
// design: the single directional key here stands in for a SKY DOME, so the lobe has to be as wide
// as the dome. At 96 the wettest road in the contract (roughness 0.34) came out at exponent 42, and
// under the fixed 21-degree key with a 50-degree camera that is `0.82^42` — 0.02% of the sky, i.e.
// nothing at all. Measured, then re-fitted; a broad lobe is what "damp, not glossy" looks like.
// ---------------------------------------------------------------------------
export const SPECULAR_EXPONENT_MAX = 24;

export const SPECULAR = deepFreeze({
  realistic: {
    skyColor: PALETTE.skyFar,
    families: {
      water: { roughness: 0.15, strength: 0.62 },
      road: { roughness: 0.34, strength: 0.5 },   // wet asphalt: the ground shader's road mask
      roof: { roughness: 0.5, strength: 0.34 },
      metal: { roughness: 0.55, strength: 0.26 },
      building: { roughness: 0.86, strength: 0.1 },
      slabLike: { roughness: 0.85, strength: 0.11 },
      prop: { roughness: 0.72, strength: 0.16 },
      rock: { roughness: 0.88, strength: 0.06 },
      boulder: { roughness: 0.88, strength: 0.06 },
      ground: { roughness: 0.92, strength: 0.05 },
      foliage: { roughness: 0.95, strength: 0.03 },
      trunk: { roughness: 0.93, strength: 0.02 },
    },
  },
  vector: { skyColor: '#ffffff', families: {} },
});

/**
 * The `{shininess, specularColor}` half of a deck Phong material for one surface family.
 * Vector always answers a dead lobe; an unknown family answers the same, never a guess.
 */
export function specularFor(mode, family) {
  const table = SPECULAR[assertMode(mode)];
  const spec = table.families[family];
  if (!spec) return { shininess: 1, specularColor: [0, 0, 0] };
  const gloss = Math.max(0, 1 - spec.roughness);
  const shininess = Math.max(1, Math.round(1 + SPECULAR_EXPONENT_MAX * gloss * gloss));
  const sky = rgb255(table.skyColor);
  return { shininess, specularColor: sky.map((c) => Math.round(c * spec.strength)) };
}

// ---------------------------------------------------------------------------
// R1.5 — water
//
// Part C, "Water and shore": shallow tea/olive sediment deepening to blue-grey, a Fresnel blend
// toward the sky at grazing angle, and a soft shore. Depths are REAL game metres measured against
// the carved bed; alpha is what lets the bed read through near the bank.
// ---------------------------------------------------------------------------
export const WATER = deepFreeze({
  shallow: PALETTE.waterShallow,
  deep: PALETTE.waterDeep,
  sky: PALETTE.skyFar,
  depthMaxMeters: 4.5,
  shallowAt: 0.08,
  deepAt: 0.8,
  reflectBase: 0.28,
  reflectFresnel: 0.44,
  fresnelPower: 4,
  maxAlpha: 0.92,
  shoreAlpha: 0.22,
  shoreFade: 0.3,
  /*
   * The water surface is drawn UNLIT (its shading is the extension's, not deck's Phong), so it is
   * the one world surface that never passes through atmosphere.js's EXPOSURE lift. Without this it
   * renders at the raw authored albedo while every lit surface around it renders at roughly the
   * authored value — measured on Woods: the lake came back near-black against grass at its own
   * palette value. This is the same compensation, applied where it belongs, and it is a RENDERER
   * calibration of the two stops above, not a second art direction.
   */
  exposureLift: 1.22,
  // Realistic only: the vector skin keeps its flat semantic fill (Part C's flip table).
  vectorEnabled: false,
});

// ---------------------------------------------------------------------------
// R1.5 — the backdrop the diorama sits in
//
// The void plane is no longer the sky colour exactly. It is a slightly darker ground haze that the
// world fog carries to the far-fog value with distance, so the frame reads sky at the top and
// darkens toward the horizon instead of ending on one flat sheet. The skirt is a vertical ramp from
// its earth value into that haze, so the cut edge feathers instead of floating.
// ---------------------------------------------------------------------------
export const BACKDROP = deepFreeze({
  realistic: {
    voidColor: BACKGROUND.realistic.ground,
    voidMarginFactor: 1.4,   // × the map's playable diagonal
    skirtTop: '#655f54',
    skirtBottom: '#42403a',
    skirtFeather: 0.72,      // how far down the skirt the ramp reaches
    /*
     * The sky's own vertical ramp, applied in the grade pass.
     *
     * The canvas clears to ONE colour (FOG.realistic.color) and a horizontal void plane can never
     * appear above the horizon, so the band of frame above the skyline had nowhere to get a
     * gradient from. The grade pass can give it one, because a pixel that already sits at the
     * far-fog value IS atmosphere — sky, or geometry the fog has fully turned into sky — and
     * tinting atmosphere by screen height is exactly what a sky gradient is. `tolerance` is how far
     * from the far-fog value a pixel may be and still count as sky: anything the fog has not
     * finished (a half-fogged ridge, a label, the map) is further away than that and is untouched.
     *
     * The two colours are BACKGROUND.realistic's own zenith and horizon, so the ramp darkens
     * upward — which is what a real overcast sky does, and the opposite of a UI gradient.
     */
    skyZenith: BACKGROUND.realistic.zenith,
    skyHorizon: BACKGROUND.realistic.horizon,
    skyTolerance: 0.09,
    skyStrength: 1,
  },
  vector: {
    voidColor: '#0a0d0c',
    voidMarginFactor: 0.12,
    skirtTop: '#0c0e0d',
    skirtBottom: '#0c0e0d',
    skirtFeather: 0,
    skyZenith: PALETTE.vectorBackground,
    skyHorizon: PALETTE.vectorBackground,
    skyTolerance: 0,
    skyStrength: 0,
  },
});

// ---------------------------------------------------------------------------
// R1.5 — terrain macro variation
//
// Large-scale autumn die-off / mud splotches laid over the land-cover base (Part C: "break up the
// flat olive green with large-scale splotches of desaturated yellow, brown, and darker greens").
// Wavelengths are metres; each patch is a thresholded value-noise field, so nothing here moves a
// road, a shoreline or a feature boundary.
// ---------------------------------------------------------------------------
export const TERRAIN_MACRO = deepFreeze({
  patches: [
    { color: '#7d7450', wavelength: 88, threshold: 0.55, gain: 2.1, strength: 0.34, seed: [613, -271] },
    { color: '#5b4c3a', wavelength: 141, threshold: 0.6, gain: 1.9, strength: 0.3, seed: [-457, 829] },
    { color: '#3d4736', wavelength: 67, threshold: 0.57, gain: 2.4, strength: 0.26, seed: [271, 419] },
  ],
});

// A dirt rim where a paved surface meets the ground: the plan's "edge darkening/dirt blending", as
// three widening, fading strokes under the road so the boundary is a gradient, not a pixel step.
export const ROAD_RIM = deepFreeze({
  color: '#4c4437',
  widthMeters: 3.6,
  passes: 3,
  alpha: 0.62,
});

// ---------------------------------------------------------------------------
// R1.5 — contact shading
//
// deck's stock shadow is gated on Stage 7, so "soft" is carried by the contact rings under every
// footprint. Three rings of decreasing opacity approximate a penumbra, and the colour is a cool
// damp blue-grey rather than ink: an overcast shadow is sky-lit, never black.
// ---------------------------------------------------------------------------
export const SHADOW = deepFreeze({
  realistic: {
    color: '#42505c',
    rings: [
      { meters: 1.0, alpha: 0.3 },
      { meters: 3.2, alpha: 0.15 },
      { meters: 6.6, alpha: 0.07 },
    ],
  },
  vector: {
    // Legible, but never a hole: the vector skin's shadow floor is a dark slate, not #000.
    color: '#1a2420',
    rings: [
      { meters: 1.1, alpha: 0.26 },
      { meters: 3.2, alpha: 0.12 },
      { meters: 6.6, alpha: 0.05 },
    ],
  },
});

// ---------------------------------------------------------------------------
// R1.5 — per-instance foliage variation
//
// "Randomize the tree colors slightly toward browns, yellows, and dead greens." Seeded by the
// instance index, so the same tree is the same colour on every load and in every screenshot.
// ---------------------------------------------------------------------------
export const FOLIAGE_VARIATION = deepFreeze({
  autumn: '#8d7a43',
  dead: '#5f5b3e',
  broadleaf: { autumn: 0.55, dead: 0.3, value: 0.24 },
  // Conifers keep their species colour and stay the darker half of the canopy.
  conifer: { autumn: 0.13, dead: 0.16, value: 0.15, darken: 0.08 },
});

// ---------------------------------------------------------------------------
// R1.5 — deterministic building material classes
//
// Part C's resolution order, with no random inference: an explicit landmark override, then the
// source `kind`, then the form `style`, then a conservative default.
// ---------------------------------------------------------------------------
export const BUILDING_MATERIAL = deepFreeze({
  byPlace: {
    'Dorms 2-Story': 'building-brick',
    'Dorms 3-Story': 'building-brick',
    'Big Red': 'building-brick',
    Crackhouse: 'building-plaster-timber',
    'Streamer House': 'building-plaster-timber',
    Fortress: 'building-bunker',
    Skeleton: 'building-bunker',
    'Old Construction': 'building-bunker',
    Boiler: 'building-corrugated',
  },
  byKind: { tank: 'building-steel-tank', powerline_towers: 'building-steel-tank' },
  byStyle: {
    box: 'building-concrete-panel',
    gable: 'building-corrugated',
    frame: 'building-bunker',
    canopy: 'building-concrete-panel',
    tank: 'building-steel-tank',
    'cooling-tower': 'building-bunker',
  },
  fallback: 'building-concrete-panel',
});

export const ROOF_MATERIAL = deepFreeze({
  byPlace: {
    'Dorms 2-Story': 'roof-tile',
    'Dorms 3-Story': 'roof-tile',
    'Big Red': 'roof-tile',
    Crackhouse: 'roof-tile',
    'Streamer House': 'roof-tile',
  },
  byKind: { tank: 'roof-corrugated' },
  byStyle: {
    box: 'roof-tar',
    gable: 'roof-corrugated',
    frame: 'roof-concrete',
    canopy: 'roof-corrugated',
    tank: 'roof-corrugated',
    'cooling-tower': 'roof-concrete',
  },
  fallback: 'roof-tar',
});

function resolveClass(table, feature) {
  const place = feature?.place ?? '';
  const kind = feature?.kind ?? '';
  const style = feature?.style ?? 'box';
  return table.byPlace[place] ?? table.byKind[kind] ?? table.byStyle[style] ?? table.fallback;
}

/** The wall material id for one building feature. Deterministic; never random. */
export const buildingMaterialId = (feature) => resolveClass(BUILDING_MATERIAL, feature);
/** The roof material id for one building feature. Deterministic; never random. */
export const roofMaterialId = (feature) => resolveClass(ROOF_MATERIAL, feature);

/** The specular family a material id belongs to, so a wall and its roof do not share a lobe. */
export function specularFamilyFor(materialId) {
  const m = MATERIALS[materialId];
  if (!m) return 'building';
  if (m.group === 'water') return 'water';
  if (m.group === 'vegetation') return materialId === 'bark' ? 'trunk' : 'foliage';
  if (materialId.startsWith('roof-')) return 'roof';
  if (m.real.metallicFactor >= 0.3) return 'metal';
  if (m.group === 'prop') return 'prop';
  return 'building';
}

// ---------------------------------------------------------------------------
// styleFor
// ---------------------------------------------------------------------------
function assertMode(mode) {
  if (!isStyleMode(mode)) {
    throw new Error(`render-style: unknown mode ${JSON.stringify(mode)} (expected ${STYLE_MODES.join(' | ')})`);
  }
  return mode;
}

// Per-mode flags that describe the exact parameter flip in Part C's table.
const FLAGS = deepFreeze({
  realistic: {
    baseColorTextures: true,
    normalTextures: true,
    ormTextures: true,
    imageBasedLighting: true,
    contours: false,
    hypsometry: false,
    geometryOutlines: false,
    bakedAO: true,
    grime: true,
    waterAnimation: true,
    roadMarkingWear: true,
  },
  vector: {
    baseColorTextures: false,
    normalTextures: false,
    ormTextures: false,
    imageBasedLighting: false,
    // Plan, Top-look decision 1: "no contours or strong hypsometry in realistic
    // mode; preserve them as optional vector parameters." Both survive here.
    contours: true,
    hypsometry: true,
    geometryOutlines: true,
    bakedAO: false,
    grime: false,
    waterAnimation: false,
    roadMarkingWear: false,
  },
});

function buildStyle(mode) {
  const variant = mode === 'realistic' ? 'real' : 'vector';
  const materials = {};
  for (const [id, m] of Object.entries(MATERIALS)) {
    const v = m[variant];
    materials[id] = {
      id,
      group: m.group,
      label: m.label,
      variant,
      ...v,
      // In vector mode every texture slot is force-disabled on the same
      // geometry — the flip must never reach a sampler.
      ...(variant === 'vector'
        ? { baseColorTexture: null, normalTexture: null, ormTexture: null, normalScale: 0, roughnessFactor: 0, metallicFactor: 0, wetness: 0, macroVariation: 0 }
        : {}),
    };
  }
  return deepFreeze({
    mode,
    variant,
    palette: PALETTE,
    light: LIGHT[mode],
    fog: FOG[mode],
    background: BACKGROUND[mode],
    post: POST[mode],
    flags: FLAGS[mode],
    materials,
    materialIds: Object.keys(materials),
  });
}

const STYLES = deepFreeze({
  realistic: buildStyle('realistic'),
  vector: buildStyle('vector'),
});

/**
 * The complete frozen style contract for one skin.
 * Pure: the same mode always returns the same frozen object.
 * @param {'realistic'|'vector'} mode
 */
export function styleFor(mode) {
  return STYLES[assertMode(mode)];
}

/** One resolved material for one skin, or undefined when the id is unknown. */
export function materialFor(mode, id) {
  return styleFor(mode).materials[id];
}
