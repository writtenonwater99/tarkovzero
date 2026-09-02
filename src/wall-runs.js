/**
 * Walls, fences and gates: one dimension table, one run planner, no renderer constants.
 *
 * Three separate hard-coded numbers used to decide how tall a barrier stood on Customs:
 * `1.9` in map3d-three.js's fence `THREE.Line` lift, `prop.h ?? 2.5` and `prop.w ?? 0.4` in the
 * prop loop, and `h`/`w` hand-authored per row in `data/customs-props.json`. None of the three was
 * ever measured. They are collected here, in `WALL_CLASSES`, marked `provisional-unmeasured`, so
 * the mesh-bounds lane (docs/plans/BOUNDS-SPIKE-FINDINGS.md) replaces NUMBERS through
 * `resolveWallClasses(measurements)` rather than re-editing renderer code.
 *
 * This module is pure — no Three.js, no DOM, no data files — because the invariants that matter
 * (a run's panels plus its openings equal its length; every dimension traces to the table) are
 * arithmetic, and arithmetic is testable.
 *
 * WHAT THE DATA ACTUALLY CONTAINS. Only two barrier classes exist in the Customs sources, and
 * `CLASS_INVENTORY` below records where each one comes from. There is no jersey barrier, no plant
 * wall distinct from the Fortress, and no gate row anywhere: the tarkov.dev SVG's `Fence` group is
 * 65 `<path>` elements carrying a `d` and nothing else — no per-path class, id, or width — so a
 * gate cannot be read out of it. See `inferRoadCrossingGates` for what can honestly be derived
 * instead, and how little of it there is.
 */

/** A dimension nobody has measured. Every number in `WALL_CLASSES` ships with this status. */
export const PROVISIONAL = 'provisional-unmeasured';
/** A dimension supplied by the gated mesh-bounds run, per BOUNDS-SPIKE-FINDINGS.md §7. */
export const MEASURED = 'measured-mesh-bounds';
/** Height measured, thickness not (or the reverse). */
export const PARTIALLY_MEASURED = 'partially-measured';

const DIMENSION_KEYS = Object.freeze(['heightM', 'thicknessM']);

/**
 * `fill` is the pipeline's way to say chain-link versus solid. Every Customs fence row currently
 * resolves to `chainlink-fence`, but a row may carry `wallClass` and be routed anywhere in here
 * the moment the source can tell the two apart.
 *
 * On `thicknessM` for a `mesh` class: chain-link fabric IS a surface, so the renderer draws it as
 * one alpha-masked quad rather than a 5 cm slab — two masked faces 5 cm apart moiré against each
 * other at a grazing angle and buy nothing. The run's real, occupying thickness is its posts
 * (`postWidthM`) and rails (`railThicknessM`), which are boxes. `thicknessM` stays the declared
 * envelope of the whole run: it is what a solid variant extrudes, and it is what anything asking
 * "how wide is this barrier on the ground" must read. The bounds lane measures it like any other
 * dimension.
 */
