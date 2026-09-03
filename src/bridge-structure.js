/**
 * Bridge structure — piers, deck fascia and railings — as pure, GPU-free mesh data.
 *
 * The deck.gl renderer has drawn FOUR things per bridge since the 2026-08-29 fidelity pass
 * (`piers`, `bridge-edges`, `bridges`, `bridge-rails` in src/map3d.js). The Three renderer drew one
 * flat ribbon, so the Main Bridge read as a painted stripe on the gorge and the Junk Bridge did not
 * read as a bridge at all. This module is the half of the parity fix that can be asserted without a
 * GPU: it plans the structure in game coordinates and emits ready-to-upload positions/indices.
 *
 * Two rules here are load-bearing and both are inherited from the deck renderer:
 *
 *  1. A **ford is not a structure.** deck.gl filters fords out of its piers, edges and rails with
 *     `!b.ford`; Customs' "River path" is one — a shallow crossing where the road simply runs
 *     through the water. It keeps its deck and gets nothing else. Railings on a ford would be a
 *     rendered claim that a bridge exists where the game has none.
 *  2. **Every dimension scales from the bridge's own width.** Hardcoding the Main Bridge's numbers
 *     puts a motorway parapet on a 3 m footbridge; the footbridge then stops reading as a small
 *     bridge, which is the one thing it has to do. The deck itself is NOT planned here — it keeps
 *     the renderer's existing measured-surface behaviour (`measuredSurfaceY`), and this module is
 *     handed that same deck altitude as `deckYAt` so the structure cannot drift off it.
 *  3. **A deck is FLAT.** Nothing in this module may bend one. Where a deck ends above its bank the
 *     gap is filled by structure — see `bridgeApproachPlan` — never by dragging the running surface
 *     down to the ground.
 */
import { DRAPE, cleanPath, miteredEdges, pathCumulative, resamplePath } from './wall-runs.js';
import { drapedPrismStripMeshData, gameToWorld } from './three-world.js';

const clamp = (low, value, high) => Math.min(high, Math.max(low, value));
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * Fixed offsets that exist to keep coincident surfaces apart, not to describe a bridge.
 *
 * The fascia's top sits just UNDER the deck ribbon and the railings' feet just ABOVE it: both
 * surfaces would otherwise be exactly coplanar with a ribbon that is already drawn there, which is
 * a depth fight, not a detail.
 */
export const BRIDGE_STRUCTURE = Object.freeze({
  fasciaTopGapM: 0.02,
  railBaseLiftM: 0.02,
  /** Piers are sunk into the ground rather than parked on it; a sampled bed is never exact. */
  pierFootEmbedM: 0.4,
  /** Below this the pier is a seam between the deck and the ground, not a support. */
  minPierHeightM: 0.6,
  /** Same reason as `pierFootEmbedM`: an abutment is founded IN the bank, never parked on it. */
  abutmentFootEmbedM: 0.35,
  /**
   * Below this a deck end already meets its bank, and an abutment there would be a kerb across the
   * road rather than a support under a deck.
   */
  minAbutmentGapM: 0.35,
  /**
   * The grade the approach road leaves the deck on — the number that decides whether the crossing
   * reads as a road arriving at a bridge or as a skate ramp.
   *
   * 10% is a steep but real road grade. The measured alternative is on record: the ease-the-deck-
   * down-to-grade attempt this replaced reached a LOCAL grade of 102% on the Main Bridge's east
   * approach (measured along its centre line at 0.25 m, displayed metres at relief 2), because it
   * spent a fixed 15 m on a 7.89 m drop and chased the bank's own fall while doing it.
   */
  approachGrade: 0.1,
  /**
   * How far above the ground the approach finishes. Road ribbons are drawn at `H + 0.08`, so an
   * approach landing at exactly the ground would be coplanar with the road it joins; 0.1 m puts it
   * 2 cm proud of that instead of into a depth fight.
   */
  approachGradeLiftM: 0.1,
  /** Thickness of the carriageway the embankment carries, so the fill is UNDER the road surface. */
  approachSurfaceM: 0.06,
  /** An approach that has not reached grade by here is reported as such, never extended forever. */
  approachMaxLengthM: 240,
  /** No prism is emitted thinner than this; a zero-height solid is z-fighting, not geometry. */
  minPrismHeightM: 0.05,
});

