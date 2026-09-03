#!/usr/bin/env node
/**
 * Derive the local-only Customs bridge package from the user-owned scalar facts dump.
 *
 * WHY. `scripts/build-3d.mjs` emits a bridge only where a road/rail path crosses a WATER polygon,
 * and both Customs railway bridges span a ROAD. They are therefore invisible to that detector by
 * construction and absent from `public/data/customs-3d.json`. The Junk Bridge is hardcoded there
 * as a 22 m axis-aligned line that stops on a mid-river island.
 *
 * BOUNDARY. Output goes to `.local-game-derived/customs/bridges.json`, which is gitignored, is
 * outside `public/`, is served only by the dev-only `/@local-game-derived/` loopback route, and is
 * proven absent from `dist/` by `npm run verify:build-boundary`. **This script is git-tracked and
 * therefore contains no coordinates.** Every selector below is a NAME, a hierarchy root, or a
 * dimensionless clustering parameter; every number it emits is read out of the dump at run time.
 *
 * WHAT IT CAN AND CANNOT SEE. The acquisition layer is imported verbatim from
 * `customs-industrial-second-source.mjs` — one acquisition, per handoff §2, so agreement with any
 * other extractor downstream of it is not validation. The dump carries name, hierarchyPath,
 * parentage and TRS. It carries **no bounds**: no width, no thickness, no deck-top height exists
 * anywhere in it. So every dimension emitted here is DERIVED from composed world PIVOTS and is
 * marked `provisional-unmeasured`, with the derivation written into the record.
 *
 * Usage: node --max-old-space-size=12288 scripts/extract-customs-bridges-local.mjs [--facts PATH]
 *        [--out PATH] [--dry-run]
 * It streams ~460 MB off `/mnt/c` and takes 3-5 minutes. That is not a hang.
 */
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_FACTS_PATH,
  createGameObjectScanner,
  FactsStore,
  identityMatrix,
  localMatrixFromTransform,
  multiply4x4,
  stripInstanceSuffix,
} from './customs-industrial-second-source.mjs';
import {
  CUSTOMS_LOCAL_BRIDGES_SCHEMA_VERSION,
  CUSTOMS_LOCAL_BRIDGES_SOURCE_FRAME,
  PROVISIONAL_UNMEASURED,
  validateCustomsLocalBridgesPackage,
} from '../src/customs-local-bridges.js';

const REPOSITORY_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_OUT = resolve(REPOSITORY_ROOT, '.local-game-derived/customs/bridges.json');
const GENERATOR = 'scripts/extract-customs-bridges-local.mjs';

/**
 * Identity-only selectors. A deck is named, its ends are named, and the passage beneath it has a
 * named light-portal group; nothing here is spatial.
 *
 * `endFamily` is the object family whose two members are taken as the deck's ENDS. For the Old Gas
 * bridge those are its abutments (`bridge_opora04`); the Underbridge has no abutment objects, so
 * its two end piers (`bridge_opora02`) stand in — which is why the midpoint assertion below matters:
 * it is the check that the pair actually brackets the deck rather than merely sharing its name.
 */
const RAIL_BRIDGES = Object.freeze([
  {
    id: 'old-gas-railway-bridge',
    name: 'Old Gas Railway Bridge',
    hierarchyRoot: 'SBG_Custom_FactoryStorageZone',
    deckName: 'bridge_small02',
    endFamily: 'bridge_opora04',
    endRole: 'abutment',
    portalGroup: 'OldGasStationBridge',
  },
  {
    id: 'railway-underbridge',
    name: 'Railway Underbridge',
    hierarchyRoot: 'SBG_Custom_multiScene',
    deckName: 'bridge_small',
    endFamily: 'bridge_opora02',
    endRole: 'end pier',
    portalGroup: 'Underbridge2',
  },
]);

