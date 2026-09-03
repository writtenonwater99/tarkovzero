/**
 * Small-box detail planner — the long tail.
 *
 * Thirty of Customs' seventy-one buildings route here (`kind: 'small_buildings'`), and they are the
 * most nearly identical population on the map: **fifteen of them are the same 6.1-6.7 x 2.5-2.9 m
 * shed at 3.5 m and one storey**, differing only in yaw and a few centimetres of footprint. Two more
 * are the ZB kiosks, eleven are medium sheds, and two are occupied blocks (the Dorms 3-Story stair
 * core and the Military Checkpoint scav house).
 *
 * So the deliverable of THIS module is not detail. It is DIFFERENTIATION. A beautifully detailed
 * shed applied thirty times gives thirty identical beautifully detailed sheds, and the founder's
 * complaint — "random boxes and cylinders" — is unmoved. Every element below therefore has two
 * justifications recorded against it: what real rule derives it from public data, and what makes it
 * come out DIFFERENT on the next shed along.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE, AND WHY (build decision 4: silhouette over surface)
 *
 * Metres-per-pixel is exactly `2^-zoom` and the default 3D zoom is 0, so **at the default view one
 * pixel is one metre**. On a 6.3 x 2.8 x 3.5 m shed that is a six-by-three pixel footprint three and
 * a half pixels tall. Anything thinner than a metre is not visible there at all. Accordingly:
 *
 *   - **No wall ribs, pilasters, cills or reveals.** 0.35 m of relief is a third of a pixel.
 *   - **No skids, footings or base kerbs**, although the brief lists them. Two reasons, both
 *     decisive: a 0.15 m runner is a sixth of a pixel, AND the ground contact under these buildings
 *     is already owned by the near-black plinth skirt (`seatBuilding`/`plinthColor` in
 *     src/buildings.js, build decision 5). Geometry there would be spent under a shadow.
 *   - **No downpipes or gutters.** Sub-pixel, and `downpipe` is a registered family another
 *     archetype with real wall height can spend better.
 *
 * The budget goes instead to the four things that change a 6x3 pixel blob's OUTLINE: the roof's
 * form, the direction it falls, how far it overhangs, and a stovepipe standing proud of it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ROOF SITS ABOVE `height`, AND THAT IS NOT A HEIGHT CHANGE
 *
 * Standing decision 4 (handoff §4) freezes building heights, and this module never reads or writes
 * one except through `seat`. The extruded prism the renderer already draws stands exactly `height`
 * tall; this planner treats that top plane as the **eave line**, which is what a pitch requires —
 * you cannot derive a ridge from a plausible pitch and also keep the ridge under the eave. The mass
 * the player reads as "the building" is unchanged; a roof is added to it.
 *
 * The rise is capped at `maxRiseHeightRatio` of the building's own height precisely so that this
 * stays true: uncapped, the 16.5 x 16.1 m Military Checkpoint shed would take a 3.24 m ridge on a
 * 3.5 m building and read as a tent. The cap turns wide spans into shallow ones — which is also how
 * wide-span roofs are actually built, so the cap is a rule and not a fudge.
 *
 * ---------------------------------------------------------------------------------------------
 * FRAMES
 *
 * Internally everything is computed in GAME coordinates as `[x, z, y]` triples (y up) and converted
 * once, at emit, by `gameToWorld`. That map is `(x, z, y) -> (-x, -z, y)`, whose matrix is
 * `diag(-1, -1, 1)` with determinant +1, so it preserves orientation and face winding survives it
 * unchanged. `yaws` are reported in WORLD radians about +Z, which is the game yaw plus pi.
 */
import { gameToWorld } from '../three-world.js';
import { MATERIAL_SLOT_INDEX, emptyDetailPlan } from './contract.js';

const ARCHETYPE = 'small-box';

const clamp = (low, value, high) => Math.min(high, Math.max(low, value));
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const DEG = Math.PI / 180;

// --------------------------------------------------------------------------------------------- //
// 1. The dimension tables. Every number states the measurement or the pixel that justifies it.
// --------------------------------------------------------------------------------------------- //

export const SMALL_BOX_ROOF = Object.freeze({
  /**
   * A gable pitch. 26 degrees is a Russian shed/dacha roof — steep enough to shed snow, which is
   * what these are for. On the 2.5 m sheds it yields a 0.61 m ridge; anything shallower and the
   * fifteen twins are back to being flat-topped boxes at every zoom.
   */
  gablePitchDeg: 26,
  /**
   * A lean-to falls further per metre than a gable because it crosses the WHOLE span rather than
   * half of it, so it needs a shallower pitch to land at a comparable rise: 15 degrees over the
   * 2.5 m sheds is 0.67 m, within 10% of the gable's 0.61 m. Matching the two rises is deliberate —
   * the point of the mono/ridge split is the SHAPE of the outline, not two different building
   * heights next to each other.
   */
  monoPitchDeg: 15,
  /**
   * The rise cap, as a fraction of the building's own height. 0.45 lets the narrow sheds keep their
   * full geometric pitch (0.61 / 3.5 = 0.17) while pulling the 16 m spans down: 8.03 m of half-span
   * at 26 degrees wants 3.92 m and gets 1.58 m, an effective 11 degrees. A low-slope trussed roof
   * over a wide span is correct; a 3.9 m ridge on a 3.5 m building is a circus tent.
   */
  maxRiseHeightRatio: 0.45,
  /** And an absolute ceiling, so a tall future small-box cannot grow an unbounded roof. */
  maxRiseM: 3,
  /**
   * Below this the roof is not a form, it is a wobble in the flat cap — and it would cost the same
   * triangles. A building whose capped rise falls under it gets `flat-parapet` treatment instead,
   * which at least reads as a deliberate flat roof.
   */
  minRiseM: 0.3,
  /**
   * Vertical thickness of the roof slab. 0.22 m is what makes the eave read as an EDGE rather than
   * a paper plane: at zoom 1 it is a fifth of a pixel of shadow, at zoom 3 it is two pixels of
   * fascia. It is also the only thing standing between the overhang and a zero-volume surface.
   */
  slabThicknessM: 0.22,
  /**
   * Eave overhang, across the span. TWO values, picked by seed — see the bit map below. This is the
   * cheapest genuine variation available on a shed: the overhang sets both how far the roof stands
   * proud in plan AND, through `underside(v)`, how tall the attic band under it is, so one bit
   * changes two visible dimensions at once.
   */
  eaveOverhangM: Object.freeze([0.28, 0.45]),
  /** Along the ridge, at the gable ends. Constant: a barge-board overhang is not where variety lives. */
  endOverhangM: 0.22,
  /**
   * Parapet height on the two occupied blocks. A roof a person can stand on needs a guard; 1.05 m
   * is a guard. There are only two such rows in this archetype, so this is a constant on purpose —
   * inventing a seed-driven guard height would be variation with nothing behind it.
   */
  parapetHeightM: 1.05,
  /** How far in from the wall face the parapet's inner leaf sits, so it reads as a wall not a lid. */
  parapetThicknessM: 0.3,
});