/**
 * Resolve one bridge's structural dimensions from its deck width, in metres.
 *
 * The clamps matter more than the ratios: a pure ratio gives the 3 m Junk Bridge a 0.27 m parapet
 * and a 0.1 m deck edge, which at map zoom is nothing at all, while an unclamped ratio on a wider
 * deck would grow a pier as broad as the carriageway. Ratios set the family, clamps keep both ends
 * of the range legible.
 */
export function bridgeStructureProfile(widthM) {
  const width = Math.max(0.5, num(widthM));
  /** How far the fascia stands proud of the deck on each side. */
  const fasciaOverhangM = clamp(0.12, width * 0.05, 0.6);
  return Object.freeze({
    widthM: width,
    /** Deck slab depth — what turns the ribbon from a painted stripe into a surface with an edge. */
    deckThicknessM: clamp(0.35, width * 0.09, 1.1),
    fasciaOverhangM,
    /** How far back UNDER the deck the abutment reaches, so the deck end BEARS on it. */
    abutmentInsetM: clamp(0.4, width * 0.12, 2),
    /** ...and how far behind the deck end it continues, so it reads as founded, not pasted on. */
    abutmentDepthM: clamp(2.5, width * 0.55, 9),
    /** The fascia line plus a wing-wall flare, so the abutment is a little wider than the deck. */
    abutmentHalfWidthM: width / 2 + fasciaOverhangM + clamp(0.15, width * 0.06, 0.8),
    /** The embankment carries the FASCIA's width outward, so the deck's edge line continues. */
    embankmentHalfWidthM: width / 2 + fasciaOverhangM,
    railHeightM: clamp(0.9, width * 0.11, 1.35),
    railBarWidthM: clamp(0.16, width * 0.035, 0.45),
    /** Distance from the centre line to each railing. Always inside the deck. */
    railHalfSpanM: Math.max(0.35, width / 2 - clamp(0.15, width * 0.1, 0.4)),
    /** Across the path. */
    pierWidthM: clamp(0.9, width * 0.45, 5),
    /** Along the path. */
    pierDepthM: clamp(0.7, width * 0.28, 3),
    pierSpacingM: clamp(8, width * 2.2, 24),
    /** No pier inside this distance of either abutment — that end is carried by the bank. */
    pierEndClearanceM: clamp(1.5, width * 0.6, 8),
  });
}

/** Unit tangent of `path` at along-run distance `distance`, plus the point itself. */
function sampleAlong(points, cumulative, distance) {
  const total = cumulative[cumulative.length - 1];
  const target = clamp(0, distance, total);
  let index = 1;
  while (index < points.length - 1 && cumulative[index] < target) index++;
  const [ax, az] = points[index - 1], [bx, bz] = points[index];
  const span = cumulative[index] - cumulative[index - 1];
  const t = span > 1e-9 ? (target - cumulative[index - 1]) / span : 0;
  return {
    x: ax + (bx - ax) * t,
    z: az + (bz - az) * t,
    yaw: Math.atan2(bz - az, bx - ax),
  };
}

/**
 * A prism with a GIVEN top and a base that follows the ground under every one of its corners.
 *
 * `drapedPrismStripMeshData` cannot express this: it takes ONE height and rides a surface, so its
 * top follows the ground too. An abutment is the opposite shape — its top is decided by the deck
 * and its base by the bank — and an embankment is the same shape with a sloping top. Winding,
 * vertex order and the index pattern are copied from that function so the two families of solid in
 * this renderer share normals and cull the same way.
 *
 * The base is clamped to `minPrismHeightM` below the top rather than the top being lifted: a solid
 * may be founded deeper than intended, but a solid whose top is not where the deck says it is would
 * be a lie about the structure.
 */
