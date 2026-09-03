/**
 * Open structures — canopies and unfinished frames — as pure, GPU-free mesh data.
 *
 * `classifyAll()` routes six Customs buildings to `open-structure`: three `style: 'canopy'` decks
 * (New Gas 668 m2, Old Gas 164 m2, Bus Station 18.5 m2) and three `style: 'frame'` concrete
 * skeletons (Fortress 1538 m2, Skeleton 1522 m2, Old Construction "construction 2nd" 502 m2).
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE OPEN ONES READ, MEASURED RATHER THAN ASSERTED
 *
 * The brief says this archetype "already reads best of all the archetypes because they are open".
 * That is true of TWO of the six, and the reason is worth stating precisely because it is the thing
 * this module has to preserve:
 *
 *   Skeleton  reaches `buildOpenFrameBuildingAsset()` (src/three-prop-assets.js) — but ONLY via
 *             `safeText(building.place).toLowerCase() === 'skeleton' && height >= 8` at
 *             src/map3d-three.js:2481. A place-name literal, not a data rule.
 *   Fortress  reads well because it has an authored GLB (`customs.building.fortress.main`) and its
 *             procedural node is retired by `suppressedProceduralFeatures`. Nothing about the
 *             procedural path is doing that work.
 *
 * The other FOUR — Old Construction's frame and all three canopies — miss the name literal and fall
 * through to the ordinary `THREE.ExtrudeGeometry` branch. They are solid boxes today. A fuel canopy
 * drawn as a 4.8 m solid block is the single most obviously wrong object in this archetype, and a
 * 6.6 x 2.8 x 4.8 m solid block at a bus stop is the second.
 *
 * So "these already read best" is a statement about a name literal's two lucky hits, not about the
 * archetype. This module makes it a property of the DATA: every `open-structure` row gets the open
 * treatment because `style` says `canopy` or `frame`, and no string is compared to 'skeleton'.
 *
 * WHAT MAKES AN OPEN STRUCTURE READ, in one sentence: the eye reads the SPACING of its members and
 * the sky between them, never the thickness of a member.
 *
 * That is not a preference, it is the pixel budget. Metres-per-pixel is 2^-zoom and the default 3D
 * zoom is 0, so at the default view ONE PIXEL IS ONE METRE (decision 4). The existing frame asset's
 * 0.28-0.46 m posts are therefore SUB-PIXEL and contribute nothing on their own; what the founder is
 * actually seeing is a 7.5 m column rhythm (7-8 px), a 3-5 m deck pitch (3-5 px) and — decisively —
 * a silhouette that is mostly HOLE where every other archetype's is a filled rectangle. This module
 * reports that hole as a number, `elevationSolidFraction`, and the test pins it: a solid extrusion
 * scores 1.0, and anything over 0.45 has stopped being an open structure.
 *
 * Every member section below therefore lands in the same 0.24-0.7 m band the existing asset uses.
 * Growing them would "add detail" and destroy the only property that matters.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS MISSING, AND WHAT IS DELIBERATELY NOT ADDED
 *
 * Added, because the silhouette has no way to exist without it:
 *   columns      on a deterministic bay grid — the rhythm, and the only thing holding a deck up.
 *   decks/slabs  a canopy's one deck, a frame's per-level floor slabs.
 *   deck edge    a downstand band under every deck, in the `trim` slot. THIS is the element the
 *                brief names "deck edges, fascia" and it is the one that was actually absent: the
 *                existing asset's deck edge is a 0.13 m plate, sub-pixel and the same colour as the
 *                frame, so at the default view a frame's horizontal banding does not exist. One
 *                shade off the wall across a 0.35-0.9 m band is what makes a level line read.
 *
 * NOT added, deliberately:
 *   roofs        a frame has none — that is what the object IS (`roofForm: 'none'`), and the router
 *                doc is explicit that "an open frame's top is a floor slab".
 *   roof plant   there is no roof to put it on. Vents on a canopy would be an invented claim.
 *   interior beams  the existing asset draws beams on both axes at every level. They sit UNDER a
 *                full-plan slab and the camera pitches 50 degrees down, so they are occluded from
 *                every angle the map is ever seen at, at a cost of ~200 triangles per frame. Not
 *                rebuilt here.
 *   wall relief, ribs, pilasters   decision 4. Sub-pixel at the default view, and this archetype
 *                has no wall to put them on in the first place.
 *
 * ---------------------------------------------------------------------------------------------
 * `massDisposition` — THE ONE THING THE WIRING AGENT MUST NOT MISS
 *
 * Every other archetype's planner ADDS to a solid mass. This one REPLACES it. Columns inside a solid
 * extrusion are invisible, and a canopy is defined by the void under its deck; there is no version
 * of "add detail to the block" that produces a canopy. So each plan carries
 * `massDisposition: 'replace'`, and the renderer must skip `ExtrudeGeometry` for these six rows and
 * draw `plan.mesh` alone — exactly what src/map3d-three.js:2482 already does for Skeleton, but keyed
 * on the router instead of on a place name.
 *
 * Fortress is planned like the other five even though its GLB will retire the procedural node. That
 * is on purpose: a planner that returns `null` for it would guarantee a SOLID BOX on any run where
 * the authored asset fails to mount, and handoff section 6 lists five separate occasions on which
 * this project reported success while something had silently fallen back. The fallback here is an
 * open frame, not a block.
 *
 * ---------------------------------------------------------------------------------------------
 * PUBLIC DATA ONLY. Everything below derives from `poly`, `height`, `floors`, `style`, the seat and
 * the terrain sampler, all of which reach this module through `classifyBuilding()` and the planner
 * context. No game-derived coordinate, no traced asset, no landmark literal, and nothing random.
 *
 * `classification.seed` is deliberately UNUSED here. Variation between these six is fully DERIVED —
 * from footprint, height, floors and the ground each one stands on — and a hash would only add
 * noise on top of it. The one axis that looked like it needed a hash, which way a canopy drains,
 * turned out to be better answered by the terrain: see `planDetail`.
 *
 * Heights are never changed (handoff section 4, standing decision 4).
 */
