// src/atmosphere.js — Stage 1 of docs/plans/RENDER-REALISM.md: light, world-only fog, background,
// the shared realistic/vector colour tables, the terrain ground-detail material, and the one
// combined post-process grade.
//
// Everything here reads the frozen contract in src/render-style.js. Nothing here changes geometry,
// transforms, feature ids, picking or LOD placement — the plan's rule is that `look` is a MATERIAL
// STATE, and this module is where that state is turned into deck.gl/luma objects.
//
// Three mechanisms, all verified against the pinned deck.gl 9.3.11 / luma.gl 9.3.6 sources:
//
//  1. FOG is a `LayerExtension`. Its shader injection writes one varying in the vertex stage (deck's
//     `DECKGL_FILTER_GL_POSITION` hook, where `geometry.position` is already the common-space
//     position and `project.cameraPosition` is the eye) and mixes toward the fog colour at
//     `fs:#main-end`, i.e. AFTER the layer's own lighting. Mixing at `fs:DECKGL_FILTER_COLOR`
//     instead would be wrong for SimpleMeshLayer, whose filter hook runs BEFORE
//     `lighting_getLightColor` — fogged terrain would then be multiplied by the sun.
//     Only world layers get the extension; labels, icons, quest, live and selection layers never do.
//
//  2. GROUND DETAIL is a second `LayerExtension`, on the terrain mesh only. It binds the shipped
//     Ground106 albedo/normal/ORM plus the macro-noise tile and samples them TRIPLANAR in world
//     space at `fs:DECKGL_FILTER_COLOR` — which for SimpleMeshLayer runs before lighting, so it
//     modulates ALBEDO, which is what a detail map is for. It carries its own world-position and
//     normal varyings rather than reading the layer's, because a hook injection is emitted as a
//     standalone function ahead of the layer's own varying declarations, not inlined into main().
//
//  3. The GRADE is a `PostProcessEffect` sampler pass: optional FXAA, then the shipped 16³ LUT,
//     then vignette and grain. The LUT arrives as a luma texture binding (anything in the module
//     props that is not a declared uniform becomes a binding — the same path deck's own
//     `screen.texSrc` takes).
//
// All fog/detail/grade constants are baked into the GLSL as literals rather than plumbed as
// uniforms. They are frozen per (look, map) and only change when the look changes, which rebuilds
// the layers anyway — so this trades a shader recompile on a rare toggle for zero uniform-block
// plumbing, and makes every constant visible in one place.
import { LightingEffect, AmbientLight, DirectionalLight, LayerExtension, PostProcessEffect } from '@deck.gl/core';
import {
  styleFor, fogFor, rgb255, rgb01, PALETTE, LIGHT, isStyleMode, DEFAULT_MODE,
  specularFor, specularFamilyFor, SPECULAR, MATERIALS, SHADOW, BACKDROP, WATER, TERRAIN_MACRO,
  FOG_DESATURATION, FOG_COOL_TINT, FOG_COOL_AMOUNT,
} from './render-style.js';

// ---------------------------------------------------------------------------- look state
export const LOOKS = ['realistic', 'vector'];
export const DEFAULT_LOOK = DEFAULT_MODE; // 'realistic'
/** Coerce anything (query string, localStorage, an API call) to a supported look. */
export const resolveLook = (value) => (isStyleMode(value) ? value : DEFAULT_LOOK);

const f = (n) => {
  // GLSL literals must always carry a decimal point, and must never carry an exponent that a
  // driver could parse as an identifier boundary. 6 decimals is well inside float precision.
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`atmosphere: non-finite shader constant ${n}`);
  return v.toFixed(6);
};
const glslVec3 = (rgb) => `vec3(${rgb.map((c) => f(c)).join(', ')})`;
/** Scale an 0..1 triple so its Rec.601 luma is exactly 1 — a pure hue/chroma multiplier. */
const lumaNormalised = (rgb) => {
  const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  return l > 0 ? rgb.map((c) => c / l) : [1, 1, 1];
};

// ---------------------------------------------------------------------------- colour tables
// `vector` is the CURRENT look, value for value — the plan's vector skin has to reproduce today's
// map, so this table is a verbatim copy of what map3d.js shipped before Stage 1. `realistic` is the
// same key set re-tuned from PALETTE. UI/accent/marker colours are IDENTICAL in both: the plan's
// fog and grade never touch labels, icons or selection, and neither does the palette.
const UI = {
  cream: [230, 227, 215], creamDim: [198, 196, 182], ink: [14, 18, 15], amber: [255, 208, 92],
  accentExtract: [45, 190, 108], accentExtractScav: [224, 135, 43], accentExtractTransit: [58, 150, 186], accentExtractNeutral: [128, 134, 130],
  accentPlayer: [56, 214, 200], accentDanger: [210, 69, 63], accentSpawn: [92, 122, 158], accentBoss: [190, 46, 48],
  undergroundOn: [255, 176, 48, 190], glass: [37, 49, 52, 225],
};

/**
 * The three contact rings under every footprint, as RGBA fills.
 *
 * deck's cast shadows are gated on Stage 7, so this IS the soft shadow: three rings of decreasing
 * opacity, in the contract's cool damp blue-grey rather than ink, because an overcast shadow is
 * still lit by the whole sky dome. `shadowRings()` below hands the metric radii to map3d.
 */
function shadeColors(mode) {
  const s = SHADOW[mode];
  const [r, g, b] = rgb255(s.color);
  const a = (i) => [r, g, b, Math.round(255 * s.rings[i].alpha)];
  return { shade: a(0), shadeSoft: a(1), shadeWide: a(2) };
}

/** Metric radii of the contact rings, widest first, for one look. */
export const shadowRings = (look) => SHADOW[resolveLook(look)].rings.map((ring) => ring.meters);

/*
 * R1.5 vector contrast pass.
 *
 * The vector skin draws on a BLACK void (that stays — it is what the skin is), but the pre-R1.5
 * palette was authored against a light sheet: mid-tone pastel terrain against #0a0d0c blew the
 * contrast ratio out, and every shadow value bottomed out at ink. Woods' Mountain Spine read as a
 * hole in the map (frame 14) because its rock material ran ambient 0.36 under a light with
 * keyIntensity 0.12 — 36% of the albedo and nothing else.
 *
 * Two rules applied here: no terrain/shadow value drops below the SHADOW.vector floor, and the
 * field stops come down ~8% so the black ground has something to be darker THAN.
 */