export const WALL_CLASSES = Object.freeze({
  'chainlink-fence': Object.freeze({
    id: 'chainlink-fence',
    label: 'Chain-link perimeter fence',
    fill: 'mesh',
    heightM: 1.9,
    thicknessM: 0.05,
    postSpacingM: 2.6,
    postWidthM: 0.09,
    postRiseM: 0.11,
    railThicknessM: 0.055,
    railHeightFractions: Object.freeze([0.985, 0.055]),
    capHeightM: 0,
    capOverhangM: 0,
    meshUvScaleM: 0.62,
    gate: Object.freeze({
      jambWidthM: 0.15,
      jambRiseM: 0.34,
      leafOpenDeg: 62,
      leafCoverage: 0.94,
      leafFrameThicknessM: 0.07,
      minSpanM: 3.5,
      maxSpanM: 14,
    }),
    dimensionSource: Object.freeze({
      heightM: 'renderer constant — src/map3d-three.js fence THREE.Line lift, unmeasured',
      thicknessM: 'authored for this module; the line it replaces had no thickness at all',
    }),
  }),
  'concrete-perimeter-wall': Object.freeze({
    id: 'concrete-perimeter-wall',
    label: 'Concrete perimeter wall (Fortress)',
    fill: 'solid',
    heightM: 3.5,
    thicknessM: 0.5,
    postSpacingM: 0,
    postWidthM: 0,
    postRiseM: 0,
    railThicknessM: 0,
    railHeightFractions: Object.freeze([]),
    capHeightM: 0.14,
    capOverhangM: 0.07,
    meshUvScaleM: 0,
    gate: Object.freeze({
      jambWidthM: 0.7,
      jambRiseM: 0.55,
      leafOpenDeg: 74,
      leafCoverage: 0.92,
      leafFrameThicknessM: 0.09,
      minSpanM: 3.5,
      maxSpanM: 12,
    }),
    dimensionSource: Object.freeze({
      heightM: 'hand trace — data/customs-props.json "Fortress wall *" h, unmeasured',
      thicknessM: 'hand trace — data/customs-props.json "Fortress wall *" w, unmeasured',
    }),
  }),
});

/** Where each class's rows come from, so a reader can check the enumeration against the data. */
export const CLASS_INVENTORY = Object.freeze({
  'chainlink-fence': Object.freeze({
    source: 'public/data/<map>-3d.json `fences[]`, from the tarkov.dev SVG group `Fence`',
    customsRows: 76,
    note: 'the SVG draws one undifferentiated line class; chain-link vs solid is not in it',
  }),
  'concrete-perimeter-wall': Object.freeze({
    source: 'data/customs-props.json rows with `type: "wall"` (a `path` and no `x`/`z`)',
    customsRows: 5,
    note: 'all five are the Fortress perimeter and its inner wall',
  }),
});

const FENCE_DEFAULT_CLASS = 'chainlink-fence';
const WALL_PROP_DEFAULT_CLASS = 'concrete-perimeter-wall';

const finite = (value) => Number.isFinite(Number(value));
const num = (value, fallback = 0) => (finite(value) ? Number(value) : fallback);

/** Reject anything the bounds lane could not legitimately have produced. Never a plausibility gate. */
function assertMeasurement(classId, key, entry) {
  const value = Number(entry?.[key]);
  if (!Number.isFinite(value) || !(value > 0)) {
    throw new TypeError(`wall measurement ${classId}.${key} must be a finite positive number`);
  }
  if (typeof entry.source !== 'string' || !entry.source) {
    throw new TypeError(`wall measurement ${classId} must name its source`);
  }
  if (typeof entry.measuredAt !== 'string' || !entry.measuredAt) {
    throw new TypeError(`wall measurement ${classId} must carry measuredAt`);
  }
  return value;
}

/**
 * Resolve the class table, optionally overriding dimensions with measured values.
 *
 * `measurements` is `{ [classId]: { heightM?, thicknessM?, source, measuredAt } }` — exactly the
 * shape a mesh-bounds run can emit once its output contract lands. Anything not supplied stays
 * provisional, and the per-field `dimensions` record says which is which. This function is the
 * ONLY seam: no caller may pass a height or thickness into the geometry builders directly.
 */
