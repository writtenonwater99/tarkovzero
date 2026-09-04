/**
 * Marker level of detail — one rule, shared by the 2D map and the 3D diorama.
 *
 * The red team's finding #12 was that "below fit-zoom+1" is not a threshold: fit zoom is a
 * function of the map's size and the window's, so the same rule draws dots on Customs and badges
 * on Woods. The physical quantity a player actually reads is **metres per pixel** — how much
 * ground one screen pixel covers — so that is what the tiers are cut on.
 *
 * Measured on a 1400x985 viewport (the QA window):
 *
 *   map      cover-fit m/px      +1 zoom     +2 zooms
 *   Customs      0.55             0.276        0.138
 *   Reserve      0.42             0.21         0.106
 *   Woods        1.01             0.50         0.25
 *
 * Leaflet's zoomDelta is 0.5, so the stops a wheel or a +/- click actually lands on are
 * … 0.552, 0.391, 0.276, 0.195, 0.138 … The boundaries below sit on the geometric midpoints
 * BETWEEN two stops (0.465 = √(0.552·0.391), 0.165 = √(0.195·0.138)), so no ordinary zoom stop
 * lands inside a hysteresis band and the tier never depends on which direction you arrived from:
 *
 *   dot   m/px > 0.465     cover fit only            — 6 px desaturated dots, no glyph
 *   icon  0.165 < m/px ≤ 0.465  half a zoom in       — badge, no label
 *   full  m/px ≤ 0.165     two zooms in              — badge + label on hover/selection
 *
 * WHY 0.465 AND NOT 0.33 (2026-09-03). The dot|icon boundary was one stop finer, at
 * 0.33 = √(0.391·0.276), which put the whole of `fit + one half-step` in the dot tier. The founder
 * read that as a bug rather than a tier: at the permalink #3.48/257.7/-42.3 (0.375 m/px) he got
 * 6 px dots — "pmc spawns and other icons are hard to see" — and at #3.92/257.9/-22.1
 * (0.276 m/px) badges — "at this distance they are fine. so bring the same size for the other
 * one." Moving the boundary out by exactly one zoom stop puts both of his cameras in `icon`, which
 * is what "the same size" means, and it is the same construction as before, not a new constant:
 * the geometric midpoint of the next pair of stops. Cover fit is still `dot` on Customs (0.552)
 * and on Woods (1.005); the tier the map opens at has not changed. Reserve's cover fit (0.423)
 * moves from `dot` to `icon` — it is a small map and 0.423 m/px is a badge-reading scale by the
 * same physical rule that decides everything else here. Reserve is not a shipped map today, and if
 * that ever reads wrong the answer is a Reserve zoom-stop table, not a per-map tier.
 *
 * Hysteresis is ±10% around each boundary: crossing it only changes the tier once you are 10%
 * past it, so panning or a trackpad wheel that dithers across a boundary cannot flicker.
 *
 * What the tier is allowed to do, by layer — this is the exemption from red-team row 12, written
 * as what the two renderers actually do rather than as a slogan:
 *
 *   extracts (`extract-*`, transits included), live players
 *       fully exempt. Never clustered, never dimmed to a dot, never resized. They are what the
 *       map is FOR, and a player looking for the way out is usually zoomed out.
 *   objectives of a selected quest
 *       exempt from the two things that lose information: they are never clustered and never
 *       hidden, at any tier. They DO get quieter below `full` — 30% smaller, and the numbered
 *       badge gives way to the plain objective glyph (2D: quests.js questIcon; 3D: map3d.js
 *       questLayers). At fit zoom the gold hexes were bigger than the terrain they point at and
 *       their numbers were too small to read anyway (Gemini pass, commit 269e9ae); the numbers
 *       are for reading a checklist against the map, which is a zoomed-in job. Amended into
 *       UI-REWORK.md row 12 — if you change this, change that row too.
 *   everything else
 *       clustered and tiered as above.
 */

/** Coarse to fine. The index in this array is the tier's rank. */
export const TIERS = ['dot', 'icon', 'full'];
/** BOUNDS[i] separates TIERS[i] from TIERS[i + 1], in metres per pixel. */
export const BOUNDS = [0.465, 0.165];
/** Fraction of a boundary you must overshoot before the tier changes. */
export const HYSTERESIS = 0.1;

