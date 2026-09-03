// Where the river's surface sits, and why the answer changes when exact terrain is mounted.
//
// THE DEFECT THIS EXISTS FOR. `map3d-three.js` used to seat every water sheet at
// `level * relief`, where `level` is a field of `public/data/customs-3d.json`'s water rows. That
// number is fitted: it comes from the same interpolated public heightfield the terrain used to
// come from, and that heightfield is fitted from SPT spawn and loose-loot points, which never sit
// on a riverbed. Once the EXACT local terrain mounts, the ground under the river drops to its real
// canonical depth while `level` does not move, so the water sheet ends up metres above the bed —
// and above anything seated against that bed. The Junk Bridge's plank decks, seated
// terrain-relative from their canonical game Y, went under the sheet and disappeared entirely
// while every applied/replaced counter stayed green. Handoff §6: a metric that cannot fail is
// worse than no metric, so the seating decision is a value here and the clearance it produces is
// reported, not assumed.
//
// THE RULE, and the honest part. There is NO water-surface evidence. The 460 MB scalar facts dump
// was searched for a water object under 196 candidate names and has none, so the surface height is
// an explicit UNKNOWN. What is derivable is where the water MEETS THE LAND: the water polygons'
// outlines are traced from tarkov.dev's SVG — an acquisition wholly independent of the game
// install — and a shoreline is by definition the line along which the surface touches the ground.
// So with exact terrain mounted the sheet is seated at the DISPLAY height of the exact terrain at
// a representative shoreline vertex. That keeps the sheet flat, makes its own edge meet the ground
// it is drawn against, and reuses the renderer's terrain samplers rather than re-deriving the
// relief transform here — the rule is correct at any relief because it never does the arithmetic.
//
// Everything that follows from that is DERIVED, never measured: the outline is hand-traced, the
// terrain sample under it is exact but the trace's position is not, and a real river is not level
// over its whole reach. `spreadM` reports how badly one flat plane fits, so a reader can see the
// size of the assumption instead of trusting a tidy number. The founder's raids are the instrument
// that can settle this; until then the altitude is marked `provisional-unmeasured`, the same
// vocabulary `wall-runs.js` and `customs-local-bridges.js` use for everything else in this repo
// that was composed rather than measured.
//
// ESTIMATOR. The median of the outline's own terrain samples — the estimator this repo already
// uses for a surface altitude (`Main Bridge.surfaceY` is the median of its evidence samples). Hole
// rings (the mid-river island) are deliberately EXCLUDED: an island outline is a short ring on the
// steepest ground inside the polygon, so its samples are dominated by tracing error rather than by
// the waterline, and only one of the three Customs polygons has one — including them would give
// the estimator a different meaning per polygon. `shoreline.holeRings` reports how many rings were
// left out so the exclusion is visible rather than silent.

export const WATER_SURFACE_SEATING = Object.freeze({
  /** The shipped fitted `level`, multiplied by relief. Production, and any run without exact terrain. */
  PUBLIC_LEVEL: 'public-fitted-level',
  /** The display height of the exact terrain at a representative shoreline vertex. */
  EXACT_SHORELINE: 'exact-terrain-shoreline',
});

/** Same token `wall-runs.js` and `customs-local-bridges.js` mark unmeasured dimensions with. */
export const PROVISIONAL_UNMEASURED = 'provisional-unmeasured';

const PUBLIC_LEVEL_SOURCE =
  'public/data/customs-3d.json water[].level, fitted from the interpolated public heightfield '
  + '(SPT spawn + loose-loot points, which never sit on a riverbed); multiplied by display relief';

const SHORELINE_SOURCE =
  'median of the EXACT local canonical terrain sampled at the vertices of this polygon\'s '
  + 'tarkov.dev-traced outline, converted to display height through the renderer\'s own terrain '
  + 'sampler. NOT a measurement: no water-surface object exists in the facts dump under any of 196 '
  + 'candidate names, the outline is hand-traced, and one flat plane cannot fit a real river reach '
  + '(see spreadM). Known constraint, not evidence: the Junk Bridge planks are walkable in game, so '
  + 'the true surface lies below them.';

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const ringPoints = (ring) => (Array.isArray(ring) ? ring : []).filter((point) =>
  Array.isArray(point) && finite(point[0]) != null && finite(point[1]) != null);

function publicLevelPlan(water, relief, lift, reason) {
  const factor = finite(relief) ?? 1;
  return Object.freeze({
    mode: WATER_SURFACE_SEATING.PUBLIC_LEVEL,
    reason,
    displayY: ((finite(water?.level) ?? 0) * factor) + lift,
    level: Object.freeze({ status: PROVISIONAL_UNMEASURED, source: PUBLIC_LEVEL_SOURCE }),
    shoreline: null,
  });
}

