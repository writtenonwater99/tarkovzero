#!/usr/bin/env node

/**
 * Independent second source for the Customs industrial rail-yard identity question.
 *
 * This script deliberately shares no code, spec, or heuristic with the primary
 * industrial-roots extractor. It reads ONE artefact that already exists on disk:
 * a scalar-only Unity facts dump (GameObject names, hierarchy paths, parent
 * pointers, local TRS). It never touches a game install.
 *
 * What the dump carries: names, hierarchyPath, parentGameObjectPathId, active,
 * localPosition / localRotation / localScale, sceneIndex, scenePath, asset.
 * What it does NOT carry: renderers, meshes, materials, textures, colours.
 * Every colour statement below therefore rests on a NAME token, never on a
 * material — see CAPABILITY_STATEMENT.
 *
 * Coordinate frame (see resolveWorkingFrame): world positions are composed in
 * the dump's own frame, which is Unity world metres, Y up. The scene manifest
 * calls that frame 'eft-unity-world-metres-y-up' and the rail-yard scope box is
 * expressed in the same frame (ground plane X/Z, centre {x, z}, widthM/depthM).
 * The runtime frame 'three-z-up-metres' is reachable by runtimeFromSource
 * [-x, -z, y]; the script computes it too and reports scope containment under
 * BOTH readings so the frame choice is evidence, not an assumption.
 */

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');

export const DEFAULT_FACTS_PATH = '/tmp/tarkovzero-customs-unity-facts.json';
export const SCENE_MANIFEST_PATH = resolve(
  REPOSITORY_ROOT,
  'public/assets/3d/customs/scene-manifest.json',
);
/** Hand-traced from a satellite render; never derived from the facts dump. */
export const TRACED_PROPS_PATH = resolve(REPOSITORY_ROOT, 'data/customs-props.json');

export const SOURCE_FRAME = 'eft-unity-world-metres-y-up';
export const RUNTIME_FRAME = 'three-z-up-metres';
export const RUNTIME_FROM_SOURCE = '[-x, -z, y]';

export const RAIL_YARD_SCOPE = Object.freeze({
  id: 'customs-industrial-rail-yard',
  center: Object.freeze({ x: 230, z: -110 }),
  widthM: 360,
  depthM: 300,
});

export const HANDOFF_CLAIM = Object.freeze({
  'closed-freight-wagon': 3,
  'tank-wagon': 2,
  'hopper-wagon': 1,
  'container-6m-red': 2,
});

export const DEFAULT_MAX_PARENT_DEPTH = 128;
export const DEFAULT_DEDUPE_TOLERANCE_M = 0.5;

export const CAPABILITY_STATEMENT = Object.freeze({
  can: Object.freeze([
    'Enumerate every GameObject whose NAME declares a rail-body or shipping-container type.',
    'Compose a world position for each from the local TRS chain through parentGameObjectPathId.',
    'Decide scope membership against the rail-yard box on the X/Z ground plane.',
    'Reduce nested LOD / collider / door children to the placed root that owns them.',
    'Report a per-name-token census with positions, scenes and hierarchy paths.',
    'Report a colour token WHEN the author put one in the name (…_Red_close, …_green).',
  ]),
  cannot: Object.freeze([
    'Establish colour, material, texture or paint for any object whose name lacks a colour token — the dump has no renderer, mesh or material fields at all.',
    'Confirm that a name-borne colour token matches the material actually assigned in the scene.',
    'Measure any object dimension: no bounds, no mesh, so "6 m" is read from the name token container_6m, never from geometry.',
    'Distinguish a visible prop from a disabled or culling-only placeholder beyond the boolean active flag it carries.',
    'Say anything about objects the dump omitted; it is an inventory of what was extracted, not proof of what exists.',
  ]),
});

class SecondSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecondSourceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SecondSourceError(code, message);
}

/* ------------------------------------------------------------------ *
 * Streaming reader
 * ------------------------------------------------------------------ */

const MODE_SEEK = 0;
const MODE_ARRAY = 1;
const MODE_DONE = 2;

/**
 * Incremental scanner that pulls the elements of one named top-level array out
 * of a JSON document without ever materialising the whole document. Feed it
 * chunks; it hands back the raw JSON text of each array element.
 */