const PORTAL_ROOT = 'SBG_Custom_Portals';
/** The portal group holds the volumes AND their child collision cubes; only the volumes are mouths. */
const PORTAL_VOLUME_PREFIX = 'ambient_portal';
/** A deck pivot further than this from its two ends' midpoint is not that deck's pair. */
const DECK_MIDPOINT_TOLERANCE_M = 1.5;

/** The Junk Bridge has no object named "bridge" anywhere near it — hence these two families. */
const PLANK_SURFACE_NAME = /^Plane \(\d+\)$/;
const PLANK_SURFACE_GROUP = 'AdditiveMeshes';
const PLANK_FAMILY = /^wood_board0\d_long$/;
/**
 * The plank group. `AdditiveMeshes` planes and loose boards both occur all over Customs (430 boards
 * in 70+ groups), so proximity alone selects several unrelated prop piles. Restricting the boards
 * to this one authored group is what makes the crossing identifiable by name rather than by place.
 * `underwater1` — the sibling southern debris cluster — is excluded deliberately: it has four
 * boards, no walkable plane, and reaches neither bank, so it is river-bed dressing, not a crossing.
 */
const PLANK_GROUP = 'underwater2';
/** A walkable additive plane counts as decking only with this many planks this close to it. */
const PLANK_RADIUS_M = 8;
const MIN_PLANKS_PER_SURFACE = 6;
/** Single-link clustering distance that splits the crossing into its spans. */
const SPAN_LINK_M = 10;
const JUNK_TARGET = 'Junk Bridge';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const FACTS = resolve(flag('--facts', DEFAULT_FACTS_PATH));
const OUT = resolve(flag('--out', DEFAULT_OUT));
const DRY_RUN = args.includes('--dry-run');

const round = (value, places = 3) => Number(value.toFixed(places));
const hierarchyRootOf = (path) => String(path ?? '').split('/')[0];
const hierarchyHas = (path, segment) => String(path ?? '').split('/').includes(segment);

// ---------------------------------------------------------------------------------------------
// Acquisition: stream the dump, compose every world transform, count what was seen.
// ---------------------------------------------------------------------------------------------
async function readFacts() {
  const store = new FactsStore();
  const scanner = createGameObjectScanner({ arrayKey: 'gameObjects' });
  const slots = [], names = [], paths = [], parents = [];
  let parsed = 0;
  const stream = createReadStream(FACTS, { encoding: 'utf8', highWaterMark: 1 << 24 });
  for await (const chunk of stream) {
    for (const raw of scanner.push(String(chunk))) {
      const record = JSON.parse(raw);
      const index = store.add(record);
      slots[index] = store.assetIndex.get(record.asset);
      names[index] = record.name;
      paths[index] = record.hierarchyPath;
      parents[index] = record.parentGameObjectPathId ?? 0;
      parsed += 1;
    }
    if (scanner.finished) break;
  }
  stream.destroy?.();
  // Throws on a truncated array: a short read must not read as a small map.
  scanner.end();

  const count = parsed;
  const X = new Float64Array(count), Y = new Float64Array(count), Z = new Float64Array(count);
  const state = new Uint8Array(count), matrices = new Array(count);
  const localOf = (index) => {
    const base = index * 10;
    return localMatrixFromTransform({
      localPosition: { x: store.trs[base], y: store.trs[base + 1], z: store.trs[base + 2] },
      localRotation: { x: store.trs[base + 3], y: store.trs[base + 4], z: store.trs[base + 5], w: store.trs[base + 6] },
      localScale: { x: store.trs[base + 7], y: store.trs[base + 8], z: store.trs[base + 9] },
    });
  };
  let brokenParentPointers = 0;
  for (let index = 0; index < count; index += 1) {
    if (state[index] !== 0) continue;
    const stack = [];
    let cursor = index;
    while (cursor !== undefined && state[cursor] === 0) {
      state[cursor] = 1;
      stack.push(cursor);
      const parent = parents[cursor];
      if (!parent) { cursor = undefined; break; }
      const next = store.byAsset[slots[cursor]].get(parent);
      if (next === undefined) { brokenParentPointers += 1; cursor = undefined; break; }
      cursor = next;
    }
    let accumulated = (cursor !== undefined && state[cursor] === 2) ? matrices[cursor] : identityMatrix();
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const node = stack[k];
      accumulated = multiply4x4(accumulated, localOf(node));
      matrices[node] = accumulated;
      state[node] = 2;
      X[node] = accumulated[3]; Y[node] = accumulated[7]; Z[node] = accumulated[11];
    }
  }
  // A world pivot standing on a silently dropped ancestor is this project's signature failure.
  if (brokenParentPointers > 0) {
    throw new Error(`${brokenParentPointers} broken parent pointers: world pivots are not trustworthy`);
  }
  const node = (index) => ({ name: names[index], path: paths[index], x: X[index], y: Y[index], z: Z[index] });
  return { count, node, names, paths, brokenParentPointers };
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers. All operate on composed world pivots; none of them measures anything.
// ---------------------------------------------------------------------------------------------
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function axisOf(a, b) {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  if (!(length > 1e-6)) throw new Error('degenerate deck axis');
  return { ux: (b.x - a.x) / length, uz: (b.z - a.z) / length, length };
}
const along = (axis, origin, point) => (point.x - origin.x) * axis.ux + (point.z - origin.z) * axis.uz;
const across = (axis, origin, point) => (point.x - origin.x) * axis.uz - (point.z - origin.z) * axis.ux;

