/**
 * Building seating — where a building's walls meet the draped ground, and what fills the gap.
 *
 * This module is PURE (no deck, no DOM, no module-level colour tables) for one reason: it is the
 * single definition of a building's vertical extent, and `scripts/building-height-test.mjs` has to
 * be able to assert against the very functions the renderer runs, not a re-implementation of them.
 *
 * ---------------------------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT (2026-08-30, founder report on a real GPU: "buildings have like a
 * foundation that makes it look like a 10 story building when it's 3")
 *
 * Building heights are REAL metres. The ground under them is not: `H()` multiplies the terrain by
 * the view's relief factor (3x by default), so the cross-slope under a footprint is exaggerated
 * threefold. The pre-fix seating did two things that turned that exaggeration into storeys:
 *
 *   1. it seated the walls on the HIGHEST sampled ground under the footprint, so the building stood
 *      on stilts over its own downhill corner by the full (slope x relief); and
 *   2. it closed that stilt gap with a plinth drawn in the WALL COLOUR (`wall x 0.7`), extruded,
 *      LIT, and expanded 0.25 m outward — a literal foundation, in building material.
 *
 * On Customs at relief 3 that put 19.3 m of lit, wall-coloured mass under Dorms 3-Story's 9.5 m
 * roof: 5.8 storeys of apparent building for a 3-storey block.
 *
 * The rules now:
 *
 *   - The walls sit on the ground under the footprint CENTROID (`contact`), so relief tips a
 *     building INTO its hill instead of stilting it above the downhill corner, and the visible
 *     wall above the roof's contact point is exactly `b.height` at every relief setting.
 *   - Below that, the downhill gap is closed by a skirt that is NOT the wall: near-black, unlit,
 *     not expanded outward, and capped, so it reads as the shadow under a building rather than as
 *     more building. `plinthColor()` is the only place its tint is decided.
 *   - Storey separators and window bands come from `floorLevels()`, which is a function of the REAL
 *     height and floor count and never of the extruded span.
 */

/** Nominal storey. The data's `floors` x this is what the detail recipes band against. */
export const STOREY_M = 3.3;
/** The walls stand this far proud of their contact ground so they never z-fight the mesh. */
export const WALL_LIFT = 0.06;
/** The skirt always shows a little, even on flat ground, so a building meets the earth. */
export const PLINTH_MIN_M = 0.35;
/** The skirt's top laps this far up behind the wall base, so the seam cannot open. */
export const PLINTH_OVERLAP_M = 0.12;
/** The skirt is inset/expanded by this much only — never the old 0.25 m foundation ledge. */
export const PLINTH_EXPAND_M = 0.06;

/**
 * How deep a building may be cut into its uphill ground before the seat is pulled back up.
 * A safety valve for pathological relief-3 cross-slopes (Customs' Skeleton drops 9.4 m across its
 * own footprint at 3x), not a routine clamp: none of the audited landmarks reach it.
 */
export const buryAllowance = (height) => Math.max(2.5, (height || 0) * 0.8);
/** How far the dark skirt may reach below the wall base before it stops growing. */
export const skirtCap = (height) => Math.max(1.5, (height || 0) * 0.6);

/** The footprint centroid — the point the seat is taken at. */
export const centroidOf = (poly) => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);

/**
 * The points a footprint's ground is judged from: the centroid, every vertex, every edge midpoint.
 * A 4-vertex warehouse whose long edges cross a ridge needs the midpoints or the ridge is missed.
 */
export function footprintPoints(poly) {
  const mids = poly.map((p, i) => [(p[0] + poly[(i + 1) % poly.length][0]) / 2, (p[1] + poly[(i + 1) % poly.length][1]) / 2]);
  return [centroidOf(poly), ...poly, ...mids];
}

/** `{ lo, hi, contact }` in DISPLAYED metres (relief already applied by `H`). */
export function groundStats(poly, H) {
  const c = centroidOf(poly);
  let lo = Infinity, hi = -Infinity;
  for (const p of footprintPoints(poly)) { const h = H(p[0], p[1]); if (h < lo) lo = h; if (h > hi) hi = h; }
  return { lo, hi, contact: H(c[0], c[1]) };
}

/**
 * Seat one building. Returns displayed-metre levels; does not mutate.
 *
 *   base        wall bottom == roof plane minus `height`
 *   contact     the draped ground the wall is seated on (the centroid pad)
 *   plinthBase  bottom of the dark skirt
 *   plinthHeight height of the dark skirt (its top laps behind the wall base)
 */
export function seatBuilding(b, H) {
  const { lo, hi, contact } = groundStats(b.poly, H);
  const height = b.height ?? 0;
  // Cut into the hill, but never so deep that the roof vanishes into it.
  const base = Math.max(contact, hi - buryAllowance(height)) + WALL_LIFT;
  const gap = Math.max(PLINTH_MIN_M, base - lo);
  const drop = Math.min(gap, skirtCap(height));
  return { base, contact, lo, hi, plinthBase: base - drop, plinthHeight: drop + PLINTH_OVERLAP_M };
}

/** Write the seat onto the building rows the renderer reads. */
export function placeBuildings(buildings, H) {
  for (const b of buildings) {
    const s = seatBuilding(b, H);
    b.base = s.base; b.contact = s.contact;
    b.plinthBase = s.plinthBase; b.plinthHeight = s.plinthHeight;
  }
  return buildings;
}

/**
 * The metres of WALL MATERIAL standing above the draped ground at the roof's contact point.
 *
 * This is the number the founder reads off the screen as "storeys", and it must equal the data's
 * real height at every relief setting. The dark skirt is deliberately excluded: it is a different
 * material in a different, unlit layer, and `plinthColor()` is asserted near-black so it cannot
 * quietly become wall again.
 */
export function visibleWallHeight(b, H) {
  const { base, contact } = seatBuilding(b, H);
  return base + (b.height ?? 0) - contact;
}

/**
 * Storey separators / window bands, from the REAL height and floor count.
 * `inset` drops the band below the slab line; `clearance` keeps it off the parapet.
 */
export function floorLevels(b, { inset = 0, clearance = 0.4 } = {}) {
  const h = b.height ?? 0, n = Math.max(0, Math.floor(b.floors ?? 1));
  const out = [];
  for (let k = 1; k <= n; k++) {
    const z = k * STOREY_M - inset;
    if (z > h - clearance) break;
    out.push(z);
  }
  return out;
}

/**
 * The skirt's tint. Near-black in both skins and drawn with `material: false`, so it takes no key
 * light and reads as the shadow a building sits in — never as another storey of wall.
 */
export function plinthColor(look) {
  return look === 'realistic' ? [15, 16, 15, 255] : [19, 21, 19, 255];
}
