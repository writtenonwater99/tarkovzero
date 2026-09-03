/**
 * Place-label TIERS — the vocabulary, and the style contract each tier resolves to.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026-09-02 a place label's only differentiator was an optional `size` percentage, present
 * on 19 of Customs' 32 rows and spanning 80–90 against a default of 100. A 20 % range, hand-tuned
 * row by row, with no rule behind it: FORTRESS (1,538 m², 18.1 m tall, an extract 26 m away),
 * WAREHOUSE 3 and an unnamed shed all read at the same weight, and the 2D/3D renderers each
 * re-derived "major" as `(size ?? 100) >= 100` — a threshold no data point was ever chosen against.
 *
 * `size` is GONE. Every label carries exactly one `tier` from `TIERS`, and the tier — not the row —
 * decides how it draws and when it appears. How each label got its tier is derived from public
 * repo evidence and is stated at the top of `src/labels.js`; the derivation is re-run and asserted
 * by `scripts/label-tier.test.mjs`, so a hand-edited tier fails the suite instead of drifting.
 *
 * This module is PURE and DEPENDENCY-FREE on purpose: it is imported by the 2D layer, the 3D
 * TextLayer, the build scripts and the tests, none of which may pull a renderer in behind it.
 *
 * THE FOUR TIERS
 * --------------
 *   landmark  the handful of places a player navigates the whole map by
 *   building  named buildings you'd call out on comms
 *   minor     named but secondary structures
 *   zone      areas / regions rather than buildings
 *
 * THINNING IS PART OF THE CONTRACT, NOT A RENDERER OPTION
 * ------------------------------------------------------
 * Each tier declares the scale at which it STARTS drawing. Landmarks survive to the furthest zoom
 * out; zones appear last. That ladder is the thing that stops the wall-of-names at map scale, so
 * a renderer that draws every tier at every zoom is not implementing this contract.
 *
 * UNITS — read before consuming
 * -----------------------------
 *   fontSizePx        CSS pixels. The BASE size, i.e. the size at `REFERENCE_MPP` (1.0 m/px).
 *                     A renderer is free to ramp size with zoom; what the contract fixes is the
 *                     RATIO between tiers, which is what makes FORTRESS outrank a shed.
 *   fontWeight        CSS numeric font weight, 100–900.
 *   letterSpacingEm   em, i.e. relative to the resolved font size (CSS `letter-spacing: <n>em`).
 *   textTransform     CSS `text-transform` value: 'uppercase' | 'none'.
 *   color             { ink, halo, haloPx, inkOnLight, haloOnLight } — `ink`/`halo` are the dark
 *                     bases (satellite / 3D / realistic); `*OnLight` are the roadmap base, where
 *                     the ground is pale and the ink has to invert. `haloPx` is the halo/outline
 *                     radius in CSS pixels.
 *   stemPx            CSS pixels of leader between the label's ground anchor and its baseline —
 *                     the 3D "ring / stem / cap" ping, and the 2D vertical offset. `zone` is 0 BY
 *                     DEFINITION: an area has no single anchor point to stand a stem on.
 *   showAtOrBelowMetresPerPixel
 *                     METRES PER PIXEL, the one scale unit both views already agree on
 *                     (`src/camera.js`: 2D m/px = 1 / (|transform[0]| · 2^zoom2d);
 *                      3D m/px = 1 / 2^zoom3d). The tier draws when the current scale is AT OR
 *                     BELOW this number — smaller m/px means more zoomed IN, so a LARGER threshold
 *                     means the tier survives further zoomed OUT. Expressing the threshold in m/px
 *                     rather than a zoom integer is deliberate: Customs, Reserve and Woods have
 *                     three different CRS scales (offsets 2.065 / 1.340 / 2.431), so one zoom
 *                     number means three different real-world scales. Use `minZoom2dFor()` /
 *                     `minZoom3dFor()` below to get a zoom number for a specific map.
 *
 * CALIBRATION HONESTY: `landmark` and `building` are seeded from the fit framing of the three
 * shipped maps (Customs fits at ≈0.9 m/px, Woods' 2D contain fit at zoom 1.69 ≈ 1.67 m/px), so
 * that a whole-map view shows landmarks — and, on the tighter maps, buildings — and nothing else.
 *
 * `minor` (2026-09-02, founder's ruling — "all the building names should be on except the small
 * huts") is calibrated against a DIFFERENT, closer framing: the live 3D default view, measured at
 * 0.776–1.0 m/px (`docs/CONTINUATION-HANDOFF-2026-09-02.md` §"CURRENT BEHAVIOUR"). 1.05 clears the
 * top of that measured range with headroom, so every `minor` label — a named building, per the
 * derivation below — draws at the framing the founder actually looks at, while staying below
 * `building`'s 1.20 (so the two full-map-fit framings above are unaffected). `zone` stays at 0.30,
 * below the whole measured default-framing range, so areas and genuine "small huts" (see
 * `MIN_STRUCTURE_M2` in `src/labels.js` — the floor that keeps a hut out of `minor` in the first
 * place) are the only things still thinned out there.
 *
 * None of the four has been measured against real frames on a real GPU. They are a starting
 * calibration, and the founder's eye is the instrument that settles them.
 */

