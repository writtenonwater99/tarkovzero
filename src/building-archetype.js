/**
 * Building archetype router — the SINGLE source of truth for which detail family each Customs
 * building belongs to.
 *
 * This module is pure and dependency-free (no THREE, no deck, no DOM, no fs) for the same reason
 * `src/buildings.js` and `src/bridge-structure.js` are: it is the one place a building's family is
 * decided, and `scripts/building-archetype.test.mjs` has to be able to assert against the very
 * function the renderer runs rather than a re-implementation of it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT
 *
 * Six competing design specs were written for the same 71 buildings. Each routed on a DIFFERENT
 * axis — one on `style`, one on `kind`, one on footprint area, one on place name — and between them
 * they made 84 archetype claims over 71 buildings. Fifteen buildings were claimed twice, including
 * the six biggest warehouses (35.7% of all footprint area) with CONTRADICTORY ridge counts, and two
 * buildings were claimed by nobody at all.
 *
 * The fix is not a better spec. It is ONE router, evaluated ONCE, assigning EXACTLY ONE archetype
 * per building, with the sum-equals-input-count invariant checked in `classifyAll` — see decision 1
 * in the build brief. A building that no branch claims lands in `unstyled`, which is loud on screen
 * and asserted empty for Customs, rather than being silently undressed.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THREE AXES AND NOT SEVEN ARCHETYPES
 *
 * `docs/plans/BUILDING-MASSING.md` §4.2 names seven forms (A pitched-roof masonry house,
 * B long-span industrial shed, C flat-roof concrete block, D open unfinished frame, E canopy on
 * posts, F vertical cylinder, G lattice tower). Those seven are NOT seven router branches — they are
 * points in the CROSS PRODUCT of three independent axes this module returns separately:
 *
 *     archetype   which factory builds the mass          (7 frozen keys)
 *     roofForm    what the top does                      (4 frozen keys)
 *     program     what the inside is for                 (4 frozen keys)
 *
 * so B = `big-box` + `ridged` + `industrial`, C = `big-box` + `flat-parapet` + `occupied`,
 * A = `small-box`/`big-box` + `ridged` + `occupied`. Collapsing that cross product into one
 * enumeration is exactly what produced six mutually exclusive specs: `style` and `kind` are
 * orthogonal in this data (`kind: 'tank'` carries `style: 'gable'`; `kind: 'small_buildings'`
 * carries five different styles) and any single-axis router has to overrule one of them silently.
 *
 * Gable is deliberately NOT an archetype (decision 2). It is the ridged branch of `roofForm`,
 * reachable from `big-box`, `small-box` and `garage` alike.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THE ROUTER MAY READ
 *
 * PUBLIC DATA ONLY — the fields present in `public/data/customs-3d.json`: poly, height, floors,
 * kind, name, style, place, color, roof, featureId, featureClass, heightEvidence. Nothing from
 * `.local-game-derived/` or `.local-candidates/`, and no game-derived coordinate appears here.
 * Every threshold below is stated with the measurement that justifies it and the empty band it
 * sits in, so a later reader can re-derive it from the shipped JSON alone.
 *
 * HEIGHTS ARE NEVER CHANGED. This module reads `height` and `floors`; it does not adjust them
 * (handoff §4, standing decision 4).
 */

// --------------------------------------------------------------------------------------------- //
// Frozen vocabularies. A planner may only ever be handed one of these.
// --------------------------------------------------------------------------------------------- //

/**
 * The archetypes. Exactly one is assigned per building.
 *
 * `unstyled` is a deliberate, loud fallback, not a bucket: it is asserted EMPTY for Customs, and it
 * exists so that an unknown future building is visibly undressed instead of quietly taking whatever
 * treatment the last `else` branch happened to give it.
 */
export const ARCHETYPES = Object.freeze([
  'big-box',
  'small-box',
  'garage',
  'cylinder',
  'open-structure',
  'lattice-tower',
  'unstyled',
]);