function railBridge(selector, nodes) {
  const inRoot = nodes.filter((n) => hierarchyRootOf(n.path) === selector.hierarchyRoot);
  const decks = inRoot.filter((n) => n.name === selector.deckName);
  if (decks.length !== 1) throw new Error(`${selector.id}: expected 1 ${selector.deckName}, found ${decks.length}`);
  const ends = inRoot.filter((n) => stripInstanceSuffix(n.name) === selector.endFamily);
  if (ends.length !== 2) throw new Error(`${selector.id}: expected 2 ${selector.endFamily}, found ${ends.length}`);
  const deck = decks[0];
  // Ascending X, so a path's direction is a property of the data and not of iteration order.
  const [a, b] = [...ends].sort((left, right) => left.x - right.x);
  const midpointOffsetM = Math.hypot((a.x + b.x) / 2 - deck.x, (a.z + b.z) / 2 - deck.z);
  if (!(midpointOffsetM <= DECK_MIDPOINT_TOLERANCE_M)) {
    throw new Error(`${selector.id}: deck pivot is ${midpointOffsetM.toFixed(2)} m off its ends' midpoint`);
  }
  const axis = axisOf(a, b);
  const portals = nodes.filter((n) => hierarchyRootOf(n.path) === PORTAL_ROOT
    && hierarchyHas(n.path, selector.portalGroup)
    && n.name.startsWith(PORTAL_VOLUME_PREFIX));
  if (portals.length !== 2) throw new Error(`${selector.id}: expected 2 ${selector.portalGroup} portals, found ${portals.length}`);
  // The two portals are the mouths of the passage UNDER the deck, so the component of their
  // separation perpendicular to the deck axis is the best width proxy the dump can offer.
  const widthM = Math.abs(across(axis, portals[0], portals[1]));
  const alongLeak = Math.abs(along(axis, portals[0], portals[1]));
  return {
    record: {
      id: selector.id,
      name: selector.name,
      kind: 'rail',
      path: [[round(a.x), round(a.z)], [round(b.x), round(b.z)]],
      width: round(widthM, 2),
      deckCanonicalYM: round(deck.y),
      dimensions: {
        path: {
          status: PROVISIONAL_UNMEASURED,
          source: `world pivots of the two ${selector.endRole} objects (${selector.endFamily}); the ${selector.deckName} deck pivot lies ${midpointOffsetM.toFixed(2)} m from their midpoint`,
        },
        width: {
          status: PROVISIONAL_UNMEASURED,
          source: `separation of the two ${selector.portalGroup} light-portal pivots resolved perpendicular to the deck axis (${alongLeak.toFixed(2)} m of that separation lies ALONG the axis and was discarded); portal pivots are not the deck edge`,
        },
        deckCanonicalYM: {
          status: PROVISIONAL_UNMEASURED,
          source: `${selector.deckName} pivot Y; whether that pivot sits at the deck top, bottom or centre is UNKNOWN — the dump has no bounds`,
        },
      },
    },
    diagnostics: {
      id: selector.id,
      spanM: round(axis.length, 2),
      widthM: round(widthM, 2),
      portalAlongAxisM: round(alongLeak, 2),
      deckMidpointOffsetM: round(midpointOffsetM, 2),
      endsY: ends.map((n) => round(n.y)),
    },
  };
}