export const SMALL_BOX_PLANT = Object.freeze({
  /**
   * The hut/hall line. Below it a single-storey utility row is a hut and gets a STOVEPIPE; above it
   * it is a store or a workshop and gets ridge VENTS. 45 m2 sits in a real gap in this archetype's
   * measured areas: the rows run ... 33.3, 33.6, 40.9, 41.7, 41.9 then 51.3, 51.6, 53.5 ... so the
   * threshold has 3 m2 of clearance below and 6 m2 above and no row is near it.
   */
  hutMaxAreaM2: 45,
  /** Flue diameter. A stovepipe, not a chimney stack. */
  stackDiameterM: 0.26,
  /**
   * Flue heights and stations. THIS is what stops the twelve mono-pitch twins being twelve of the
   * same object: three stations along the ridge x three heights x two fall directions x two
   * overhangs = 72 outlines before the footprint's own yaw is counted.
   */
  stackHeightsM: Object.freeze([1.05, 1.4, 1.75]),
  stackStations: Object.freeze([-0.62, 0, 0.66]),
  /** Keep the flue this far inside the gable end, so it never overhangs its own roof. */
  stackEndInsetM: 0.7,
  /** One vent per this many square metres, clamped. 40 m2 spreads the eight big utility rows 1..4. */
  ventAreaPerUnitM2: 40,
  maxVents: 4,
  ventSizeM: Object.freeze([0.9, 0.7, 0.55]),
  /** The whole vent line shifts by one of these along the ridge — differentiates equal-area sheds. */
  ventLineShiftM: Object.freeze([-0.6, 0, 0.6]),
  /** No vent closer than this to a gable end. */
  ventEndInsetM: 1.2,
  /** A roof a person stands on gets a way up. Occupied rows only. */
  hatchSizeM: Object.freeze([2.2, 1.7, 1.15]),
  /** Occupied roofs this large also carry plant. The checkpoint (64.8 m2) does; the stair core does not. */
  occupiedVentMinAreaM2: 60,
});

export const SMALL_BOX_DOOR = Object.freeze({
  /**
   * One door below this area, two above. 60 m2 also splits man-door from roller shutter: the five
   * rows above it (64.8, 75.7, 78.5, 106.5, 262.5 m2) are the only ones in this archetype wide
   * enough for a vehicle opening to be credible.
   */
  twoDoorMinAreaM2: 60,
  manDoorWidthM: 1.05,
  manDoorHeightM: 2.15,
  shutterWidthM: 2.4,
  shutterHeightM: 2.9,
  /** Head clearance kept under the eave, so a door never eats its own wall head. */
  headClearanceM: 0.35,
  /**
   * The leaf stands PROUD of the wall rather than being recessed into it. A recess would be a hole
   * cut in a mesh this planner does not own; 0.12 m proud is unambiguous geometry that also absorbs
   * the up-to-10 cm disagreement between the footprint and its oriented bounding box.
   */
  protrusionM: 0.12,
  /** Stations along the chosen wall, as a fraction of the usable half-width. */
  stations: Object.freeze([-0.34, 0, 0.36]),
  /** Two doors sit at these fractions of the wall length. */
  pairStations: Object.freeze([-0.3, 0.3]),
  /**
   * A door on the downhill face would otherwise float. It is extended DOWN to meet the ground, but
   * never by more than this — past 1.2 m the gap belongs to the plinth skirt, not to a door leaf.
   */
  maxGroundReachM: 1.2,
});

/**
 * THE SEED BIT MAP — a register allocation, and the reason two features never move together.
 *
 * `classification.seed` is a 32-bit FNV-1a hash of the quantised footprint centroid. Slicing it by
 * named, non-overlapping bit ranges is what makes "twelve sheds, seventy-two outlines" true rather
 * than hoped for: if the fall direction and the flue station both read `seed % 3`, every shed that
 * falls left would also vent left and the population would collapse to a handful of looks.
 */
export const SEED_BITS = Object.freeze({
  monoFallDirection: Object.freeze({ shift: 0, width: 1, modulo: 2 }),
  eaveOverhang: Object.freeze({ shift: 1, width: 2, modulo: 2 }),
  stackStation: Object.freeze({ shift: 3, width: 2, modulo: 3 }),
  stackHeight: Object.freeze({ shift: 5, width: 2, modulo: 3 }),
  doorWall: Object.freeze({ shift: 7, width: 1, modulo: 2 }),
  doorStation: Object.freeze({ shift: 8, width: 2, modulo: 3 }),
  ventLineShift: Object.freeze({ shift: 10, width: 2, modulo: 3 }),
  hatchQuadrant: Object.freeze({ shift: 12, width: 2, modulo: 4 }),
});

/** Read one named channel out of a seed. Pure; the only source of variation in this module. */
export function seedChannel(seed, channelName) {
  const channel = SEED_BITS[channelName];
  if (!channel) throw new TypeError(`unknown seed channel "${channelName}"`);
  const raw = (num(seed) >>> channel.shift) & ((1 << channel.width) - 1);
  return raw % channel.modulo;
}

// --------------------------------------------------------------------------------------------- //
// 2. Roof geometry, as pure arithmetic. Everything else in this file consumes these two functions.
// --------------------------------------------------------------------------------------------- //

/**
 * The roof's rise above the eave, and the effective pitch that rise actually represents.
 *
 * `roofForm` decides which span the pitch crosses: a ridge crosses HALF the width, a lean-to crosses
 * all of it. `heightM` decides the cap. The returned `capped` flag is carried into the plan's notes
 * so a reader can see which rows are on their geometric pitch and which are on the cap.
 */