import { MATERIAL_SLOT_INDEX, emptyDetailPlan } from './contract.js';
import { gameToWorld, inRing } from '../three-world.js';

const clamp = (low, value, high) => Math.min(high, Math.max(low, value));
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

// --------------------------------------------------------------------------------------------- //
// Frozen dimension tables. Every number states the rule it comes from.
// --------------------------------------------------------------------------------------------- //

export const OPEN_STRUCTURE = Object.freeze({
  /**
   * The reading scale. At the default 3D view one pixel is one metre, so a member SPACING below
   * this is a smear and a spacing above it is a rhythm. Every bay target and every clamp in this
   * file is checked against it, and `openStructureProfile` reports the worst spacing it produced.
   */
  minReadableSpacingM: 3.0,

  /**
   * Frame bay. 7.5 m is a real reinforced-concrete/steel bay (6-8 m is the whole industrial range)
   * AND it is 7-8 px at the default view, which is the point: it is the largest spacing that still
   * reads as a repeat rather than as two unrelated posts, on a 61 m elevation. It also reproduces
   * the column count the existing Skeleton asset already ships — `xCount = clamp(round(L/8)+1, 5, 10)`
   * gives 9 lines on Skeleton's 60.66 m and this gives 9 — so the look that already works is kept.
   */
  frameBayTargetM: 7.5,
  /**
   * Canopy bay. A canopy is NOT a frame with a lid: its deck oversails its columns, which is the
   * silhouette signature that separates "shelter" from "building". 12 m bays plus the cantilever
   * below put 6 columns under New Gas's 33 x 24 m deck and 4 under Old Gas's 13 m square — a fuel
   * canopy's real column count. A 7.5 m grid would have put 20 under New Gas and turned it into a
   * hypostyle hall.
   */
  canopyBayTargetM: 12,
  /** How far the canopy deck oversails its outermost columns, as a fraction of the short span. */
  canopyCantileverFrac: 0.18,
  /** No axis ever carries more lines than this — a 61 m frame is 9 bays, never 60. */
  maxLinesPerAxis: 10,

  /**
   * A frame level taller than this is not a storey, it is two. Measured over this archetype's own
   * rows: the storey ratios are 4.75, 4.75 and 9.05 m, so (4.75, 9.05) is empty and 6.0 sits in it
   * with 1.25 m of clearance below and 3.05 m above. It gives Skeleton and Old Construction 2 decks
   * each (their `floors`) and Fortress 4, and it is the reason the level count is not simply a
   * re-derived `height / 3.15` that ignores what the data says about floors.
   */
  frameMaxClearHeightM: 6.0,
  /** A frame never carries more decks than this, whatever a future height claims. */
  maxFrameLevels: 6,

  /**
   * The clear height a canopy must keep under its fascia. The canopy rows are all 4.8 m tall and
   * heights are a standing decision, so this is a CONSTRAINT on the fascia, never a lift of the
   * deck: the fascia gets whatever depth is left over above 3.2 m, and on New Gas that is what caps
   * it at 0.9 m rather than the 1.46 m its span would otherwise ask for.
   */
  canopyMinClearM: 3.2,

  /** Columns are founded IN the ground, never parked on it; a sampled ground is never exact. */
  columnFootEmbedM: 0.35,
  /**
   * How far a column may reach below the building's seat before it stops. This is deliberately the
   * SAME rule as the dark skirt's (`skirtCap()` in src/buildings.js): below it the downhill gap is
   * the plinth's job, not a stilt's. Skeleton's footprint drops 9.4 m across itself at relief 3, so
   * without this a downhill column becomes a 14 m leg.
   */
  maxFootDropM: (heightM) => Math.max(1.5, num(heightM) * 0.6),

  /** Drainage fall of a canopy deck, as a fraction of its run. 2.5% is a real flat-roof fall. */
  canopyFallGrade: 0.025,

  /**
   * How far a column may overhang the footprint edge before it is dropped instead of drawn.
   *
   * A quarter of a metre is a quarter of a pixel at the default view — below the resolution the
   * founder reads the map at, and far above float noise. The number exists because the OBB the grid
   * is laid out in CONTAINS the footprint: Skeleton's short ends sit 2-6 cm inside their own
   * bounding box, so a strict "fully inside" test deleted all six of its end-line columns and left
   * a frame standing on its interior grid. Deleting an end column is visible from every angle;
   * 6 cm of overhang is visible from none. What this still catches is the case it is for: New Gas's
   * notched 14-gon puts one grid node 2.7 m OUTSIDE the deck, and that one is dropped.
   */
  maxColumnOverhangM: 0.25,
  /** Below this a solid is z-fighting, not geometry. */
  minMemberM: 0.05,
  /**
   * The share of an elevation a member may occupy before the object stops reading as open. A solid
   * extrusion scores 1.0. Nothing this module plans may exceed this, and the test asserts it against
   * the six real rows.
   */
  maxElevationSolidFraction: 0.45,
  /** ...and below this there is nothing on screen at all. Both ends of the band can fail. */
  minElevationSolidFraction: 0.06,
});