export function createGameObjectScanner({ arrayKey = 'gameObjects', depth: keyDepth = 1 } = {}) {
  let mode = MODE_SEEK;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let carriedString = '';
  let candidateKey = null;
  let awaitingColon = false;
  let pendingKey = null;

  let itemDepth = 0;
  let itemStart = -1;
  let carry = '';
  let emitted = 0;

  function finishString(chunk, endIndex) {
    const body = stringStart >= 0 ? carriedString + chunk.slice(stringStart, endIndex) : carriedString;
    carriedString = '';
    stringStart = -1;
    return body;
  }

  return {
    get finished() {
      return mode === MODE_DONE;
    },
    get started() {
      return mode !== MODE_SEEK;
    },
    get count() {
      return emitted;
    },
    /** @returns {string[]} raw JSON text of each element completed by this chunk */
    push(chunk) {
      const items = [];
      if (mode === MODE_DONE) return items;
      if (mode === MODE_ARRAY && itemStart >= 0) itemStart = 0;

      for (let i = 0; i < chunk.length; i += 1) {
        const ch = chunk[i];

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
            if (mode === MODE_SEEK) {
              candidateKey = finishString(chunk, i);
              awaitingColon = true;
            }
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          escaped = false;
          if (mode === MODE_SEEK) {
            stringStart = i + 1;
            carriedString = '';
          }
          continue;
        }

        if (mode === MODE_SEEK) {
          if (ch === ':' && awaitingColon) {
            pendingKey = candidateKey;
            awaitingColon = false;
            continue;
          }
          if (ch === '{') {
            depth += 1;
            pendingKey = null;
            awaitingColon = false;
          } else if (ch === '}') {
            depth -= 1;
            pendingKey = null;
            awaitingColon = false;
          } else if (ch === '[') {
            if (depth === keyDepth && pendingKey === arrayKey) {
              mode = MODE_ARRAY;
              itemDepth = 0;
              itemStart = -1;
              carry = '';
              continue;
            }
            depth += 1;
            pendingKey = null;
            awaitingColon = false;
          } else if (ch === ']') {
            depth -= 1;
            pendingKey = null;
            awaitingColon = false;
          } else if (ch === ',') {
            pendingKey = null;
            awaitingColon = false;
          }
          continue;
        }

        // MODE_ARRAY
        if (itemStart < 0) {
          if (ch === ']') {
            mode = MODE_DONE;
            break;
          }
          if (ch === ',' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
          itemStart = i;
          itemDepth = 0;
        }
        if (ch === '{' || ch === '[') {
          itemDepth += 1;
        } else if (ch === '}' || ch === ']') {
          itemDepth -= 1;
          if (itemDepth === 0) {
            items.push(carry + chunk.slice(itemStart, i + 1));
            carry = '';
            itemStart = -1;
            emitted += 1;
          }
        }
      }

      if (mode === MODE_SEEK && inString && stringStart >= 0) {
        carriedString += chunk.slice(stringStart);
        stringStart = 0;
      }
      if (mode === MODE_ARRAY && itemStart >= 0) {
        carry += chunk.slice(itemStart);
      }
      return items;
    },
    end() {
      if (mode === MODE_SEEK) {
        fail('ERR_SECOND_SOURCE_ARRAY_MISSING', `array "${arrayKey}" was never reached`);
      }
      if (mode === MODE_ARRAY && (itemStart >= 0 || carry.length > 0)) {
        fail('ERR_SECOND_SOURCE_TRUNCATED', `array "${arrayKey}" ended mid-element`);
      }
      return emitted;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Transform algebra (row-major 4x4, translation in the last column)
 * ------------------------------------------------------------------ */

export function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply4x4(a, b) {
  const out = new Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[row * 4 + col] =
        a[row * 4] * b[col] +
        a[row * 4 + 1] * b[4 + col] +
        a[row * 4 + 2] * b[8 + col] +
        a[row * 4 + 3] * b[12 + col];
    }
  }
  return out;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Builds T * R * S for one Unity local transform. */
export function localMatrixFromTransform(transform) {
  const p = transform?.localPosition ?? {};
  const q = transform?.localRotation ?? {};
  const s = transform?.localScale ?? {};
  const px = numberOr(p.x, 0);
  const py = numberOr(p.y, 0);
  const pz = numberOr(p.z, 0);
  const qx = numberOr(q.x, 0);
  const qy = numberOr(q.y, 0);
  const qz = numberOr(q.z, 0);
  const qw = numberOr(q.w, 1);
  const sx = numberOr(s.x, 1);
  const sy = numberOr(s.y, 1);
  const sz = numberOr(s.z, 1);

  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;

  const r00 = 1 - 2 * (yy + zz);
  const r01 = 2 * (xy - wz);
  const r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz);
  const r11 = 1 - 2 * (xx + zz);
  const r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy);
  const r21 = 2 * (yz + wx);
  const r22 = 1 - 2 * (xx + yy);

  return [
    r00 * sx, r01 * sy, r02 * sz, px,
    r10 * sx, r11 * sy, r12 * sz, py,
    r20 * sx, r21 * sy, r22 * sz, pz,
    0, 0, 0, 1,
  ];
}

export function matrixTranslation(matrix) {
  return { x: matrix[3], y: matrix[7], z: matrix[11] };
}

/**
 * Walks parentKey pointers up from `key`, then composes downwards.
 *
 * Guards, all of which are reported rather than silently smoothed over:
 *  - cycle          a key repeats in its own ancestry
 *  - depth-exceeded the chain is longer than maxDepth
 *  - missing        the key itself is unknown to the lookup
 *  - broken-chain   an ancestor pointer names a node the lookup does not have
 */