export function resolveWallClasses(measurements = {}) {
  if (measurements == null || typeof measurements !== 'object' || Array.isArray(measurements)) {
    throw new TypeError('wall measurements must be an object keyed by class id');
  }
  for (const classId of Object.keys(measurements)) {
    if (!(classId in WALL_CLASSES)) throw new TypeError(`unknown wall class in measurements: ${classId}`);
  }
  const resolved = {};
  for (const [classId, base] of Object.entries(WALL_CLASSES)) {
    const supplied = measurements[classId] ?? null;
    const dimensions = {};
    const values = {};
    for (const key of DIMENSION_KEYS) {
      if (supplied && supplied[key] != null) {
        const value = assertMeasurement(classId, key, supplied);
        values[key] = value;
        dimensions[key] = Object.freeze({
          value, status: MEASURED, source: supplied.source, measuredAt: supplied.measuredAt,
        });
      } else {
        values[key] = base[key];
        dimensions[key] = Object.freeze({
          value: base[key], status: PROVISIONAL, source: base.dimensionSource[key], measuredAt: null,
        });
      }
    }
    const measuredCount = DIMENSION_KEYS.filter((key) => dimensions[key].status === MEASURED).length;
    resolved[classId] = Object.freeze({
      ...base,
      ...values,
      // Derived, so the table stays the only place a number is written down.
      railOffsetsM: Object.freeze(base.railHeightFractions.map((fraction) => fraction * values.heightM)),
      postHeightM: values.heightM + base.postRiseM,
      capWidthM: values.thicknessM + base.capOverhangM * 2,
      dimensions: Object.freeze(dimensions),
      status: measuredCount === DIMENSION_KEYS.length ? MEASURED
        : measuredCount === 0 ? PROVISIONAL : PARTIALLY_MEASURED,
    });
  }
  return Object.freeze(resolved);
}

/** The table as it ships today: every number provisional. */
export const PROVISIONAL_WALL_CLASSES = resolveWallClasses();

/** Resolve a source row's class id, failing loud on a class the table has never heard of. */
export function wallClassIdFor(row, fallbackId) {
  const declared = row?.wallClass ?? row?.wallClassId ?? null;
  if (declared != null) {
    const id = String(declared);
    if (!(id in WALL_CLASSES)) throw new TypeError(`unknown wall class: ${id}`);
    return id;
  }
  if (!(fallbackId in WALL_CLASSES)) throw new TypeError(`unknown wall class: ${fallbackId}`);
  return fallbackId;
}

// ---------------------------------------------------------------------------------------------
// Path arithmetic
// ---------------------------------------------------------------------------------------------

/** Drop repeats and non-finite points; a run is the polyline that survives. */
export function cleanPath(path) {
  const points = [];
  for (const point of Array.isArray(path) ? path : []) {
    const x = Number(point?.[0]), z = Number(point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const last = points[points.length - 1];
    if (last && Math.hypot(x - last[0], z - last[1]) <= 1e-6) continue;
    points.push([x, z]);
  }
  return points;
}

/** Cumulative along-run distance at every vertex; `cumulative.at(-1)` is the run length. */
export function pathCumulative(path) {
  const points = cleanPath(path);
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative[index - 1]
      + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
  }
  return { points, cumulative };
}

export function runLengthM(path) {
  const { cumulative } = pathCumulative(path);
  return cumulative.length ? cumulative[cumulative.length - 1] : 0;
}

/** The point at along-run distance `distance`, clamped to the run. */
export function pointAtDistance(path, distance) {
  const { points, cumulative } = pathCumulative(path);
  if (!points.length) return null;
  const total = cumulative[cumulative.length - 1];
  const target = Math.min(Math.max(num(distance), 0), total);
  for (let index = 1; index < points.length; index++) {
    if (cumulative[index] < target) continue;
    const span = cumulative[index] - cumulative[index - 1];
    const t = span > 0 ? (target - cumulative[index - 1]) / span : 0;
    return [
      points[index - 1][0] + (points[index][0] - points[index - 1][0]) * t,
      points[index - 1][1] + (points[index][1] - points[index - 1][1]) * t,
    ];
  }
  return [...points[points.length - 1]];
}

/**
 * The sub-polyline between two along-run distances, with exact cut points at both ends.
 *
 * The cut points are inserted rather than snapped to the nearest vertex: snapping is what turns a
 * "5 m gate" into anything between 2 m and 9 m depending on where the source happened to sample.
 */