// --------------------------------------------------------------------------------------------- //
// Footprint helpers. Pure, and shared between the deck, the fascia and the column filter so that
// all three agree about where the edge of the building is.
// --------------------------------------------------------------------------------------------- //

/** Signed shoelace area in game (x, z). Positive is counter-clockwise. */
export function signedRingArea(ring) {
  let twice = 0;
  for (let index = 0; index < ring.length; index++) {
    const [ax, az] = ring[index];
    const [bx, bz] = ring[(index + 1) % ring.length];
    twice += ax * bz - bx * az;
  }
  return twice / 2;
}

/**
 * Clean a `poly` into finite pairs, drop repeated points, and normalise to counter-clockwise.
 *
 * The winding matters and is not optional. `gameToWorld(x, z) = [-x, -z]` is a 180-degree rotation
 * of the ground plane, whose determinant is +1, so orientation is PRESERVED into world space. A
 * counter-clockwise game ring is therefore counter-clockwise in world XY, which is what every face
 * winding below assumes. The building materials are `MeshStandardMaterial` at the default
 * `THREE.FrontSide`, so a reversed ring would render the whole structure inside-out.
 */
export function normalisedRing(poly) {
  const raw = (Array.isArray(poly) ? poly : [])
    .filter((point) => Array.isArray(point)
      && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
    .map((point) => [Number(point[0]), Number(point[1])]);
  const ring = raw.filter((point, index) => {
    const previous = raw[(index - 1 + raw.length) % raw.length];
    return raw.length < 2 || Math.hypot(point[0] - previous[0], point[1] - previous[1]) > 1e-6;
  });
  if (ring.length < 3) return [];
  return signedRingArea(ring) < 0 ? ring.slice().reverse() : ring;
}

/**
 * Offset a counter-clockwise ring inward by `distance`, vertex for vertex.
 *
 * Used for the inner edge of every downstand band. The mitre is clamped at 4x the offset so that
 * New Gas's near-collinear staircase vertices cannot throw a vertex to infinity; the caller checks
 * the result rather than trusting it, because an offset that folds a polygon is a silent defect and
 * a reported one is not.
 */
export function offsetRingInward(ring, distance) {
  const count = ring.length;
  const width = Math.max(0, num(distance));
  const out = [];
  for (let index = 0; index < count; index++) {
    const [px, pz] = ring[index];
    const [ax, az] = ring[(index - 1 + count) % count];
    const [bx, bz] = ring[(index + 1) % count];
    const inLen = Math.hypot(px - ax, pz - az) || 1;
    const outLen = Math.hypot(bx - px, bz - pz) || 1;
    // Interior is to the LEFT of the edge direction on a counter-clockwise ring.
    const n0x = -(pz - az) / inLen, n0z = (px - ax) / inLen;
    const n1x = -(bz - pz) / outLen, n1z = (bx - px) / outLen;
    const bxs = n0x + n1x, bzs = n0z + n1z;
    const bLen = Math.hypot(bxs, bzs);
    if (!(bLen > 1e-9)) { out.push([px + n1x * width, pz + n1z * width]); continue; }
    const ux = bxs / bLen, uz = bzs / bLen;
    const cosHalf = ux * n1x + uz * n1z;
    const scale = clamp(0, width / Math.max(0.25, cosHalf), width * 4);
    out.push([px + ux * scale, pz + uz * scale]);
  }
  return out;
}

/** True when `inner` is a usable hole for `outer`: same winding, not folded, still inside. */
export function ringOffsetIsSound(outer, inner) {
  const outerArea = signedRingArea(outer);
  const innerArea = signedRingArea(inner);
  if (!(outerArea > 1e-6) || !(innerArea > 1e-6)) return false;
  if (innerArea / outerArea < 0.25) return false;
  return inner.every((point) => inRing(point, outer));
}

/** Distance from a point to the polygon boundary. Used to keep columns clear of the deck edge. */
export function distanceToBoundary(point, ring) {
  let best = Infinity;
  for (let index = 0; index < ring.length; index++) {
    const [ax, az] = ring[index];
    const [bx, bz] = ring[(index + 1) % ring.length];
    const dx = bx - ax, dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-12 ? clamp(0, ((point[0] - ax) * dx + (point[1] - az) * dz) / lengthSq, 1) : 0;
    best = Math.min(best, Math.hypot(point[0] - (ax + dx * t), point[1] - (az + dz * t)));
  }
  return best;
}

const pointInTriangle = (p, a, b, c) => {
  const side = (u, v) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const s0 = side(a, b), s1 = side(b, c), s2 = side(c, a);
  return (s0 >= -1e-9 && s1 >= -1e-9 && s2 >= -1e-9) || (s0 <= 1e-9 && s1 <= 1e-9 && s2 <= 1e-9);
};

/**
 * Ear-clip a counter-clockwise simple polygon into `ring.length - 2` triangles, counter-clockwise.
 *
 * Needed because New Gas's canopy deck is a 14-gon (fill 0.824, `metrics.rectilinear` false) and a
 * deck is not a rectangle. Returns fewer than `n - 2` triangles only if the ring is not simple,
 * which the caller reports rather than swallowing.
 */
export function earClipTriangles(ring) {
  const count = ring.length;
  if (count < 3) return [];
  const live = Array.from({ length: count }, (_, index) => index);
  const triangles = [];
  let guard = count * count + 8;
  while (live.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let position = 0; position < live.length; position++) {
      const i0 = live[(position - 1 + live.length) % live.length];
      const i1 = live[position];
      const i2 = live[(position + 1) % live.length];
      const a = ring[i0], b = ring[i1], c = ring[i2];
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 1e-9) continue;
      let occupied = false;
      for (const other of live) {
        if (other === i0 || other === i1 || other === i2) continue;
        if (pointInTriangle(ring[other], a, b, c)) { occupied = true; break; }
      }
      if (occupied) continue;
      triangles.push([i0, i1, i2]);
      live.splice(position, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (live.length === 3) triangles.push([live[0], live[1], live[2]]);
  return triangles;
}

// --------------------------------------------------------------------------------------------- //
// Mesh parts. A part is `{ slot, positions: number[], indices: number[] }` in WORLD space; the
// assembler concatenates parts by slot so each material is exactly ONE contiguous group, which is
// what keeps the draw-call delta at one extra call per building.
// --------------------------------------------------------------------------------------------- //

const emptyPart = (slot) => ({ slot, positions: [], indices: [] });
const pushVertex = (part, x, z, y) => {
  const index = part.positions.length / 3;
  part.positions.push(...gameToWorld(x, z, y));
  return index;
};
const pushTriangle = (part, a, b, c) => part.indices.push(a, b, c);

/**
 * A closed solid over a counter-clockwise game ring, with an independent top and bottom surface.
 *
 * Both surfaces are functions of (x, z), so one call builds a flat slab, a sloping canopy deck and
 * a column whose foot follows the ground. The top is authoritative: if the bottom would rise above
 * it the bottom is pushed down, never the top lifted, because a top that is not where the plan says
 * it is would be a lie about the structure (the rule `bridge-structure.js` holds for abutments).
 */
export function prismPart(slot, ring, bottomYAt, topYAt) {
  const part = emptyPart(slot);
  if (ring.length < 3) return part;
  const tops = ring.map(([x, z]) => num(topYAt(x, z), NaN));
  const bottoms = ring.map(([x, z], index) => Math.min(
    num(bottomYAt(x, z), NaN), tops[index] - OPEN_STRUCTURE.minMemberM,
  ));
  if (![...tops, ...bottoms].every(Number.isFinite)) return part;
  const bottomIds = ring.map(([x, z], index) => pushVertex(part, x, z, bottoms[index]));
  const topIds = ring.map(([x, z], index) => pushVertex(part, x, z, tops[index]));
  for (const [i0, i1, i2] of earClipTriangles(ring)) {
    pushTriangle(part, topIds[i0], topIds[i1], topIds[i2]);        // +Z, counter-clockwise
    pushTriangle(part, bottomIds[i2], bottomIds[i1], bottomIds[i0]); // -Z, reversed
  }
  for (let index = 0; index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    pushTriangle(part, bottomIds[index], bottomIds[next], topIds[next]);
    pushTriangle(part, bottomIds[index], topIds[next], topIds[index]);
  }
  return part;
}

/**
 * The downstand BAND around a deck: a closed ring solid between an outer and an inner ring.
 *
 * This is the element the brief calls the deck edge / fascia and it is the one that was missing. It
 * is a band and not a solid slab for one reason worth keeping: its inner face is visible from any
 * oblique angle under the deck, so the underside of a canopy reads as a rimmed void rather than as a
 * flat painted ceiling.
 */
export function bandPart(slot, outer, inner, bottomYAt, topYAt) {
  const part = emptyPart(slot);
  if (outer.length < 3 || outer.length !== inner.length) return part;
  const level = (points) => {
    const tops = points.map(([x, z]) => num(topYAt(x, z), NaN));
    const bottoms = points.map(([x, z], index) => Math.min(
      num(bottomYAt(x, z), NaN), tops[index] - OPEN_STRUCTURE.minMemberM,
    ));
    return { tops, bottoms };
  };
  const o = level(outer), i = level(inner);
  if (![...o.tops, ...o.bottoms, ...i.tops, ...i.bottoms].every(Number.isFinite)) return part;
  const ob = outer.map(([x, z], index) => pushVertex(part, x, z, o.bottoms[index]));
  const ot = outer.map(([x, z], index) => pushVertex(part, x, z, o.tops[index]));
  const ib = inner.map(([x, z], index) => pushVertex(part, x, z, i.bottoms[index]));
  const it = inner.map(([x, z], index) => pushVertex(part, x, z, i.tops[index]));
  for (let index = 0; index < outer.length; index++) {
    const next = (index + 1) % outer.length;
    // Outer face, outward.
    pushTriangle(part, ob[index], ob[next], ot[next]);
    pushTriangle(part, ob[index], ot[next], ot[index]);
    // Inner face, facing into the hole (the reverse winding of the outer one).
    pushTriangle(part, ib[next], ib[index], it[index]);
    pushTriangle(part, ib[next], it[index], it[next]);
    // Top annulus, +Z.
    pushTriangle(part, ot[index], ot[next], it[next]);
    pushTriangle(part, ot[index], it[next], it[index]);
    // Bottom annulus, -Z.
    pushTriangle(part, ib[index], ib[next], ob[next]);
    pushTriangle(part, ib[index], ob[next], ob[index]);
  }
  return part;
}

/** A rectangular column, axis-aligned to the structure's own long axis. */
function columnPart(slot, column) {
  const { x, z, yaw, widthM, depthM, bottomY, topY } = column;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const half = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [
    x + (u * widthM / 2) * cos - (v * depthM / 2) * sin,
    z + (u * widthM / 2) * sin + (v * depthM / 2) * cos,
  ]);
  const ring = signedRingArea(half) < 0 ? half.slice().reverse() : half;
  return prismPart(slot, ring, () => bottomY, () => topY);
}

/** Merge parts into one contract-shaped mesh, one contiguous group per material slot. */
function assembleMesh(parts) {
  const bySlot = new Map();
  for (const part of parts) {
    if (!part || part.indices.length === 0) continue;
    const bucket = bySlot.get(part.slot) ?? emptyPart(part.slot);
    const offset = bucket.positions.length / 3;
    bucket.positions.push(...part.positions);
    for (const index of part.indices) bucket.indices.push(index + offset);
    bySlot.set(part.slot, bucket);
  }
  if (!bySlot.size) return null;
  const positions = [], indices = [], groups = [];
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const bucket = bySlot.get(slot);
    const vertexOffset = positions.length / 3;
    positions.push(...bucket.positions);
    groups.push({ start: indices.length, count: bucket.indices.length, materialSlot: slot });
    for (const index of bucket.indices) indices.push(index + vertexOffset);
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    groups,
  };
}