export function resolveWorldTransform(lookup, key, { maxDepth = DEFAULT_MAX_PARENT_DEPTH } = {}) {
  const chain = [];
  const seen = new Set();
  let cursor = key;
  let status = 'ok';

  while (cursor !== null && cursor !== undefined) {
    if (seen.has(cursor)) {
      status = 'cycle';
      break;
    }
    if (chain.length >= maxDepth) {
      status = 'depth-exceeded';
      break;
    }
    seen.add(cursor);
    const node = lookup(cursor);
    if (!node) {
      status = chain.length === 0 ? 'missing' : 'broken-chain';
      break;
    }
    chain.push(node);
    cursor = node.parentKey ?? null;
  }

  if (status !== 'ok') {
    return { status, position: null, matrix: null, depth: chain.length, activeInHierarchy: false };
  }

  let matrix = identityMatrix();
  let activeInHierarchy = true;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    matrix = multiply4x4(matrix, localMatrixFromTransform(chain[i].transform));
    if (chain[i].active === false) activeInHierarchy = false;
  }

  return {
    status: 'ok',
    position: matrixTranslation(matrix),
    matrix,
    depth: chain.length,
    activeInHierarchy,
  };
}

/* ------------------------------------------------------------------ *
 * Frames and scope
 * ------------------------------------------------------------------ */

/** runtimeFromSource '[-x, -z, y]' applied literally. */
export function sourceToRuntime(position) {
  return { x: -position.x, y: -position.z, z: position.y };
}

export function scopeBounds(scope) {
  const halfWidth = scope.widthM / 2;
  const halfDepth = scope.depthM / 2;
  return {
    minX: scope.center.x - halfWidth,
    maxX: scope.center.x + halfWidth,
    minZ: scope.center.z - halfDepth,
    maxZ: scope.center.z + halfDepth,
  };
}

/** Scope membership on the Y-up ground plane (X across, Z along). */
export function isWithinScopeXZ(position, scope) {
  const b = scopeBounds(scope);
  return position.x >= b.minX && position.x <= b.maxX && position.z >= b.minZ && position.z <= b.maxZ;
}

/**
 * Membership if the box were instead read in the runtime frame, where the
 * ground plane is X/Y. Only used to prove which reading is the right one.
 */
export function isWithinScopeRuntimeXY(runtimePosition, scope) {
  const b = scopeBounds(scope);
  return (
    runtimePosition.x >= b.minX
    && runtimePosition.x <= b.maxX
    && runtimePosition.y >= b.minZ
    && runtimePosition.y <= b.maxZ
  );
}

/* ------------------------------------------------------------------ *
 * Name tokens
 * ------------------------------------------------------------------ */

const INSTANCE_SUFFIX = /\s*\((\d+)\)\s*$/;
const TECHNICAL_SUFFIX = /_(?:LOD\d+|COLLIDER|SHADOW_LOD\d+|SHADOW|BALLISTIC_[A-Za-z]+|decal_LOD\d+|decal)$/i;
const COLOUR_WORDS = new Set([
  'red', 'green', 'blue', 'darkblue', 'yellow', 'orange', 'black', 'grey', 'gray', 'white', 'brown',
]);

/** Strips Unity's " (3)" duplicate marker. */
export function stripInstanceSuffix(name) {
  return String(name).replace(INSTANCE_SUFFIX, '').trim();
}

/**
 * Reduces an authored name to its stable body token: duplicate marker off,
 * then every trailing renderer/collider/shadow/ballistic decoration off.
 */
export function bodyTokenFromName(name) {
  let token = stripInstanceSuffix(name);
  let previous = null;
  while (token !== previous) {
    previous = token;
    token = token.replace(TECHNICAL_SUFFIX, '');
  }
  return token.toLowerCase();
}

export function hasTechnicalSuffix(name) {
  return TECHNICAL_SUFFIX.test(stripInstanceSuffix(name));
}

/**
 * Classifies a body token from the token alone. Returns null for anything that
 * is not rail rolling stock or a shipping container. `role` is 'body' for a
 * placeable body and 'part' for a named sub-assembly (doors, wheels).
 */