export function roofRise(roofForm, widthM, heightM) {
  const width = Math.max(0, num(widthM));
  const height = Math.max(0, num(heightM));
  const span = roofForm === 'ridged' ? width / 2 : width;
  const pitchDeg = roofForm === 'ridged' ? SMALL_BOX_ROOF.gablePitchDeg : SMALL_BOX_ROOF.monoPitchDeg;
  const geometric = span * Math.tan(pitchDeg * DEG);
  const cap = Math.min(SMALL_BOX_ROOF.maxRiseHeightRatio * height, SMALL_BOX_ROOF.maxRiseM);
  const riseM = Math.min(geometric, cap);
  return {
    riseM,
    geometricRiseM: geometric,
    capM: cap,
    capped: geometric > cap + 1e-9,
    effectivePitchDeg: span > 1e-9 ? Math.atan(riseM / span) / DEG : 0,
    readable: riseM >= SMALL_BOX_ROOF.minRiseM,
  };
}

/**
 * The height of the roof's UNDERSIDE above the eave plane, at cross-span position `v`.
 *
 * This one function is the seam between the roof slab and the wall under it: the slab is built from
 * it and the attic band's top is built from it, so the two cannot disagree and there can be no gap
 * between the wall head and the roof. `halfSpanM` is the OVERHUNG half-width, which is why the
 * underside is strictly positive everywhere over the wall (|v| <= widthM/2 < halfSpanM) and the
 * attic band therefore never degenerates to a zero-height quad.
 */
export function roofUndersideAt(roofForm, v, halfSpanM, riseM, fallSign = 1) {
  const half = Math.max(1e-6, num(halfSpanM));
  if (roofForm === 'ridged') return riseM * Math.max(0, 1 - Math.abs(num(v)) / half);
  // Mono-pitch: linear from the low eave (-half) to the high eave (+half) in the FALL frame.
  const local = clamp(-half, num(v) * (fallSign >= 0 ? 1 : -1), half);
  return riseM * ((local + half) / (2 * half));
}

// --------------------------------------------------------------------------------------------- //
// 3. Mesh assembly. Game-space in, world-space out, flat normals, one group per material slot.
// --------------------------------------------------------------------------------------------- //

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Accumulates triangles per material slot and emits one contiguous group per slot.
 *
 * Faces are emitted with INDEPENDENT vertices — nothing is shared between two faces — so that the
 * renderer's computed normals come out FLAT. A shared vertex at a ridge would average the two roof
 * planes into a smooth curve, which is the one thing a ridge must not look like.
 *
 * `addQuad`/`addTri` take an OUTWARD reference direction and flip the winding to match it. Winding
 * is therefore never asserted against the code that produced it: the test checks the emitted
 * geometry's signed volume against an analytic volume instead (see the module's test file).
 */
class DetailMeshBuilder {
  constructor() {
    /** @type {Map<number, number[][][]>} slot -> array of triangles, each 3 game-space points */
    this.bySlot = new Map();
  }

  get triangleCount() {
    let total = 0;
    for (const list of this.bySlot.values()) total += list.length;
    return total;
  }

  addTri(slot, a, b, c, outwardRef) {
    const normal = cross(sub(b, a), sub(c, a));
    const tri = outwardRef && dot(normal, outwardRef) < 0 ? [a, c, b] : [a, b, c];
    if (!this.bySlot.has(slot)) this.bySlot.set(slot, []);
    this.bySlot.get(slot).push(tri);
  }

  addQuad(slot, a, b, c, d, outwardRef) {
    this.addTri(slot, a, b, c, outwardRef);
    this.addTri(slot, a, c, d, outwardRef);
  }

  build() {
    const slots = [...this.bySlot.keys()].sort((left, right) => left - right);
    const positions = [];
    const normals = [];
    const indices = [];
    const groups = [];
    let cursor = 0;
    for (const slot of slots) {
      const triangles = this.bySlot.get(slot);
      if (!triangles.length) continue;
      for (const [a, b, c] of triangles) {
        const wa = gameToWorld(a[0], a[1], a[2]);
        const wb = gameToWorld(b[0], b[1], b[2]);
        const wc = gameToWorld(c[0], c[1], c[2]);
        const raw = cross(sub(wb, wa), sub(wc, wa));
        const length = Math.hypot(raw[0], raw[1], raw[2]) || 1;
        const unit = [raw[0] / length, raw[1] / length, raw[2] / length];
        for (const vertex of [wa, wb, wc]) {
          indices.push(positions.length / 3);
          positions.push(vertex[0], vertex[1], vertex[2]);
          normals.push(unit[0], unit[1], unit[2]);
        }
      }
      groups.push({ start: cursor, count: triangles.length * 3, materialSlot: slot });
      cursor += triangles.length * 3;
    }
    if (!groups.length) return null;
    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      normals: new Float32Array(normals),
      groups,
    };
  }
}

// --------------------------------------------------------------------------------------------- //
// 4. Footprint helpers. All thirty small-box rows are convex quads with fill >= 0.976, which is why
//    a centroid test is enough to orient an edge and why the OBB is a fair stand-in for the plan.
// --------------------------------------------------------------------------------------------- //

function cleanRing(poly) {
  if (!Array.isArray(poly)) return [];
  const ring = poly
    .filter((point) => Array.isArray(point)
      && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
    .map((point) => [Number(point[0]), Number(point[1])]);
  // Drop a repeated closing vertex; a duplicate corner would emit a zero-area wall quad.
  if (ring.length > 2) {
    const [fx, fz] = ring[0];
    const [lx, lz] = ring[ring.length - 1];
    if (Math.hypot(fx - lx, fz - lz) < 1e-6) ring.pop();
  }
  return ring;
}

const ringCentroid = (ring) => ring.reduce(
  (acc, point) => [acc[0] + point[0] / ring.length, acc[1] + point[1] / ring.length],
  [0, 0],
);

/**
 * The wall edge whose outward normal points most nearly along `targetGame`.
 *
 * "Outward" is decided by the centroid, not by winding: `poly` winding is not consistent across the
 * shipped rows (`ringArea` in src/building-archetype.js takes an absolute value for exactly this
 * reason), and every footprint here is convex, so "away from the centroid" is exact.
 */
export function pickWall(ring, targetGame) {
  const centroid = ringCentroid(ring);
  let best = null;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const run = Math.hypot(dx, dz);
    if (!(run > 1e-6)) continue;
    let nx = dz / run, nz = -dx / run;
    const midX = (a[0] + b[0]) / 2, midZ = (a[1] + b[1]) / 2;
    if (nx * (midX - centroid[0]) + nz * (midZ - centroid[1]) < 0) { nx = -nx; nz = -nz; }
    const score = nx * targetGame[0] + nz * targetGame[1];
    if (!best || score > best.score) {
      best = { score, a, b, lengthM: run, normal: [nx, nz], mid: [midX, midZ], tangent: [dx / run, dz / run] };
    }
  }
  return best;
}