export function slicePath(path, fromM, toM) {
  const { points, cumulative } = pathCumulative(path);
  if (points.length < 2) return [];
  const total = cumulative[cumulative.length - 1];
  const from = Math.min(Math.max(num(fromM), 0), total);
  const to = Math.min(Math.max(num(toM), from), total);
  if (!(to - from > 1e-9)) return [];
  const out = [pointAtDistance(path, from)];
  for (let index = 0; index < points.length; index++) {
    if (cumulative[index] <= from + 1e-9 || cumulative[index] >= to - 1e-9) continue;
    out.push([...points[index]]);
  }
  out.push(pointAtDistance(path, to));
  return cleanPath(out);
}

// ---------------------------------------------------------------------------------------------
// Run planning
// ---------------------------------------------------------------------------------------------

/** Merge, clamp and sort openings so two overlapping gates cannot delete a panel twice. */
function normalizeOpenings(openings, totalM) {
  const spans = [];
  for (const opening of Array.isArray(openings) ? openings : []) {
    const from = Math.min(Math.max(num(opening?.fromM), 0), totalM);
    const to = Math.min(Math.max(num(opening?.toM), from), totalM);
    if (!(to - from > 1e-6)) continue;
    spans.push({ ...opening, fromM: from, toM: to });
  }
  spans.sort((a, b) => a.fromM - b.fromM || a.toM - b.toM);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.fromM <= last.toM + 1e-9) {
      last.toM = Math.max(last.toM, span.toM);
      last.merged = (last.merged ?? 1) + 1;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function postsAlong(path, fromM, toM, spacingM, widthM, heightM, startKind, endKind) {
  if (!(spacingM > 0) || !(widthM > 0)) return [];
  const span = toM - fromM;
  const intervals = Math.max(1, Math.ceil(span / spacingM - 1e-9));
  const posts = [];
  for (let step = 0; step <= intervals; step++) {
    const distance = fromM + (span * step) / intervals;
    const point = pointAtDistance(path, distance);
    if (!point) continue;
    posts.push({
      x: point[0], z: point[1], distanceM: distance, widthM, heightM,
      kind: step === 0 ? startKind : step === intervals ? endKind : 'line',
    });
  }
  return posts;
}

/**
 * Split one run into solid panels and openings, and place its posts.
 *
 * The invariant this exists to hold: `panelLengthM + openingLengthM === lengthM`. A gate is a
 * declared span of the run, not a segment quietly dropped upstream, so nothing can go missing
 * without the arithmetic saying so.
 */
export function planWallRun({ id = null, path, classId, classes = PROVISIONAL_WALL_CLASSES, openings = [], meta = null }) {
  const spec = classes?.[classId];
  if (!spec) throw new TypeError(`unknown wall class: ${classId}`);
  const points = cleanPath(path);
  const lengthM = runLengthM(points);
  if (points.length < 2 || !(lengthM > 1e-6)) return null;

  const cuts = normalizeOpenings(openings, lengthM);
  const panels = [];
  let cursor = 0;
  const pushPanel = (fromM, toM, startKind, endKind) => {
    if (!(toM - fromM > 1e-6)) return;
    const panelPath = slicePath(points, fromM, toM);
    if (panelPath.length < 2) return;
    panels.push({
      fromM, toM, lengthM: toM - fromM, path: panelPath,
      startKind, endKind,
      posts: postsAlong(points, fromM, toM, spec.postSpacingM, spec.postWidthM, spec.postHeightM, startKind, endKind),
    });
  };
  for (const cut of cuts) {
    pushPanel(cursor, cut.fromM, cursor === 0 ? 'end' : 'jamb', 'jamb');
    cursor = cut.toM;
  }
  pushPanel(cursor, lengthM, cursor === 0 ? 'end' : 'jamb', 'end');

  const panelLengthM = panels.reduce((total, panel) => total + panel.lengthM, 0);
  const openingLengthM = cuts.reduce((total, cut) => total + (cut.toM - cut.fromM), 0);
  return {
    id, classId, spec, meta,
    path: points,
    lengthM,
    panels,
    openings: cuts.map((cut) => ({
      fromM: cut.fromM, toM: cut.toM, spanM: cut.toM - cut.fromM,
      gateId: cut.gateId ?? null, provenance: cut.provenance ?? 'declared',
      center: pointAtDistance(points, (cut.fromM + cut.toM) / 2),
    })),
    panelLengthM,
    openingLengthM,
    posts: panels.flatMap((panel) => panel.posts),
  };
}

// ---------------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------------

const normalize = ([x, z]) => {
  const length = Math.hypot(x, z);
  return length > 1e-9 ? [x / length, z / length] : [0, 0];
};
const rotate = ([x, z], radians) => {
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return [x * cos - z * sin, x * sin + z * cos];
};

/**
 * Turn a gate record into the segments a renderer draws: two jamb posts and two swing leaves.
 *
 * At `leafOpenDeg === 0` the two leaves meet exactly at the centre of the opening — that is the
 * closed gate, and it is what makes the geometry checkable. The shipped angle swings them open.
 */
export function planGate({ id = null, a, b, classId, classes = PROVISIONAL_WALL_CLASSES, provenance = 'declared', evidence = null }) {
  const spec = classes?.[classId];
  if (!spec) throw new TypeError(`unknown wall class: ${classId}`);
  const ax = Number(a?.[0]), az = Number(a?.[1]), bx = Number(b?.[0]), bz = Number(b?.[1]);
  if (![ax, az, bx, bz].every(Number.isFinite)) return null;
  const spanM = Math.hypot(bx - ax, bz - az);
  if (!(spanM > 1e-3)) return null;
  const axis = normalize([bx - ax, bz - az]);
  const gate = spec.gate;
  const open = (gate.leafOpenDeg * Math.PI) / 180;
  const leafLengthM = (spanM / 2) * gate.leafCoverage;
  const leafA = rotate(axis, open);
  const leafB = rotate([-axis[0], -axis[1]], -open);
  return {
    id, classId, spec, spanM, provenance, evidence,
    center: [(ax + bx) / 2, (az + bz) / 2],
    axis,
    jambs: [
      { x: ax, z: az, widthM: gate.jambWidthM, heightM: spec.heightM + gate.jambRiseM, kind: 'jamb' },
      { x: bx, z: bz, widthM: gate.jambWidthM, heightM: spec.heightM + gate.jambRiseM, kind: 'jamb' },
    ],
    leaves: [
      { side: 'a', a: [ax, az], b: [ax + leafA[0] * leafLengthM, az + leafA[1] * leafLengthM], lengthM: leafLengthM },
      { side: 'b', a: [bx, bz], b: [bx + leafB[0] * leafLengthM, bz + leafB[1] * leafLengthM], lengthM: leafLengthM },
    ],
  };
}

/**
 * How hard a candidate opening has to try before it is called a gate.
 *
 * These are DETECTION thresholds, not dimensions — they decide which gaps in the source are
 * openings, and they belong to the inference, not to the class table.
 */
export const GATE_INFERENCE = Object.freeze({
  minSpanM: 3.5,
  maxSpanM: 14,
  // Two run ends that meet at a corner are not the two sides of one gate. |da·db| near 1 means the
  // two runs are collinear, i.e. one line interrupted; near 0 means a corner, and 48 of Customs'
  // 52 candidate gaps fail here or on the road test.
  minCollinearity: 0.8,
  roadMarginM: 2.5,
  defaultRoadWidthM: 4,
});

const runEnds = (runs) => {
  const ends = [];
  runs.forEach((run, runIndex) => {
    const points = run.path;
    if (!points || points.length < 2) return;
    ends.push({
      runIndex, runId: run.id ?? runIndex, end: 'start', classId: run.classId,
      point: points[0], inward: normalize([points[1][0] - points[0][0], points[1][1] - points[0][1]]),
    });
    const last = points.length - 1;
    ends.push({
      runIndex, runId: run.id ?? runIndex, end: 'finish', classId: run.classId,
      point: points[last],
      inward: normalize([points[last - 1][0] - points[last][0], points[last - 1][1] - points[last][1]]),
    });
  });
  return ends;
};

const nearestRoad = (point, roads, defaultWidthM) => {
  let best = { distanceM: Infinity, halfWidthM: defaultWidthM / 2, road: null };
  for (const road of Array.isArray(roads) ? roads : []) {
    const halfWidthM = (num(road?.width, defaultWidthM) || defaultWidthM) / 2;
    for (const vertex of Array.isArray(road?.path) ? road.path : []) {
      const distanceM = Math.hypot(num(vertex?.[0]) - point[0], num(vertex?.[1]) - point[1]);
      if (distanceM < best.distanceM) best = { distanceM, halfWidthM, road: road.name ?? road.kind ?? null };
    }
  }
  return best;
};

/**
 * Derive gate openings from gaps between run ends that a road drives through.
 *
 * READ THE NUMBERS BEFORE TRUSTING THIS. There is no gate anywhere in the source data: the
 * tarkov.dev SVG's `Fence` group carries geometry and nothing else, and `scripts/build-3d.mjs`
 * already CUT the fence lines where roads cross without recording where it cut. So the only thing
 * left to work with is the gaps in the shipped runs — which are a mixture of the build's road cuts,
 * the artist's pen-lifts, and plain corners, with no field telling them apart.
 *
 * On Customs today: 52 mutual-nearest end pairs, of which 13 sit on a road at all, and 4 also read
 * as one collinear line interrupted. Those 4 are what this returns. Every record is stamped
 * `inferred:road-crossing`; none of them is a measurement, and the other 48 gaps stay plain run
 * ends with an end post rather than being guessed into gates.
 */
export function inferRoadCrossingGates(runs, roads, options = {}) {
  const settings = { ...GATE_INFERENCE, ...options };
  const ends = runEnds(Array.isArray(runs) ? runs : []);
  const nearest = ends.map((end, index) => {
    let bestIndex = -1, bestDistance = Infinity;
    ends.forEach((other, otherIndex) => {
      if (other.runIndex === end.runIndex) return;
      const distance = Math.hypot(other.point[0] - end.point[0], other.point[1] - end.point[1]);
      if (distance < bestDistance) { bestDistance = distance; bestIndex = otherIndex; }
    });
    return { index, bestIndex, bestDistance };
  });

  const gates = [], rejected = [];
  for (const candidate of nearest) {
    // Mutual nearest only: a fence end that merely happens to be closest to a busy junction is not
    // half of a gate. This also makes every gap appear exactly once.
    if (candidate.bestIndex < 0 || candidate.index > candidate.bestIndex) continue;
    if (nearest[candidate.bestIndex].bestIndex !== candidate.index) continue;
    const a = ends[candidate.index], b = ends[candidate.bestIndex];
    const spanM = candidate.bestDistance;
    const center = [(a.point[0] + b.point[0]) / 2, (a.point[1] + b.point[1]) / 2];
    const collinearity = Math.abs(a.inward[0] * b.inward[0] + a.inward[1] * b.inward[1]);
    const road = nearestRoad(center, roads, settings.defaultRoadWidthM);
    const onRoad = road.distanceM <= road.halfWidthM + settings.roadMarginM;
    const record = {
      id: `gate:${a.runId}:${a.end}-${b.runId}:${b.end}`,
      classId: a.classId === b.classId ? a.classId : FENCE_DEFAULT_CLASS,
      a: a.point, b: b.point, spanM, center, collinearity,
      roadDistanceM: road.distanceM, road: road.road, onRoad,
      provenance: 'inferred:road-crossing',
    };
    const reasons = [];
    if (!(spanM >= settings.minSpanM)) reasons.push('span-below-min');
    if (!(spanM <= settings.maxSpanM)) reasons.push('span-above-max');
    if (!onRoad) reasons.push('no-road-through-gap');
    if (!(collinearity >= settings.minCollinearity)) reasons.push('ends-not-collinear');
    if (reasons.length) rejected.push({ ...record, reasons });
    else gates.push(record);
  }
  // Plain code-unit order, not `localeCompare`: the collation `localeCompare` uses depends on the
  // host's ICU data, so it is exactly the wrong tool for an order a test is going to pin.
  gates.sort((left, right) => (String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0));
  return { gates, rejected, candidates: gates.length + rejected.length, settings };
}

// ---------------------------------------------------------------------------------------------
// Whole-map plan
// ---------------------------------------------------------------------------------------------

/** A prop row is a wall run when it draws a path rather than sitting at a point. */
export const isWallPropRow = (prop) => String(prop?.type ?? '') === 'wall' && Array.isArray(prop?.path) && prop.path.length >= 2;

/**
 * Plan every barrier on a map: chain-link runs, solid wall runs, and their gates.
 *
 * `gates` may be supplied verbatim by an authored source once one exists. When it is not, gates are
 * inferred (see `inferRoadCrossingGates`) and every record says so. Pass `inferGates: false` to get
 * runs and no gates at all.
 */
export function planWallStructures({
  fences = [], props = [], roads = [], gates = null,
  classes = PROVISIONAL_WALL_CLASSES, inferGates = true, inferenceOptions = {},
} = {}) {
  const runs = [];
  (Array.isArray(fences) ? fences : []).forEach((fence, index) => {
    const plan = planWallRun({
      id: fence?.id ?? `fence:${index}`,
      path: fence?.path,
      classId: wallClassIdFor(fence, FENCE_DEFAULT_CLASS),
      classes,
      meta: { kind: 'fence', name: fence?.name ?? null, sourceIndex: index },
    });
    if (plan) runs.push(plan);
  });
  (Array.isArray(props) ? props : []).forEach((prop, index) => {
    if (!isWallPropRow(prop)) return;
    const plan = planWallRun({
      id: prop?.featureId ?? prop?.name ?? `wall:${index}`,
      path: prop.path,
      classId: wallClassIdFor(prop, WALL_PROP_DEFAULT_CLASS),
      classes,
      meta: { kind: 'wall-prop', name: prop?.name ?? null, featureId: prop?.featureId ?? null, color: prop?.color ?? null, sourceIndex: index },
    });
    if (plan) runs.push(plan);
  });

  let gatePlans = [], inference = null;
  if (Array.isArray(gates)) {
    gatePlans = gates.map((gate, index) => planGate({
      id: gate?.id ?? `gate:${index}`,
      a: gate?.a, b: gate?.b,
      classId: wallClassIdFor(gate, FENCE_DEFAULT_CLASS),
      classes,
      provenance: gate?.provenance ?? 'authored',
      evidence: gate?.evidence ?? null,
    })).filter(Boolean);
  } else if (inferGates) {
    inference = inferRoadCrossingGates(runs, roads, inferenceOptions);
    gatePlans = inference.gates.map((gate) => planGate({
      id: gate.id, a: gate.a, b: gate.b, classId: gate.classId, classes,
      provenance: gate.provenance,
      evidence: {
        spanM: gate.spanM, collinearity: gate.collinearity,
        roadDistanceM: gate.roadDistanceM, road: gate.road,
      },
    })).filter(Boolean);
  }

  const byClass = {};
  for (const run of runs) {
    const bucket = byClass[run.classId] ?? (byClass[run.classId] = { runs: 0, lengthM: 0, panels: 0, posts: 0, status: run.spec.status });
    bucket.runs += 1;
    bucket.lengthM += run.lengthM;
    bucket.panels += run.panels.length;
    bucket.posts += run.posts.length;
  }
  return {
    runs,
    gates: gatePlans,
    inference,
    stats: {
      runs: runs.length,
      gates: gatePlans.length,
      gateProvenance: gatePlans.length ? [...new Set(gatePlans.map((gate) => gate.provenance))] : [],
      lengthM: runs.reduce((total, run) => total + run.lengthM, 0),
      panelLengthM: runs.reduce((total, run) => total + run.panelLengthM, 0),
      openingLengthM: runs.reduce((total, run) => total + run.openingLengthM, 0),
      posts: runs.reduce((total, run) => total + run.posts.length, 0),
      byClass,
      dimensionStatus: Object.fromEntries(Object.entries(classes).map(([id, spec]) => [id, spec.status])),
    },
  };
}

/**
 * Every dimension in a plan, with the class field it came from.
 *
 * The test that keeps the table honest walks this and asserts each value is identical to the
 * resolved class entry — a stray literal in the renderer or the planner shows up as a mismatch.
 */
export function planDimensionLedger(plan) {
  const rows = [];
  for (const run of plan?.runs ?? []) {
    rows.push({ owner: run.id, classId: run.classId, field: 'heightM', value: run.spec.heightM });
    rows.push({ owner: run.id, classId: run.classId, field: 'thicknessM', value: run.spec.thicknessM });
    for (const post of run.posts) {
      rows.push({ owner: run.id, classId: run.classId, field: 'postWidthM', value: post.widthM });
      rows.push({ owner: run.id, classId: run.classId, field: 'postHeightM', value: post.heightM });
    }
  }
  for (const gate of plan?.gates ?? []) {
    for (const jamb of gate.jambs) {
      rows.push({ owner: gate.id, classId: gate.classId, field: 'gate.jambWidthM', value: jamb.widthM });
      rows.push({ owner: gate.id, classId: gate.classId, field: 'gate.jambHeightM', value: jamb.heightM });
    }
  }
  return rows;
}

/** Look a ledger row's expected value up in the resolved table. Throws on a field it cannot map. */
export function expectedDimension(classes, classId, field) {
  const spec = classes?.[classId];
  if (!spec) throw new TypeError(`unknown wall class: ${classId}`);
  switch (field) {
    case 'heightM': return spec.heightM;
    case 'thicknessM': return spec.thicknessM;
    case 'postWidthM': return spec.postWidthM;
    case 'postHeightM': return spec.postHeightM;
    case 'gate.jambWidthM': return spec.gate.jambWidthM;
    case 'gate.jambHeightM': return spec.heightM + spec.gate.jambRiseM;
    default: throw new TypeError(`unmapped wall dimension field: ${field}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/**
 * A terrain-draped vertical quad with UVs — the surface a chain-link texture is masked onto.
 *
 * `drapedLinearSegmentMeshData` in three-world.js builds the closed prism a solid wall needs; a
 * mesh fence is genuinely a surface, and giving it a prism's six faces both doubles its triangles
 * and hides the alpha mask behind an opaque edge. Both ends sample the ground independently, so
 * the panel follows a slope instead of floating over it.
 */
export function drapedPanelMeshData(a, b, heightM, verticalOffsetM = 0, surfaceYFor = () => 0, uvScaleM = 1, uStartM = 0) {
  const ax = Number(a?.[0]), az = Number(a?.[1]), bx = Number(b?.[0]), bz = Number(b?.[1]);
  if (![ax, az, bx, bz].every(Number.isFinite)) return null;
  const lengthM = Math.hypot(bx - ax, bz - az);
  const height = Math.max(0.01, num(heightM));
  if (!(lengthM > 1e-4)) return null;
  const scale = num(uvScaleM) > 1e-6 ? Number(uvScaleM) : 1;
  const offset = num(verticalOffsetM);
  const baseA = num(surfaceYFor(ax, az)) + offset;
  const baseB = num(surfaceYFor(bx, bz)) + offset;
  // Z-up world: gameToWorld negates both horizontal axes, which is applied by the caller.
  return {
    corners: [
      [ax, az, baseA], [bx, bz, baseB],
      [ax, az, baseA + height], [bx, bz, baseB + height],
    ],
    uvs: new Float32Array([
      uStartM / scale, 0,
      (uStartM + lengthM) / scale, 0,
      uStartM / scale, height / scale,
      (uStartM + lengthM) / scale, height / scale,
    ]),
    indices: new Uint16Array([0, 1, 2, 2, 1, 3]),
    lengthM,
  };
}