function seatedPrismMeshData(edges, topYFor, baseYFor) {
  const ring = (Array.isArray(edges) ? edges : []).filter((edge) => [
    edge?.left?.[0], edge?.left?.[1], edge?.right?.[0], edge?.right?.[1],
  ].every((value) => Number.isFinite(Number(value))));
  if (ring.length < 2) return null;
  const footprint = [];
  for (const edge of ring) {
    footprint.push(
      [Number(edge.left[0]), Number(edge.left[1])],
      [Number(edge.right[0]), Number(edge.right[1])],
    );
  }
  const bases = [], tops = [];
  for (const [x, z] of footprint) {
    const topY = num(topYFor(x, z), NaN);
    const groundY = num(baseYFor(x, z), NaN);
    if (!Number.isFinite(topY) || !Number.isFinite(groundY)) return null;
    tops.push(topY);
    bases.push(Math.min(groundY, topY - BRIDGE_STRUCTURE.minPrismHeightM));
  }
  const positions = [];
  footprint.forEach(([x, z], index) => positions.push(...gameToWorld(x, z, bases[index])));
  footprint.forEach(([x, z], index) => positions.push(...gameToWorld(x, z, tops[index])));
  const top = footprint.length;
  const indices = [];
  for (let index = 1; index < ring.length; index++) {
    const b0 = 2 * (index - 1), b1 = b0 + 1, b2 = 2 * index, b3 = b2 + 1;
    const t0 = top + b0, t1 = top + b1, t2 = top + b2, t3 = top + b3;
    indices.push(
      b0, b2, b1, b1, b2, b3, // ground-facing bottom
      t0, t1, t2, t1, t3, t2, // upward-facing top
      b0, t0, b2, t0, t2, b2, // left side
      b1, b3, t1, t1, b3, t3, // right side
    );
    if (index === 1) indices.push(b0, b1, t0, b1, t1, t0);               // start cap
    if (index === ring.length - 1) indices.push(b2, t2, b3, t2, t3, b3); // end cap
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    footprint,
    bases,
    tops,
  };
}

/**
 * Plan the ABUTMENT and the approach EMBANKMENT at one end of a deck.
 *
 * Returns null when this end needs neither — a deck that already meets its bank.
 */