// --------------------------------------------------------------------------------------------- //
// The profile: every dimension of one open structure, derived and reported before any vertex exists
// --------------------------------------------------------------------------------------------- //

/**
 * Evenly spaced column stations across a span, inset from both ends.
 *
 * The single rule worth stating: an axis whose usable run is shorter than `minReadableSpacingM`
 * carries ONE centre line, not two. At one metre per pixel two lines 1.6 m apart are one smudge, and
 * Bus Station's 2.8 m depth is exactly that case — two rows of posts there would cost geometry to
 * produce a thicker single line. One row down the middle under an oversailing deck is also what a
 * bus shelter actually is.
 */
export function bayStations(spanM, insetM, targetM, maxLines) {
  const span = num(spanM);
  const inset = clamp(0, num(insetM), Math.max(0, span / 2 - 0.25));
  const usable = Math.max(0, span - 2 * inset);
  if (usable < OPEN_STRUCTURE.minReadableSpacingM) {
    // One line carries the WHOLE span, so the span is its tributary width, not the usable run.
    return { bays: 0, spacingM: Math.max(0, span), stations: [0], collapsed: true };
  }
  const bays = clamp(1, Math.round(usable / Math.max(0.5, num(targetM, 1))), Math.max(1, maxLines - 1));
  const first = -span / 2 + inset;
  return {
    bays,
    spacingM: usable / bays,
    stations: Array.from({ length: bays + 1 }, (_, index) => first + (usable * index) / bays),
    collapsed: false,
  };
}