const VECTOR_COLORS = {
  grass1: [52, 74, 53], grass2: [62, 87, 57], grass3: [74, 98, 61], grass4: [92, 110, 67], grass5: [112, 125, 77],
  grass: [62, 87, 57], grassHigh: [112, 125, 77], land: [62, 87, 57], grassDry: [122, 116, 92], grassShadow: [42, 58, 44],
  water: [38, 86, 105], waterDeep: [25, 59, 76], shore: [99, 151, 161, 185],
  pavement: [112, 115, 108], pavementWorn: [123, 125, 116], road: [137, 142, 133], roadEdge: [86, 91, 83],
  highway: [150, 153, 141], highwayEdge: [96, 101, 91], roadMarking: [230, 226, 207, 190],
  track: [126, 105, 73], dirt: [139, 121, 88], dirtEdge: [103, 88, 64],
  rail: [132, 130, 121], sleeper: [99, 91, 75], fence: [119, 114, 99], fenceTop: [78, 73, 62],
  building: [181, 174, 159], buildingMulti: [165, 157, 143], buildingPlinth: [132, 126, 114], buildingHover: [255, 215, 112],
  roofWarehouse: [119, 128, 130], roofHouse: [145, 92, 72], roofFlat: [126, 120, 108], roofRib: [0, 0, 0, 42],
  skylight: [190, 201, 196, 235], parapet: [145, 138, 125], dockDoor: [60, 52, 47],
  tank: [181, 186, 184], tankBand: [0, 0, 0, 55], tower: [150, 152, 145],
  understory: [48, 72, 49, 52], tree: [72, 99, 65], treeShadow: [23, 37, 28, 110], rock: [149, 144, 128],
  bridge: [137, 132, 119], bridgeRail: [88, 83, 73], pier: [112, 107, 96],
  contour: [26, 42, 26, 90], contourMajor: [20, 32, 20, 150],
  void: [10, 13, 12], oob: rgb255(BACKDROP.vector.voidColor), voidRing: [24, 28, 26], cliff: rgb255(BACKDROP.vector.skirtTop),
  ...shadeColors('vector'), floorLine: [0, 0, 0, 70],
  underground: [46, 44, 40, 120],
  sandbag: [151, 137, 105], rust: [149, 89, 61], bigRed: [163, 70, 59], bigRedTrim: [224, 216, 199],
  concreteRaw: [187, 181, 169], rebar: [159, 140, 108], hazardStripe: [226, 190, 67],
  // Tree fallback tones and trunk (src/trees.js reads these two).
  treeTones: [[72, 99, 65], [84, 112, 72], [96, 124, 79]],
  trunk: [91, 69, 47],
  // Deterministic generic-building container tints (map3d propParts()).
  containerTints: [[164, 88, 69], [121, 131, 125], [146, 138, 120], [134, 106, 83]],
  // Target that map3d's liftTone() pulls an authored colour toward, so a data-authored landmark
  // colour still sits in the look's value range instead of staying at its raw saturation.
  liftTarget: [232, 224, 207],
  ...UI,
};

const P = (key) => rgb255(PALETTE[key]);
const shade = (rgb, k) => rgb.map((c, i) => (i < 3 ? Math.max(0, Math.min(255, Math.round(c * k))) : c));

// Damp overcast autumn. Ground/road/roof/water values come straight from the plan's Part C table
// via PALETTE; everything else is derived from those by a single multiply so the family holds
// together. The one rule applied throughout: keep asphalt and concrete separated (the plan asks
// for it explicitly) and never let a structure drop below the ground it stands on.
const REALISTIC_COLORS = {
  grass1: shade(P('grassWet'), 0.92), grass2: P('grassWet'), grass3: P('grass'), grass4: shade(P('grass'), 1.1), grass5: shade(P('forestLitter'), 1.02),
  grass: P('grass'), grassHigh: shade(P('forestLitter'), 1.05), land: P('grass'),
  grassDry: shade(P('forestLitter'), 1.08), grassShadow: shade(P('grassWet'), 0.62),
  // Overcast water is mostly reflected sky, so both stops are lifted toward the far-fog value.
  water: shade(P('waterShallow'), 1.18), waterDeep: shade(P('waterDeep'), 1.22),
  // R1.5: the realistic water surface now fades out over its own shore band, so the stroke that
  // used to DRAW the shoreline is demoted to a wet-bank hint (the plan's "narrow dark wet-bank
  // band"), not an outline. Vector keeps the full-strength stroke.
  shore: [...shade(P('dirtWet'), 1.15), 96],
  pavement: rgb255('#6f6f68'), pavementWorn: rgb255('#7a7a72'),
  road: P('asphalt'), roadEdge: shade(P('asphalt'), 0.74),
  highway: shade(P('asphalt'), 1.12), highwayEdge: shade(P('asphalt'), 0.7),
  roadMarking: [198, 194, 178, 150],
  track: shade(P('dirt'), 0.86), dirt: P('dirt'), dirtEdge: shade(P('dirtWet'), 1.05),
  rail: rgb255('#6d6a63'), sleeper: shade(P('dirtWet'), 1.02),
  fence: rgb255('#6a675d'), fenceTop: rgb255('#4c4a43'),
  building: rgb255('#9d9b90'), buildingMulti: rgb255('#8e8d84'), buildingPlinth: rgb255('#7c7b73'),
  buildingHover: [255, 215, 112],
  // Roofs are lifted off the plan's authored albedo on purpose. A horizontal face under a key at
  // 21 degrees of elevation receives sin(21) = 0.36 of the key, so a tar roof authored at #43443f
  // renders near black and a warehouse stops being findable from the overview — the exact opposite
  // of the acceptance rule that roofs and buildings stay readable. The hue is the plan's; the value
  // is the renderer's exposure calibration, and it lives here rather than in the frozen contract.
  roofWarehouse: rgb255('#7a817f'), roofHouse: rgb255('#8a6759'), roofFlat: rgb255('#6f7069'),
  roofRib: [0, 0, 0, 52],
  skylight: [150, 160, 158, 220], parapet: rgb255('#8e8d84'), dockDoor: rgb255('#3d3c37'),
  tank: rgb255('#9d9b90'), tankBand: [0, 0, 0, 62], tower: rgb255('#8b8a81'),
  understory: [...shade(P('forestLitter'), 0.8), 62], tree: P('conifer'),
  treeShadow: [22, 28, 22, 120], rock: rgb255('#6b6a63'),
  bridge: rgb255('#87867d'), bridgeRail: rgb255('#615f58'), pier: rgb255('#78776f'),
  // Contours/hypsometry are OFF in realistic mode; the keys survive so nothing has to branch.
  contour: [26, 42, 26, 0], contourMajor: [20, 32, 20, 0],
  /*
   * R1.5: the void plane is no longer exactly the sky.
   *
   * Painting it the clear colour made the whole background one flat sheet, which is the read Gemini
   * called "floating diorama": there was no horizon, only a hard cut where the mesh stopped. It is
   * now a slightly darker GROUND HAZE (the contract's BACKGROUND.ground) and it is FOGGED, so it
   * washes to the far-fog value with distance on its own. The frame therefore reads sky at the top
   * and darkens toward the horizon, without a second sky layer or a screen-space gradient that
   * would also tint the map.
   */
  void: rgb255(BACKDROP.realistic.voidColor), oob: rgb255(BACKDROP.realistic.voidColor),
  voidRing: shade(rgb255(BACKDROP.realistic.voidColor), 0.92),
  // The cut edge of the diorama: an earth value, not a black wall, and now a vertical ramp into
  // the haze below it (terrain.js bakes the ramp into the skirt mesh's COLOR_0).
  cliff: rgb255(BACKDROP.realistic.skirtTop),
  ...shadeColors('realistic'), floorLine: [0, 0, 0, 58],
  underground: [46, 44, 40, 120],
  sandbag: rgb255('#8d8370'), rust: shade(P('metalRust'), 1.1), bigRed: rgb255('#8a4a3f'), bigRedTrim: rgb255('#bab4a6'),
  concreteRaw: rgb255('#9d9b90'), rebar: rgb255('#8b7f68'), hazardStripe: rgb255('#b89c50'),
  treeTones: [P('conifer'), rgb255(PALETTE.broadleafLight), rgb255(PALETTE.broadleafDark)],
  trunk: rgb255('#4f4639'),
  containerTints: [P('metalRust'), rgb255('#5c6a63'), rgb255('#6a6558'), rgb255('#63513f')],
  liftTarget: rgb255('#b6b3a6'),
  ...UI,
};