/**
 * Decide one water polygon's display altitude.
 *
 * `canonicalGroundAt` / `displayGroundAt` are the renderer's OWN pair of samplers — the same two
 * `displayCanonicalObjectY` seats every canonical object against. Pass them only when the exact
 * local terrain is mounted; with the public heightfield they must be null, and the plan then
 * reproduces the shipped expression `level * relief + lift` exactly, which is what keeps production
 * byte-for-byte unchanged.
 */
export function waterSurfacePlan(water, {
  relief = 1,
  lift = 0,
  canonicalGroundAt = null,
  displayGroundAt = null,
} = {}) {
  const bias = finite(lift) ?? 0;
  if (typeof canonicalGroundAt !== 'function' || typeof displayGroundAt !== 'function') {
    return publicLevelPlan(water, relief, bias, 'no-exact-terrain');
  }
  const outline = ringPoints(water?.poly);
  const samples = [];
  for (const point of outline) {
    const x = finite(point[0]), z = finite(point[1]);
    const canonicalYM = finite(canonicalGroundAt(x, z));
    if (canonicalYM != null) samples.push({ x, z, canonicalYM });
  }
  // Three vertices is the smallest ring that encloses anything; below that there is no shoreline
  // to read and the fitted level is still the best available answer, with the reason on record.
  if (samples.length < 3) return publicLevelPlan(water, relief, bias, 'insufficient-shoreline-samples');
  const sorted = [...samples].sort((a, b) => a.canonicalYM - b.canonicalYM);
  // For an even count take the LOWER middle sample: a water plane that errs downward exposes the
  // riverbed, one that errs upward drowns whatever stands in the channel — which is this defect.
  const anchor = sorted[Math.floor((sorted.length - 1) / 2)];
  const displayY = finite(displayGroundAt(anchor.x, anchor.z));
  if (displayY == null) return publicLevelPlan(water, relief, bias, 'shoreline-anchor-has-no-display-height');
  return Object.freeze({
    mode: WATER_SURFACE_SEATING.EXACT_SHORELINE,
    reason: 'exact-terrain-mounted',
    displayY: displayY + bias,
    level: Object.freeze({ status: PROVISIONAL_UNMEASURED, source: SHORELINE_SOURCE }),
    shoreline: Object.freeze({
      samples: samples.length,
      outlinePoints: outline.length,
      holeRings: Array.isArray(water?.holes) ? water.holes.length : 0,
      anchor: Object.freeze([anchor.x, anchor.z]),
      canonicalYM: anchor.canonicalYM,
      spreadM: sorted[sorted.length - 1].canonicalYM - sorted[0].canonicalYM,
    }),
  });
}

/** Even-odd ray cast. A ring is a closed polygon; the last vertex joins the first. */
function ringContains(ring, x, z) {
  const points = ringPoints(ring);
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = Number(points[i][0]), zi = Number(points[i][1]);
    const xj = Number(points[j][0]), zj = Number(points[j][1]);
    if ((zi > z) !== (zj > z) && x < (((xj - xi) * (z - zi)) / (zj - zi)) + xi) inside = !inside;
  }
  return inside;
}

/** True when (x, z) is inside the polygon and outside every island cut out of it. */
export function waterSurfaceContains(water, x, z) {
  if (!ringContains(water?.poly, x, z)) return false;
  return !(water?.holes || []).some((hole) => ringContains(hole, x, z));
}

/**
 * The highest water surface covering (x, z), or null where there is none.
 *
 * HIGHEST, not first: where sheets overlap, the one that would swallow an object is the one that
 * matters to the question this is asked for — is anything drawn here under water?
 */
export function waterSurfaceAt(plans, x, z) {
  let surface = null;
  for (const entry of Array.isArray(plans) ? plans : []) {
    if (!waterSurfaceContains(entry?.water, x, z)) continue;
    const displayY = finite(entry?.plan?.displayY);
    if (displayY != null && (surface == null || displayY > surface)) surface = displayY;
  }
  return surface;
}

/**
 * Least clearance a deck keeps over the water it crosses, sampled at its own path vertices.
 *
 * This is the number that would have caught the invisible Junk Bridge. `crossings` counts the
 * vertices that stand over water at all, so "no crossing" (null clearance, a bridge over dry land)
 * can never be mistaken for "clears the water everywhere".
 */
export function deckWaterClearance(path, deckYAt, plans) {
  let clearanceM = null;
  let crossings = 0;
  for (const point of ringPoints(path)) {
    const x = Number(point[0]), z = Number(point[1]);
    const surfaceY = waterSurfaceAt(plans, x, z);
    if (surfaceY == null) continue;
    const deckY = finite(deckYAt(x, z));
    if (deckY == null) continue;
    crossings += 1;
    const gap = deckY - surfaceY;
    if (clearanceM == null || gap < clearanceM) clearanceM = gap;
  }
  return { clearanceM, crossings };
}