/** What the top of the mass does. A SEPARATE axis from the archetype (decision 2). */
export const ROOF_FORMS = Object.freeze(['ridged', 'flat-parapet', 'mono-pitch', 'none']);

/**
 * What the inside is for. `unresolved` is the same kind of loud fallback as `unstyled`: it is the
 * measured gap between the two populations, and it is asserted empty for Customs.
 */
export const PROGRAMS = Object.freeze(['occupied', 'industrial', 'utility', 'unresolved', 'none']);

/** The `kind` values this router recognises, and the branch each one takes. */
export const KNOWN_KINDS = Object.freeze([
  'powerline_towers', 'tank', 'cooling_tower', 'garages', 'big_buildings', 'small_buildings',
]);

/** The `style` values this router recognises. */
export const KNOWN_STYLES = Object.freeze(['box', 'gable', 'tank', 'cooling-tower', 'canopy', 'frame']);

// --------------------------------------------------------------------------------------------- //
// Thresholds. Every one names the measurement it came from and the empty band it sits in.
// --------------------------------------------------------------------------------------------- //

export const ARCHETYPE_THRESHOLDS = Object.freeze({
  /**
   * Storey ratio = height / floors. Measured over the 13 Customs rows with `floors >= 2`:
   * the occupied blocks land on 3.17, 3.17, 3.25, 3.25, 3.60, 3.75 and the industrial halls on
   * 4.75, 4.75, 4.75, 4.75, 5.75, 7.75, 9.05. Nothing at all lies in (3.75, 4.75) — that gap IS
   * the classifier, and the two bounds below sit inside it with room on both sides.
   */
  occupiedMaxStoreyM: 4.0,
  industrialMinStoreyM: 4.5,
  /**
   * For a single-storey row the storey ratio degenerates to the height, and the measured gap is a
   * different and much wider one: garages sit at 4.0 m, the 3.5 m small buildings below them, and
   * the next single-storey row up is a 9.0 m warehouse. 4.0 -> 9.0 is empty, so 4.5 is a threshold
   * with 0.5 m of clearance below and 4.5 m above.
   */
  singleStoreyIndustrialMinM: 4.5,
  /**
   * A ridge needs a span to sit on. Below this short-side width the ridge on a plausible pitch is
   * shorter than the eave detail around it, and the object reads as a lean-to: 25 of the 28 small
   * `box` rows are 6.3 x 2.8 m sheds, whose ridge at 22 degrees would stand 0.57 m proud. The
   * measured gap here is 4.1 m (the two ZB kiosks) to 5.4 m (the trailer pair).
   */
  monoPitchMaxWidthM: 5.0,
  /**
   * Footprint area / oriented-bounding-box area. Below this the plan is articulated (an L, a T, an
   * E or a curve) and a planner must decompose it into rectilinear units with their OWN ridge axes
   * rather than throwing one ridge across the whole plan (decision 3). Measured: the quads all sit
   * at 0.98-1.00, and the next value down is 0.94 (Depot), then 0.89, 0.82, 0.79, 0.78, 0.74, 0.66,
   * 0.54 (Repair Shop).
   */
  rectilinearMinFill: 0.96,
  /**
   * A circle inscribed in its own bounding box fills pi/4 = 0.7854 of it. A footprint with at least
   * this many vertices, an aspect near 1 and a fill near pi/4 is a drawn circle, whatever its
   * `style` says. This is the only geometric rule that OVERRIDES an authored field, and it exists
   * because `kind: 'tank'` row 16 carries `style: 'gable'` — a 16-gon of aspect 1.01 and fill 0.79.
   */
  roundMinVertices: 12,
  roundMaxAspect: 1.15,
  roundFillTolerance: 0.05,
  /**
   * ONLY used for a row whose `kind` is not in `KNOWN_KINDS`. It is NOT how Customs is routed and
   * cannot be: `small_buildings` reaches 263 m2 while `big_buildings` starts at 138 m2, so the two
   * populations overlap and NO area threshold reproduces the authored split. Stated here so that a
   * future unknown-kind row still lands somewhere real instead of in `unstyled`.
   */
  unknownKindBigMinAreaM2: 300,
});