const COLOR_TABLES = Object.freeze({ realistic: Object.freeze(REALISTIC_COLORS), vector: Object.freeze(VECTOR_COLORS) });

/** The `C` colour table map3d.js/terrain.js/trees.js draw with, for one look. Frozen. */
export function paletteFor(look) {
  return COLOR_TABLES[resolveLook(look)];
}

// Baked-terrain surface colours (src/terrain.js draws roads/rail/pavement into the ground texture).
export function surfaceFor(look) {
  const C = paletteFor(look);
  return {
    pavement: C.pavement,
    road: C.road, roadEdge: C.roadEdge,
    highway: C.highway, highwayEdge: C.highwayEdge, marking: C.roadMarking.slice(0, 3),
    dirt: C.dirt, dirtEdge: C.dirtEdge, track: C.track,
    rail: C.rail, sleeper: C.sleeper,
  };
}

// ---------------------------------------------------------------------------- lighting
// render-style's keyDirection is in GAME space (x east, y up, z south) and is the direction the
// light travels. deck space is [x = -gameX, y = -gameZ, z = gameY], so the components swap and two
// of them flip. Getting this wrong lights the map from the wrong side and fights the baked shading.
export const toDeckDirection = ([gx, gy, gz]) => [-gx, -gz, gy];

/**
 * The scene light for one look: a broad cool ambient, a weak low warm key at the contract's fixed
 * azimuth/elevation, and (realistic only) a second non-casting fill for overcast bounce.
 * Shadows stay off — the plan gates them on Stage 7.
 */
export function lightingFor(look) {
  const L = styleFor(resolveLook(look)).light;
  const lights = {
    ambient: new AmbientLight({ color: rgb255(L.ambientColor), intensity: L.ambientIntensity }),
    sun: new DirectionalLight({
      color: rgb255(L.keyColor),
      intensity: L.keyIntensity,
      direction: toDeckDirection(L.keyDirection),
      _shadow: false,
    }),
  };
  if (L.fillIntensity > 0) {
    // Bounce comes back from roughly the opposite quadrant and from higher up; it is a fill, never
    // a second key, so it never casts and never gets its own shadow map.
    const fill = toDeckDirection(L.keyDirection).map((v, i) => (i === 2 ? -Math.abs(v) - 0.55 : -v));
    lights.fill = new DirectionalLight({ color: rgb255(L.fillColor), intensity: L.fillIntensity, direction: fill, _shadow: false });
  }
  return new LightingEffect(lights);
}

/**
 * EXPOSURE — the one scalar that puts the authored palette back on screen.
 *
 * deck's Phong term is
 *   colour * (ambientColour * ambientIntensity * material.ambient
 *             + SUM over lights of lightColour * intensity * max(0, N.L) * material.diffuse)
 *
 * With the contract's cool ambient (#a8b0ae at 1.05, so 0.69 of white) and a key at only 21 degrees
 * of elevation (N.L = 0.36 on level ground), physically-shaped coefficients land the whole map at
 * roughly 45% of its authored albedo — measured, not guessed: the Customs ground came back at
 * (42,53,39) against an authored #586149 = (88,97,73). That is a night scene, not a damp afternoon.
 *
 * EXPOSURE multiplies the AMBIENT coefficient only, so the key still shapes every surface and the
 * palette stays faithful to the plan's Part C table. It lives here, next to the light it
 * compensates for, rather than being smeared through thirty colour literals.
 *
 * R1.5 dropped it 1.85 -> 1.72 when LIGHT.realistic.ambientIntensity went 1.05 -> 1.18: the sky
 * dome carries more of the frame (the plan's overcast softbox) at the same measured ground value,
 * +4.5% overall. The two numbers are a pair — changing one without the other re-exposes the map.
 */
const EXPOSURE = 1.72;
const lit = (ambient, rest) => ({ ambient: Number((ambient * EXPOSURE).toFixed(3)), ...rest });

/**
 * Phong coefficients per surface family, per look.
 *
 * Overcast light is dominated by a bright sky dome, so a realistic surface leans on ambient and
 * takes only a modest directional term; the pre-Stage-1 vector numbers are preserved exactly so the
 * vector skin is unchanged.
 */
const MATERIALS_BY_LOOK = {
  realistic: {
    building: lit(0.5, { diffuse: 0.5 }),
    roof: lit(0.57, { diffuse: 0.3 }),
    slabLike: lit(0.51, { diffuse: 0.42 }),
    prop: lit(0.51, { diffuse: 0.42 }),
    rock: lit(0.27, { diffuse: 0.85 }),
    boulder: lit(0.3, { diffuse: 0.78 }),
    player: { ambient: 0.55, diffuse: 0.7, shininess: 20, specularColor: [80, 80, 80] },
    foliage: lit(0.31, { diffuse: 0.76 }),
    trunk: lit(0.22, { diffuse: 0.8 }),
  },
  vector: {
    building: { ambient: 0.7, diffuse: 0.55 },
    roof: { ambient: 0.82, diffuse: 0.38 },
    slabLike: { ambient: 0.75, diffuse: 0.45 },
    prop: { ambient: 0.75, diffuse: 0.5 },
    /*
     * R1.5: rock honours the look, like foliage already did.
     *
     * The vector light is ambient 1.0 with a key at 0.12, so `ambient: 0.36` meant a rock face
     * rendered at ~40% of its albedo with nothing to lift it — against a black void that is a hole,
     * and Woods' Mountain Spine was exactly that (frame 14). Part C's flip table says the vector
     * skin is "unlit or near-unlit high ambient" for EVERY family; these two were the exceptions.
     */
    rock: { ambient: 0.78, diffuse: 0.4 },
    boulder: { ambient: 0.8, diffuse: 0.36 },
    foliage: { ambient: 0.72, diffuse: 0.58 },
    trunk: { ambient: 0.48, diffuse: 0.72 },
    player: { ambient: 0.55, diffuse: 0.7, shininess: 20, specularColor: [80, 80, 80] },
  },
};

/**
 * Phong coefficients for one surface family under one look.
 *
 * R1.5: the `{shininess, specularColor}` half now comes from the frozen SPECULAR table rather than
 * from ad-hoc literals here, so "wet asphalt reflects the sky, concrete does not" is one reviewable
 * data block instead of nine scattered numbers. `player` keeps its own lobe — it is a UI token, not
 * a world surface, and the plan holds UI colours out of the look.
 */
export function surfaceMaterial(look, kind) {
  const mode = resolveLook(look);
  const base = MATERIALS_BY_LOOK[mode][kind];
  if (!base || kind === 'player') return base;
  return { ...base, ...specularFor(mode, kind) };
}

/**
 * The display colour of one material class under one look, as an RGB triple.
 *
 * Realistic answers the contract's authored albedo (the palette is already exposure-calibrated by
 * EXPOSURE above); vector answers the contract's flat semantic fill. `seed` applies a deterministic
 * +/-6% value jitter so a street of the same material class is not one flat sheet — same input,
 * same colour, every load.
 */