function planApproachEnd(points, index, sign, side, profile, deckYAt, groundYAt) {
  const [px, pz] = points[index];
  const [qx, qz] = points[index + sign];
  const dx = px - qx, dz = pz - qz;
  const run = Math.hypot(dx, dz);
  if (!(run > 1e-9)) return null;
  // Outward: away from the span, along the deck's OWN end tangent. Nothing else decides where the
  // approach goes — no road row, no landmark, no literal.
  const ux = dx / run, uz = dz / run;
  const at = (distance) => [px + ux * distance, pz + uz * distance];
  const along = (x, z) => (x - px) * ux + (z - pz) * uz;
  const ground = (x, z) => num(groundYAt(x, z), NaN);

  const deckY = num(deckYAt(px, pz), NaN);
  const groundYEnd = ground(px, pz);
  if (!Number.isFinite(deckY) || !Number.isFinite(groundYEnd)) return null;
  const gapM = deckY - groundYEnd;
  if (!(gapM > BRIDGE_STRUCTURE.minAbutmentGapM)) return null;

  // The abutment's top is the STRUCTURE's underside — the same plane the fascia's base sits on —
  // so the deck's last metres bear on solid mass instead of ending over air.
  const undersideY = deckY - profile.deckThicknessM - BRIDGE_STRUCTURE.fasciaTopGapM;
  const footY = (x, z) => ground(x, z) - BRIDGE_STRUCTURE.abutmentFootEmbedM;
  // Resampled at the drape step for the same reason walls are: a solid only samples the ground at
  // its own corners, and this one is metres long across a bank that falls away.
  const abutmentPath = resamplePath(
    [at(-profile.abutmentInsetM), at(profile.abutmentDepthM)],
    DRAPE.maxSegmentM,
  );
  const abutment = seatedPrismMeshData(
    miteredEdges(abutmentPath, profile.abutmentHalfWidthM),
    () => undersideY,
    footY,
  );

  // The embankment: the road leaves the deck at `approachGrade` and runs until it reaches the
  // ground, which is a distance the TERRAIN decides, never a fixed length.
  const grade = BRIDGE_STRUCTURE.approachGrade;
  const surfaceAt = (distance) => deckY - grade * distance;
  let approachLengthM = 0;
  let meetsGrade = false;
  for (let s = DRAPE.maxSegmentM; s <= BRIDGE_STRUCTURE.approachMaxLengthM + 1e-9; s += DRAPE.maxSegmentM) {
    approachLengthM = s;
    const groundYHere = ground(...at(s));
    if (!Number.isFinite(groundYHere)) break;
    if (surfaceAt(s) <= groundYHere + BRIDGE_STRUCTURE.approachGradeLiftM) { meetsGrade = true; break; }
  }
  // The fill's top is the carriageway MINUS its own thickness, so the road ribbon laid on top of it
  // lands exactly on the deck's level at the joint instead of a few centimetres proud of it.
  const topYAt = (x, z) => surfaceAt(clamp(0, along(x, z), approachLengthM)) - BRIDGE_STRUCTURE.approachSurfaceM;
  const approachPath = resamplePath([at(0), at(approachLengthM)], DRAPE.maxSegmentM);
  const embankment = approachLengthM > DRAPE.maxSegmentM / 2
    ? seatedPrismMeshData(miteredEdges(approachPath, profile.embankmentHalfWidthM), topYAt, footY)
    : null;
  const tailGroundY = ground(...at(approachLengthM));

  return {
    side,
    x: px,
    z: pz,
    yaw: Math.atan2(uz, ux),
    deckY,
    undersideY,
    /** How far the deck end stood above its bank before any of this was built. */
    gapM,
    abutment,
    embankment,
    approachPath,
    approachLengthM,
    approachGradePct: grade * 100,
    /** The fill's top surface at any (x, z); the road ribbon rides `approachSurfaceM` above it. */
    topYAt,
    meetsGrade,
    /**
     * How far the carriageway still stands above the ground where the embankment stops. This is the
     * metric that can FAIL: `meetsGrade` alone would report success for an approach that ran out of
     * `approachMaxLengthM` while still metres in the air.
     */
    residualGapM: Number.isFinite(tailGroundY) ? surfaceAt(approachLengthM) - tailGroundY : null,
  };
}

/**
 * Where a deck LANDS: the abutment at each end, and the embankment that carries the road to it.
 *
 * THE DEFECT, and the fix that was wrong. A deck seated on an absolute measured altitude is one
 * flat plane, and the row carrying that altitude says nothing about where the deck ends. Customs'
 * Main Bridge is seated on the median of sixteen loot samples taken on its own deck; the
 * interpolated public heightfield then falls away under both ends, so the deck stopped 2.34 m above
 * the highway at its west end and 7.99 m above it at the east one (displayed metres at relief 2).
 * The first attempt eased the last 15 m of each end DOWN to grade. It connected, and the founder
 * looked at it up close and said "need a fix this aint a bridge no more" — correctly: a bridge deck
 * is FLAT, and a deck bent at both ends is a folded ribbon at up to a 102% local grade.
 *
 * THE STRUCTURE THAT IS ACTUALLY THERE. A bridge keeps its level deck and lands on ABUTMENTS —
 * solid masses filling the gap between the deck's underside and the ground — with an approach
 * EMBANKMENT carrying the road up to deck level wherever the drop is too large for an abutment
 * alone to be anything but a cliff. The game agrees: Customs' main bridge carries objects named
 * `end_bridge` at both deck ends, beside the `bridge_opora` piers this module already draws.
 *
 * WHAT THIS MAY BE CALLED WITH. MEASURED seating only. A `terrain-lift` deck already tracks the
 * ground at a constant lift, and a `canonical-game-y` deck is pinned to its HIGHEST bank on purpose
 * so its ends are flush already — the Junk Bridge clears the water by 0.48 m and anything that
 * reaches for a sampled bed under it puts it back under the river. A ford is a crossing, not a
 * structure, and gets nothing.
 *
 * EVERY NUMBER IS DERIVED from the deck path, the deck width, the deck altitude and the terrain
 * sampler. There is no game-derived coordinate here and no bridge literal.
 */