// --------------------------------------------------------------------------------------------- //
// 5. Instanced prototypes. Built once at module load; the renderer merges one InstancedMesh per
//    family across all 71 buildings, so a prototype's triangles are paid once per instance drawn
//    and its DRAW CALL is paid once for the whole map.
//
//    Convention shared by every family here: prototype local +X is the FACING or LONG axis (what
//    `yaws` rotates), +Y is across it, +Z is up, and the prototype stands on z = 0 so that
//    `offsets` names the point the object sits on and `scales` names its real metres.
// --------------------------------------------------------------------------------------------- //

function prototypeFromFaces(faces) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const [a, b, c] of faces) {
    const raw = cross(sub(b, a), sub(c, a));
    const length = Math.hypot(raw[0], raw[1], raw[2]) || 1;
    for (const vertex of [a, b, c]) {
      indices.push(positions.length / 3);
      positions.push(vertex[0], vertex[1], vertex[2]);
      normals.push(raw[0] / length, raw[1] / length, raw[2] / length);
    }
  }
  return Object.freeze({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
  });
}

function boxFaces({ withBottom = true, xMin = -0.5, xMax = 0.5 } = {}) {
  const x0 = xMin, x1 = xMax, y0 = -0.5, y1 = 0.5, z0 = 0, z1 = 1;
  const corner = (x, y, z) => [x, y, z];
  const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
  const faces = [
    ...quad(corner(x1, y0, z0), corner(x1, y1, z0), corner(x1, y1, z1), corner(x1, y0, z1)), // +X
    ...quad(corner(x0, y1, z0), corner(x0, y0, z0), corner(x0, y0, z1), corner(x0, y1, z1)), // -X
    ...quad(corner(x0, y1, z0), corner(x0, y1, z1), corner(x1, y1, z1), corner(x1, y1, z0)), // +Y
    ...quad(corner(x1, y0, z0), corner(x1, y0, z1), corner(x0, y0, z1), corner(x0, y0, z0)), // -Y
    ...quad(corner(x0, y0, z1), corner(x1, y0, z1), corner(x1, y1, z1), corner(x0, y1, z1)), // +Z
  ];
  if (withBottom) faces.push(...quad(corner(x0, y1, z0), corner(x1, y1, z0), corner(x1, y0, z0), corner(x0, y0, z0)));
  return faces;
}

/** An octagonal pipe. Eight sides because a flue reads as round the moment it is more than a pixel. */
function pipeFaces(sides = 8) {
  const faces = [];
  const ring = [];
  for (let index = 0; index < sides; index++) {
    const angle = (index / sides) * Math.PI * 2;
    ring.push([Math.cos(angle) * 0.5, Math.sin(angle) * 0.5]);
  }
  for (let index = 0; index < sides; index++) {
    const [ax, ay] = ring[index];
    const [bx, by] = ring[(index + 1) % sides];
    faces.push([[ax, ay, 0], [bx, by, 0], [bx, by, 1]]);
    faces.push([[ax, ay, 0], [bx, by, 1], [ax, ay, 1]]);
  }
  for (let index = 1; index < sides - 1; index++) {
    faces.push([[ring[0][0], ring[0][1], 1], [ring[index][0], ring[index][1], 1], [ring[index + 1][0], ring[index + 1][1], 1]]);
  }
  return faces;
}

/**
 * ONE FAMILY IS ONE `InstancedMesh`, SO ONE FAMILY MUST BE ONE PROTOTYPE.
 *
 * The contract has each planner ship a prototype with its declaration, and the renderer merges the
 * declarations of all 71 buildings into a single InstancedMesh per `familyId` — which can carry only
 * one geometry. Six planners writing in parallel can therefore hand the renderer two different
 * prototypes under the same id, and it will silently draw one of them for everybody.
 *
 * `src/building-detail/big-box.js` exports `unitBoxPrototype()`: a CLOSED unit box, x and y over
 * [-0.5, 0.5], z over [0, 1], 12 triangles — the same frame and the same unit convention this module
 * reached independently. `roof-vent` and `roof-hatch` here are built to match it exactly, so whoever
 * wires the renderer can take either copy and be right. The 2 extra triangles per instance (a closed
 * bottom face that is never seen) cost 38 triangles map-wide and buy away a whole class of defect.
 *
 * `roof-stack` (an octagonal flue) and `door-module` (a leaf that grows OUTWARD from the wall, so
 * its x runs 0..1 rather than being centred) are NOT reconciled here, because reconciling them means
 * editing a sibling planner. They are flagged for the wiring agent instead.
 */
export const SMALL_BOX_PROTOTYPES = Object.freeze({
  'roof-stack': prototypeFromFaces(pipeFaces(8)),
  'roof-vent': prototypeFromFaces(boxFaces({ withBottom: true })),
  'roof-hatch': prototypeFromFaces(boxFaces({ withBottom: true })),
  'door-module': prototypeFromFaces(boxFaces({ withBottom: true, xMin: 0, xMax: 1 })),
});

/** Collects instances of one family for one building and emits the contract's parallel arrays. */
class InstanceCollector {
  constructor(familyId, buildingIndex) {
    this.familyId = familyId;
    this.buildingIndex = buildingIndex;
    this.rows = [];
  }

  /** `offsetGame` is `[x, z, y]`; `yawGame` is a game-space yaw and is converted here, once. */
  add(offsetGame, yawGame, scale, levelAboveBaseM) {
    this.rows.push({ offsetGame, yawGame, scale, levelAboveBaseM });
  }

