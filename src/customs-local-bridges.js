// Pure contract for the local-only authored Customs bridge package.
//
// WHY THIS EXISTS. `scripts/build-3d.mjs` emits a bridge only where a road or rail path crosses a
// WATER polygon. Both Customs railway bridges span a ROAD, so that detector can never see them and
// they are absent from `public/data/customs-3d.json` by construction — not by mistake. The Junk
// Bridge is hardcoded there instead, at a straight 22 m line that stops on a mid-river island.
//
// The corrections come from the founder's own game install under a LOCAL-USE-ONLY approval
// (docs/CONTINUATION-HANDOFF-2026-09-02.md §9), so they may not enter a git-tracked file or a
// production build. They live in the gitignored `.local-game-derived/customs/bridges.json`
// package, are served only by the dev-only loopback route, and are merged into the renderer's
// bridge list at runtime by `mergeCustomsLocalBridges` below. Production keeps exactly the three
// bridges `customs-3d.json` ships.
//
// WHAT THE EVIDENCE CANNOT DO — and why every dimension here is `provisional-unmeasured`. The
// scalar facts dump carries `name`, `hierarchyPath`, parentage and TRS. It carries no renderers,
// no meshes and **no bounds**. So there is no measured width, no measured thickness and no
// measured deck height anywhere in this package: every number is DERIVED by composing the world
// PIVOTS of an object's own abutments, piers, portals or planks and boxing them. A pivot box is a
// lower bound on the real footprint. Three specific unknowns are NOT papered over here and must
// not be treated as resolved by a later reader:
//
//   1. whether a deck object's pivot sits at the deck TOP, BOTTOM or CENTRE (unknown for the two
//      `bridge_small*` assets; the `AdditiveMeshes` planes are the one exception, because a plane
//      has no thickness for its pivot to sit inside);
//   2. the water surface height — no water-surface object exists in the dump under any name;
//   3. every real dimension of every structure.
//
// A record therefore carries `deckCanonicalYM` and NO `height`. `height` in the public bridge rows
// is a LIFT above interpolated terrain, and for `kind: 'rail'` the detector's literal is 8 m —
// which would put these decks about six metres above where the game's own pivots put them. A local
// record that cannot state a canonical deck Y does not exist.

export const CUSTOMS_LOCAL_BRIDGES_SCHEMA_VERSION = 1;
export const CUSTOMS_LOCAL_BRIDGES_SOURCE_FRAME = 'eft-unity-world-metres-y-up';
export const CUSTOMS_LOCAL_BRIDGES_FILE = 'bridges.json';
/** Route segments under `/@local-game-derived/`; the middleware authorizes exactly this path. */
export const CUSTOMS_LOCAL_BRIDGES_SEGMENTS = Object.freeze(['customs', CUSTOMS_LOCAL_BRIDGES_FILE]);
/** Same token `src/wall-runs.js` marks its unmeasured wall dimensions with. One vocabulary. */
export const PROVISIONAL_UNMEASURED = 'provisional-unmeasured';

const MAP_ID = 'customs';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const KINDS = new Set(['rail', 'foot']);
const MAX_BRIDGES = 32;
const MAX_PATH_POINTS = 512;

export class CustomsLocalBridgesError extends Error {
  constructor(path, message) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'CustomsLocalBridgesError';
    this.code = 'ERR_CUSTOMS_LOCAL_BRIDGES_SCHEMA';
    this.path = path;
  }
}

const fail = (path, message) => { throw new CustomsLocalBridgesError(path, message); };

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional, path) {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path, `is missing required field ${key}`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(path, `contains unsupported field(s): ${unexpected.join(', ')}`);
  return value;
}

function finite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
  return Object.is(value, -0) ? 0 : value;
}

function text(value, path, limit = 120) {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit || value.trim() !== value) {
    fail(path, `must be a non-empty, already-trimmed string of at most ${limit} characters`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function normalizePath(value, path) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_PATH_POINTS) {
    fail(path, `must be an array of 2 through ${MAX_PATH_POINTS} game-coordinate points`);
  }
  const points = value.map((point, index) => {
    const entry = `${path}[${index}]`;
    if (!Array.isArray(point) || point.length !== 2) fail(entry, 'must be a [x, z] pair');
    return [finite(point[0], `${entry}[0]`), finite(point[1], `${entry}[1]`)];
  });
  for (let index = 1; index < points.length; index += 1) {
    const [ax, az] = points[index - 1], [bx, bz] = points[index];
    // A repeated point is a zero-length segment: `ribbonGeometry` drops it silently and
    // `bridgeStructurePlan` would place a pier on an undefined tangent.
    if (Math.hypot(bx - ax, bz - az) < 1e-3) fail(`${path}[${index}]`, 'repeats the previous point');
  }
  return points;
}

