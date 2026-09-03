/**
 * Lattice-tower detail planner — the four Customs powerline pylons, as openwork steel.
 *
 * PURE and GPU-free, for the same reason `src/bridge-structure.js` and `src/buildings.js` are:
 * `scripts/building-detail-lattice-tower.test.mjs` asserts against the very functions the renderer
 * runs, not a re-implementation of them. No THREE, no DOM, no fs, no clock, no `Math.random`.
 *
 * ---------------------------------------------------------------------------------------------
 * THE DEFECT
 *
 * Rows 67-70 of `public/data/customs-3d.json` are `kind: 'powerline_towers'`, `style: 'box'`,
 * `height: 22`, `floors: 1`, on ~7 x 7 m square footprints. The Three renderer extrudes them like
 * every other building, so each one is a SOLID 22 m grey slab — 154 px of unbroken fill at the
 * default 3D framing, the tallest wrong objects on the map and the single largest unowned
 * silhouette defect. `docs/plans/BUILDING-MASSING.md` §2 puts them outside the building lane
 * entirely ("lattice structures, not buildings"). The deck.gl renderer has drawn them as pylons
 * since the 2026-08-29 fidelity pass (`pylonParts`, src/map3d.js:264); this module is the Three
 * equivalent, rebuilt to the detail contract rather than ported.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE SUB-PIXEL ARGUMENT DOES NOT RETIRE THIS ARCHETYPE
 *
 * Decision 4 of the build brief says metres-per-pixel is 2^-zoom and the default 3D zoom is 0, so
 * one pixel is one metre: 0.35 m wall ribs are sub-pixel and not worth building. A 0.20 m lattice
 * diagonal is sub-pixel by the same arithmetic — and it is still worth building, because for THIS
 * archetype the members are not surface relief, they are the silhouette. The thing that changes is
 * not the member, it is the SKY BETWEEN the members: a solid 7 x 22 m slab covers ~154 px of the
 * frame and an openwork tower of the same envelope covers roughly a third of that. The test
 * measures exactly this (`silhouetteFill`) rather than counting triangles, because coverage is the
 * property that has to move.
 *
 * The corollary is that the budget goes on ENVELOPE — leg batter, waist, cross-arm reach, the
 * earth-wire peak — and never on member cross-sections. Members are sized so that at zoom 2-3,
 * where the founder actually inspects a tower, they read as steel rather than as wire; at zoom 0
 * they only have to break up the mass.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS PLANNER DOES *NOT* EMIT, DELIBERATELY
 *
 *  - **No plinth / skirt.** Decision 5 says to wire the plinths that `src/buildings.js` already
 *    computes. That is right for 67 buildings and wrong for these four: a pylon stands on four
 *    separate concrete footings, and a continuous near-black skirt around a 7 m square would put a
 *    solid apron under an object whose whole point is that you can see through it. `suppressPlinth`
 *    on the returned plan says so out loud rather than leaving the renderer to guess.
 *  - **No instanced family.** `INSTANCED_FAMILIES` in the contract is frozen and closed, and every
 *    entry in it is a roof or facade fitting (`roof-vent`, `downpipe`, `door-module`, ...). None
 *    describes a pylon. Emitting the tower into the building's OWN mesh instead costs FEWER draw
 *    calls than a family would (see `latticeTowerDrawCallDelta`), so the closed registry costs
 *    nothing here; it is reported, not worked around.
 *  - **Nothing above `seat.baseY + building.height`.** Heights are a standing decision (handoff §4)
 *    and the earth-wire peak is carved out of the top of the 22 m, never stacked on top of it. The
 *    apex sits at exactly `baseY + height` and the test asserts it from the position buffer.
 */

import { MATERIAL_SLOT_INDEX, emptyDetailPlan } from './contract.js';

// --------------------------------------------------------------------------------------------- //
// 1. Frozen dimensions. Every one names the measurement or the rule it came from.
// --------------------------------------------------------------------------------------------- //