  emit() {
    const count = this.rows.length;
    if (!count) return null;
    const offsets = new Float32Array(count * 3);
    const yaws = new Float32Array(count);
    const scales = new Float32Array(count * 3);
    const ownerIndex = new Int32Array(count);
    const levelAboveBaseM = new Float32Array(count);
    this.rows.forEach((row, index) => {
      const world = gameToWorld(row.offsetGame[0], row.offsetGame[1], row.offsetGame[2]);
      offsets.set(world, index * 3);
      // (x, z) -> (-x, -z) is a rotation by pi, so a game yaw becomes a world yaw by adding pi.
      yaws[index] = row.yawGame + Math.PI;
      scales.set(row.scale, index * 3);
      ownerIndex[index] = this.buildingIndex;
      levelAboveBaseM[index] = row.levelAboveBaseM;
    });
    return {
      familyId: this.familyId,
      count,
      prototype: SMALL_BOX_PROTOTYPES[this.familyId],
      offsets,
      yaws,
      scales,
      ownerIndex,
      levelAboveBaseM,
    };
  }
}

// --------------------------------------------------------------------------------------------- //
// 6. The seat. Two spellings are accepted; NEITHER is invented.
// --------------------------------------------------------------------------------------------- //

/**
 * `src/building-detail/contract.js` documents the seat as `{ baseY, contactY, ... }` while
 * `seatBuilding()` in src/buildings.js returns `{ base, contact, ... }`. Both spellings are real and
 * the wiring agent may hand over either, so both are read — and a seat carrying NEITHER throws
 * rather than defaulting to zero, which would seat every roof on the map at sea level and report
 * success while doing it (handoff §6).
 */
export function seatBaseY(seat) {
  const candidate = seat?.baseY ?? seat?.base;
  if (!Number.isFinite(Number(candidate))) {
    throw new TypeError('small-box planner: seat must carry a finite `baseY` (or `base`)');
  }
  return Number(candidate);
}

// --------------------------------------------------------------------------------------------- //
// 7. The planner.
// --------------------------------------------------------------------------------------------- //

/**
 * Plan the detail for one small-box building.
 *
 * Returns `null` for any building this archetype does not own — the contract's "adds nothing" answer
 * — and an `emptyDetailPlan` for a small-box row whose footprint is too degenerate to dress.
 *
 * @param {object} building  the row from public/data/customs-3d.json
 * @param {{buildingIndex:number, classification:object, seat:object, groundYAt:Function}} context
 */