export function classifyBodyToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;

  const containerMatch = /^container_(6m|12m)(?:_(.*))?$/.exec(token);
  if (containerMatch) {
    const size = containerMatch[1];
    const rest = containerMatch[2] ? containerMatch[2].split('_') : [];
    if (rest.includes('door')) {
      return { family: `container-${size}`, role: 'part', part: 'door', colour: null, damaged: false, closed: false };
    }
    const colour = rest.find((segment) => COLOUR_WORDS.has(segment)) ?? null;
    return {
      family: `container-${size}`,
      role: 'body',
      part: null,
      colour,
      damaged: rest.includes('damage'),
      closed: rest.includes('close'),
    };
  }

  const wagonMatch = /^vagon_(.*)$/.exec(token);
  if (wagonMatch) {
    const segments = wagonMatch[1].split('_').filter((segment) => segment.length > 0);
    const colour = segments.find((segment) => COLOUR_WORDS.has(segment)) ?? null;
    const head = segments[0];
    if (head === 'tank') {
      return { family: 'tank-wagon', role: 'body', part: null, colour, damaged: false, closed: false };
    }
    if (head === 'hopper') {
      return { family: 'hopper-wagon', role: 'body', part: null, colour, damaged: false, closed: false };
    }
    if (head === 'shutted') {
      return { family: 'closed-freight-wagon', role: 'body', part: null, colour, damaged: false, closed: true };
    }
    if (head === 'gondola') {
      return { family: 'gondola-wagon', role: 'body', part: null, colour, damaged: false, closed: false };
    }
    if (head === 'movable') {
      // Vagon_movable_door_slide_0N is a leaf door; Vagon_movable_doors_* is the
      // door assembly. Neither is asserted to be a wagon body by this source.
      return {
        family: 'wagon-movable-door-assembly',
        role: 'part',
        part: segments.includes('slide') ? 'door-leaf' : 'door-assembly',
        colour,
        damaged: false,
        closed: false,
      };
    }
    return { family: `wagon-other:${head ?? ''}`, role: 'body', part: null, colour, damaged: false, closed: false };
  }

  return null;
}

/** Cheap pre-filter run against every streamed name before any parsing work. */
export function isCandidateName(name) {
  return /^(?:vagon_|container_(?:6m|12m))/i.test(stripInstanceSuffix(name));
}

/* ------------------------------------------------------------------ *
 * Root reduction and dedupe
 * ------------------------------------------------------------------ */

/**
 * A match is a placed root when no ancestor of it is also a match. That is what
 * collapses container_6m_door_01_L, Vagon_tank_LOD1 and friends into the one
 * object that was actually placed.
 */
export function selectPlacedRoots(matches, lookup, { maxDepth = DEFAULT_MAX_PARENT_DEPTH } = {}) {
  const matchKeys = new Set(matches.map((match) => match.key));
  const roots = [];
  const nested = [];
  for (const match of matches) {
    let cursor = lookup(match.key)?.parentKey ?? null;
    const seen = new Set([match.key]);
    let owner = null;
    let steps = 0;
    while (cursor !== null && cursor !== undefined && steps < maxDepth) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      if (matchKeys.has(cursor)) {
        owner = cursor;
        break;
      }
      cursor = lookup(cursor)?.parentKey ?? null;
      steps += 1;
    }
    if (owner === null) roots.push(match);
    else nested.push({ ...match, ownerKey: owner });
  }
  return { roots, nested };
}

function quantize(value, toleranceM) {
  return Math.round(value / toleranceM);
}

/**
 * Collapses the same physical object placed in more than one scene (a multiScene
 * copy and its background/LOD twin) into a single occupancy, keyed by body token
 * plus quantized world position.
 */
export function dedupePlacedRoots(rows, { toleranceM = DEFAULT_DEDUPE_TOLERANCE_M } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = [
      row.token,
      quantize(row.world.x, toleranceM),
      quantize(row.world.y, toleranceM),
      quantize(row.world.z, toleranceM),
    ].join('|');
    const existing = groups.get(key);
    if (existing) {
      existing.duplicates.push(row);
    } else {
      groups.set(key, { key, representative: row, duplicates: [] });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group.representative,
    duplicateCount: group.duplicates.length,
    scenes: [
      ...new Set([group.representative.sceneIndex, ...group.duplicates.map((d) => d.sceneIndex)]),
    ].sort((a, b) => a - b),
    names: [...new Set([group.representative.name, ...group.duplicates.map((d) => d.name)])],
  }));
}