export function materialTint(look, materialId, seed = 0, foldSkyLobe = false) {
  const mode = resolveLook(look);
  const m = MATERIALS[materialId] ?? MATERIALS['prop-unresolved'];
  let rgb = rgb255(mode === 'realistic' ? m.real.baseColor : m.vector.fill);
  if (mode === 'realistic' && foldSkyLobe) {
    const strength = SPECULAR.realistic.families[specularFamilyFor(materialId)]?.strength ?? 0;
    const sky = rgb255(SPECULAR.realistic.skyColor);
    rgb = rgb.map((c, i) => c + (sky[i] - c) * strength * SKY_LOBE_FOLD);
  }
  const k = seed ? 0.94 + ((seed % 1000) / 1000) * 0.12 : 1;
  return rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * k))));
}

/**
 * How much of a family's specular strength is folded into an UNLIT face's albedo.
 *
 * Roofs and every other flat cap are drawn by non-extruded SolidPolygonLayers, and deck only calls
 * `lighting_getLightColor` for extruded ones — so a `material` prop on those layers is inert and a
 * Phong lobe can never reach them. Under a uniform overcast dome, though, a broad lobe on a
 * near-horizontal face is view-INDEPENDENT: it is a constant fraction of the sky colour. Folding
 * that constant into the albedo is the same number a lit pass would produce for this geometry, and
 * it is what separates a wet corrugated roof from a matte tar one from the concrete wall below.
 *
 * 0.9 is calibrated, not chosen: it lands the corrugated class within a value or two of the
 * exposure-tuned roof grey Stage 1 measured as "still findable from the overview", and keeps tar
 * clearly the darker of the two. Walls do NOT take it — they are extruded, therefore lit, therefore
 * already carry their lobe as a real specular.
 */
const SKY_LOBE_FOLD = 0.9;

/** The specular family a material id belongs to (re-exported so map3d needs one import). */
export { specularFamilyFor };

/** Foliage/trunk materials, used by src/trees.js (vector keeps its own pre-Stage-1 numbers). */
export const foliageMaterialFor = (look) => surfaceMaterial(look, 'foliage');
export const trunkMaterialFor = (look) => surfaceMaterial(look, 'trunk');

/** The material the terrain mesh is lit with. Realistic lets the scene key carry the relief. */
export function terrainMaterialFor(look) {
  const mode = resolveLook(look);
  return mode === 'realistic'
    // Lower BASE ambient + higher diffuse than vector: the mesh normals and the 21-degree key do
    // the relief work, because the realistic bake no longer carries a strong cartographic
    // hillshade. EXPOSURE then lifts the whole thing back to the authored value. The lobe is the
    // contract's `ground` family — high roughness, almost no sky reflection; the WET half (roads)
    // is added per-fragment by the ground-detail extension's road mask, not by this material.
    ? lit(0.62, { diffuse: 0.86, ...specularFor('realistic', 'ground') })
    // Vector keeps the pre-Stage-1 numbers exactly: ambient high so the BAKE sets the ground value.
    : { ambient: 0.95, diffuse: 0.55, shininess: 1, specularColor: [10, 12, 10] };
}

// ---------------------------------------------------------------------------- background
/**
 * The canvas clear colour, as deck `View.clearColor` (0..255 RGBA).
 *
 * Realistic uses the far-fog value from the contract, so geometry that fades into fog fades into
 * the background rather than into a hole. Vector deliberately keeps the pre-Stage-1 dark void:
 * the brief requires the vector skin to reproduce TODAY's look, and today's background is the void,
 * not the (untested, never-rendered) `BACKGROUND.vector` value in render-style.js. render-style is
 * shipped, tested data and is left untouched.
 */
export function backgroundFor(look) {
  return resolveLook(look) === 'realistic'
    ? [...rgb255(PALETTE.fogFar), 255]
    : [...VECTOR_COLORS.void, 255];
}

/** The same colour as a CSS string, for the container behind the canvas. */
export const backgroundCss = (look) => { const [r, g, b] = backgroundFor(look); return `rgb(${r},${g},${b})`; };

// ---------------------------------------------------------------------------- fog
/** Metric fog parameters for one look over a map whose playable diagonal is `diagonalMeters`. */
export function fogParams(look, diagonalMeters) {
  return fogFor(resolveLook(look), diagonalMeters);
}

/** The XZ diagonal of a map's playable limit ring, in metres. */
export function limitDiagonal(limit) {
  if (!Array.isArray(limit) || limit.length < 3) return 1000;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of limit) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const d = Math.hypot(x1 - x0, z1 - z0);
  return d > 1 ? d : 1000;
}

// NOTE on `this` in every extension hook: deck calls them as
// `extension.<hook>.call(layer, ..., extension)` (see @deck.gl/core layer.js), so inside a hook
// `this` is the LAYER and the extension itself is the last argument. Reading `this.opts` here would
// silently read `undefined` off the layer.
// The one value that cannot be a literal: how far the eye currently stands off its orbit target.
// See the note in FogExtension for why the fog depth is measured from the target and not the eye.
// A single scalar in its own std140 block — all-scalar so luma's packing and the driver's cannot
// disagree about vec3 padding.
// `ground` and `relief` are the second pair the shader cannot know as literals: the height term is
// specified in REAL metres above the ground (src/render-style.js), and deck-space Z is game altitude
// already multiplied by the relief preference, measured from world zero.
const FOG_MODULE = {
  name: 'tzFog',
  vs: `layout(std140) uniform tzFogUniforms {
  float origin;
  float ground;
  float relief;
} tzFog;
`,
  uniformTypes: { origin: 'f32', ground: 'f32', relief: 'f32' },
  defaultUniforms: { origin: 0, ground: 0, relief: 1 },
};