/**
 * Per-field provenance, mirroring `WALL_CLASSES`' `dimensionSource`: a status token plus a sentence
 * naming the pivots the number came from. A field whose status is not `provisional-unmeasured` is
 * rejected — nothing in this package has ever been measured, and a record that claims otherwise is
 * exactly the laundering this repo keeps producing.
 */
function normalizeDimensions(value, path) {
  if (!isPlainObject(value)) fail(path, 'must be an object keyed by dimension');
  const keys = Object.keys(value);
  if (keys.length === 0) fail(path, 'must document at least one dimension');
  const dimensions = {};
  for (const key of keys) {
    const entry = exactKeys(value[key], ['status', 'source'], [], `${path}.${key}`);
    if (entry.status !== PROVISIONAL_UNMEASURED) {
      fail(`${path}.${key}.status`, `must be ${PROVISIONAL_UNMEASURED}; the facts dump carries no bounds`);
    }
    dimensions[key] = { status: PROVISIONAL_UNMEASURED, source: text(entry.source, `${path}.${key}.source`, 400) };
  }
  return dimensions;
}

function normalizeBridge(value, index, ids) {
  const path = `bridges[${index}]`;
  const bridge = exactKeys(
    value,
    ['id', 'name', 'kind', 'path', 'width', 'deckCanonicalYM', 'dimensions'],
    ['replaces', 'foot'],
    path,
  );
  const id = text(bridge.id, `${path}.id`, 64);
  if (!ID_PATTERN.test(id)) fail(`${path}.id`, 'must be a lowercase kebab-case id');
  if (ids.has(id)) fail(`${path}.id`, `duplicates ${id}`);
  ids.add(id);
  if (!KINDS.has(bridge.kind)) fail(`${path}.kind`, `must be one of ${[...KINDS].join(', ')}`);
  const width = finite(bridge.width, `${path}.width`);
  if (!(width > 0) || width > 60) fail(`${path}.width`, 'must be a plausible positive deck width in metres');
  const normalized = {
    id,
    name: text(bridge.name, `${path}.name`),
    kind: bridge.kind,
    path: normalizePath(bridge.path, `${path}.path`),
    width,
    // The deck altitude in the game's own frame. `map3d-three.js` converts it to a display Y with
    // the SAME `terrainRelativeDisplayY` every other canonical-Y object goes through, against the
    // exact local terrain — never against the fitted public heightfield, which is interpolated from
    // spawn and loot points and never sits on a riverbed.
    deckCanonicalYM: finite(bridge.deckCanonicalYM, `${path}.deckCanonicalYM`),
    dimensions: normalizeDimensions(bridge.dimensions, `${path}.dimensions`),
  };
  if (bridge.replaces !== undefined) normalized.replaces = text(bridge.replaces, `${path}.replaces`);
  if (bridge.foot !== undefined) {
    if (bridge.foot !== true) fail(`${path}.foot`, 'must be true when present');
    normalized.foot = true;
  }
  return normalized;
}

/** Validate and deep-freeze the package. Unknown fields are rejected, as in the terrain manifest. */
export function validateCustomsLocalBridgesPackage(value) {
  const root = exactKeys(
    value,
    ['schemaVersion', 'map', 'localOnly', 'sourceFrame', 'generator', 'bridges'],
    [],
    'bridges package',
  );
  if (root.schemaVersion !== CUSTOMS_LOCAL_BRIDGES_SCHEMA_VERSION) {
    fail('bridges package.schemaVersion', `must be ${CUSTOMS_LOCAL_BRIDGES_SCHEMA_VERSION}`);
  }
  if (root.map !== MAP_ID) fail('bridges package.map', `must be ${MAP_ID}`);
  if (root.localOnly !== true) fail('bridges package.localOnly', 'must be true');
  if (root.sourceFrame !== CUSTOMS_LOCAL_BRIDGES_SOURCE_FRAME) {
    fail('bridges package.sourceFrame', `must be ${CUSTOMS_LOCAL_BRIDGES_SOURCE_FRAME}`);
  }
  text(root.generator, 'bridges package.generator', 200);
  if (!Array.isArray(root.bridges) || root.bridges.length === 0 || root.bridges.length > MAX_BRIDGES) {
    fail('bridges package.bridges', `must hold 1 through ${MAX_BRIDGES} bridges`);
  }
  const ids = new Set();
  return deepFreeze({
    schemaVersion: CUSTOMS_LOCAL_BRIDGES_SCHEMA_VERSION,
    map: MAP_ID,
    localOnly: true,
    sourceFrame: CUSTOMS_LOCAL_BRIDGES_SOURCE_FRAME,
    generator: root.generator,
    bridges: root.bridges.map((bridge, index) => normalizeBridge(bridge, index, ids)),
  });
}