/**
 * Resolve every dimension of one open structure from public data alone.
 *
 * WHAT VARIES BETWEEN THE SIX, AND WHAT DRIVES IT — this table is the deliverable:
 *
 *   sub-family      `classification.roofForm`: 'mono-pitch' (canopy) vs 'none' (frame). A canopy is
 *                   one oversailing deck on few columns; a frame is stacked decks on a dense grid.
 *   bay counts      the OBB's own `lengthM`/`widthM` over the sub-family's bay target, so the 61 m
 *                   Skeleton gets 9 x 4 lines and the 6.6 m bus shelter gets 2 x 2.
 *   column section  the tributary bay area it carries, times the number of decks above it.
 *   deck count      `floors`, subdivided only where a storey would exceed `frameMaxClearHeightM`.
 *   deck pitch      `heightM / levels`.
 *   deck thickness  the SHORT span, so a 33 m canopy's deck is thicker than a 2.8 m shelter's.
 *   edge band depth the bay it spans, at the structural L/12 — so a deck edge deepens with its bay.
 *   fascia depth    what is left of `heightM` above `canopyMinClearM`, which is why New Gas's is
 *                   capped by its own height rather than by its span.
 *   fall direction  which end of the long axis stands on LOWER ground — see `planDetail`. Derived,
 *                   not hashed, and it separates the three canopies where a seed bit did not.
 *   fall magnitude  the run along the fall axis at `canopyFallGrade`.
 *   grid rotation   `metrics.yawRad`, the OBB long axis, so a column grid is square to its building.
 */