class FogExtension extends LayerExtension {
  getShaders(extension) {
    const { startMeters, k, maxDensity, heightFalloffMeters, color } = extension.opts;
    const FOG = glslVec3(rgb01(color));
    // Luma-normalised, so the cool shift moves hue and leaves brightness where the lighting put it.
    const COOL = glslVec3(lumaNormalised(rgb01(FOG_COOL_TINT)));
    return {
      modules: [FOG_MODULE],
      inject: {
        'vs:#decl': 'out float tz_fogAmount;\n',
        // Every vertex must write the varying, including the degenerate branches PathLayer takes
        // for a zero-length segment — an unwritten `out` is undefined, not zero.
        'vs:#main-start': 'tz_fogAmount = 0.0;\n',
        /*
         * Fog depth is `eye distance MINUS the eye's standoff from the orbit target`, not raw eye
         * distance.
         *
         * This is what makes the plan's numbers mean what the plan says. The map is viewed from an
         * orbit camera that backs off as it zooms out: at the default Customs framing the eye is
         * ~1.5 km from every point on the map, so a fog that starts at 250 m of EYE distance
         * fogs the entire map uniformly at the one zoom that matters — "hide the map", which the
         * plan explicitly forbids. Measured from the target instead, the near half of the diorama
         * is at negative depth and stays clear, the far half accumulates haze, and zooming in to
         * inspect a building puts everything inside the clear zone. That is aerial perspective,
         * and it is the only reading of "start near max(250 m, 0.12D)" that survives a real camera.
         */
        /*
         * The height term is ELEVATION ABOVE THE GROUND REFERENCE, in REAL metres — not altitude.
         *
         * `tzWorld.z` is deck space: game altitude times the relief preference (3 by default),
         * measured from world zero. Feeding that straight into `exp(-z / 120)` got both halves
         * wrong. The 120 is 120 real metres in the contract, so dividing exaggerated metres by it
         * made the falloff 40 m; and measuring from world zero de-fogged ground by how high it sits,
         * which inverts aerial perspective on a map with real relief — on Woods a ridge at +82.8
         * kept 50% of its fog and a valley at 0 kept 100%, so the far ridge read CLEARER than the
         * near valley.
         *
         * `tzFog.ground` is the map's own reference ground level (the median of its heightfield,
         * pushed in relief-scaled), which is the closest thing to "the ground under this vertex"
         * that a vertex shader with no terrain sampler can have. What it buys is that the terrain
         * fogs by distance, as the plan intends, and only things genuinely standing above the
         * landscape — roofs, treetops, a rock summit — thin out.
         */
        'vs:DECKGL_FILTER_GL_POSITION': `
  {
    vec3 tzWorld = geometry.position.xyz;
    float tzDepth = length(tzWorld - project.cameraPosition) - tzFog.origin;
    float tzBase = 1.0 - exp(-${f(k)} * max(0.0, tzDepth - ${f(startMeters)}));
    float tzAbove = max(0.0, (tzWorld.z - tzFog.ground) / max(tzFog.relief, 0.001));
    float tzHeight = exp(-tzAbove / ${f(heightFalloffMeters)});
    tz_fogAmount = clamp(tzBase * tzHeight, 0.0, ${f(maxDensity)});
  }
`,
        'fs:#decl': 'in float tz_fogAmount;\n',
        /*
         * AFTER the layer's own lighting: SimpleMeshLayer lights inside main(), past the colour
         * filter hook, so mixing there would put the sun on top of the fog.
         *
         * R1.5 — this is AERIAL PERSPECTIVE, not a wash. A single `mix(colour, fogColour, t)` is
         * what Gemini read as "a flat, linear alpha fade into a solid hex-code background": every
         * hue marches to the same grey at the same rate and nothing loses saturation on the way.
         * Real distance takes chroma FIRST (scattering fills in the gaps between an object's colour
         * and the sky's) and casts what is left toward the cool end. So: desaturate toward a
         * luma-preserving cool grey, then take the sky's cast, and only then wash toward far-fog.
         * ${f(FOG_DESATURATION)} / ${f(FOG_COOL_AMOUNT)} are the frozen contract's constants.
         */
        'fs:#main-end': `
  {
    vec3 tzC = fragColor.rgb;
    float tzL = dot(tzC, vec3(0.299, 0.587, 0.114));
    vec3 tzCool = vec3(tzL) * ${COOL};
    tzC = mix(tzC, tzCool, tz_fogAmount * ${f(FOG_DESATURATION)});
    tzC = mix(tzC, tzC * ${COOL}, tz_fogAmount * ${f(FOG_COOL_AMOUNT)});
    fragColor.rgb = mix(tzC, ${FOG}, tz_fogAmount);
  }
`,
      },
    };
  }

  draw(params, extension) {
    // `this` is the layer. The viewport is the live OrbitViewport, so the standoff is exact for
    // whatever the camera is doing this frame — no view-state mirror to drift out of sync.
    const vp = this.context.viewport;
    const cam = vp?.cameraPosition, target = vp?.target;
    const origin = cam && target
      ? Math.hypot(cam[0] - target[0], cam[1] - target[1], cam[2] - target[2])
      : 0;
    // The scene reads live, so a relief change needs no new extension (and therefore no shader
    // recompile on every world layer).
    const scene = extension.opts.scene?.() ?? null;
    const relief = Number(scene?.relief) > 0 ? Number(scene.relief) : 1;
    const ground = Number.isFinite(scene?.groundMeters) ? scene.groundMeters * relief : 0;
    this.setShaderModuleProps({ tzFog: { origin, ground, relief } });
  }
}
FogExtension.extensionName = 'TzFogExtension';

/**
 * The world-layer fog extension for one look and map, or `null` when the look has fog off.
 * Callers spread it: `extensions: fogExt ? [fogExt] : []`.
 *
 * `scene` is read every draw and answers `{groundMeters, relief}` — the map's reference ground level
 * in real game metres, and the relief preference the camera is currently drawing at.
 */
export function fogExtensionFor(look, diagonalMeters, scene = null) {
  const p = fogParams(look, diagonalMeters);
  if (!p.enabled || !(p.k > 0)) return null;
  return new FogExtension({
    startMeters: p.startMeters,
    k: p.k,
    maxDensity: p.maxDensity,
    heightFalloffMeters: p.heightFalloffMeters,
    color: p.color,
    scene,
  });
}

/**
 * The map's reference ground level in real game metres: the median of its heightfield.
 *
 * Median, not mean: a map whose relief is one big ridge (Woods) should not have its whole valley
 * floor counted as "below ground". Returns 0 when there is no heightfield to read.
 */
export function referenceGroundMeters(terrain) {
  const h = terrain?.heights;
  if (!h || !h.length) return 0;
  const sorted = Array.prototype.slice.call(h).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Number.isFinite(m) ? m : 0;
}

// ---------------------------------------------------------------------------- ground detail
// The one processed material Stage 1 ships (R1-ASSETS.md): Ground106 albedo/normal/ORM at 512²
// plus the self-authored macro-noise tile (R = low frequency, G = mid, B = high, A = Bayer).
const GROUND_MODULE = {
  name: 'tzGround',
  fs: `
uniform sampler2D tzDetailAlbedo;
uniform sampler2D tzDetailNormal;
uniform sampler2D tzDetailOrm;
uniform sampler2D tzMacroNoise;
`,
};

/** Tuning for the realistic ground. Frozen: the plan requires deterministic screenshots. */
export const GROUND_DETAIL = Object.freeze({
  detailMeters: 2.5,   // world metres per Ground106 tile (matches MATERIALS['terrain-grass'].uvMeters)
  macroMeters: 190,    // low-frequency breakup, far wider than any 1K repeat
  detailStrength: 0.5, // how much of the albedo's value variation reaches the ground
  macroStrength: 0.42,
  normalScale: 0.5,    // MATERIALS['terrain-grass'].normalScale
  bumpMix: 0.55,       // how much of the detail-normal shading ratio reaches the albedo
  aoStrength: 0.3,
  slopeDarken: 0.22,   // slope-based darkening, the plan's third ground cue
  /*
   * R1.5 — the wet-asphalt lobe, and the mask that decides where it lands.
   *
   * Roads are not a layer: terrain.js paints them into the ONE baked ground texture, so there is no
   * road geometry to hang a material on. But the BAKED ALBEDO is the mask — asphalt is the only
   * thing on this ground that is both dark and neutral. Measured on the shipped palette:
   *
   *   asphalt   #4a4e4d  luma 0.302  sat 0.052   -> mask 0.63
   *   road edge (asphalt x0.74)  luma 0.212  sat 0.055  -> mask ~1
   *   pavement  #6f6f68  luma 0.432  sat 0.062   -> 0 (too light)
   *   rail      #6d6a63  luma 0.416  sat 0.091   -> 0 (too light)
   *   grass     #586149  luma 0.362  sat 0.247   -> 0 (too green)
   *   sleeper   (dirtWet x1.02)     luma 0.271  sat 0.203  -> 0 (too brown)
   *
   * The mask is read from the ALBEDO the bake handed us, at the top of the colour filter and before
   * this extension modulates anything — not from the lit fragment, whose values move with the
   * exposure and would need re-fitting every time the light changes. Because it selects exactly the
   * pixels the bake painted, it cannot drift out of register with the road it is shading.
   */
  roadSatLo: 0.07, roadSatHi: 0.16,  // saturation window (neutral end)
  roadLumLo: 0.22, roadLumHi: 0.42,  // luminance window (dark end)
});