export const LATTICE_TOWER = Object.freeze({
  /**
   * Member half-widths, metres. A real 220 kV suspension tower's main leg angle is roughly
   * 200 x 200 mm over its lower body and the bracing angles 100-150 mm, so these are the real
   * steel sizes rounded up by about half — the rounding buys legibility at zoom 2-3 and costs
   * nothing at zoom 0, where every one of them is sub-pixel either way.
   */
  legHalfWidthM: 0.17,
  beltHalfWidthM: 0.11,
  braceHalfWidthM: 0.10,
  armHalfWidthM: 0.12,
  peakHalfWidthM: 0.09,
  insulatorHalfWidthM: 0.07,

  /**
   * The four feet are sunk into the ground rather than parked on it, for the same reason
   * `BRIDGE_STRUCTURE.pierFootEmbedM` exists: a sampled heightfield is never exact, and a leg that
   * ends exactly at its sample floats the moment the mesh interpolates differently.
   */
  footEmbedM: 0.45,

  /**
   * The earth-wire peak occupies the top of the tower's own height, never an extension above it.
   * 7.5% of 22 m is 1.65 m — on a real pylon the peak above the top conductor arm is 1.5-3 m.
   */
  peakHeightFrac: 0.075,

  /**
   * Leg batter, expressed as the shaft width at the waist as a FRACTION of the base width. Real
   * suspension towers come in at 0.25-0.35 (a ~7 m base square narrowing to a ~2 m body); the
   * seeded range below sits inside that. Above ~0.5 the tower reads as a box with dents; below
   * ~0.2 it reads as a tepee.
   */
  waistRatioMin: 0.26,
  waistRatioSpan: 0.10,
  /** The shaft keeps tapering above the waist, but only slightly — this is the top/waist ratio. */
  shaftTopTaper: 0.86,

  /**
   * Where the splay stops, as a fraction of the leg-top height. On a real pylon the body extension
   * runs to somewhere between half and two thirds of the height, and the arms all sit on the narrow
   * shaft above it.
   */
  waistFracMin: 0.52,
  waistFracSpan: 0.14,

  /**
   * Target panel height. Lattice panels on a tower this size are 2.5-5.5 m; the panel COUNT then
   * falls out of the height rather than being chosen. Over Customs' 20.35 m leg the range below
   * gives 2-4 body panels and 1-3 shaft panels, so the bracing pitch visibly differs tower to
   * tower. A narrower range (3.4-4.6 m was the first draft) is just as real and produced 3 body +
   * 2 shaft panels on all four towers — a variation axis that did not vary.
   */
  panelTargetMinM: 3.0,
  panelTargetSpanM: 2.2,
  minBodyPanels: 2,
  maxBodyPanels: 5,
  minShaftPanels: 1,
  maxShaftPanels: 4,

  /**
   * Cross-arm reach from the tower axis, as a multiple of the base half-extent. A pylon's arm span
   * is close to its base width and a little more on the lower arms; 0.82-1.12 x the base half-width
   * puts the tip-to-tip span at 5.7-7.8 m on a 7 m base.
   */
  armReachRatioMin: 0.82,
  armReachRatioSpan: 0.30,
  /** A "cat-head" tower's arms lengthen downward. This is the per-step growth when it does. */
  catHeadGrowth: 0.18,
  /** The top arm sits this far below the leg top, so the peak has a frame to spring from. */
  armTopClearFrac: 0.05,
  armTopClearMinM: 0.6,
  /** ...and the lowest arm this far above the waist, so no arm springs off the splayed body. */
  armWaistClearFrac: 0.04,
  armWaistClearMinM: 0.6,
  /** Two arms closer together than this read as one thick arm, so the count is reduced instead. */
  minArmPitchM: 1.5,
  /** How far the under-tie drops below its arm, as a fraction of the arm's clear overhang. */
  armTieDropRatio: 0.5,
  armTieDropMinM: 1.2,
  armTieDropMaxM: 4.0,
  /** A suspension insulator string. 1.2 m is a 110 kV string; it is the arm tip's silhouette break. */
  insulatorLengthM: 1.2,

  /** Below this a member is a degenerate sliver, not steel. Counted, never silently dropped. */
  minMemberLengthM: 0.05,
});

/** The one material slot this archetype uses. Galvanised steel is not wall and is not roof. */
export const LATTICE_MATERIAL_SLOT = MATERIAL_SLOT_INDEX.metal;

/**
 * Flags the wiring agent MUST honour. They are not decoration: without the first one the renderer
 * draws the lattice INSIDE the 22 m solid box it was built to replace, and the founder sees no
 * change at all — which is precisely the handoff §6 failure shape (a system reporting success while
 * the thing it replaced is still on screen).
 */