/** The tier vocabulary, ordered from most to least important. Order is load-bearing: it is also
 *  the draw/thinning order, and `TIER_RANK` is derived from it. */
export const TIERS = Object.freeze(['landmark', 'building', 'minor', 'zone']);

/** tier -> 0..3. Lower rank = more important = drawn on top, and thinned last. */
export const TIER_RANK = Object.freeze(Object.fromEntries(TIERS.map((t, i) => [t, i])));

/** Every property a tier MUST resolve. A test asserts the contract is total against this list. */
export const STYLE_KEYS = Object.freeze([
  'fontSizePx',
  'fontWeight',
  'letterSpacingEm',
  'textTransform',
  'color',
  'stemPx',
  'showAtOrBelowMetresPerPixel',
]);

/** Every property `style.color` MUST resolve. */
export const COLOR_KEYS = Object.freeze(['ink', 'halo', 'haloPx', 'inkOnLight', 'haloOnLight']);

/** The scale `fontSizePx` is authored at, in metres per pixel. */
export const REFERENCE_MPP = 1.0;

/** The one ink used to punch a label out of a dark ground, and its pale-ground counterpart.
 *  Same values the 2D CSS and the 3D TextLayer already use — this is a move, not a repaint. */
const HALO_DARK = '#0E1110';
const HALO_LIGHT = '#FFFFFF';

export const TIER_STYLE = Object.freeze({
  // The map's skeleton. Full caps, widest tracking, brightest ink, longest stem, and visible at
  // any scale the three maps can actually reach (the largest, Woods, tops out near 2.7 m/px).
  landmark: Object.freeze({
    fontSizePx: 15,
    fontWeight: 700,
    letterSpacingEm: 0.085,
    textTransform: 'uppercase',
    color: Object.freeze({ ink: '#F2EFE6', halo: HALO_DARK, haloPx: 3, inkOnLight: '#232827', haloOnLight: HALO_LIGHT }),
    stemPx: 30,
    showAtOrBelowMetresPerPixel: 6.0,
  }),
  // Named buildings. Still caps so they read as structures, one step down in size and tracking.
  building: Object.freeze({
    fontSizePx: 13,
    fontWeight: 700,
    letterSpacingEm: 0.07,
    textTransform: 'uppercase',
    color: Object.freeze({ ink: '#E4E0D4', halo: HALO_DARK, haloPx: 2.5, inkOnLight: '#2B3130', haloOnLight: HALO_LIGHT }),
    stemPx: 24,
    showAtOrBelowMetresPerPixel: 1.2,
  }),
  // Secondary structures. Sentence case is the register change that matters more than the 1.5 px:
  // caps read as "this is a place", mixed case reads as "this is a detail". Threshold calibrated
  // to the live 3D DEFAULT framing (measured 0.776-1.0 m/px), not a full-map fit like the two
  // tiers above — the founder's ruling was "all the building names should be on except the small
  // huts", and a named building only reaches `minor` after clearing MIN_STRUCTURE_M2 in
  // src/labels.js, so every row here is a building, never a hut.
  minor: Object.freeze({
    fontSizePx: 11.5,
    fontWeight: 600,
    letterSpacingEm: 0.045,
    textTransform: 'none',
    color: Object.freeze({ ink: '#CFCCC1', halo: HALO_DARK, haloPx: 2, inkOnLight: '#3E4643', haloOnLight: HALO_LIGHT }),
    stemPx: 16,
    showAtOrBelowMetresPerPixel: 1.05,
  }),
  // Areas. Cartography's convention for a region: light, widely tracked caps, low contrast, and
  // NO stem — the name belongs to the ground it is written across, not to a point on it.
  zone: Object.freeze({
    fontSizePx: 11.5,
    fontWeight: 500,
    letterSpacingEm: 0.16,
    textTransform: 'uppercase',
    color: Object.freeze({ ink: '#B9BDB0', halo: HALO_DARK, haloPx: 2, inkOnLight: '#4A524D', haloOnLight: HALO_LIGHT }),
    stemPx: 0,
    showAtOrBelowMetresPerPixel: 0.3,
  }),
});