export function planDetail(building, context) {
  const { buildingIndex, classification, seat, groundYAt } = context ?? {};
  if (!classification || classification.archetype !== ARCHETYPE) return null;

  const metrics = classification.metrics ?? {};
  const heightM = num(classification.heightM, num(building?.height));
  const widthM = num(metrics.widthM);
  const lengthM = num(metrics.lengthM);
  const areaM2 = num(metrics.areaM2);
  const ring = cleanRing(building?.poly);
  const plan = emptyDetailPlan(buildingIndex, ARCHETYPE);

  if (ring.length < 3 || widthM < 0.5 || lengthM < 0.5 || heightM <= 0) {
    plan.notes.push(`degenerate small-box: ${ring.length} vertices, ${widthM.toFixed(2)} x ${lengthM.toFixed(2)} m, h ${heightM}`);
    return plan;
  }

  const baseY = seatBaseY(seat);
  const roofY = baseY + heightM;           // the EAVE plane — see the module header.
  const seed = num(classification.seed);
  const yaw = num(metrics.yawRad);
  const ux = Math.cos(yaw), uz = Math.sin(yaw);   // along the long axis, game space
  const vx = -Math.sin(yaw), vz = Math.cos(yaw);  // across it
  const centerX = num(metrics.centerX, num(metrics.centroidX));
  const centerZ = num(metrics.centerZ, num(metrics.centroidZ));
  /** Local (u, v) -> game (x, z). `u` runs along the ridge, `v` across the span. */
  const at = (u, v) => [centerX + u * ux + v * vx, centerZ + u * uz + v * vz];
  /** Game (x, z) -> the cross-span coordinate the roof's underside is a function of. */
  const vOf = (x, z) => (x - centerX) * vx + (z - centerZ) * vz;

  const wall = MATERIAL_SLOT_INDEX.wall;
  const roofSlot = MATERIAL_SLOT_INDEX.roof;
  const mesh = new DetailMeshBuilder();

  const overhangIndex = seedChannel(seed, 'eaveOverhang');
  const eaveOverhangM = SMALL_BOX_ROOF.eaveOverhangM[overhangIndex];
  const fallSign = seedChannel(seed, 'monoFallDirection') === 0 ? 1 : -1;

  const rise = roofRise(classification.roofForm, widthM, heightM);
  // A roof form whose capped rise is below `minRiseM` would be a wobble, not a form. Falling back to
  // the parapet treatment is a real flat roof rather than a pretend pitch.
  let roofForm = classification.roofForm;
  if ((roofForm === 'ridged' || roofForm === 'mono-pitch') && !rise.readable) {
    plan.notes.push(`rise ${rise.riseM.toFixed(2)} m is under minRiseM — treated as flat-parapet`);
    roofForm = 'flat-parapet';
  }

  const halfSpanM = widthM / 2 + eaveOverhangM;
  const halfLengthM = lengthM / 2 + SMALL_BOX_ROOF.endOverhangM;
  const slabT = SMALL_BOX_ROOF.slabThicknessM;
  const undersideAt = (v) => roofUndersideAt(roofForm, v, halfSpanM, rise.riseM, fallSign);

  // ------------------------------------------------------------------------------------------- //
  // E1. THE ATTIC BAND — the wall carried from the eave plane up to the roof's underside.
  //
  //   Rule: over the REAL footprint ring (not the bounding box), a prism from `roofY` to
  //   `roofY + underside(v)` at each corner.
  //   Why:  the roof overhangs, so its underside at the wall line is strictly ABOVE the eave plane;
  //         without this band every shed has a daylight gap between its wall head and its roof. It
  //         is also the gable tympanum, generalised: on a ridged roof the band's top is a chevron
  //         and it reads as the triangle of wall under the gable.
  //   Varies: its height scales with the eave overhang (one seed bit) and with the rise, so it is
  //         visibly taller on a steep narrow shed than on a wide capped one.
  //   Slot: `wall` — FREE (it is wall, and it takes the building's own authored colour).
  //
  // The band has no top cap (the roof slab's underside is that surface, and a coincident face would
  // z-fight) and no bottom cap (the building's own extrusion cap is that surface). Its outer faces
  // are exactly coplanar with the walls below them and meet them edge-to-edge, never overlapping.
  // ------------------------------------------------------------------------------------------- //
  if (roofForm === 'ridged' || roofForm === 'mono-pitch') {
    const centroid = ringCentroid(ring);
    for (let index = 0; index < ring.length; index++) {
      const [ax, az] = ring[index];
      const [bx, bz] = ring[(index + 1) % ring.length];
      if (Math.hypot(bx - ax, bz - az) < 1e-6) continue;
      const topA = roofY + undersideAt(vOf(ax, az));
      const topB = roofY + undersideAt(vOf(bx, bz));
      const midX = (ax + bx) / 2, midZ = (az + bz) / 2;
      const outward = [midX - centroid[0], midZ - centroid[1], 0];
      mesh.addQuad(wall, [ax, az, roofY], [bx, bz, roofY], [bx, bz, topB], [ax, az, topA], outward);
    }
  }

  // ------------------------------------------------------------------------------------------- //
  // E2. THE ROOF SLAB — the silhouette.
  //
  //   Rule: a prismatic slab of constant VERTICAL thickness `slabThicknessM`, swept along the
  //         footprint's own dominant long axis (`metrics.yawRad`) from -halfLength to +halfLength,
  //         whose cross-section follows `roofUndersideAt`. Ridge height comes from a constant pitch
  //         capped against the building's height (build decision 3).
  //   Why:  this is the only element on a 6x3 pixel shed that changes its OUTLINE. A gable makes a
  //         peak, a lean-to makes a diagonal, and the overhang makes both stand proud of the wall.
  //   Varies: form (router), ridge axis (footprint yaw), fall direction (seed bit 0), overhang
  //         (seed bits 1-2), and the rise itself (span and height).
  //   Slot: `roof` — FREE, and it is the surface that picks up the authored `roof` colour on the
  //         three rows that carry one (Crackhouse, Warehouse 4 and Warehouse 17 outbuildings).
  //
  //   The cross-section is a closed loop, so the slab is a closed solid whose signed volume is
  //   exactly `slabThicknessM * 2*halfSpan * 2*halfLength`. The test asserts that identity, which is
  //   what checks the winding WITHOUT re-deriving it from the code that produced it.
  // ------------------------------------------------------------------------------------------- //
  if (roofForm === 'ridged' || roofForm === 'mono-pitch') {
    const section = [];
    const vs = roofForm === 'ridged' ? [-halfSpanM, 0, halfSpanM] : [-halfSpanM, halfSpanM];
    for (const v of vs) section.push([v, undersideAt(v)]);
    // ...and back along the top, giving one closed loop in the (v, y) plane.
    const loop = [...section, ...section.slice().reverse().map(([v, y]) => [v, y + slabT])];
    const outerU = [ux, uz, 0];
    for (let index = 0; index < loop.length; index++) {
      const [v0, y0] = loop[index];
      const [v1, y1] = loop[(index + 1) % loop.length];
      if (Math.abs(v0 - v1) < 1e-9 && Math.abs(y0 - y1) < 1e-9) continue;
      // Outward reference for a swept side face: the 2D outward normal of the section edge, lifted.
      const dv = v1 - v0, dy = y1 - y0;
      const outward = [vx * dy, vz * dy, -dv];
      const [pAx, pAz] = at(-halfLengthM, v0);
      const [pBx, pBz] = at(-halfLengthM, v1);
      const [pCx, pCz] = at(halfLengthM, v1);
      const [pDx, pDz] = at(halfLengthM, v0);
      mesh.addQuad(
        roofSlot,
        [pAx, pAz, roofY + y0], [pBx, pBz, roofY + y1],
        [pCx, pCz, roofY + y1], [pDx, pDz, roofY + y0],
        outward,
      );
    }
    // The two gable-end caps (the barge boards). The section is a CHEVRON BAND, not a convex
    // polygon, so a triangle fan from one vertex would sweep outside it and put a solid lid across
    // the gable. It is closed instead the way it is defined: one quad per section SEGMENT, between
    // that segment and its own `+slabT` copy.
    for (const end of [-1, 1]) {
      const outward = [ux * end, uz * end, 0];
      for (let index = 0; index < section.length - 1; index++) {
        const [v0, y0] = section[index];
        const [v1, y1] = section[index + 1];
        const [ax, az] = at(halfLengthM * end, v0);
        const [bx, bz] = at(halfLengthM * end, v1);
        mesh.addQuad(
          roofSlot,
          [ax, az, roofY + y0], [bx, bz, roofY + y1],
          [bx, bz, roofY + y1 + slabT], [ax, az, roofY + y0 + slabT],
          outward,
        );
      }
    }
  }

  // ------------------------------------------------------------------------------------------- //
  // E3. THE PARAPET RING — the two occupied blocks.
  //
  //   Rule: `roofForm === 'flat-parapet'` (Dorms 3-Story stair core, Military Checkpoint scav
  //         house). A ring standing `parapetHeightM` above the eave plane over the real footprint,
  //         with an inner leaf inset by `parapetThicknessM` and a coping between them.
  //   Why:  these are Soviet panel blocks. The router's own note says a ridge on one would be the
  //         most obviously wrong roof on the map, and a bare flat cap is the "random box" the
  //         founder is complaining about. A 1.05 m upstand is what makes a flat roof read as a roof.
  //   Varies: barely, and honestly so — there are two rows. They differ by footprint, by height, and
  //         by whether they carry plant (see E5). Inventing a seed-driven guard height would be
  //         variation with nothing behind it.
  //   Slots: `wall` (outer and inner leaves) + `roof` (coping). Both FREE.
  // ------------------------------------------------------------------------------------------- //
  if (roofForm === 'flat-parapet') {
    const centroid = ringCentroid(ring);
    const inset = ring.map(([x, z]) => {
      const dx = x - centroid[0], dz = z - centroid[1];
      const run = Math.hypot(dx, dz) || 1;
      const pull = Math.min(SMALL_BOX_ROOF.parapetThicknessM, run * 0.4);
      return [x - (dx / run) * pull, z - (dz / run) * pull];
    });
    const topY = roofY + SMALL_BOX_ROOF.parapetHeightM;
    for (let index = 0; index < ring.length; index++) {
      const next = (index + 1) % ring.length;
      const [ax, az] = ring[index], [bx, bz] = ring[next];
      const [iax, iaz] = inset[index], [ibx, ibz] = inset[next];
      if (Math.hypot(bx - ax, bz - az) < 1e-6) continue;
      const midX = (ax + bx) / 2, midZ = (az + bz) / 2;
      const outward = [midX - centroid[0], midZ - centroid[1], 0];
      const inward = [-outward[0], -outward[1], 0];
      mesh.addQuad(wall, [ax, az, roofY], [bx, bz, roofY], [bx, bz, topY], [ax, az, topY], outward);
      mesh.addQuad(wall, [iax, iaz, roofY], [ibx, ibz, roofY], [ibx, ibz, topY], [iax, iaz, topY], inward);
      mesh.addQuad(roofSlot, [ax, az, topY], [bx, bz, topY], [ibx, ibz, topY], [iax, iaz, topY], [0, 0, 1]);
    }
  }

  // ------------------------------------------------------------------------------------------- //
  // E4. ROOF PLANT — the pixel that stands proud of the roofline.
  //
  //   Rule A (stovepipe): `program === 'utility'` and `areaM2 < hutMaxAreaM2` (45 m2) -> exactly ONE
  //         `roof-stack`. Twenty rows qualify, including all fifteen twins.
  //   Rule B (vents): `program === 'utility'` and `areaM2 >= 45` -> `clamp(1, round(area/40), 4)`
  //         `roof-vent`s on an evenly spaced line along the ridge, inset 1.2 m from each gable end.
  //         Eight rows: 51.3 and 53.5 m2 get 1, 75.7 and 78.5 get 2, 106.5 gets 3, 262.5 gets 4.
  //   Rule C (occupied): one `roof-hatch` in a seed-chosen corner quadrant, plus two vents when the
  //         roof is at least `occupiedVentMinAreaM2` (60 m2) — which separates the checkpoint
  //         (64.8 m2, hatch + 2 vents) from the stair core (51.9 m2, hatch only).
  //   Why:  a 1.4 m flue on a 3.5 m hut is 40% of the building's height standing above its ridge —
  //         at one metre per pixel it is the single most visible thing this planner can add, and it
  //         is what a heated shed in Tarkov actually has.
  //   Varies: station (3) x height (3) for the flue; count (1-4) x line shift (3) for the vents;
  //         quadrant (4) for the hatch. All from disjoint seed-bit channels.
  //   Cost: instanced, so ONE map-wide draw call per family however many buildings contribute.
  // ------------------------------------------------------------------------------------------- //
  const program = classification.program;
  const plant = [];

  if (program === 'utility' && areaM2 < SMALL_BOX_PLANT.hutMaxAreaM2 && roofForm !== 'flat-parapet') {
    const collector = new InstanceCollector('roof-stack', buildingIndex);
    const usableHalf = Math.max(0.1, lengthM / 2 - SMALL_BOX_PLANT.stackEndInsetM);
    const u = SMALL_BOX_PLANT.stackStations[seedChannel(seed, 'stackStation')] * usableHalf * 2;
    // Ridged flues rise off the ridge; a lean-to's rises near its HIGH eave, inside the wall line.
    const v = roofForm === 'ridged'
      ? 0
      : fallSign * Math.max(0, widthM / 2 - 0.55);
    const [x, z] = at(clamp(-usableHalf, u, usableHalf), v);
    const level = heightM + undersideAt(v) + slabT - 0.05;
    const stackHeight = SMALL_BOX_PLANT.stackHeightsM[seedChannel(seed, 'stackHeight')];
    collector.add(
      [x, z, baseY + level], yaw,
      [SMALL_BOX_PLANT.stackDiameterM, SMALL_BOX_PLANT.stackDiameterM, stackHeight],
      level,
    );
    plant.push(collector.emit());
    plan.notes.push(`stovepipe: ${stackHeight.toFixed(2)} m at u=${u.toFixed(2)} (area ${areaM2.toFixed(1)} m2 < ${SMALL_BOX_PLANT.hutMaxAreaM2})`);
  }

  const ventCount = program === 'utility' && areaM2 >= SMALL_BOX_PLANT.hutMaxAreaM2
    ? clamp(1, Math.round(areaM2 / SMALL_BOX_PLANT.ventAreaPerUnitM2), SMALL_BOX_PLANT.maxVents)
    : (program === 'occupied' && areaM2 >= SMALL_BOX_PLANT.occupiedVentMinAreaM2 ? 2 : 0);
  if (ventCount > 0) {
    const collector = new InstanceCollector('roof-vent', buildingIndex);
    const usableHalf = Math.max(0.2, lengthM / 2 - SMALL_BOX_PLANT.ventEndInsetM);
    const shift = SMALL_BOX_PLANT.ventLineShiftM[seedChannel(seed, 'ventLineShift')];
    const [sizeX, sizeY, sizeZ] = SMALL_BOX_PLANT.ventSizeM;
    for (let index = 0; index < ventCount; index++) {
      const t = ventCount === 1 ? 0 : -1 + (2 * index) / (ventCount - 1);
      const u = clamp(-usableHalf, t * usableHalf * 0.85 + shift, usableHalf);
      // Ridge ventilators straddle the ridge; on a flat roof the line sits a quarter off centre.
      const v = roofForm === 'ridged' ? 0
        : roofForm === 'mono-pitch' ? fallSign * widthM * 0.25
          : widthM * 0.2;
      const [x, z] = at(u, v);
      const level = roofForm === 'flat-parapet' ? heightM : heightM + undersideAt(v) + slabT - 0.04;
      collector.add([x, z, baseY + level], yaw, [sizeX, sizeY, sizeZ], level);
    }
    plant.push(collector.emit());
    plan.notes.push(`${ventCount} roof vent(s) from area ${areaM2.toFixed(1)} m2 / ${SMALL_BOX_PLANT.ventAreaPerUnitM2}`);
  }

  if (program === 'occupied') {
    const collector = new InstanceCollector('roof-hatch', buildingIndex);
    const quadrant = seedChannel(seed, 'hatchQuadrant');
    const su = quadrant < 2 ? -1 : 1;
    const sv = quadrant % 2 === 0 ? -1 : 1;
    const [x, z] = at(su * lengthM * 0.22, sv * widthM * 0.22);
    const [sizeX, sizeY, sizeZ] = SMALL_BOX_PLANT.hatchSizeM;
    collector.add([x, z, baseY + heightM], yaw, [sizeX, sizeY, sizeZ], heightM);
    plant.push(collector.emit());
    plan.notes.push(`stair-head hatch in quadrant ${quadrant}`);
  }

  // ------------------------------------------------------------------------------------------- //
  // E5. THE DOOR FACE.
  //
  //   Rule: one leaf below `twoDoorMinAreaM2` (60 m2), two above; a 1.05 m man-door below it and a
  //         2.4 m roller shutter above. The wall it lands on is decided by the ROOF, because that is
  //         where a door actually goes:
  //           ridged      -> a gable END (which end from seed bit 7), where the wall is full height;
  //           mono-pitch  -> the HIGH eave wall, which is the only one with head room;
  //           flat-parapet-> a long wall, side from seed bit 7.
  //         The wall itself is the real footprint edge whose outward normal best matches that
  //         target, so a leaf sits on the plan's own face rather than on the bounding box's.
  //   Why:  a door is the one thing that tells a viewer which way a building faces, and it is the
  //         first detail to appear on zoom-in. At the default view it is a 1 x 2 pixel dark patch —
  //         this is a zoom payoff, stated as such, and it costs one map-wide draw call, not 30.
  //   Varies: wall (2) x station (3) x width class (2), and the wall choice is downstream of the
  //         roof form, so a shed that falls the other way also opens the other way.
  //   Ground: `groundYAt` is used HERE and nowhere else. On a cross-slope the eave plane is flat but
  //         the ground is not, so a leaf on the downhill face would float; it is extended down to
  //         the ground, by at most `maxGroundReachM`, past which the plinth skirt owns the gap.
  // ------------------------------------------------------------------------------------------- //
  const doorTarget = roofForm === 'ridged'
    ? (seedChannel(seed, 'doorWall') === 0 ? [ux, uz] : [-ux, -uz])
    : roofForm === 'mono-pitch'
      ? [fallSign * vx, fallSign * vz]
      : (seedChannel(seed, 'doorWall') === 0 ? [vx, vz] : [-vx, -vz]);
  const doorWall = pickWall(ring, doorTarget);
  if (doorWall) {
    const twoDoors = areaM2 >= SMALL_BOX_DOOR.twoDoorMinAreaM2;
    // A vehicle opening is a claim about the PROGRAM, not just the size: a 2.4 m roller shutter
    // belongs on a workshop, never on the two-storey scav house. Occupied rows keep man-doors
    // whatever their footprint.
    const shutter = twoDoors && program === 'utility';
    const widthDoor = shutter ? SMALL_BOX_DOOR.shutterWidthM : SMALL_BOX_DOOR.manDoorWidthM;
    const heightDoor = Math.min(
      shutter ? SMALL_BOX_DOOR.shutterHeightM : SMALL_BOX_DOOR.manDoorHeightM,
      heightM - SMALL_BOX_DOOR.headClearanceM,
    );
    if (heightDoor > 0.8 && doorWall.lengthM > widthDoor + 0.3) {
      const collector = new InstanceCollector('door-module', buildingIndex);
      const usableHalf = Math.max(0, doorWall.lengthM / 2 - widthDoor / 2 - 0.15);
      const stations = twoDoors
        ? SMALL_BOX_DOOR.pairStations.map((fraction) => fraction * doorWall.lengthM)
        : [SMALL_BOX_DOOR.stations[seedChannel(seed, 'doorStation')] * usableHalf * 2];
      const yawWall = Math.atan2(doorWall.normal[1], doorWall.normal[0]);
      for (const station of stations) {
        const offset = clamp(-usableHalf, station, usableHalf);
        const x = doorWall.mid[0] + doorWall.tangent[0] * offset + doorWall.normal[0] * 0.01;
        const z = doorWall.mid[1] + doorWall.tangent[1] * offset + doorWall.normal[1] * 0.01;
        const ground = num(groundYAt?.(x, z), baseY);
        const footY = clamp(baseY - SMALL_BOX_DOOR.maxGroundReachM, Math.min(baseY, ground), baseY);
        collector.add(
          [x, z, footY], yawWall,
          [SMALL_BOX_DOOR.protrusionM, widthDoor, (baseY + heightDoor) - footY],
          heightDoor,
        );
      }
      const family = collector.emit();
      if (family) {
        plant.push(family);
        plan.notes.push(`${stations.length} door(s) ${widthDoor.toFixed(2)} m on the ${roofForm === 'ridged' ? 'gable end' : roofForm === 'mono-pitch' ? 'high eave' : 'long'} wall`);
      }
    }
  }

  plan.mesh = mesh.build();
  plan.instances = plant.filter(Boolean);
  plan.notes.unshift(
    `${roofForm} | rise ${rise.riseM.toFixed(2)} m at ${rise.effectivePitchDeg.toFixed(1)} deg${rise.capped ? ' (capped)' : ''}`
    + ` | eave overhang ${eaveOverhangM} m | fall ${fallSign > 0 ? '+v' : '-v'}`,
  );
  return plan;
}

/**
 * A compact, comparable description of what makes ONE building's outline different from the next.
 *
 * This exists for the test, and it exists as EXPORTED code rather than test-local code so that the
 * variation claim is made by the shipped module about its own behaviour. Two buildings with equal
 * signatures are two buildings that will look the same from any distance at which their footprints
 * are indistinguishable — which, for the fifteen twins, is every distance.
 */
export function variationSignature(classification, buildingArea) {
  const seed = num(classification?.seed);
  const area = num(buildingArea, num(classification?.metrics?.areaM2));
  return [
    classification?.roofForm,
    seedChannel(seed, 'monoFallDirection'),
    seedChannel(seed, 'eaveOverhang'),
    seedChannel(seed, 'stackStation'),
    seedChannel(seed, 'stackHeight'),
    seedChannel(seed, 'doorWall'),
    seedChannel(seed, 'doorStation'),
    area >= SMALL_BOX_PLANT.hutMaxAreaM2 ? seedChannel(seed, 'ventLineShift') : 'x',
  ].join('/');
}

export default planDetail;