const PI_OVER_4 = Math.PI / 4;

// --------------------------------------------------------------------------------------------- //
// Footprint geometry. Pure, and shared with every downstream planner so that the ridge axis a
// planner uses is the same axis the router measured its aspect on.
// --------------------------------------------------------------------------------------------- //

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** Clean a `poly` row into finite [x, z] pairs; anything else is dropped rather than coerced. */
function cleanRing(poly) {
  if (!Array.isArray(poly)) return [];
  return poly
    .filter((point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
    .map((point) => [Number(point[0]), Number(point[1])]);
}

/** Shoelace area, unsigned — winding is not consistent across the shipped rows. */
function ringArea(ring) {
  let twice = 0;
  for (let index = 0; index < ring.length; index++) {
    const [ax, az] = ring[index];
    const [bx, bz] = ring[(index + 1) % ring.length];
    twice += ax * bz - bx * az;
  }
  return Math.abs(twice) / 2;
}

/** Andrew's monotone chain. The minimum-area rectangle of a polygon is that of its convex hull. */
function convexHull(ring) {
  if (ring.length < 3) return ring.slice();
  const points = ring.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (source) => {
    const out = [];
    for (const point of source) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  return [...half(points), ...half(points.slice().reverse())];
}

/**
 * The minimum-area oriented bounding box, by rotating calipers over the hull's own edge directions.
 *
 * Returns metres and radians in GAME coordinates: `yawRad` is `atan2(dz, dx)` of the LONG axis, the
 * same convention `bridge-structure.js` uses for a path tangent and the same one `mesh.rotation.z`
 * takes in the Three renderer.
 */
export function orientedBoundingBox(ring) {
  const hull = convexHull(ring);
  if (hull.length < 3) {
    return { lengthM: 0, widthM: 0, areaM2: 0, yawRad: 0, centerX: 0, centerZ: 0 };
  }
  let best = null;
  for (let index = 0; index < hull.length; index++) {
    const [ax, az] = hull[index];
    const [bx, bz] = hull[(index + 1) % hull.length];
    const run = Math.hypot(bx - ax, bz - az);
    if (!(run > 1e-9)) continue;
    const ux = (bx - ax) / run, uz = (bz - az) / run;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, z] of hull) {
      const u = x * ux + z * uz;
      const v = -x * uz + z * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const spanU = maxU - minU, spanV = maxV - minV;
    const area = spanU * spanV;
    if (best && !(area < best.area - 1e-9)) continue;
    const midU = (minU + maxU) / 2, midV = (minV + maxV) / 2;
    best = {
      area,
      spanU, spanV, ux, uz,
      centerX: midU * ux - midV * uz,
      centerZ: midU * uz + midV * ux,
    };
  }
  if (!best) return { lengthM: 0, widthM: 0, areaM2: 0, yawRad: 0, centerX: 0, centerZ: 0 };
  const alongIsLong = best.spanU >= best.spanV;
  return {
    lengthM: Math.max(best.spanU, best.spanV),
    widthM: Math.min(best.spanU, best.spanV),
    areaM2: best.area,
    // The LONG axis: the edge direction itself when it is the longer span, else its perpendicular.
    yawRad: alongIsLong ? Math.atan2(best.uz, best.ux) : Math.atan2(best.ux, -best.uz),
    centerX: best.centerX,
    centerZ: best.centerZ,
  };
}

/** The footprint centroid, matching `centroidOf` in `src/buildings.js` (vertex mean, not area). */
export function footprintCentroid(ring) {
  if (!ring.length) return [0, 0];
  return ring.reduce((acc, point) => [acc[0] + point[0] / ring.length, acc[1] + point[1] / ring.length], [0, 0]);
}

/**
 * Everything a planner needs to scale itself to the actual object rather than to its archetype
 * label. The archetype names the FACTORY; these numbers are its parameters.
 */
export function footprintMetrics(poly) {
  const ring = cleanRing(poly);
  const areaM2 = ring.length >= 3 ? ringArea(ring) : 0;
  const obb = orientedBoundingBox(ring);
  const aspect = obb.widthM > 1e-9 ? obb.lengthM / obb.widthM : 0;
  const fill = obb.areaM2 > 1e-9 ? areaM2 / obb.areaM2 : 0;
  const [centroidX, centroidZ] = footprintCentroid(ring);
  const T = ARCHETYPE_THRESHOLDS;
  return Object.freeze({
    vertices: ring.length,
    areaM2,
    perimeterM: ring.reduce((sum, point, index) => {
      const next = ring[(index + 1) % ring.length];
      return sum + Math.hypot(next[0] - point[0], next[1] - point[1]);
    }, 0),
    lengthM: obb.lengthM,
    widthM: obb.widthM,
    aspect,
    fill,
    /** The dominant long axis. A rectilinear plan's ridge runs along this; an articulated one's does not. */
    yawRad: obb.yawRad,
    centerX: obb.centerX,
    centerZ: obb.centerZ,
    centroidX,
    centroidZ,
    /**
     * True when one ridge across the whole plan is defensible. False means the planner MUST
     * decompose into rectilinear units and give each its own ridge axis (decision 3).
     */
    rectilinear: fill >= T.rectilinearMinFill,
    /** A drawn circle, whatever `style` claims. See `roundMinVertices` above. */
    round: ring.length >= T.roundMinVertices
      && aspect > 0 && aspect <= T.roundMaxAspect
      && Math.abs(fill - PI_OVER_4) <= T.roundFillTolerance,
  });
}

// --------------------------------------------------------------------------------------------- //
// Deterministic seed. Variation between buildings is the point; randomness is forbidden.
// --------------------------------------------------------------------------------------------- //

/**
 * A stable 32-bit hash of the footprint centroid, quantised to 1 cm so that float noise in an
 * upstream build cannot flip a building's variation. FNV-1a over the quantised decimal text.
 *
 * Every planner MUST take its variation from this and never from an array index, a Date, or
 * `Math.random` (which is unavailable and would make the renderer irreproducible run to run).
 */
export function seedFor(building) {
  const ring = cleanRing(building?.poly);
  const [x, z] = footprintCentroid(ring);
  const key = `${Math.round(x * 100)}:${Math.round(z * 100)}:${Math.round(num(building?.height) * 100)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The same seed as a number in [0, 1). Convenience only — `seedFor` is the source of truth. */
export const unitSeedFor = (building) => seedFor(building) / 0x100000000;

// --------------------------------------------------------------------------------------------- //
// The router.
// --------------------------------------------------------------------------------------------- //

const text = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

/**
 * The archetype branch, and the reason it was taken. Precedence is TOP TO BOTTOM and the first
 * match wins — that ordering is what makes "exactly one archetype" true by construction rather
 * than by hope.
 */
function routeArchetype(kind, style, metrics) {
  // 1. Lattice towers first, before anything can mistake a 7 m square footprint for a shed.
  //    The four `powerline_towers` rows are drawn today as 22 m SOLID BOXES — the tallest wrong
  //    objects on the map — and `docs/plans/BUILDING-MASSING.md` §2 puts them outside the building
  //    lane entirely ("lattice structures, not buildings; they belong to the prop lane"). Routing
  //    them to their own archetype is how they stop being dressed as sheds.
  if (kind === 'powerline_towers') return { archetype: 'lattice-tower', reason: 'kind:powerline_towers' };

  // 2. Cylinders. `kind` and `style` disagree here (row 16 is `kind: 'tank'`, `style: 'gable'`),
  //    so the geometry gets the casting vote: a 16-gon of aspect 1.01 filling 0.79 of its box is a
  //    drawn circle and a gable roof on it would be a claim the footprint contradicts.
  if (kind === 'tank' || kind === 'cooling_tower') return { archetype: 'cylinder', reason: `kind:${kind}` };
  if (style === 'tank' || style === 'cooling-tower') return { archetype: 'cylinder', reason: `style:${style}` };
  if (metrics.round) return { archetype: 'cylinder', reason: 'geometry:round-footprint' };

  // 3. Structures with no enclosing wall: a canopy on posts and an unfinished concrete frame are
  //    the same problem (columns and slabs, sky between them) and the opposite of a box.
  if (style === 'canopy' || style === 'frame') return { archetype: 'open-structure', reason: `style:${style}` };

  // 4. Garage ranks. Their own archetype because a rank of 6 m deep bays repeated along a wall is a
  //    different object from a building of the same footprint, and because 12 of them share one
  //    door module — the single largest instancing opportunity on the map.
  if (kind === 'garages') return { archetype: 'garage', reason: 'kind:garages' };

  // 5. The box split. `kind` decides it, not area: the two populations OVERLAP (small_buildings
  //    reaches 263 m2, big_buildings starts at 138 m2) so no area threshold can reproduce the
  //    authored split, and the authored split is the one that matches what a player reads. Size is
  //    handed to the planner as a PARAMETER (`metrics`), never as the routing key.
  if (kind === 'big_buildings') return { archetype: 'big-box', reason: 'kind:big_buildings' };
  if (kind === 'small_buildings') return { archetype: 'small-box', reason: 'kind:small_buildings' };

  // 6. Unknown kind, recognised style: fall back to area so the row still lands somewhere real.
  //    This path is dead for Customs and is asserted so.
  if (style === 'box' || style === 'gable') {
    const big = metrics.areaM2 >= ARCHETYPE_THRESHOLDS.unknownKindBigMinAreaM2;
    return { archetype: big ? 'big-box' : 'small-box', reason: `fallback:style:${style}:area` };
  }

  // 7. Nothing recognised either axis. Loud on screen, asserted empty for Customs.
  return { archetype: 'unstyled', reason: 'unrouted' };
}

/**
 * What the inside is for.
 *
 * Only meaningful for the three enclosed-box archetypes. A cylinder, a lattice tower and an open
 * frame have no storeys to be occupied or industrial, and saying otherwise would be a claim with
 * nothing behind it, so they return `none`.
 */
function routeProgram(archetype, heightM, floors) {
  if (archetype !== 'big-box' && archetype !== 'small-box' && archetype !== 'garage') {
    return { program: 'none', storeyRatio: null };
  }
  const T = ARCHETYPE_THRESHOLDS;
  const count = Math.max(1, Math.floor(num(floors, 1)));
  const storeyRatio = heightM / count;
  if (count >= 2) {
    if (storeyRatio <= T.occupiedMaxStoreyM) return { program: 'occupied', storeyRatio };
    if (storeyRatio >= T.industrialMinStoreyM) return { program: 'industrial', storeyRatio };
    // Inside the measured empty band. Loud, and asserted empty for Customs.
    return { program: 'unresolved', storeyRatio };
  }
  // A single storey: the ratio degenerates to the height, and the useful question is whether the
  // clear height is a hall's or a hut's.
  return {
    program: heightM >= T.singleStoreyIndustrialMinM ? 'industrial' : 'utility',
    storeyRatio,
  };
}

/**
 * What the top does.
 *
 * THE RULE: an authored `style` that names a roof form WINS; shape decides only where style is
 * silent (`box`, or an unrecognised value). That is what stops this from becoming a seventh
 * competing spec — the data already carries 18 `gable` rows and 18 of them get a ridge.
 *
 * `none` does NOT mean "flat". It means the roof-form branch contributes nothing and the archetype
 * planner owns the top: an open frame's top is a floor slab, a cooling tower's is an open rim, and
 * a lattice tower has no top at all.
 */
function routeRoofForm(archetype, style, program, metrics) {
  if (archetype === 'lattice-tower' || archetype === 'cylinder') return { roofForm: 'none', reason: `archetype:${archetype}` };
  if (archetype === 'open-structure') {
    // A fuel canopy is a shallow single-slope deck; an unfinished frame has no roof — it is the
    // point of the building that it does not (Skeleton, Old Construction).
    return style === 'canopy'
      ? { roofForm: 'mono-pitch', reason: 'style:canopy' }
      : { roofForm: 'none', reason: 'style:frame' };
  }
  if (style === 'gable') return { roofForm: 'ridged', reason: 'style:gable' };
  if (style === 'canopy') return { roofForm: 'mono-pitch', reason: 'style:canopy' };

  // Style is silent (`box`). Shape and program decide.
  //
  // An occupied block is flat-roofed with a parapet: Dorms 2-Story, Dorms 3-Story, Oil Rig and the
  // Dorms stair core are Soviet panel blocks, and a ridge on one would be the single most obviously
  // wrong roof on the map.
  if (program === 'occupied') return { roofForm: 'flat-parapet', reason: 'program:occupied' };
  // A garage rank drains one way, across the bays.
  if (archetype === 'garage') return { roofForm: 'mono-pitch', reason: 'archetype:garage' };
  // Too narrow for a ridge to read: a lean-to.
  if (metrics.widthM > 0 && metrics.widthM < ARCHETYPE_THRESHOLDS.monoPitchMaxWidthM) {
    return { roofForm: 'mono-pitch', reason: 'shape:narrow-span' };
  }
  return { roofForm: 'ridged', reason: 'shape:span' };
}

/**
 * Classify ONE building. Pure, total, and deterministic: same row in, same record out, forever.
 *
 * The returned record is the whole interface a planner gets. It never contains the look — geometry
 * may not depend on the look flip (see `src/building-detail/contract.js`).
 */
export function classifyBuilding(building) {
  const kind = text(building?.kind);
  const style = text(building?.style);
  const metrics = footprintMetrics(building?.poly);
  const heightM = num(building?.height);
  const floors = Math.max(1, Math.floor(num(building?.floors, 1)));

  const { archetype, reason } = routeArchetype(kind, style, metrics);
  const { program, storeyRatio } = routeProgram(archetype, heightM, floors);
  const { roofForm, reason: roofReason } = routeRoofForm(archetype, style, program, metrics);

  return Object.freeze({
    archetype,
    roofForm,
    program,
    metrics,
    heightM,
    floors,
    storeyRatio,
    seed: seedFor(building),
    /** Present on 18 rows and thrown away by the renderer today — free differentiation. */
    roofColor: Array.isArray(building?.roof) ? Object.freeze([...building.roof]) : null,
    wallColor: Array.isArray(building?.color) ? Object.freeze([...building.color]) : null,
    place: text(building?.place) || null,
    name: text(building?.name) || null,
    kind,
    style,
    featureId: building?.featureId ?? null,
    sourceKey: building?.sourceKey ?? null,
    /** Why this branch was taken. Carried so a census can be read without re-running the router. */
    routedBy: reason,
    roofRoutedBy: roofReason,
    /** True when neither axis was recognised — the loud state, asserted empty for Customs. */
    unrouted: archetype === 'unstyled',
  });
}

// --------------------------------------------------------------------------------------------- //
// The census, and the invariant that is the point of this whole module.
// --------------------------------------------------------------------------------------------- //

class ArchetypeInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchetypeInvariantError';
  }
}
export { ArchetypeInvariantError };

const emptyBuckets = () => Object.fromEntries(ARCHETYPES.map((key) => [key, []]));
const emptyTally = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));

/**
 * Classify EVERY building once, and check that the assignment is a partition.
 *
 * This THROWS on violation rather than returning a flag. The distinction matters and is the whole
 * design: an unknown DATA row is survivable and lands in `unstyled`, which renders loudly and is
 * counted; a broken ROUTER — a building claimed twice, claimed by nobody, or a census that does not
 * add up — is a code defect that must not be allowed to render at all. Handoff §6 documents five
 * separate occasions on which this project reported success while something had silently fallen
 * back; a returned-but-unread status field would have been the sixth.
 */
export function classifyAll(buildings) {
  const rows = Array.isArray(buildings) ? buildings : [];
  const assignments = rows.map((building) => classifyBuilding(building));

  const byArchetype = emptyBuckets();
  const claimedBy = new Array(rows.length).fill(null);
  assignments.forEach((record, index) => {
    if (!ARCHETYPES.includes(record.archetype)) {
      throw new ArchetypeInvariantError(
        `building ${index} was assigned archetype "${record.archetype}", which is not in ARCHETYPES`,
      );
    }
    if (claimedBy[index] !== null) {
      throw new ArchetypeInvariantError(
        `building ${index} was claimed twice: "${claimedBy[index]}" and "${record.archetype}"`,
      );
    }
    claimedBy[index] = record.archetype;
    byArchetype[record.archetype].push(index);
  });

  const unclaimed = claimedBy.reduce((acc, value, index) => (value === null ? [...acc, index] : acc), []);
  if (unclaimed.length) {
    throw new ArchetypeInvariantError(`${unclaimed.length} building(s) unclaimed: ${unclaimed.join(', ')}`);
  }

  const bucketed = ARCHETYPES.reduce((sum, key) => sum + byArchetype[key].length, 0);
  if (bucketed !== rows.length) {
    throw new ArchetypeInvariantError(
      `archetype counts sum to ${bucketed}, but ${rows.length} buildings were handed in`,
    );
  }

  const totalAreaM2 = assignments.reduce((sum, record) => sum + record.metrics.areaM2, 0);
  const census = ARCHETYPES.map((archetype) => {
    const indices = byArchetype[archetype];
    const areaM2 = indices.reduce((sum, index) => sum + assignments[index].metrics.areaM2, 0);
    return {
      archetype,
      count: indices.length,
      areaM2,
      areaPct: totalAreaM2 > 0 ? (areaM2 / totalAreaM2) * 100 : 0,
    };
  });

  const censusCount = census.reduce((sum, row) => sum + row.count, 0);
  const censusArea = census.reduce((sum, row) => sum + row.areaM2, 0);
  if (censusCount !== rows.length) {
    throw new ArchetypeInvariantError(`census counts sum to ${censusCount}, expected ${rows.length}`);
  }
  if (totalAreaM2 > 0 && Math.abs(censusArea - totalAreaM2) / totalAreaM2 > 1e-9) {
    throw new ArchetypeInvariantError(`census area ${censusArea} does not equal footprint total ${totalAreaM2}`);
  }

  const roofCensus = emptyTally(ROOF_FORMS);
  const programCensus = emptyTally(PROGRAMS);
  for (const record of assignments) {
    roofCensus[record.roofForm] += 1;
    programCensus[record.program] += 1;
  }

  return {
    count: rows.length,
    assignments,
    byArchetype,
    census,
    roofCensus,
    programCensus,
    totals: { count: rows.length, areaM2: totalAreaM2 },
    /** Rows nothing claimed by name. MUST be empty for Customs; loud, not silent, if it is not. */
    unstyled: byArchetype.unstyled.slice(),
    /** Rows in the measured storey-ratio gap. MUST be empty for Customs. */
    unresolvedProgram: assignments.reduce(
      (acc, record, index) => (record.program === 'unresolved' ? [...acc, index] : acc),
      [],
    ),
  };
}

/** A one-line-per-row census table, for a report or a console. Pure formatting. */
export function formatCensus(result) {
  const rows = result.census.filter((row) => row.count > 0 || row.archetype === 'unstyled');
  const width = Math.max(...ARCHETYPES.map((key) => key.length));
  const lines = rows.map((row) => [
    row.archetype.padEnd(width),
    String(row.count).padStart(5),
    row.areaM2.toFixed(0).padStart(9),
    `${row.areaPct.toFixed(1)}%`.padStart(7),
  ].join('  '));
  const total = [
    'TOTAL'.padEnd(width),
    String(result.totals.count).padStart(5),
    result.totals.areaM2.toFixed(0).padStart(9),
    '100.0%'.padStart(7),
  ].join('  ');
  return [
    ['archetype'.padEnd(width), 'count'.padStart(5), 'area m2'.padStart(9), 'share'.padStart(7)].join('  '),
    ...lines,
    total,
  ].join('\n');
}