class GroundDetailExtension extends LayerExtension {
  getShaders(extension) {
    const t = extension.opts.tuning;
    // Direction TOWARD the key, in deck space — the negated travel direction.
    const KEY = glslVec3(extension.opts.keyDirection.map((v) => -v));
    const SPEC = specularFor('realistic', 'road');
    const SPEC_COLOR = glslVec3(SPEC.specularColor.map((c) => c / 255));
    return {
      modules: [GROUND_MODULE],
      inject: {
        /*
         * The detail carries its OWN world position and normal from the vertex stage.
         *
         * A deck shader hook is not inlined into main(): luma emits it as a standalone
         * `void DECKGL_FILTER_COLOR(inout vec4 color, FragmentGeometry geometry)` placed BEFORE the
         * layer's own `in vec4 position_commonspace;` declarations. So the layer's varyings and
         * main()'s local `normal` are simply not in scope here — reading them fails to compile
         * (verified: "'position_commonspace' : undeclared identifier"). Two varyings of our own
         * cost 6 floats and make the injection independent of any layer's internals.
         */
        'vs:#decl': 'out vec3 tz_gPos;\nout vec3 tz_gNormal;\n',
        'vs:#main-start': 'tz_gPos = vec3(0.0);\n  tz_gNormal = vec3(0.0, 0.0, 1.0);\n',
        // geometry.normal is assigned immediately before this hook in the SimpleMeshLayer vertex
        // shader, so both are the final values for this vertex.
        'vs:DECKGL_FILTER_GL_POSITION': `
  tz_gPos = geometry.position.xyz;
  tz_gNormal = geometry.normal;
`,
        // `tz_roadMask` is a fragment-scope GLOBAL, not a varying: the two injections below run in
        // the same fragment invocation (DECKGL_FILTER_COLOR first, then main's tail), and a global
        // is the only way to carry a value from a hook FUNCTION into main's inlined tail. It is
        // initialised at declaration so a layer that somehow skipped the filter still links.
        'fs:#decl': 'in vec3 tz_gPos;\nin vec3 tz_gNormal;\nfloat tz_roadMask = 0.0;\n',
        // Runs before the layer lights the fragment, so this modulates ALBEDO — which is what a
        // detail map is for. The normal map arrives as a shading ratio (see below) rather than as
        // a real normal perturbation, because main()'s `normal` is out of reach from here.
        'fs:DECKGL_FILTER_COLOR': `
  {
    // Wet-asphalt mask, taken from the untouched bake albedo (see GROUND_DETAIL above).
    //
    // Both ramps are INVERTED — asphalt is the low-saturation, low-luma end — and the way to write
    // an inverted ramp is 1.0 - smoothstep(lo, hi, x), never smoothstep(hi, lo, x). GLSL ES 3.00
    // leaves smoothstep undefined when edge0 >= edge1; every driver we can test here (ANGLE,
    // SwiftShader) computes it as clamp((x-edge0)/(edge1-edge0)) and lands on the intended ramp,
    // but a conformant driver may return anything, which would put the road specular on the wrong
    // pixels or on none. Algebraically identical on the drivers that do define it.
    // (No backticks in this comment: it lives inside a JS template literal.)
    float tzMx = max(color.r, max(color.g, color.b));
    float tzMn = min(color.r, min(color.g, color.b));
    tz_roadMask = (1.0 - smoothstep(${f(t.roadSatLo)}, ${f(t.roadSatHi)}, (tzMx - tzMn) / max(tzMx, 0.0001)))
                * (1.0 - smoothstep(${f(t.roadLumLo)}, ${f(t.roadLumHi)}, dot(color.rgb, vec3(0.299, 0.587, 0.114))));
    vec3 tzP = tz_gPos;
    vec3 tzN = normalize(tz_gNormal);
    vec3 tzW = abs(tzN);
    tzW /= max(0.0001, tzW.x + tzW.y + tzW.z);
    vec2 tzUvTop = tzP.xy / ${f(t.detailMeters)};
    vec2 tzUvX = tzP.yz / ${f(t.detailMeters)};
    vec2 tzUvY = tzP.xz / ${f(t.detailMeters)};
    vec3 tzDet = texture(tzDetailAlbedo, tzUvTop).rgb * tzW.z
               + texture(tzDetailAlbedo, tzUvX).rgb * tzW.x
               + texture(tzDetailAlbedo, tzUvY).rgb * tzW.y;
    // The bake owns the hue; the detail only supplies surface frequency, as value.
    float tzL = dot(tzDet, vec3(0.299, 0.587, 0.114));
    color.rgb *= mix(1.0, 0.56 + tzL * 0.94, ${f(t.detailStrength)});
    float tzMacro = texture(tzMacroNoise, tzP.xy / ${f(t.macroMeters)}).r;
    color.rgb *= mix(1.0, 0.80 + tzMacro * 0.42, ${f(t.macroStrength)});
    float tzAo = texture(tzDetailOrm, tzUvTop).r;
    color.rgb *= mix(1.0, tzAo, ${f(t.aoStrength)} * tzW.z);
    float tzSlope = 1.0 - clamp(tzN.z, 0.0, 1.0);
    color.rgb *= 1.0 - ${f(t.slopeDarken)} * smoothstep(0.04, 0.72, tzSlope);
    // Detail normal as a diffuse RATIO against the frozen key direction: the same number a real
    // perturbation would produce for a Lambertian surface, applied to albedo instead of to the
    // normal. The 0.35 floor keeps a grazing key from dividing by ~0 on a lit face.
    vec3 tzNm = texture(tzDetailNormal, tzUvTop).rgb * 2.0 - 1.0;
    vec3 tzPert = normalize(vec3(tzN.xy + tzNm.xy * (${f(t.normalScale)} * tzW.z), tzN.z));
    float tzFlatL = max(0.0, dot(tzN, ${KEY})) + 0.35;
    float tzBumpL = max(0.0, dot(tzPert, ${KEY})) + 0.35;
    color.rgb *= clamp(mix(1.0, tzBumpL / tzFlatL, ${f(t.bumpMix)}), 0.72, 1.32);
  }
`,
        /*
         * The specular half of the ground, added AFTER lighting so it is a reflection and not a
         * second albedo. `cameraPosition` and `position_commonspace` are the SimpleMeshLayer's own
         * varyings: `fs:#main-end` is inlined into main(), unlike DECKGL_FILTER_COLOR above, so
         * everything the layer declared is in scope here. This extension is only ever attached to
         * the terrain mesh, which is what makes that safe to rely on.
         *
         * The lobe is Blinn-Phong against the frozen key, tinted the SKY colour, gated on the road
         * mask — the plan's "broad, low-roughness specular lobe to reflect the overcast sky" for
         * wet asphalt, with nothing added on grass, dirt or gravel.
         */
        'fs:#main-end': `
  if (tz_roadMask > 0.0) {
    vec3 tzV = normalize(cameraPosition - position_commonspace.xyz);
    vec3 tzHv = normalize(tzV + ${KEY});
    float tzSpec = pow(max(dot(normalize(tz_gNormal), tzHv), 0.0), ${f(SPEC.shininess)});
    fragColor.rgb += ${SPEC_COLOR} * (tzSpec * tz_roadMask);
  }
`,
      },
    };
  }