/** Single-link clustering in XZ; returns clusters plus the shortest link that was NOT taken. */
function clusterByLink(points, linkM) {
  const clusters = points.map((point) => [point]);
  let nearestRejected = Infinity;
  let merged = true;
  while (merged) {
    merged = false;
    nearestRejected = Infinity;
    outer: for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        let best = Infinity;
        for (const a of clusters[i]) for (const b of clusters[j]) best = Math.min(best, distance(a, b));
        if (best <= linkM) {
          clusters[i] = clusters[i].concat(clusters[j]);
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
        nearestRejected = Math.min(nearestRejected, best);
      }
    }
  }
  return { clusters, nearestRejected };
}

function junkBridge(nodes) {
  const planks = nodes.filter((n) => PLANK_FAMILY.test(stripInstanceSuffix(n.name))
    && hierarchyHas(n.path, PLANK_GROUP));
  const surfaces = nodes.filter((n) => PLANK_SURFACE_NAME.test(n.name) && hierarchyHas(n.path, PLANK_SURFACE_GROUP))
    .map((surface) => ({
      ...surface,
      planks: planks.filter((plank) => distance(plank, surface) <= PLANK_RADIUS_M),
    }))
    .filter((surface) => surface.planks.length >= MIN_PLANKS_PER_SURFACE);
  if (surfaces.length < 2) throw new Error(`junk bridge: only ${surfaces.length} plank-backed walkable surfaces found`);
  const { clusters, nearestRejected } = clusterByLink(surfaces, SPAN_LINK_M);
  if (clusters.length !== 2) throw new Error(`junk bridge: expected 2 spans, clustered ${clusters.length}`);

  const spans = clusters
    .map((cluster) => {
      let ends = [cluster[0], cluster[cluster.length - 1]];
      let longest = -1;
      for (const a of cluster) for (const b of cluster) {
        if (distance(a, b) > longest) { longest = distance(a, b); ends = [a, b]; }
      }
      // Ascending X, so a path's direction is a property of the data and not of iteration order.
      if (ends[0].x > ends[1].x) ends = [ends[1], ends[0]];
      const origin = ends[0];
      const axis = axisOf(ends[0], ends[1]);
      const ordered = [...cluster].sort((a, b) => along(axis, origin, a) - along(axis, origin, b));
      const near = planks.filter((plank) => cluster.some((surface) => distance(plank, surface) <= PLANK_RADIUS_M));
      const projections = near.map((plank) => along(axis, origin, plank));
      const offsets = near.map((plank) => across(axis, origin, plank));
      // Extend each end of the walkable-surface polyline to the furthest plank on that span: the
      // planes stop short of both banks, and a deck that ends where the last plane pivot sits
      // would under-report the crossing the same way the public 22 m line does. A zero shift adds
      // no point — a repeated vertex is a zero-length segment with no tangent.
      const first = ordered[0], last = ordered[ordered.length - 1];
      const startShift = Math.min(0, Math.min(...projections) - along(axis, origin, first));
      const endShift = Math.max(0, Math.max(...projections) - along(axis, origin, last));
      const path = [
        ...(startShift < -1e-3 ? [{ x: first.x + axis.ux * startShift, z: first.z + axis.uz * startShift }] : []),
        ...ordered,
        ...(endShift > 1e-3 ? [{ x: last.x + axis.ux * endShift, z: last.z + axis.uz * endShift }] : []),
      ];
      return {
        cluster: ordered,
        path,
        plankCount: near.length,
        widthM: Math.max(...offsets) - Math.min(...offsets),
        deckY: ordered.reduce((sum, s) => sum + s.y, 0) / ordered.length,
        startShift,
        endShift,
      };
    })
    .sort((a, b) => a.path[0].x - b.path[0].x);

  return spans.map((span, index) => ({
    record: {
      id: `junk-bridge-span-${index + 1}`,
      // Deliberately not "west"/"east": the map's own frame puts +x on the LEFT of the screen, the
      // evidence report uses both conventions in different sections, and a compass word nobody
      // checked is a claim. Order along the crossing is what the data actually supports.
      name: `Junk Bridge (span ${index + 1} of ${spans.length})`,
      kind: 'foot',
      foot: true,
      replaces: JUNK_TARGET,
      path: span.path.map((point) => [round(point.x), round(point.z)]),
      width: round(Math.max(1.5, span.widthM), 2),
      deckCanonicalYM: round(span.deckY),
      dimensions: {
        path: {
          status: PROVISIONAL_UNMEASURED,
          source: `pivots of ${span.cluster.length} ${PLANK_SURFACE_GROUP} walkable planes, in order along the span, extended ${Math.abs(span.startShift).toFixed(2)} m / ${span.endShift.toFixed(2)} m to the furthest of ${span.plankCount} plank pivots within ${PLANK_RADIUS_M} m; a fitted centreline is not a survey`,
        },
        width: {
          status: PROVISIONAL_UNMEASURED,
          source: `spread of those ${span.plankCount} plank pivots perpendicular to the span axis, floored at 1.5 m; plank pivots are not deck edges`,
        },
        deckCanonicalYM: {
          status: PROVISIONAL_UNMEASURED,
          source: `mean pivot Y of the span's ${span.cluster.length} walkable planes. A Unity plane has no thickness, so its pivot lies ON the surface — the one height in this package whose pivot convention is not in doubt. The MEAN of several is still derived, and the water surface height remains unknown (no water object exists in the dump)`,
        },
      },
    },
    diagnostics: {
      id: `junk-bridge-span-${index + 1}`,
      surfaces: span.cluster.length,
      plankCount: span.plankCount,
      widthM: round(span.widthM, 2),
      deckY: round(span.deckY),
      lengthM: round(Math.hypot(
        span.path[span.path.length - 1].x - span.path[0].x,
        span.path[span.path.length - 1].z - span.path[0].z,
      ), 2),
      spanLinkRejectedM: round(nearestRejected, 2),
    },
  }));
}

const facts = await readFacts();
process.stderr.write(`scanned ${facts.count} gameObjects, ${facts.brokenParentPointers} broken parent pointers\n`);
const nodes = Array.from({ length: facts.count }, (_, index) => facts.node(index));
const built = [...RAIL_BRIDGES.map((selector) => railBridge(selector, nodes)), ...junkBridge(nodes)];
const bridgesPackage = validateCustomsLocalBridgesPackage({
  schemaVersion: CUSTOMS_LOCAL_BRIDGES_SCHEMA_VERSION,
  map: 'customs',
  localOnly: true,
  sourceFrame: CUSTOMS_LOCAL_BRIDGES_SOURCE_FRAME,
  generator: GENERATOR,
  bridges: built.map(({ record }) => record),
});
process.stderr.write(`${JSON.stringify(built.map(({ diagnostics }) => diagnostics), null, 2)}\n`);
if (DRY_RUN) {
  process.stderr.write('--dry-run: nothing written\n');
} else {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(bridgesPackage, null, 2)}\n`, 'utf8');
  process.stderr.write(`wrote ${bridgesPackage.bridges.length} bridges to ${OUT}\n`);
}