/**
 * How one bridge row's deck altitude is decided. Three rules, one seam.
 *
 *  - `canonical-game-y`: the row states its deck's Y in the game's own frame, so it is converted
 *    against canonical ground and the relief transform must NOT touch it.
 *  - `measured-surface`: a public row with `surfaceY`, the existing measured-surface contract.
 *  - `terrain-lift`: a public row with neither, lifted above interpolated terrain by `height`.
 *
 * It is a pure function rather than an inline expression in `map3d-three.js` so the one decision
 * that separates a local deck from a shipped one can be asserted without a GPU.
 */
export const BRIDGE_SEATING = Object.freeze({
  CANONICAL: 'canonical-game-y',
  MEASURED: 'measured-surface',
  LIFT: 'terrain-lift',
});

export function bridgeSeating(bridge) {
  const canonicalYM = Number(bridge?.deckCanonicalYM);
  const path = Array.isArray(bridge?.path) ? bridge.path : [];
  if (Number.isFinite(canonicalYM) && path.length >= 2) {
    return Object.freeze({ mode: BRIDGE_SEATING.CANONICAL, canonicalYM });
  }
  return Object.freeze({
    mode: Number.isFinite(Number(bridge?.surfaceY)) ? BRIDGE_SEATING.MEASURED : BRIDGE_SEATING.LIFT,
    canonicalYM: null,
  });
}

/**
 * The point on a deck at which its canonical altitude is converted into a display altitude: the
 * path vertex standing on the HIGHEST canonical ground.
 *
 * This is not arbitrary. The renderer exaggerates terrain by a fixed 2x while an object keeps its
 * TRUE clearance above the ground beneath it (`terrainRelativeDisplayY`). A flat deck therefore has
 * to be pinned somewhere, and the two candidates behave very differently under that stretch:
 *
 *   * pin it over the middle of the crossing and both ends sink into their own banks, because each
 *     bank has just grown by (relief - 1) x its height above the low point while the deck has not;
 *   * pin it to the highest bank — where a deck physically MEETS its approach — and the ends stay
 *     flush while the span gains clearance over a cut that is now twice as deep.
 *
 * Measured on the exact local terrain: the Old Gas deck's own abutments stand at canonical 3.62 and
 * 3.76 with the road cut beneath it at -0.20, and the junk-bridge planks meet their banks at -13.2
 * and -13.9 over a river bed at -15.4. Pinning either of those mid-span buries both of its ends.
 *
 * `canonicalGroundAt(x, z)` must be the CANONICAL sampler (relief 1). Returns null when no vertex
 * has finite ground — a bridge outside terrain coverage is not seated by guesswork.
 */
export function bridgeDeckAnchor(bridge, canonicalGroundAt) {
  if (typeof canonicalGroundAt !== 'function') return null;
  let anchor = null;
  let highest = -Infinity;
  for (const point of Array.isArray(bridge?.path) ? bridge.path : []) {
    if (!Array.isArray(point)) continue;
    const x = Number(point[0]), z = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const ground = Number(canonicalGroundAt(x, z));
    if (Number.isFinite(ground) && ground > highest) { highest = ground; anchor = Object.freeze([x, z]); }
  }
  return anchor;
}

/**
 * Merge the local package into the public bridge rows, returning a NEW array.
 *
 * A record with `replaces` takes the position of the public bridge of that name — several records
 * may replace one row (the Junk Bridge is two plank spans with an island between them, and the
 * public data has a single row). A record without `replaces` is appended.
 *
 * `unmatchedReplaceTargets` is the load-bearing field. If `public/data/customs-3d.json` ever stops
 * shipping a bridge a record names, the record is still added — the geometry is real either way —
 * but the miss is REPORTED. Silently appending would turn a data change into an invisible
 * duplicate, which is the failure mode §6 of the handoff is about.
 */
export function mergeCustomsLocalBridges(publicBridges, packageValue) {
  const base = Array.isArray(publicBridges) ? publicBridges : [];
  const local = validateCustomsLocalBridgesPackage(packageValue);
  const byTarget = new Map();
  const appended = [];
  for (const bridge of local.bridges) {
    if (bridge.replaces == null) { appended.push(bridge); continue; }
    if (!byTarget.has(bridge.replaces)) byTarget.set(bridge.replaces, []);
    byTarget.get(bridge.replaces).push(bridge);
  }
  const matched = new Set();
  const bridges = [];
  for (const bridge of base) {
    const replacements = byTarget.get(bridge?.name);
    if (!replacements) { bridges.push(bridge); continue; }
    matched.add(bridge.name);
    bridges.push(...replacements);
  }
  const unmatchedReplaceTargets = [...byTarget.keys()].filter((name) => !matched.has(name));
  for (const name of unmatchedReplaceTargets) bridges.push(...byTarget.get(name));
  bridges.push(...appended);
  return {
    bridges,
    added: appended.length,
    replaced: [...matched].sort(),
    unmatchedReplaceTargets: unmatchedReplaceTargets.sort(),
  };
}