  draw(params, extension) {
    // `this` is the LAYER here (deck calls extension.draw.call(layer, ...)). Bindings are set every
    // draw because a model can be rebuilt under us (relief change, texture reupload).
    const tex = extension.opts.textures;
    if (!tex) return;
    this.setShaderModuleProps({
      tzGround: {
        tzDetailAlbedo: tex.albedo,
        tzDetailNormal: tex.normal,
        tzDetailOrm: tex.orm,
        tzMacroNoise: tex.macro,
      },
    });
  }
}
GroundDetailExtension.extensionName = 'TzGroundDetailExtension';

/**
 * The terrain ground-detail extension, or `null` in vector mode / before the textures have loaded.
 * `textures` is the object returned by `createGroundTextures()`.
 */
export function groundDetailExtensionFor(look, textures) {
  const mode = resolveLook(look);
  if (mode !== 'realistic' || !textures) return null;
  return new GroundDetailExtension({ tuning: GROUND_DETAIL, textures, keyDirection: toDeckDirection(LIGHT[mode].keyDirection) });
}

// ---------------------------------------------------------------------------- water
/**
 * The realistic water surface: translucent, depth-tinted, sky-reflecting, soft at the shore.
 *
 * This is a MATERIAL on the mesh terrain.js welds out of the ground grid, not a second scene. Every
 * vertex carries two numbers in `COLOR_0`:
 *   r = depth of the CARVED BED below the water plane, in real game metres / WATER.depthMaxMeters
 *   g = 1 inside the water polygon, 0 at a grid vertex outside it
 * so the shore fade is the mesh's own 2.5 m interpolation across the boundary cells, and the depth
 * tint is the surveyed bathymetry the heightfield already carries — not a distance-to-outline
 * guess. The layer draws with `getColor: [255,255,255]`, which makes `vColor.rgb` those two numbers
 * verbatim; this extension replaces them with the water colour.
 *
 * Reading them needs `vs:#main-start`, not the FILTER hooks: a deck hook injection is emitted as a
 * standalone function ahead of the layer's `in vec3 colors;` declaration, so `colors` is only in
 * scope in the one place that is inlined into main(). Same trap as the ground detail above.
 */
class WaterExtension extends LayerExtension {
  getShaders() {
    const lift = (hex) => rgb01(hex).map((c) => Math.min(1, c * WATER.exposureLift));
    const SHALLOW = glslVec3(lift(WATER.shallow));
    const DEEP = glslVec3(lift(WATER.deep));
    const SKY = glslVec3(rgb01(WATER.sky));
    return {
      inject: {
        'vs:#decl': 'out float tz_wDepth;\nout float tz_wIn;\n',
        'vs:#main-start': '  tz_wDepth = colors.r;\n  tz_wIn = colors.g;\n',
        'fs:#decl': 'in float tz_wDepth;\nin float tz_wIn;\n',
        // Before lighting (the layer runs `material: false`, so this IS the surface colour).
        'fs:DECKGL_FILTER_COLOR': `
  {
    float tzD = clamp(tz_wDepth, 0.0, 1.0);
    float tzIn = clamp(tz_wIn, 0.0, 1.0);
    // Shallow tea/olive over the bank, blue-grey once the bed drops away.
    vec3 tzBody = mix(${SHALLOW}, ${DEEP}, smoothstep(${f(WATER.shallowAt)}, ${f(WATER.deepAt)}, tzD));
    float tzShore = smoothstep(0.0, ${f(WATER.shoreFade)}, tzD);
    color.rgb = tzBody;
    // Thin at the bank so the carved bed reads through it, opaque over the channel.
    color.a = tzIn * mix(${f(WATER.shoreAlpha)}, ${f(WATER.maxAlpha)}, tzShore);
  }
`,
        /*
         * The environmental reflection, added after the surface colour: a flat sky term plus a
         * Fresnel lift at grazing angle. The plan calls this out as "a convincing environmental
         * reflection cue, not a true scene reflection" — there is no planar pass and none is
         * claimed. The surface is level, so the normal is deck-space up.
         */
        'fs:#main-end': `
  {
    vec3 tzN = vec3(0.0, 0.0, 1.0);
    vec3 tzV = normalize(cameraPosition - position_commonspace.xyz);
    float tzF = pow(1.0 - clamp(dot(tzN, tzV), 0.0, 1.0), ${f(WATER.fresnelPower)});
    float tzMix = clamp(${f(WATER.reflectBase)} + tzF * ${f(WATER.reflectFresnel)}, 0.0, 1.0);
    fragColor.rgb = mix(fragColor.rgb, ${SKY}, tzMix * clamp(tz_wIn, 0.0, 1.0));
  }
`,
      },
    };
  }
}
WaterExtension.extensionName = 'TzWaterExtension';

/** The realistic water material, or `null` in vector mode (which keeps its flat semantic fill). */
export function waterExtensionFor(look) {
  return resolveLook(look) === 'realistic' ? new WaterExtension() : null;
}

/** The frozen water contract, so terrain.js can encode depth on the scale the shader decodes. */
export const waterTuning = () => WATER;

// ---------------------------------------------------------------------------- backdrop
/** How far past the playable limit the void plane reaches, in metres, for one look. */
export function voidMargin(look, diagonalMeters) {
  const b = BACKDROP[resolveLook(look)];
  // A map with no usable diagonal falls back to 1 km rather than to a 60 m apron: too little haze
  // is the bug this replaces, and a too-large quad costs two triangles.
  const d = Number.isFinite(diagonalMeters) && diagonalMeters > 0 ? diagonalMeters : 1000;
  return Math.max(60, b.voidMarginFactor * d);
}

/** The skirt's top and bottom colours plus how far the ramp reaches, for one look. */
export function skirtRamp(look) {
  const b = BACKDROP[resolveLook(look)];
  return { top: rgb255(b.skirtTop), bottom: rgb255(b.skirtBottom), feather: b.skirtFeather };
}

/** The frozen terrain macro-variation patches (src/terrain.js bakes them). */
export const terrainMacro = () => TERRAIN_MACRO;

// ---------------------------------------------------------------------------- asset loading
const ASSET_ROOT = '/assets/3d/';