export function summarizeCounts(rows) {
  const byToken = new Map();
  const byFamily = new Map();
  for (const row of rows) {
    byToken.set(row.token, (byToken.get(row.token) ?? 0) + 1);
    byFamily.set(row.family, (byFamily.get(row.family) ?? 0) + 1);
  }
  return {
    total: rows.length,
    byToken: [...byToken.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    byFamily: [...byFamily.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/**
 * Explains WHY the colour question is or is not decidable, by attributing every
 * colourless container root to the authored group it came from. If they all sit
 * under one non-container group, that is a fact worth reading, not a shrug.
 */
export function analyseColourDecidability(rows) {
  const containers = rows.filter((row) => row.role === 'body' && row.family.startsWith('container-'));
  const colourless = containers.filter((row) => row.colour === null);
  const byRoot = new Map();
  const byGroup = new Map();
  for (const row of colourless) {
    const root = hierarchyRootOf(row.hierarchyPath);
    byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
    const path = String(row.hierarchyPath ?? '');
    const group = path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '(scene root)';
    byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
  }
  return {
    containerRoots: containers.length,
    withColourToken: containers.length - colourless.length,
    withoutColourToken: colourless.length,
    colourlessByHierarchyRoot: [...byRoot.entries()].sort((a, b) => b[1] - a[1]),
    colourlessByGroup: [...byGroup.entries()].sort((a, b) => b[1] - a[1]),
    colourlessScenes: [...new Set(colourless.map((row) => row.sceneIndex))].sort((a, b) => a - b),
  };
}

/**
 * Scores the handoff's 3 closed / 2 tank / 1 hopper / 2 red-6m claim. Colour is
 * only decidable for containers whose name carries a colour token; any
 * colourless 6 m container in scope forces 'cannot-address' rather than a guess.
 */
export function evaluateHandoffClaim(rows, claim = HANDOFF_CLAIM) {
  const bodies = rows.filter((row) => row.role === 'body');
  const countFamily = (family) => bodies.filter((row) => row.family === family).length;

  const containers6m = bodies.filter((row) => row.family === 'container-6m');
  const red6m = containers6m.filter((row) => row.colour === 'red');
  const colourless6m = containers6m.filter((row) => row.colour === null);

  const items = [
    ['closed-freight-wagon', countFamily('closed-freight-wagon'), null],
    ['tank-wagon', countFamily('tank-wagon'), null],
    ['hopper-wagon', countFamily('hopper-wagon'), null],
  ].map(([family, observed]) => ({
    item: family,
    claimed: claim[family],
    observed,
    decidable: true,
    status: observed === claim[family] ? 'supports' : 'contradicts',
  }));

  items.push({
    item: 'container-6m-red',
    claimed: claim['container-6m-red'],
    observed: red6m.length,
    observedTotal6m: containers6m.length,
    colourlessInScope: colourless6m.length,
    decidable: colourless6m.length === 0,
    status:
      colourless6m.length > 0
        ? 'cannot-address'
        : red6m.length === claim['container-6m-red']
          ? 'supports'
          : 'contradicts',
    note:
      colourless6m.length > 0
        ? `${colourless6m.length} in-scope 6 m container root(s) carry no colour token; colour lives in the material, which this source does not have.`
        : 'every in-scope 6 m container root carries a colour token in its name.',
  });

  const verdicts = items.map((item) => item.status);
  return {
    items,
    overall: verdicts.includes('contradicts')
      ? 'contradicts'
      : verdicts.includes('cannot-address')
        ? 'partly-supports-partly-undecidable'
        : 'supports',
  };
}

/* ------------------------------------------------------------------ *
 * Consist grouping
 * ------------------------------------------------------------------ */

/**
 * Buckets rail bodies by the authored group that owns them (the hierarchy path
 * minus the leaf). A claim about "a consist" is a claim about one of these
 * buckets, not about the whole scope box.
 */
export function groupByHierarchyParent(rows) {
  const groups = new Map();
  for (const row of rows) {
    const path = String(row.hierarchyPath ?? '');
    const parent = path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '(scene root)';
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(row);
  }
  return [...groups.entries()]
    .map(([group, members]) => ({
      group,
      count: members.length,
      families: summarizeCounts(members).byFamily,
      members,
    }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}

export function hierarchyRootOf(hierarchyPath) {
  const path = String(hierarchyPath ?? '');
  const cut = path.indexOf('/');
  return cut < 0 ? path : path.slice(0, cut);
}

/* ------------------------------------------------------------------ *
 * Frame verification against an independent in-repo artefact
 * ------------------------------------------------------------------ */

/**
 * Nearest-neighbour match between composed world positions and the repository's
 * hand-traced prop table (data/customs-props.json), which was traced from a
 * satellite render and never derived from this dump. Agreement with NO transform
 * applied is the evidence that both are expressed in the same frame.
 */
export function crossCheckAgainstTracedProps(rows, tracedProps, { toleranceM = 3 } = {}) {
  const pairs = [];
  for (const traced of tracedProps) {
    let best = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      const distance = Math.hypot(row.world.x - traced.x, row.world.z - traced.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = row;
      }
    }
    pairs.push({
      tracedName: traced.name,
      traced: { x: traced.x, z: traced.z },
      composedName: best?.name ?? null,
      composed: best ? { x: best.world.x, z: best.world.z } : null,
      distanceM: bestDistance,
      matched: bestDistance <= toleranceM,
    });
  }
  const residuals = pairs.filter((pair) => pair.matched).map((pair) => pair.distanceM).sort((a, b) => a - b);
  return {
    toleranceM,
    tracedCount: tracedProps.length,
    matched: residuals.length,
    medianResidualM: residuals.length ? residuals[residuals.length >> 1] : null,
    maxResidualM: residuals.length ? residuals[residuals.length - 1] : null,
    pairs,
  };
}

/* ------------------------------------------------------------------ *
 * Frame resolution
 * ------------------------------------------------------------------ */

/**
 * Decides, from the data rather than from belief, which frame the scope box is
 * written in: the reading that actually puts rail bodies inside the box wins.
 */
export function resolveWorkingFrame(candidates, scope) {
  let sourceHits = 0;
  let runtimeHits = 0;
  for (const row of candidates) {
    if (isWithinScopeXZ(row.world, scope)) sourceHits += 1;
    if (isWithinScopeRuntimeXY(row.runtime, scope)) runtimeHits += 1;
  }
  return {
    sourceFrame: SOURCE_FRAME,
    runtimeFrame: RUNTIME_FRAME,
    runtimeFromSource: RUNTIME_FROM_SOURCE,
    sourceHits,
    runtimeHits,
    chosen: sourceHits >= runtimeHits ? 'source' : 'runtime',
  };
}

/* ------------------------------------------------------------------ *
 * Facts store
 * ------------------------------------------------------------------ */

function nodeKey(asset, pathId) {
  return `${asset}:${pathId}`;
}

class FactsStore {
  constructor() {
    this.capacity = 1024;
    this.size = 0;
    this.parentPathId = new Float64Array(this.capacity);
    this.active = new Uint8Array(this.capacity);
    this.trs = new Float64Array(this.capacity * 10);
    this.assetIndex = new Map();
    this.assetNames = [];
    this.byAsset = [];
  }

  #grow() {
    const capacity = this.capacity * 2;
    const parentPathId = new Float64Array(capacity);
    parentPathId.set(this.parentPathId);
    const active = new Uint8Array(capacity);
    active.set(this.active);
    const trs = new Float64Array(capacity * 10);
    trs.set(this.trs);
    this.capacity = capacity;
    this.parentPathId = parentPathId;
    this.active = active;
    this.trs = trs;
  }

  assetSlot(asset) {
    let index = this.assetIndex.get(asset);
    if (index === undefined) {
      index = this.assetNames.length;
      this.assetIndex.set(asset, index);
      this.assetNames.push(asset);
      this.byAsset.push(new Map());
    }
    return index;
  }

  add(record) {
    if (this.size === this.capacity) this.#grow();
    const index = this.size;
    this.size += 1;
    const slot = this.assetSlot(record.asset);
    this.byAsset[slot].set(record.pathId, index);
    this.parentPathId[index] = record.parentGameObjectPathId ?? 0;
    this.active[index] = record.active === false ? 0 : 1;
    const t = record.transform ?? {};
    const p = t.localPosition ?? {};
    const q = t.localRotation ?? {};
    const s = t.localScale ?? {};
    const base = index * 10;
    this.trs[base] = numberOr(p.x, 0);
    this.trs[base + 1] = numberOr(p.y, 0);
    this.trs[base + 2] = numberOr(p.z, 0);
    this.trs[base + 3] = numberOr(q.x, 0);
    this.trs[base + 4] = numberOr(q.y, 0);
    this.trs[base + 5] = numberOr(q.z, 0);
    this.trs[base + 6] = numberOr(q.w, 1);
    this.trs[base + 7] = numberOr(s.x, 1);
    this.trs[base + 8] = numberOr(s.y, 1);
    this.trs[base + 9] = numberOr(s.z, 1);
    return index;
  }

  lookup(key) {
    const split = key.lastIndexOf(':');
    if (split < 0) return null;
    const asset = key.slice(0, split);
    const pathId = Number(key.slice(split + 1));
    const slot = this.assetIndex.get(asset);
    if (slot === undefined) return null;
    const index = this.byAsset[slot].get(pathId);
    if (index === undefined) return null;
    const base = index * 10;
    const parent = this.parentPathId[index];
    return {
      parentKey: parent ? nodeKey(asset, parent) : null,
      active: this.active[index] === 1,
      transform: {
        localPosition: { x: this.trs[base], y: this.trs[base + 1], z: this.trs[base + 2] },
        localRotation: {
          x: this.trs[base + 3],
          y: this.trs[base + 4],
          z: this.trs[base + 5],
          w: this.trs[base + 6],
        },
        localScale: { x: this.trs[base + 7], y: this.trs[base + 8], z: this.trs[base + 9] },
      },
    };
  }
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

export async function runSecondSource({
  factsPath = DEFAULT_FACTS_PATH,
  scope = RAIL_YARD_SCOPE,
  maxDepth = DEFAULT_MAX_PARENT_DEPTH,
  dedupeToleranceM = DEFAULT_DEDUPE_TOLERANCE_M,
  highWaterMark = 1 << 24,
  excludeHierarchyRoots = [],
  tracedPropsPath = TRACED_PROPS_PATH,
  onProgress = null,
} = {}) {
  const store = new FactsStore();
  const matches = [];
  const scanner = createGameObjectScanner({ arrayKey: 'gameObjects' });

  const stream = createReadStream(factsPath, { encoding: 'utf8', highWaterMark });
  let parsed = 0;
  for await (const chunk of stream) {
    for (const raw of scanner.push(chunk)) {
      const record = JSON.parse(raw);
      store.add(record);
      parsed += 1;
      if (typeof record.name === 'string' && isCandidateName(record.name)) {
        const token = bodyTokenFromName(record.name);
        const classification = classifyBodyToken(token);
        if (classification) {
          matches.push({
            key: nodeKey(record.asset, record.pathId),
            name: record.name,
            token,
            family: classification.family,
            role: classification.role,
            part: classification.part,
            colour: classification.colour,
            damaged: classification.damaged,
            closed: classification.closed,
            technicalSuffix: hasTechnicalSuffix(record.name),
            asset: record.asset,
            sceneIndex: record.sceneIndex,
            scenePath: record.scenePath,
            hierarchyPath: record.hierarchyPath,
            hierarchyComplete: record.hierarchyComplete !== false,
            declaredActive: record.active !== false,
          });
        }
      }
    }
    if (onProgress && parsed > 0) onProgress(parsed);
    if (scanner.finished) break;
  }
  stream.destroy();
  scanner.end();

  const lookup = (key) => store.lookup(key);
  const { roots, nested } = selectPlacedRoots(matches, lookup, { maxDepth });

  const resolved = [];
  const unresolved = [];
  for (const root of roots) {
    const world = resolveWorldTransform(lookup, root.key, { maxDepth });
    if (world.status !== 'ok') {
      unresolved.push({ ...root, resolveStatus: world.status });
      continue;
    }
    resolved.push({
      ...root,
      world: world.position,
      runtime: sourceToRuntime(world.position),
      chainDepth: world.depth,
      activeInHierarchy: world.activeInHierarchy,
    });
  }

  const frame = resolveWorkingFrame(resolved, scope);
  const excluded = new Set(excludeHierarchyRoots);
  const kept = excluded.size === 0
    ? resolved
    : resolved.filter((row) => !excluded.has(hierarchyRootOf(row.hierarchyPath)));
  const inScopeAll = kept.filter((row) => isWithinScopeXZ(row.world, scope));
  const inScopeActive = inScopeAll.filter((row) => row.activeInHierarchy);
  const deduped = dedupePlacedRoots(inScopeActive, { toleranceM: dedupeToleranceM });
  const railBodies = deduped.filter((row) => row.role === 'body' && row.family.endsWith('-wagon'));

  let frameCrossCheck = null;
  try {
    const traced = JSON.parse(await readFile(tracedPropsPath, 'utf8'));
    const rail = (traced.props ?? []).filter(
      (prop) => prop.type === 'railcar'
        || prop.type === 'tanker'
        || /rail|locomotive|wagon/i.test(prop.name ?? ''),
    );
    const allRailBodies = resolved.filter((row) => row.role === 'body' && row.family.endsWith('-wagon'));
    frameCrossCheck = crossCheckAgainstTracedProps(allRailBodies, rail, { toleranceM: 3 });
    frameCrossCheck.tracedPropsPath = tracedPropsPath;
  } catch (error) {
    frameCrossCheck = { unavailable: String(error?.message ?? error), tracedPropsPath };
  }

  return {
    factsPath,
    scope,
    scopeBounds: scopeBounds(scope),
    frame,
    frameCrossCheck,
    excludeHierarchyRoots: [...excluded],
    consists: groupByHierarchyParent(railBodies),
    colourDecidability: analyseColourDecidability(deduped),
    totals: {
      gameObjectsStreamed: store.size,
      nameMatches: matches.length,
      nestedUnderAnotherMatch: nested.length,
      placedRoots: roots.length,
      placedRootsResolved: resolved.length,
      placedRootsUnresolved: unresolved.length,
      rootsInScope: inScopeAll.length,
      rootsInScopeActive: inScopeActive.length,
      rootsInScopeAfterDedupe: deduped.length,
      orphanTechnicalRoots: roots.filter((row) => row.technicalSuffix).length,
    },
    unresolved,
    orphanTechnicalRoots: roots.filter((row) => row.technicalSuffix),
    summaryAllRoots: summarizeCounts(resolved),
    summaryInScope: summarizeCounts(deduped),
    rows: deduped.sort((a, b) => a.token.localeCompare(b.token) || a.world.x - b.world.x),
    outOfScope: resolved.filter((row) => !isWithinScopeXZ(row.world, scope)),
    verdict: evaluateHandoffClaim(deduped),
    capabilities: CAPABILITY_STATEMENT,
  };
}

function fixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value);
}

export function formatReport(result) {
  const lines = [];
  const push = (line = '') => lines.push(line);

  push('CUSTOMS INDUSTRIAL — INDEPENDENT SECOND SOURCE (Unity facts dump, scalar-only)');
  push(`facts: ${result.factsPath}`);
  push();
  push('FRAME');
  push(`  source frame declared by scene-manifest : ${result.frame.sourceFrame}`);
  push(`  runtime frame                            : ${result.frame.runtimeFrame}`);
  push(`  runtimeFromSource                        : ${result.frame.runtimeFromSource}`);
  push(`  rail bodies inside box read as SOURCE x/z : ${result.frame.sourceHits}`);
  push(`  rail bodies inside box read as RUNTIME x/y: ${result.frame.runtimeHits}`);
  push(`  working frame chosen                      : ${result.frame.chosen}`);
  const cross = result.frameCrossCheck;
  if (cross && !cross.unavailable) {
    push('  independent check vs hand-traced data/customs-props.json (no transform applied):');
    push(
      `    ${cross.matched}/${cross.tracedCount} traced rail props matched a composed rail body within `
      + `${cross.toleranceM} m; median residual ${fixed(cross.medianResidualM)} m, max ${fixed(cross.maxResidualM)} m`,
    );
  } else if (cross) {
    push(`  independent check unavailable: ${cross.unavailable}`);
  }
  push();
  push('SCOPE');
  push(
    `  ${result.scope.id}: centre (x=${result.scope.center.x}, z=${result.scope.center.z}), `
    + `${result.scope.widthM} m x ${result.scope.depthM} m`,
  );
  const b = result.scopeBounds;
  push(`  bounds: x [${b.minX}, ${b.maxX}]  z [${b.minZ}, ${b.maxZ}]`);
  push();
  push('TOTALS');
  for (const [key, value] of Object.entries(result.totals)) {
    push(`  ${key.padEnd(28)} ${value}`);
  }
  push();
  push('IN-SCOPE ROOTS BY NAME TOKEN (deduped)');
  for (const [token, count] of result.summaryInScope.byToken) {
    push(`  ${String(count).padStart(4)}  ${token}`);
  }
  push();
  push('IN-SCOPE ROOTS BY BODY FAMILY (deduped)');
  for (const [family, count] of result.summaryInScope.byFamily) {
    push(`  ${String(count).padStart(4)}  ${family}`);
  }
  push();
  push('IN-SCOPE ROOTS — COMPOSED WORLD POSITIONS');
  for (const row of result.rows) {
    push(
      `  ${row.name.padEnd(30)} token=${row.token.padEnd(28)} family=${row.family.padEnd(28)}`
      + ` world=(${fixed(row.world.x)}, ${fixed(row.world.y)}, ${fixed(row.world.z)})`
      + ` scenes=[${row.scenes.join(',')}] dup=${row.duplicateCount}`,
    );
    push(`      path: ${row.hierarchyPath}`);
  }
  push();
  push('RAIL BODIES GROUPED BY AUTHORED GROUP (a "consist" is one of these, not the whole box)');
  for (const consist of result.consists) {
    push(`  ${String(consist.count).padStart(3)}  ${consist.group}`);
    push(`       ${consist.families.map(([family, count]) => `${count} ${family}`).join(', ')}`);
  }
  push();
  push('COLOUR DECIDABILITY (name tokens only — this source has no materials)');
  const colour = result.colourDecidability;
  push(`  container roots in scope        : ${colour.containerRoots}`);
  push(`  carrying a colour token in name: ${colour.withColourToken}`);
  push(`  carrying no colour token       : ${colour.withoutColourToken}`);
  for (const [group, count] of colour.colourlessByGroup) {
    push(`      ${String(count).padStart(3)} colourless under ${group}`);
  }
  push();
  push('VERDICT ON THE HANDOFF CLAIM (3 closed / 2 tank / 1 hopper / 2 red 6 m containers)');
  for (const item of result.verdict.items) {
    push(
      `  ${item.item.padEnd(24)} claimed=${item.claimed}  observed=${item.observed}  ${item.status}`,
    );
    if (item.note) push(`      ${item.note}`);
  }
  push(`  OVERALL: ${result.verdict.overall}`);
  push();
  push('WHAT THIS SOURCE CAN ESTABLISH');
  for (const line of result.capabilities.can) push(`  + ${line}`);
  push('WHAT THIS SOURCE CANNOT ESTABLISH');
  for (const line of result.capabilities.cannot) push(`  - ${line}`);

  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--facts') options.factsPath = argv[i + 1];
    else if (arg === '--json') options.json = true;
    else if (arg === '--all-roots') options.allRoots = true;
    else if (arg === '--exclude-hierarchy-root') {
      options.excludeHierarchyRoots = [...(options.excludeHierarchyRoots ?? []), argv[i + 1]];
    }
  }
  return options;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runSecondSource({
    factsPath: options.factsPath ?? DEFAULT_FACTS_PATH,
    excludeHierarchyRoots: options.excludeHierarchyRoots ?? [],
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
    if (options.allRoots) {
      process.stdout.write('\nALL PLACED ROOTS (any position)\n');
      for (const [token, count] of result.summaryAllRoots.byToken) {
        process.stdout.write(`  ${String(count).padStart(4)}  ${token}\n`);
      }
    }
  }
}