export function bridgeApproachPlan(bridge, { deckYAt = () => 0, groundYAt = () => 0 } = {}) {
  const path = cleanPath(bridge?.path);
  const profile = bridgeStructureProfile(bridge?.width);
  const ford = bridge?.ford === true;
  const plan = {
    name: String(bridge?.name ?? 'bridge'),
    ford,
    profile,
    ends: [],
  };
  // A ford is a crossing, not a structure — the same rule `bridgeStructurePlan` holds.
  if (ford || path.length < 2) return plan;
  const last = path.length - 1;
  for (const [index, sign, side] of [[0, 1, 'start'], [last, -1, 'end']]) {
    const end = planApproachEnd(path, index, sign, side, profile, deckYAt, groundYAt);
    if (end) plan.ends.push(end);
  }
  return plan;
}

/**
 * Plan the structure under and along one bridge deck.
 *
 * `deckYAt(x, z)` must be the SAME function the renderer seats its deck ribbon with, so a bridge
 * with measured evidence keeps its surveyed altitude and an unmeasured one keeps its local lift.
 * `groundYAt(x, z)` is the terrain the piers stand on.
 */
export function bridgeStructurePlan(bridge, { deckYAt = () => 0, groundYAt = () => 0 } = {}) {
  const path = cleanPath(bridge?.path);
  const profile = bridgeStructureProfile(bridge?.width);
  const ford = bridge?.ford === true;
  const plan = {
    name: String(bridge?.name ?? 'bridge'),
    ford,
    foot: bridge?.foot === true,
    profile,
    path,
    lengthM: 0,
    fascia: null,
    rails: [],
    piers: [],
  };
  if (path.length < 2) return plan;
  const { points, cumulative } = pathCumulative(path);
  plan.lengthM = cumulative[cumulative.length - 1];
  // A ford is a crossing, not a structure. Everything below this line is structure.
  if (ford) return plan;

  const fasciaEdges = miteredEdges(path, profile.widthM / 2 + profile.fasciaOverhangM);
  plan.fascia = drapedPrismStripMeshData(
    fasciaEdges,
    profile.deckThicknessM,
    -(profile.deckThicknessM + BRIDGE_STRUCTURE.fasciaTopGapM),
    deckYAt,
  );

  const railEdges = miteredEdges(path, profile.railHalfSpanM);
  for (const side of ['left', 'right']) {
    const centreline = railEdges.map((edge) => edge[side]);
    const rail = drapedPrismStripMeshData(
      miteredEdges(centreline, profile.railBarWidthM / 2),
      profile.railHeightM,
      BRIDGE_STRUCTURE.railBaseLiftM,
      deckYAt,
    );
    if (rail) plan.rails.push({ side, ...rail });
  }

  // Piers are spread EVENLY over the supportable span rather than stepped from one end, so a run
  // whose length is not a whole number of spacings does not end with one long unsupported half.
  const first = profile.pierEndClearanceM;
  const last = plan.lengthM - profile.pierEndClearanceM;
  const supportable = last - first;
  const bays = supportable > 1e-6 ? Math.max(1, Math.round(supportable / profile.pierSpacingM)) : 0;
  const stations = bays
    ? Array.from({ length: bays + 1 }, (_, index) => first + (supportable * index) / bays)
    : [plan.lengthM / 2]; // too short to keep a clearance: one support in the middle or none at all
  for (const distance of stations) {
    const { x, z, yaw } = sampleAlong(points, cumulative, distance);
    const topY = num(deckYAt(x, z)) - profile.deckThicknessM;
    const bottomY = num(groundYAt(x, z)) - BRIDGE_STRUCTURE.pierFootEmbedM;
    const heightM = topY - bottomY;
    // The deck runs at grade here (an approach ramp, or a bridge over a bank): there is nothing to
    // hold up, and a stub pier would poke through the road.
    if (!(heightM >= BRIDGE_STRUCTURE.minPierHeightM)) continue;
    plan.piers.push({
      x, z, yaw, topY, bottomY, heightM,
      widthM: profile.pierWidthM,
      depthM: profile.pierDepthM,
      distanceM: distance,
    });
  }
  return plan;
}