export function openStructureProfile(classification) {
  const metrics = classification?.metrics ?? {};
  const heightM = Math.max(1, num(classification?.heightM, 1));
  const lengthM = Math.max(1, num(metrics.lengthM, 1));
  const widthM = Math.max(1, num(metrics.widthM, 1));
  const shortSpanM = Math.min(lengthM, widthM);
  const floors = Math.max(1, Math.floor(num(classification?.floors, 1)));
  const canopy = classification?.roofForm === 'mono-pitch';

  if (canopy) {
    const deckThicknessM = clamp(0.22, shortSpanM * 0.02, 0.55);
    // The fascia takes what the DATA's height leaves above the clear height. Heights are never
    // changed (standing decision 4), so on a 4.8 m canopy this is the binding constraint, not the
    // span-derived cap next to it.
    const fasciaDropM = clamp(0.25, Math.min(
      shortSpanM * 0.06,
      heightM - OPEN_STRUCTURE.canopyMinClearM - deckThicknessM,
    ), 0.9);
    const cantileverM = clamp(0.6, shortSpanM * OPEN_STRUCTURE.canopyCantileverFrac, 6);
    const long = bayStations(lengthM, cantileverM, OPEN_STRUCTURE.canopyBayTargetM, OPEN_STRUCTURE.maxLinesPerAxis);
    const across = bayStations(widthM, cantileverM, OPEN_STRUCTURE.canopyBayTargetM, OPEN_STRUCTURE.maxLinesPerAxis);
    const tributary = Math.max(1, long.spacingM * across.spacingM);
    const columnWidthM = clamp(0.24, 0.04 * Math.sqrt(tributary), 0.6);
    // A canopy's grid is inset by the CANTILEVER, which does not depend on the column width, so the
    // two-pass fixed point the frame branch needs does not arise here.
    return Object.freeze({
      family: 'canopy',
      heightM, lengthM, widthM, shortSpanM, floors,
      levels: 1,
      deckThicknessM,
      fasciaDropM,
      fasciaWidthM: clamp(0.2, deckThicknessM * 0.7, 0.5),
      clearHeightM: heightM - deckThicknessM - fasciaDropM,
      cantileverM,
      long, across,
      columnWidthM,
      columnDepthM: columnWidthM,
      fallDropM: lengthM * OPEN_STRUCTURE.canopyFallGrade,
      slabThicknessM: deckThicknessM,
      edgeBandDropM: fasciaDropM,
      edgeBandWidthM: clamp(0.2, deckThicknessM * 0.7, 0.5),
    });
  }

  const storeyRatio = heightM / floors;
  const subdivision = clamp(1, Math.ceil(storeyRatio / OPEN_STRUCTURE.frameMaxClearHeightM), 3);
  const levels = clamp(1, floors * subdivision, OPEN_STRUCTURE.maxFrameLevels);
  /**
   * A frame's edge columns are FLUSH with its slab edge — that is what an unfinished concrete frame
   * looks like, and it is why the grid inset must be exactly half a column and not a guess. The
   * inset therefore depends on the column width, which depends on the bay, which depends on the
   * inset; two passes settle it, because the inset moves the usable span by well under 2% and the
   * width that comes back differs from the first pass by under 1%. The first smoke run of this
   * module used a fixed 0.4 m inset with a larger clearance test downstream and silently DROPPED
   * every perimeter column: Skeleton came back with 14 columns from a 9x4 grid, all of them
   * interior. That is why the two numbers are now derived from one another instead of guessed.
   */
  const gridFor = (insetM) => ({
    long: bayStations(lengthM, insetM, OPEN_STRUCTURE.frameBayTargetM, OPEN_STRUCTURE.maxLinesPerAxis),
    across: bayStations(widthM, insetM, OPEN_STRUCTURE.frameBayTargetM, OPEN_STRUCTURE.maxLinesPerAxis),
  });
  const widthFor = (grid) => clamp(
    0.3,
    0.055 * Math.sqrt(Math.max(1, grid.long.spacingM * grid.across.spacingM)) * Math.sqrt(levels / 2),
    0.7,
  );
  const firstPass = gridFor(0.35);
  const { long, across } = gridFor(widthFor(firstPass) / 2);
  const columnWidthM = widthFor({ long, across });
  return Object.freeze({
    family: 'frame',
    heightM, lengthM, widthM, shortSpanM, floors,
    levels,
    storeyRatio,
    subdivision,
    deckPitchM: heightM / levels,
    slabThicknessM: clamp(0.18, across.spacingM * 0.035, 0.4),
    /** A downstand edge beam at the structural span/12 — the band that makes a level line read. */
    edgeBandDropM: clamp(0.35, long.spacingM / 12, 0.9),
    edgeBandWidthM: clamp(0.25, columnWidthM * 0.8, 0.6),
    long, across,
    columnWidthM,
    columnDepthM: columnWidthM,
    fallDropM: 0,
    clearHeightM: heightM / levels,
  });
}