/** True for a string that is one of the four tiers. */
export const isTier = (v) => Object.prototype.hasOwnProperty.call(TIER_STYLE, v) && TIERS.includes(v);

/**
 * The style contract for one tier.
 * THROWS on an unknown tier — deliberately. A silent fallback to a default style is exactly the
 * failure mode this project keeps hitting (handoff §6): the map would render, look plausible, and
 * be wrong. Fail where the bad value is, not three layers downstream.
 */
export function styleFor(tier) {
  if (!isTier(tier)) throw new TypeError(`label-tier: unknown tier ${JSON.stringify(tier)}; expected one of ${TIERS.join(', ')}`);
  return TIER_STYLE[tier];
}

/**
 * The tier of one label row. THROWS if the row has no valid `tier`, for the same reason as above:
 * a label that lost its tier must not quietly inherit `landmark` (or `minor`) and be believed.
 */
export function tierOf(label) {
  const t = label?.tier;
  if (!isTier(t)) throw new TypeError(`label-tier: label ${JSON.stringify(label?.text ?? label)} has no valid tier (got ${JSON.stringify(t)})`);
  return t;
}

/** Does this tier draw at this scale? `mpp` = metres per pixel (see units note above). */
export function visibleAtMpp(tier, mpp) {
  return Number(mpp) <= styleFor(tier).showAtOrBelowMetresPerPixel;
}

/** Every tier that draws at this scale, in `TIERS` order. */
export function tiersAtMpp(mpp) {
  return TIERS.filter((t) => visibleAtMpp(t, mpp));
}

/* ------------------------------------------------------------------ scale --- */
/* The two conversions, restated from src/camera.js so a consumer of this contract never has to
 * re-derive them. `crsScale` is |mapData.transform[0]| — 0.239 on Customs, 0.395 on Reserve,
 * 0.185 on Woods. */

/** metres per pixel at a 2D Leaflet zoom, for a map with this CRS scale. */
export const metresPerPixel2d = (zoom2d, crsScale) => 1 / (crsScale * 2 ** zoom2d);

/** metres per pixel at a 3D deck OrbitView zoom. */
export const metresPerPixel3d = (zoom3d) => 1 / 2 ** zoom3d;

/** The 2D Leaflet zoom at which `tier` starts drawing on a map with this CRS scale. */
export function minZoom2dFor(tier, crsScale) {
  return -Math.log2(styleFor(tier).showAtOrBelowMetresPerPixel * crsScale);
}

/** The 3D deck zoom at which `tier` starts drawing. Map-independent: deck's m/px is 1 / 2^zoom. */
export function minZoom3dFor(tier) {
  return -Math.log2(styleFor(tier).showAtOrBelowMetresPerPixel);
}