export const LATTICE_TOWER_FLAGS = Object.freeze({
  /** The extruded building mass must not be drawn for this building. */
  replacesMass: true,
  /** Neither must the `building-plinths` skirt. A pylon has four footings, not an apron. */
  suppressPlinth: true,
});

// --------------------------------------------------------------------------------------------- //
// 2. Deterministic variation. Randomness is forbidden; the seed is the only source.
// --------------------------------------------------------------------------------------------- //

const clamp = (low, value, high) => Math.min(high, Math.max(low, value));
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * One independent 32-bit sub-value per salt, so `armCount` and `waistFrac` are not two views of the
 * same low bits. A murmur-style finaliser over `seed XOR (salt * golden ratio)`; the avalanche is
 * what makes adjacent salts uncorrelated, which a plain `seed >>> k` does not give.
 */
export function subSeed(seed, salt) {
  let hash = (num(seed) ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}
const unitOf = (seed, salt) => subSeed(seed, salt) / 0x100000000;
const pickOf = (seed, salt, choices) => subSeed(seed, salt) % choices;

/**
 * Everything that makes one pylon a different object from the next, and what drives it.
 *
 * FROM THE FOOTPRINT (real, measured, different on all four towers):
 *   `yawRad`      the tower's own rotation — -37.7 deg, +32.8 deg, -2.5 deg, +84.2 deg on Customs.
 *                 The single most visible difference between the four, and it costs nothing.
 *   `baseHalf1/2` the OBB half-extents — 3.63 x 3.60, 3.55 x 3.48, 3.45 x 3.45, 3.52 x 3.42 m.
 *   `heightM`     22 m on all four. Never changed (handoff §4), so it contributes no variation.
 *
 * FROM THE SEED (the centroid hash — deterministic, reproducible run to run):
 *   `armCount`    2 or 3. The loudest silhouette difference available on a fixed-height tower.
 *   `waistFrac`   0.52-0.66 — how far up the splay runs, i.e. how leggy the tower looks.
 *   `waistRatio`  0.26-0.36 — how slim the shaft is above the waist.
 *   `panelTargetM` 3.4-4.6 m — sets the panel counts, i.e. how fine the bracing reads.
 *   `armReachRatio` 0.82-1.12 — arm span against base width.
 *   `catHead`     whether arms lengthen downward or stay uniform.
 *   `braceFlip`   which way the first single-diagonal shaft panel leans.
 *
 * What deliberately does NOT vary: member sizes (steel is steel), the earth-wire peak (universal),
 * and the four-legged square plan (the footprint says so).
 */
export function latticeTowerProfile(classification) {
  const metrics = classification?.metrics ?? {};
  const seed = num(classification?.seed);
  const T = LATTICE_TOWER;

  // The two floors below exist ONLY to keep the arithmetic total on a nonsense row; they are
  // deliberately far smaller than any real tower. An earlier draft floored them at 1 m and 0.4 m,
  // which quietly inflated a 0.2 m footprint into a 0.8 m-wide tower and made
  // `degenerateMembersSkipped` unreachable — a counter that could never fire, which is precisely
  // the `payloadBytesRead` shape handoff §6.4 records. Small floors let absurd input report itself.
  const heightM = Math.max(0.05, num(classification?.heightM));
  const peakHeightM = heightM * T.peakHeightFrac;
  const legTopM = heightM - peakHeightM;

  const baseHalf1 = Math.max(0.05, num(metrics.lengthM) / 2 - T.legHalfWidthM);
  const baseHalf2 = Math.max(0.05, num(metrics.widthM) / 2 - T.legHalfWidthM);

  const waistFrac = T.waistFracMin + T.waistFracSpan * unitOf(seed, 2);
  const waistRatio = T.waistRatioMin + T.waistRatioSpan * unitOf(seed, 3);
  const panelTargetM = T.panelTargetMinM + T.panelTargetSpanM * unitOf(seed, 4);
  const armReachRatio = T.armReachRatioMin + T.armReachRatioSpan * unitOf(seed, 5);
  const catHead = pickOf(seed, 6, 2) === 1;
  const braceFlip = pickOf(seed, 7, 2);

  const waistM = legTopM * waistFrac;
  const shaftM = legTopM - waistM;
  const bodyPanels = clamp(T.minBodyPanels, Math.round(waistM / panelTargetM), T.maxBodyPanels);
  const shaftPanels = clamp(T.minShaftPanels, Math.round(shaftM / panelTargetM), T.maxShaftPanels);

  // Arms live on the shaft only. The window they may occupy is bounded at both ends, and the count
  // is REDUCED to fit rather than the pitch being squeezed: two arms 0.4 m apart are one fat arm.
  const armTopClearM = Math.max(T.armTopClearMinM, legTopM * T.armTopClearFrac);
  const armWaistClearM = Math.max(T.armWaistClearMinM, legTopM * T.armWaistClearFrac);
  const armTopM = legTopM - armTopClearM;
  const armFloorM = waistM + armWaistClearM;
  const armWindowM = Math.max(0, armTopM - armFloorM);
  const wantedArms = 2 + pickOf(seed, 1, 2);
  const armCount = clamp(1, 1 + Math.floor(armWindowM / T.minArmPitchM), wantedArms);
  const armPitchM = armCount > 1 ? armWindowM / (armCount - 1) : 0;

  return Object.freeze({
    seed,
    heightM,
    /** Height of the leg tops above `seat.baseY`. The peak spans from here to `heightM`. */
    legTopM,
    peakHeightM,
    /** Half-extents of the leg square at the base plane, along the footprint's own two axes. */
    baseHalf1,
    baseHalf2,
    yawRad: num(metrics.yawRad),
    centerX: num(metrics.centerX),
    centerZ: num(metrics.centerZ),
    waistM,
    waistFrac,
    waistRatio,
    topRatio: waistRatio * T.shaftTopTaper,
    panelTargetM,
    bodyPanels,
    shaftPanels,
    armCount,
    armPitchM,
    armTopM,
    armReachRatio,
    catHead,
    braceFlip,
  });
}

/**
 * The leg square's width multiplier at `h` metres above `seat.baseY`.
 *
 * Two straight runs, not a curve: splayed legs to the waist, a near-parallel shaft above it. That
 * kink IS the pylon silhouette — a single linear taper from ground to top reads as a spire.
 */
export function taperAt(profile, h) {
  const waist = Math.max(1e-6, profile.waistM);
  if (h <= waist) return 1 + (profile.waistRatio - 1) * (h / waist);
  const shaft = Math.max(1e-6, profile.legTopM - waist);
  return profile.waistRatio + (profile.topRatio - profile.waistRatio) * ((h - waist) / shaft);
}

// --------------------------------------------------------------------------------------------- //
// 3. Members. One square-section prism between two world-space points.
// --------------------------------------------------------------------------------------------- //

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length3 = (a) => Math.hypot(a[0], a[1], a[2]);
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

function normalise(a) {
  const len = length3(a);
  return len > 1e-9 ? scale3(a, 1 / len) : null;
}

/**
 * The two unit vectors of a member's square cross-section. Shared by `pushMember` and
 * `sectionRise` so the two can never disagree about how thick a member is in a given direction.
 */
function sectionAxes(a, b, reference) {
  const axis = normalise(sub(b, a));
  if (!axis) return null;
  let u = normalise(cross(reference, axis));
  if (!u) {
    // A reference parallel to the axis gives a zero cross product; fall back to whichever world
    // axis the member is least aligned with, so the section is always well conditioned.
    const fallback = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    u = normalise(cross(fallback, axis));
  }
  if (!u) return null;
  const v = normalise(cross(axis, u));
  return v ? { axis, u, v } : null;
}

/**
 * How far a member's steel reaches ABOVE (and below) its end point, in metres.
 *
 * An inclined member's end cap is a square in the plane perpendicular to its axis, so its topmost
 * corner stands `halfWidth * (|u_z| + |v_z|)` proud of the node. On the earth-wire peak that is
 * 8 cm on a 22 m tower — small, and still the difference between "the tower is exactly its data
 * height" and "the tower is its data height plus whatever the section happens to add", which is a
 * claim about a standing decision (handoff §4) and therefore has to be exact.
 */
function sectionRise(a, b, halfWidth, reference) {
  const axes = sectionAxes(a, b, reference);
  return axes ? halfWidth * (Math.abs(axes.u[2]) + Math.abs(axes.v[2])) : 0;
}

/**
 * Append one member to `sink`.
 *
 * Every quad carries its own four vertices — nothing is shared between faces — so when the renderer
 * computes normals (the contract lets a planner omit them) it gets FLAT shading for free. Shared
 * vertices here would smooth a 0.34 m steel angle into a sausage.
 *
 * Returns false and counts nothing when the two points coincide: a zero-length member is a
 * degenerate sliver, and `stats.degenerateMembersSkipped` reports it rather than shipping NaNs.
 */
function pushMember(sink, a, b, halfWidth, reference) {
  if (length3(sub(b, a)) < LATTICE_TOWER.minMemberLengthM) return false;
  const axes = sectionAxes(a, b, reference);
  if (!axes) return false;
  const { u, v } = axes;

  const base = sink.positions.length / 3;
  const corner = (origin, su, sv) => [
    origin[0] + halfWidth * (su * u[0] + sv * v[0]),
    origin[1] + halfWidth * (su * u[1] + sv * v[1]),
    origin[2] + halfWidth * (su * u[2] + sv * v[2]),
  ];
  const ends = [
    [corner(a, -1, -1), corner(a, 1, -1), corner(a, 1, 1), corner(a, -1, 1)],
    [corner(b, -1, -1), corner(b, 1, -1), corner(b, 1, 1), corner(b, -1, 1)],
  ];
  const [c0, c1, c2, c3] = ends[0];
  const [c4, c5, c6, c7] = ends[1];
  // Outward-wound quads: four sides, then the two caps. A member is a closed solid so that a leg
  // seen end-on from above is steel, not a hole.
  const quads = [
    [c0, c1, c5, c4],
    [c1, c2, c6, c5],
    [c2, c3, c7, c6],
    [c3, c0, c4, c7],
    [c3, c2, c1, c0],
    [c4, c5, c6, c7],
  ];
  let cursor = base;
  for (const quad of quads) {
    for (const point of quad) sink.positions.push(point[0], point[1], point[2]);
    sink.indices.push(cursor, cursor + 1, cursor + 2, cursor, cursor + 2, cursor + 3);
    cursor += 4;
  }
  sink.members += 1;
  return true;
}

// --------------------------------------------------------------------------------------------- //
// 4. The tower.
// --------------------------------------------------------------------------------------------- //

/** The four leg positions, in (u1, u2) sign pairs around the square. Order is the belt order. */
const LEG_SIGNS = Object.freeze([[1, 1], [1, -1], [-1, -1], [-1, 1]]);

/**
 * Plan one pylon as world-space mesh data.
 *
 * SEATING. The four feet are sampled INDIVIDUALLY with `groundYAt` and each is embedded
 * `footEmbedM` into its own ground. That matters here more than for any other archetype: at the
 * default relief of 3 the ground under tower 67's four corners spans 2.65-4.49 m, so a tower seated
 * on one plane stands 1.8 m in the air on its downhill leg — the exact "floating" read the seating
 * work of 2026-08-30 was done to kill. The feet keep their PLAN positions on the footprint corners
 * and only their length changes, which is what a real tower's leg extensions do, and which keeps
 * every vertex inside the authored footprint.
 *
 * The sampled foot is clamped into `[seat.loY - footEmbedM, seat.hiY]` — the seat's own measured
 * ground range under this footprint. Nothing invented: if a sampler ever answers something wild the
 * tower stays inside the ground it was seated against, and `stats.groundSamplesClamped` says so.
 */
export function latticeTowerPlan(classification, seat, groundYAt) {
  const profile = latticeTowerProfile(classification);
  const T = LATTICE_TOWER;
  const sink = { positions: [], indices: [], members: 0 };
  const stats = {
    degenerateMembersSkipped: 0,
    groundSamplesFallenBack: 0,
    groundSamplesClamped: 0,
  };

  const baseY = seat.baseY;
  const loY = num(seat.loY, baseY);
  const hiY = num(seat.hiY, baseY);
  const cosYaw = Math.cos(profile.yawRad);
  const sinYaw = Math.sin(profile.yawRad);
  // Game-space footprint axes, and the same two directions in world space (gameToWorld negates x
  // and z), used as the cross-section reference so every member's square section is square to the
  // tower rather than to the world.
  const e1 = [cosYaw, sinYaw];
  const e2 = [-sinYaw, cosYaw];
  const e1World = [-e1[0], -e1[1], 0];
  const e2World = [-e2[0], -e2[1], 0];
  const upWorld = [0, 0, 1];

  /** Game-space (x, z) of the point `u1` along e1 and `u2` along e2 from the footprint centre. */
  const groundXZ = (u1, u2) => [
    profile.centerX + u1 * e1[0] + u2 * e2[0],
    profile.centerZ + u1 * e1[1] + u2 * e2[1],
  ];
  /** World-space node at (u1, u2) scaled by the taper at height `h` above `baseY`. */
  const node = (s1, s2, h) => {
    const k = taperAt(profile, h);
    const [x, z] = groundXZ(s1 * profile.baseHalf1 * k, s2 * profile.baseHalf2 * k);
    return [-x, -z, baseY + h];
  };

  // ---- feet -------------------------------------------------------------------------------- //
  const sample = typeof groundYAt === 'function' ? groundYAt : null;
  const feet = LEG_SIGNS.map(([s1, s2]) => {
    const [x, z] = groundXZ(s1 * profile.baseHalf1, s2 * profile.baseHalf2);
    const raw = sample ? Number(sample(x, z)) : NaN;
    let y;
    if (Number.isFinite(raw)) {
      const clamped = clamp(loY, raw, hiY);
      if (Math.abs(clamped - raw) > 1e-6) stats.groundSamplesClamped += 1;
      y = clamped - T.footEmbedM;
    } else {
      stats.groundSamplesFallenBack += 1;
      y = baseY - T.footEmbedM;
    }
    return [-x, -z, y];
  });

  const member = (a, b, halfWidth, reference) => {
    if (!pushMember(sink, a, b, halfWidth, reference)) stats.degenerateMembersSkipped += 1;
  };

  // ---- legs: foot -> waist -> leg top ------------------------------------------------------ //
  // Two straight runs per leg. The kink at the waist is the silhouette; one run from foot to top
  // would be a spire, which no transmission tower is.
  LEG_SIGNS.forEach(([s1, s2], index) => {
    const waistNode = node(s1, s2, profile.waistM);
    member(feet[index], waistNode, T.legHalfWidthM, e1World);
    member(waistNode, node(s1, s2, profile.legTopM), T.legHalfWidthM, e1World);
  });

  // ---- panel levels ------------------------------------------------------------------------ //
  // Split at the waist so a panel never straddles the kink; the bracing style changes there too.
  const bodyLevels = Array.from(
    { length: profile.bodyPanels + 1 },
    (_, index) => (profile.waistM * index) / profile.bodyPanels,
  );
  const shaftLevels = Array.from(
    { length: profile.shaftPanels + 1 },
    (_, index) => profile.waistM + ((profile.legTopM - profile.waistM) * index) / profile.shaftPanels,
  );
  const levels = [...bodyLevels, ...shaftLevels.slice(1)];

  // ---- horizontal belts -------------------------------------------------------------------- //
  // One per face per level, skipping level 0: a belt on the base plane is buried on any slope and
  // pays for geometry nobody sees.
  for (const h of levels.slice(1)) {
    for (let face = 0; face < LEG_SIGNS.length; face++) {
      const [a1, a2] = LEG_SIGNS[face];
      const [b1, b2] = LEG_SIGNS[(face + 1) % LEG_SIGNS.length];
      member(node(a1, a2, h), node(b1, b2, h), T.beltHalfWidthM, upWorld);
    }
  }

  // ---- bracing ----------------------------------------------------------------------------- //
  // Body panels get a full X. Shaft panels get ONE alternating diagonal: up there the face is about
  // 2 m across, and two crossing 0.2 m members inside 2 m is mush at any zoom the map is read at.
  const braceFace = (face, hLo, hHi, both, flip) => {
    const [a1, a2] = LEG_SIGNS[face];
    const [b1, b2] = LEG_SIGNS[(face + 1) % LEG_SIGNS.length];
    const lowA = node(a1, a2, hLo), lowB = node(b1, b2, hLo);
    const highA = node(a1, a2, hHi), highB = node(b1, b2, hHi);
    if (both || flip === 0) member(lowA, highB, T.braceHalfWidthM, upWorld);
    if (both || flip === 1) member(lowB, highA, T.braceHalfWidthM, upWorld);
  };
  for (let panel = 0; panel < profile.bodyPanels; panel++) {
    for (let face = 0; face < LEG_SIGNS.length; face++) {
      braceFace(face, bodyLevels[panel], bodyLevels[panel + 1], true, 0);
    }
  }
  for (let panel = 0; panel < profile.shaftPanels; panel++) {
    for (let face = 0; face < LEG_SIGNS.length; face++) {
      braceFace(face, shaftLevels[panel], shaftLevels[panel + 1], false, (panel + profile.braceFlip + face) % 2);
    }
  }

  // ---- cross-arms -------------------------------------------------------------------------- //
  // Each arm is a plan-converging truss, not a stick: two top booms from the two legs on that side
  // meeting at the tip, two under-ties back to the same legs lower down, and a suspension insulator
  // hanging below the tip. The convergence in PLAN is what makes a cat-head read as a cat-head from
  // directly above, which is the angle this map is mostly seen from.
  const arms = [];
  for (let index = 0; index < profile.armCount; index++) {
    const h = profile.armTopM - index * profile.armPitchM;
    const grow = profile.catHead ? 1 + T.catHeadGrowth * index : 1;
    const reach = profile.baseHalf1 * profile.armReachRatio * grow;
    const shaftHalf1 = profile.baseHalf1 * taperAt(profile, h);
    const overhang = Math.max(0, reach - shaftHalf1);
    const tieDrop = clamp(T.armTieDropMinM, overhang * T.armTieDropRatio, T.armTieDropMaxM);
    const hTie = Math.max(profile.waistM * 0.5, h - tieDrop);
    arms.push({ h, reach, overhang, hTie });

    for (const side of [1, -1]) {
      const [tipX, tipZ] = groundXZ(side * reach, 0);
      const tip = [-tipX, -tipZ, baseY + h];
      for (const s2 of [1, -1]) {
        member(node(side, s2, h), tip, T.armHalfWidthM, upWorld);
        member(tip, node(side, s2, hTie), T.armHalfWidthM, upWorld);
      }
      member(tip, [tip[0], tip[1], tip[2] - T.insulatorLengthM], T.insulatorHalfWidthM, e1World);
    }
  }

  // ---- earth-wire peak --------------------------------------------------------------------- //
  // Four members from the leg tops to a single apex, sized so the TOPMOST STEEL — not the apex
  // node — lands at exactly `baseY + heightM`. The tower's overall height is therefore the data's
  // height to the millimetre, at every relief setting (handoff §4: heights are never changed).
  const [apexX, apexZ] = groundXZ(0, 0);
  const legTops = LEG_SIGNS.map(([s1, s2]) => node(s1, s2, profile.legTopM));
  const topSteelY = baseY + profile.heightM;
  // Lowering the apex tilts the four peak members, which changes their section rise, which changes
  // where the apex has to be. Three fixed-point steps take the residual from 80 mm to under 0.1 mm;
  // the alternative is to quote a height that is 8 cm out and call it exact. The four members are
  // not congruent either — the base rectangle is 3.63 x 3.60 m, not square — so take the WORST.
  let apexRise = 0;
  for (let pass = 0; pass < 3; pass++) {
    const trialApex = [-apexX, -apexZ, topSteelY - apexRise];
    apexRise = Math.max(...legTops.map(
      (legTop) => sectionRise(legTop, trialApex, T.peakHalfWidthM, e1World),
    ));
  }
  const apex = [-apexX, -apexZ, topSteelY - apexRise];
  for (const legTop of legTops) member(legTop, apex, T.peakHalfWidthM, e1World);

  const positions = new Float32Array(sink.positions);
  const indices = new Uint32Array(sink.indices);
  return {
    profile,
    feet,
    levels,
    arms,
    /** The apex NODE. The steel around it reaches `apexRise` higher — see `topSteelY`. */
    apexY: apex[2],
    apexRise,
    /** Where the topmost steel is meant to land: exactly the data height above the seat. */
    topSteelY,
    mesh: {
      positions,
      indices,
      groups: [{ start: 0, count: indices.length, materialSlot: LATTICE_MATERIAL_SLOT }],
    },
    stats: Object.freeze({
      ...stats,
      memberCount: sink.members,
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
    }),
  };
}

// --------------------------------------------------------------------------------------------- //
// 5. The contract entry point.
// --------------------------------------------------------------------------------------------- //

/**
 * `planDetail(building, context) -> BuildingDetailPlan | null`, per `src/building-detail/contract.js`.
 *
 * Returns null for any building this planner does not own — the router decides archetypes and a
 * planner that dressed a shed as a pylon because it was handed one would be a silent re-route.
 *
 * `seat` is read by the contract's names (`baseY`, `loY`, `hiY`) and NOT by `src/buildings.js`'s
 * (`base`, `lo`, `hi`). If a caller hands the wrong shape this THROWS, loudly, naming the keys it
 * did receive: a quiet `?? 0` there would seat all four towers at world zero and still report a
 * plan with a triangle count, which is the handoff §6 failure verbatim.
 */
export function planDetail(building, context) {
  const classification = context?.classification;
  if (classification?.archetype !== 'lattice-tower') return null;

  const buildingIndex = context?.buildingIndex;
  const seat = context?.seat;
  if (!seat || !Number.isFinite(Number(seat.baseY))) {
    throw new TypeError(
      `lattice-tower planner: context.seat.baseY must be finite (got keys: ${
        seat ? Object.keys(seat).join(', ') : String(seat)
      })`,
    );
  }

  const plan = emptyDetailPlan(buildingIndex, 'lattice-tower');
  plan.replacesMass = LATTICE_TOWER_FLAGS.replacesMass;
  plan.suppressPlinth = LATTICE_TOWER_FLAGS.suppressPlinth;

  const metrics = classification.metrics ?? {};
  if (!(num(metrics.lengthM) > 0) || !(num(metrics.widthM) > 0)) {
    plan.notes.push('DEGENERATE FOOTPRINT: no oriented bounding box, so no tower was planned.');
    return plan;
  }

  const built = latticeTowerPlan(classification, {
    baseY: Number(seat.baseY),
    loY: num(seat.loY, Number(seat.baseY)),
    hiY: num(seat.hiY, Number(seat.baseY)),
  }, context?.groundYAt);

  plan.mesh = built.mesh;
  plan.profile = built.profile;
  plan.stats = built.stats;
  plan.notes.push(
    `${built.stats.memberCount} members, ${built.stats.triangleCount} triangles, one "metal" group.`,
    `${built.profile.armCount} cross-arm(s), ${built.profile.bodyPanels} braced body panels + `
      + `${built.profile.shaftPanels} shaft panels, waist at ${(built.profile.waistFrac * 100).toFixed(0)}% `
      + `of the leg height, shaft ${(built.profile.waistRatio * 100).toFixed(0)}% of the base width.`,
    'replacesMass: the extruded 22 m box MUST NOT be drawn for this building.',
    'suppressPlinth: a pylon stands on four footings; the near-black skirt is wrong here.',
  );
  if (built.stats.groundSamplesFallenBack > 0) {
    plan.notes.push(
      `DEGRADED: ${built.stats.groundSamplesFallenBack}/4 leg feet had no usable ground sample and `
        + 'fell back to the seat plane — those legs will not follow the slope.',
    );
  }
  if (built.stats.degenerateMembersSkipped > 0) {
    plan.notes.push(`DEGRADED: ${built.stats.degenerateMembersSkipped} member(s) were degenerate and skipped.`);
  }
  return plan;
}

// --------------------------------------------------------------------------------------------- //
// 6. Cost, stated rather than estimated.
// --------------------------------------------------------------------------------------------- //

/**
 * The draw-call delta for this archetype, from the plans themselves.
 *
 * Three.js issues one call per material group. Each tower contributes ONE group in the `metal`
 * slot, which is not one of the two the building mesh already pays for, so the delta is exactly one
 * call per tower and no instanced family at all. The contract's own `planDrawCallDelta` agrees
 * (the test asserts they do); this function exists so the number can be read per archetype.
 */
export function latticeTowerDrawCallDelta(plans) {
  const rows = (Array.isArray(plans) ? plans : []).filter((plan) => plan?.mesh);
  const slots = new Set();
  for (const plan of rows) for (const group of plan.mesh.groups) slots.add(group.materialSlot);
  return {
    buildings: rows.length,
    extraSlotsPerBuilding: 1,
    instancedFamilies: 0,
    distinctSlots: [...slots],
    drawCallDelta: rows.length,
    triangles: rows.reduce((sum, plan) => sum + plan.mesh.indices.length / 3, 0),
  };
}