/**
 * The share of the long elevation that is opaque. A solid extrusion scores 1.0.
 *
 * Computed from the PROFILE rather than from the triangles, so it is a statement about the design
 * and not a restatement of the mesh: the horizontal bands are the decks and their edge beams, and
 * the remaining open height is occluded only by the column lines crossing that elevation.
 *
 * The bars you count are the stations ALONG the long axis, not across it. Columns sharing a `u`
 * stack behind one another in that view and occlude one metre of elevation between them, not two —
 * counting the across axis instead undercounts Skeleton's cover by a factor of 2.25.
 */
export function elevationSolidFraction(profile) {
  const bandsM = profile.levels * (profile.slabThicknessM + profile.edgeBandDropM);
  const bandFraction = clamp(0, bandsM / profile.heightM, 1);
  const cover = clamp(0, (profile.long.stations.length * profile.columnWidthM) / profile.lengthM, 1);
  return bandFraction + (1 - bandFraction) * cover;
}

// --------------------------------------------------------------------------------------------- //
// The planner
// --------------------------------------------------------------------------------------------- //

/** Read the seat, accepting `seatBuilding()`'s own field names as documented aliases. */
function seatBaseY(seat) {
  const baseY = num(seat?.baseY, num(seat?.base, NaN));
  if (!Number.isFinite(baseY)) {
    throw new TypeError('open-structure: context.seat must carry a finite baseY (or base)');
  }
  return baseY;
}

/**
 * Plan one open structure.
 *
 * Returns a contract plan whose `mesh` REPLACES the building's extruded mass — see
 * `massDisposition` in the module header. Declares no instanced families: a column is sized from
 * its own building's bay grid and merges into that building's mesh for free, so instancing it would
 * buy a draw call rather than save one.
 */