/** Fetch the shipped Stage 1 asset index and decode every image it points at. Cached per page. */
let assetPromise = null;
export function loadRenderAssets() {
  if (assetPromise) return assetPromise;
  assetPromise = (async () => {
    const manifest = await (await fetch(`${ASSET_ROOT}render-assets.json`)).json();
    const byId = Object.fromEntries((manifest.assets || []).map((a) => [a.id, a]));
    const want = ['ground106-albedo', 'ground106-normal', 'ground106-orm', 'macro-noise', 'overcast-grade-lut'];
    const images = {};
    let bytes = 0;
    await Promise.all(want.map(async (id) => {
      const entry = byId[id];
      if (!entry) return;
      const res = await fetch(ASSET_ROOT + entry.path);
      if (!res.ok) throw new Error(`render asset ${id}: HTTP ${res.status}`);
      const blob = await res.blob();
      images[id] = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      bytes += entry.bytes ?? blob.size;
    }));
    return { manifest, images, sourceBytes: bytes };
  })().catch((e) => { assetPromise = null; throw e; });
  return assetPromise;
}

const REPEAT_SAMPLER = {
  minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear',
  addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8,
};

/** Upload the four tiled ground maps. Returns null if any is missing. */
export function createGroundTextures(device, images) {
  if (!device || !images) return null;
  const need = ['ground106-albedo', 'ground106-normal', 'ground106-orm', 'macro-noise'];
  if (need.some((id) => !images[id])) return null;
  const make = (id) => device.createTexture({ id: `tz-${id}`, data: images[id], mipmaps: true, sampler: REPEAT_SAMPLER });
  const textures = {
    albedo: make('ground106-albedo'),
    normal: make('ground106-normal'),
    orm: make('ground106-orm'),
    macro: make('macro-noise'),
  };
  // Resident bytes with a full mip chain: w*h*4 * 4/3.
  textures.bytes = need.reduce((sum, id) => sum + Math.round(images[id].width * images[id].height * 4 * 4 / 3), 0);
  return textures;
}

/**
 * Upload the 16³ grade LUT as a 256x16 strip. Clamped, linear, no mips.
 * Returns `{texture, bytes}` — a luma Texture is sealed, so its size cannot be hung off it.
 */
export function createLutTexture(device, images) {
  const image = images?.['overcast-grade-lut'];
  if (!device || !image) return null;
  const texture = device.createTexture({
    id: 'tz-grade-lut',
    data: image,
    mipmaps: false,
    sampler: { minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' },
  });
  return { texture, bytes: image.width * image.height * 4 };
}

// ---------------------------------------------------------------------------- post grade
const LUT_SIZE = 16; // scripts/lib/imagegen.mjs GRADE_DEFAULTS.size

/**
 * One combined pass: FXAA (optional) -> 16³ LUT grade -> vignette -> grain.
 *
 * `x = b*size + r`, `y = g` is the strip layout scripts/lib/imagegen.mjs writes; the two blue
 * slices are sampled and mixed so the 16-step blue axis does not band.
 *
 * The grain is a hash of the pixel coordinate ONLY — no time term — so a screenshot of the same
 * frame is byte-identical on every run, which the plan's comparison harness depends on.
 */
function gradeModule(post, backdrop, fogColor) {
  const N = LUT_SIZE;
  const fxaa = post.fxaa ? 1 : 0;
  // The sky ramp, expressed as a MULTIPLIER on the far-fog value so it can be applied to whatever
  // shade of atmosphere a pixel happens to be sitting at. Zero strength compiles to a no-op branch.
  const ratio = (hex) => rgb01(hex).map((c, i) => (rgb01(fogColor)[i] > 0 ? c / rgb01(fogColor)[i] : 1));
  const ZENITH = glslVec3(ratio(backdrop.skyZenith));
  const HORIZON = glslVec3(ratio(backdrop.skyHorizon));
  const FOGFAR = glslVec3(rgb01(fogColor));
  const sky = backdrop.skyStrength > 0 && backdrop.skyTolerance > 0;
  return {
    name: 'tzGrade',
    fs: `
uniform sampler2D lut;

vec3 tzGrade_lut(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float sz = ${f(N)};
  float b = c.b * (sz - 1.0);
  float b0 = floor(b), b1 = min(b0 + 1.0, sz - 1.0);
  float u = c.r * (sz - 1.0) + 0.5;
  float v = (c.g * (sz - 1.0) + 0.5) / sz;
  vec3 s0 = texture(lut, vec2((b0 * sz + u) / (sz * sz), v)).rgb;
  vec3 s1 = texture(lut, vec2((b1 * sz + u) / (sz * sz), v)).rgb;
  return mix(s0, s1, b - b0);
}

float tzGrade_luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Compact FXAA 3.11-style edge blend: luma gradient over the 4-neighbourhood, one blended tap
// along the dominant edge direction. Enough to take the shimmer off rails and foliage edges.
vec3 tzGrade_fxaa(sampler2D src, vec2 texSize, vec2 uv) {
  vec2 px = 1.0 / texSize;
  vec3 rgbM = texture(src, uv).rgb;
  float lM = tzGrade_luma(rgbM);
  float lNW = tzGrade_luma(texture(src, uv + vec2(-1.0, -1.0) * px).rgb);
  float lNE = tzGrade_luma(texture(src, uv + vec2( 1.0, -1.0) * px).rgb);
  float lSW = tzGrade_luma(texture(src, uv + vec2(-1.0,  1.0) * px).rgb);
  float lSE = tzGrade_luma(texture(src, uv + vec2( 1.0,  1.0) * px).rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) return rgbM;
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * px;
  vec3 a = 0.5 * (texture(src, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(src, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(src, uv - dir * 0.5).rgb + texture(src, uv + dir * 0.5).rgb);
  float lB = tzGrade_luma(b);
  return (lB < lMin || lB > lMax) ? a : b;
}

vec4 tzGrade_sampleColor(sampler2D src, vec2 texSize, vec2 uv) {
  vec3 c = ${fxaa ? 'tzGrade_fxaa(src, texSize, uv)' : 'texture(src, uv).rgb'};
${sky ? `  {
    // Sky ramp: only pixels that ARE atmosphere (already at the far-fog value) take it.
    float skyness = 1.0 - smoothstep(0.0, ${f(backdrop.skyTolerance)}, length(c - ${FOGFAR}));
    // deck's screen pass puts uv.y = 1 at the TOP of the frame, so the zenith is at 1 - uv.y = 0.
    vec3 ramp = mix(${ZENITH}, ${HORIZON}, clamp(1.0 - uv.y, 0.0, 1.0));
    c = mix(c, c * ramp, skyness * ${f(backdrop.skyStrength)});
  }
` : ''}  c = tzGrade_lut(c);
  vec2 d = uv - 0.5;
  float vig = 1.0 - ${f(post.vignette)} * dot(d, d) * 2.0;
  c *= clamp(vig, 0.0, 1.0);
  float g = fract(sin(dot(uv * texSize, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += g * ${f(post.grain)};
  return vec4(clamp(c, 0.0, 1.0), 1.0);
}
`,
    passes: [{ sampler: true }],
  };
}

/**
 * The single combined grade pass for one look, or `null` when the look disables post (vector) or
 * the LUT has not uploaded yet.
 */
export function gradeEffectFor(look, lut) {
  const mode = resolveLook(look);
  const style = styleFor(mode);
  if (!style.post.enabled || !lut?.texture) return null;
  return new PostProcessEffect(gradeModule(style.post, BACKDROP[mode], style.fog.color), { lut: lut.texture });
}

/** The post block from the contract, so callers can report what was applied. */
export const postFor = (look) => styleFor(resolveLook(look)).post;