/** The tier a metres-per-pixel value falls in, ignoring where you came from. */
export function tierOf(mpp) {
  const m = Number(mpp);
  if (!Number.isFinite(m) || m <= 0) return 'full';
  for (let i = 0; i < BOUNDS.length; i++) if (m > BOUNDS[i]) return TIERS[i];
  return TIERS[TIERS.length - 1];
}

/**
 * The tier for `mpp` given the tier that is on screen right now.
 *
 * Pure and idempotent: tier(m, tier(m, p)) === tier(m, p), because the loop only steps while the
 * value is past a boundary by the hysteresis margin, and stops as soon as it is not.
 */
export function tier(mpp, prev = null) {
  const m = Number(mpp);
  if (!Number.isFinite(m) || m <= 0) return TIERS.includes(prev) ? prev : 'full';
  let t = TIERS.includes(prev) ? prev : tierOf(m);
  for (let guard = 0; guard < TIERS.length + 1; guard++) {
    const i = TIERS.indexOf(t);
    if (i < BOUNDS.length && m <= BOUNDS[i] * (1 - HYSTERESIS)) { t = TIERS[i + 1]; continue; }
    if (i > 0 && m >= BOUNDS[i - 1] * (1 + HYSTERESIS)) { t = TIERS[i - 1]; continue; }
    return t;
  }
  return t;
}

/* --------------------------------------------------------------- shared state --- */
// 2D and 3D are never on screen at the same time and they read the same zoom, so one module-level
// tier keeps them in step across a view switch instead of each side hysteresing on its own.
let current = 'dot';
/** Fold a new m/px into the shared tier and return it. */
export function updateTier(mpp) { current = tier(mpp, current); return current; }
export const currentTier = () => current;
export const setTier = (t) => { current = TIERS.includes(t) ? t : 'dot'; return current; };

/* ------------------------------------------------------------------ clustering --- */
/** Screen size of a cluster cell. 24 px ≈ one badge, so two badges never overlap inside a cell. */
export const CLUSTER_PX = 24;

/**
 * Does a cluster at this tier get a count bubble?
 *
 * No, at `dot`. At fit zoom the map is already carrying ~100 marks; hanging an 8 px "2" off every
 * second one adds a number nobody can read and a second shape to decode, which is exactly the
 * "marker soup" the tier was cut to remove. A cluster at `dot` says "more than one here" the only
 * way a 6 px mark can — by being a little bigger than its neighbours. The count comes back with the
 * badge, from `icon` in, where there is room to read it. Shared by 2D (icons.js clusterHtml) and 3D
 * (map3d.js cluster-counts) so the two views can never disagree about it.
 */
export const countsVisible = (t) => t !== 'dot';
/** How much bigger a dot-tier cluster is than a lone dot: 6 px -> 9 px. */
export const CLUSTER_DOT_PX = 9;
/** Cell size in metres for a given m/px — the grid is in WORLD units, so panning cannot reshuffle it. */
export const cellFor = (mpp, px = CLUSTER_PX) => Math.max(1e-6, Number(mpp) * px);

const XZ = (d) => [d.position.x, d.position.z];

/**
 * Grid-cluster points into ~`cell`-metre squares anchored at the world origin.
 *
 * Deterministic by construction: membership depends only on the coordinates and the cell size
 * (never on the pan offset or the input order), clusters come back sorted by cell key, and each
 * cluster's members are sorted by coordinate before the centroid is summed — so the same viewport
 * always yields the same clusters, in the same order, with bit-identical centroids.
 *
 * @returns {{key:string,count:number,x:number,z:number,points:any[]}[]}
 */
export function clusterPoints(items, cell, get = XZ) {
  if (!Array.isArray(items) || !items.length) return [];
  const c = Number(cell);
  const cells = new Map();
  for (const it of items) {
    const [x, z] = get(it);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const key = Number.isFinite(c) && c > 0 ? `${Math.floor(x / c)}|${Math.floor(z / c)}` : `${x}|${z}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(it); else cells.set(key, [it]);
  }
  const out = [];
  for (const [key, members] of [...cells.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const points = members.length < 2 ? members : [...members].sort((a, b) => {
      const [ax, az] = get(a), [bx, bz] = get(b);
      return ax - bx || az - bz;
    });
    let sx = 0, sz = 0;
    for (const p of points) { const [x, z] = get(p); sx += x; sz += z; }
    out.push({ key, count: points.length, x: sx / points.length, z: sz / points.length, points });
  }
  return out;
}