export function planDetail(building, context) {
  const { buildingIndex, classification, seat, groundYAt } = context ?? {};
  const plan = emptyDetailPlan(buildingIndex, 'open-structure');
  plan.massDisposition = 'replace';
  plan.profile = null;
  plan.columns = [];
  plan.decks = [];

  if (classification?.archetype !== 'open-structure') {
    plan.notes.push(`not an open structure: archetype "${classification?.archetype}"`);
    plan.massDisposition = 'keep';
    return plan;
  }
  const ring = normalisedRing(building?.poly);
  if (ring.length < 3) {
    plan.notes.push('footprint has fewer than three usable vertices; nothing planned');
    plan.massDisposition = 'keep';
    return plan;
  }

  const profile = openStructureProfile(classification);
  const baseY = seatBaseY(seat);
  const ground = typeof groundYAt === 'function' ? groundYAt : () => baseY;
  const topY = baseY + profile.heightM;
  plan.profile = profile;

  const yaw = num(classification.metrics?.yawRad);
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const centerX = num(classification.metrics?.centerX);
  const centerZ = num(classification.metrics?.centerZ);
  /** OBB frame: u along the long axis, v across it. */
  const toWorldXZ = (u, v) => [centerX + u * cos - v * sin, centerZ + u * sin + v * cos];
  const alongU = (x, z) => (x - centerX) * cos + (z - centerZ) * sin;

  // ------------------------------------------------------------------------------------------- //
  // Decks. A canopy has ONE, on a mono-pitch fall; a frame has `levels`, flat, and its top one is a
  // floor slab rather than a roof — `roofForm: 'none'` means the archetype owns the top.
  // ------------------------------------------------------------------------------------------- //
  const halfLength = profile.lengthM / 2;
  /**
   * WHICH WAY A CANOPY DRAINS — derived, not hashed.
   *
   * A deck is laid to fall toward the low side of its own site; that is what a fall is for. Sampling
   * the terrain at both ends of the long axis therefore gives a rule that is deterministic, is
   * public data, and is guaranteed to differ between buildings standing on different ground.
   *
   * This replaced one bit of `classification.seed`, which was the obvious way to do it and was
   * wrong: bit 3 comes back 1 on all three canopies, so a "variation axis" driven by it would have
   * been constant across every instance that exists — the shape of a metric that cannot fail. The
   * seed is deliberately unused in this module: these six rows differ in footprint, height, floors
   * and ground, so every axis below is DERIVED, and a hash would only add noise on top of it.
   */
  const endGround = (sign) => num(ground(...toWorldXZ(sign * halfLength * 0.9, 0)), 0);
  const fallSign = endGround(1) <= endGround(-1) ? 1 : -1;
  const deckTopYAt = profile.family === 'canopy'
    ? (x, z) => topY - profile.fallDropM * clamp(0, (fallSign * alongU(x, z) + halfLength) / (2 * halfLength), 1)
    : null;

  const deckLevels = profile.family === 'canopy'
    ? [{ index: 0, topYAt: deckTopYAt, nominalTopY: topY }]
    : Array.from({ length: profile.levels }, (_, index) => {
      const levelY = baseY + (profile.heightM * (index + 1)) / profile.levels;
      return { index, topYAt: () => levelY, nominalTopY: levelY };
    });

  const parts = [];
  const wallSlot = MATERIAL_SLOT_INDEX.wall;
  // A canopy deck is the only thing in this archetype that is a roof; a frame's decks are raw slabs
  // in the same concrete as its columns, which is what an unfinished frame actually is.
  const deckSlot = profile.family === 'canopy' ? MATERIAL_SLOT_INDEX.roof : wallSlot;
  const bandSlot = MATERIAL_SLOT_INDEX.trim;

  const innerRing = offsetRingInward(ring, profile.edgeBandWidthM);
  const bandSound = ringOffsetIsSound(ring, innerRing);
  if (!bandSound) {
    plan.notes.push(
      `edge band skipped: inward offset of ${profile.edgeBandWidthM.toFixed(2)} m folded the footprint`,
    );
  }

  for (const level of deckLevels) {
    const slabBottom = (x, z) => level.topYAt(x, z) - profile.slabThicknessM;
    parts.push(prismPart(deckSlot, ring, slabBottom, level.topYAt));
    if (bandSound) {
      parts.push(bandPart(
        bandSlot, ring, innerRing,
        (x, z) => slabBottom(x, z) - profile.edgeBandDropM,
        slabBottom,
      ));
    }
    plan.decks.push({
      index: level.index,
      levelAboveBaseM: level.nominalTopY - baseY,
      slabThicknessM: profile.slabThicknessM,
      edgeBandDropM: bandSound ? profile.edgeBandDropM : 0,
    });
  }

  // ------------------------------------------------------------------------------------------- //
  // Columns. A grid in the building's OWN long-axis frame, filtered against the real footprint so
  // that New Gas's notched 14-gon does not grow columns outside its deck.
  // ------------------------------------------------------------------------------------------- //
  const soffitYAt = profile.family === 'canopy'
    ? (x, z) => deckTopYAt(x, z) - profile.slabThicknessM
    : () => topY;
  // A frame's edge column is FLUSH with its slab edge on purpose. See `maxColumnOverhangM`.
  const clearanceM = profile.columnWidthM / 2 - OPEN_STRUCTURE.maxColumnOverhangM;
  const footDropLimit = OPEN_STRUCTURE.maxFootDropM(profile.heightM);
  let rejected = 0;
  for (const u of profile.long.stations) {
    for (const v of profile.across.stations) {
      const [x, z] = toWorldXZ(u, v);
      if (!inRing([x, z], ring) || distanceToBoundary([x, z], ring) < clearanceM) { rejected++; continue; }
      const columnTopY = soffitYAt(x, z);
      const groundY = num(ground(x, z), baseY);
      const bottomY = Math.max(
        baseY - footDropLimit,
        Math.min(groundY - OPEN_STRUCTURE.columnFootEmbedM, baseY),
      );
      if (!(columnTopY - bottomY > OPEN_STRUCTURE.minMemberM)) { rejected++; continue; }
      const column = {
        x, z, yaw,
        widthM: profile.columnWidthM,
        depthM: profile.columnDepthM,
        bottomY,
        topY: columnTopY,
        heightM: columnTopY - bottomY,
        footedOnGround: groundY - OPEN_STRUCTURE.columnFootEmbedM >= baseY - footDropLimit,
      };
      plan.columns.push(column);
      parts.push(columnPart(wallSlot, column));
    }
  }

  plan.mesh = assembleMesh(parts);
  plan.rejectedColumnStations = rejected;
  /** Which way the canopy deck drains, +1 toward +u. Reported so a test can see it vary. */
  plan.fallSign = profile.family === 'canopy' ? fallSign : 0;
  plan.footDropLimitM = footDropLimit;
  plan.elevationSolidFraction = elevationSolidFraction(profile);
  plan.triangles = plan.mesh ? plan.mesh.indices.length / 3 : 0;
  plan.extraMaterialSlots = plan.mesh
    ? new Set(plan.mesh.groups.map((group) => group.materialSlot).filter((slot) => slot > 1)).size
    : 0;
  plan.notes.push(
    `${profile.family}: ${plan.columns.length} columns on a ${profile.long.stations.length}x${profile.across.stations.length} grid`
    + ` at ${profile.long.spacingM.toFixed(1)}x${profile.across.spacingM.toFixed(1)} m`,
    `${deckLevels.length} deck(s) at ${(profile.heightM / deckLevels.length).toFixed(2)} m pitch,`
    + ` slab ${profile.slabThicknessM.toFixed(2)} m, edge band ${(bandSound ? profile.edgeBandDropM : 0).toFixed(2)} m`,
    profile.family === 'canopy'
      ? `deck falls ${profile.fallDropM.toFixed(2)} m toward ${fallSign > 0 ? '+u' : '-u'}`
        + ` (the downhill end), clear height ${profile.clearHeightM.toFixed(2)} m`
      : `levels = floors ${profile.floors} x ${profile.subdivision} (storey ratio ${profile.storeyRatio.toFixed(2)} m)`,
    `elevation solid fraction ${plan.elevationSolidFraction.toFixed(3)} (a solid extrusion is 1.000)`,
    'mass disposition REPLACE: the renderer must not also extrude this footprint',
  );
  return plan;
}

export default planDetail;
