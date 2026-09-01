#!/usr/bin/env node

/**
 * ============================================================================
 * READ THIS BEFORE YOU READ ANY NUMBER THIS SCRIPT PRINTS
 * ============================================================================
 *
 * THIS IS NOT AN INDEPENDENT SOURCE. It shares an acquisition layer with the
 * primary industrial-roots extractor. The only input it has ever been run
 * against — the scalar-only Unity facts dump — was itself produced by
 * scripts/extract-customs-unity.py, and that same script is the selector the
 * primary extractor imports (extract-customs-industrial-roots.py imports
 * census-customs-assets.py, which imports extract-customs-unity.py). Anything
 * the selector dropped is invisible to BOTH instruments in exactly the same
 * way. AGREEMENT BETWEEN THE TWO IS THEREFORE NOT VALIDATION. It is one
 * acquisition read twice.
 *
 * What this script IS: a differently-reasoned reading of that one dump. It
 * parses names and composes transforms on its own terms, so it can disagree
 * with the extractor about *interpretation*. It cannot disagree about
 * *acquisition*, and it cannot confirm the extractor.
 *
 * WHAT THE OUTPUT IS: a CONSERVATIVE CANDIDATE ROSTER — a retrieval and
 * coordinate-correlation aid for a later survey raid, not the truth about the
 * Customs rail yard. Every count below is "how many GameObjects carrying this
 * NAME resolved to a world position inside this box", never "how many wagons
 * are in the yard". An explicit name proves a LABEL is separable; it does not
 * prove a matching GameObject is a placed, visible wagon rather than a child,
 * a collider, an LOD node, or an inactive placeholder. Confirmation has to come
 * from outside this repository — geo-tagged in-game photographs, whose
 * filenames carry world position and camera quaternion.
 *
 * ----------------------------------------------------------------------------
 *
 * What the dump carries: names, hierarchyPath, parentGameObjectPathId, active,
 * localPosition / localRotation / localScale, sceneIndex, scenePath, asset.
 * What it does NOT carry: renderers, meshes, materials, textures, colours,
 * bounds. Every colour statement below rests on a NAME token, never on a
 * material — see CAPABILITY_STATEMENT.
 *
 * Coordinate frame (see resolveWorkingFrame): world positions are composed in
 * the dump's own frame, which is Unity world metres, Y up. The scene manifest
 * calls that frame 'eft-unity-world-metres-y-up' and the rail-yard scope box is
 * expressed in the same frame (ground plane X/Z, centre {x, z}, widthM/depthM).
 * The frame strings and the scope box below are READ FROM the manifest at run
 * time and the literals are asserted against it (ERR_SECOND_SOURCE_MANIFEST_DRIFT);
 * they are not a hand-copied snapshot. The runtime frame 'three-z-up-metres' is
 * reachable by runtimeFromSource [-x, -z, y]; the script computes it too and
 * reports scope containment under BOTH readings so the frame choice is
 * evidence, not an assumption.
 */

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');

/**
 * The local scalar-only dump. It is an existing local artefact, never the game
 * install. Override with --facts.
 */
export const DEFAULT_FACTS_PATH = resolve(
  REPOSITORY_ROOT,
  '.local-game-derived/unity-facts/customs-unity-facts.json',
);
export const SCENE_MANIFEST_PATH = resolve(
  REPOSITORY_ROOT,
  'public/assets/3d/customs/scene-manifest.json',
);
/** Hand-traced from a satellite render; never derived from the facts dump. */
export const TRACED_PROPS_PATH = resolve(REPOSITORY_ROOT, 'data/customs-props.json');

/**
 * Printed before every number this script emits, and carried in the JSON
 * result. Anyone reading a count must meet this sentence first.
 */
export const PROVENANCE_STATEMENT = Object.freeze([
  'NOT AN INDEPENDENT SOURCE. This reading shares an acquisition layer with the primary',
  'industrial-roots extractor: its input dump was produced by scripts/extract-customs-unity.py,',
  'the same selector that extractor imports (via census-customs-assets.py). Agreement between',
  'the two is NOT independent validation — it is one acquisition read twice.',
  '',
  'OUTPUT IS A CONSERVATIVE CANDIDATE ROSTER, not the truth about the Customs rail yard.',
  'Each count is "GameObjects carrying this NAME that resolved inside this box", never',
  '"wagons in the yard". A name proves a LABEL is separable; it does not prove the object is a',
  'placed, visible wagon rather than a child, collider, LOD node, or inactive placeholder.',
  'Confirmation must come from outside this repository — geo-tagged in-game photographs.',
]);

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
/** Two roots closer than this are reported as a suspected duplicate placement. */
export const DEFAULT_DUPLICATE_TOLERANCE_M = 0.5;

/**
 * Hierarchy roots excluded by DEFAULT, each with the reason and the falsifier.
 * Nothing is filtered silently: every exclusion is reported with its own count
 * and can be re-admitted from the CLI with --include-hierarchy-root.
 */
export const DEFAULT_EXCLUSIONS = Object.freeze([
  Object.freeze({
    hierarchyRoot: 'NewYear_Event',
    reason:
      'Seasonal garland-anchor subtree. Its container_6m nodes are decoration anchors placed ON existing '
      + 'containers (measured against this dump 2026-09-01: of the 50 in-scope garland roots, 47 sit within '
      + '1e-6 m of a non-garland container root and all 50 within 0.40 m), so counting them double-counts the '
      + 'same physical box and manufactures colourless containers that make the colour question undecidable.',
    falsifier:
      'If an in-scope NewYear_Event root is ever measured further than the duplicate tolerance from every '
      + 'non-NewYear_Event root, this exclusion is wrong for that object and must be reconsidered.',
  }),
]);

export const CAPABILITY_STATEMENT = Object.freeze({
  can: Object.freeze([
    'Enumerate every GameObject whose NAME declares a rail-body, locomotive, bogie or shipping-container type.',
    'Compose a world position for each from the local TRS chain through parentGameObjectPathId.',
    'Decide scope membership against the rail-yard box on the X/Z ground plane.',
    'Reduce nested LOD / collider / shadow / ballistic / door children to the placed root that owns them.',
    'Flag roots that sit at the same world position as another root, whatever their names.',
    'Report a per-name-token census with positions, scenes and hierarchy paths.',
    'Report a colour token WHEN the author put one in the name (…_Red_close, …_green).',
    'Report which authored group owns each body, so a claim about "a consist" can be aimed at one group.',
  ]),
  cannot: Object.freeze([
    'Validate the primary extractor. Both instruments read one dump produced by one selector; agreement between them carries no independent evidence.',
    'Establish that a named GameObject is a placed, visible wagon rather than a child, collider, LOD node, or inactive placeholder — beyond the boolean active flag it carries.',
    'Establish colour, material, texture or paint for any object whose name lacks a colour token — the dump has no renderer, mesh or material fields at all.',
    'Confirm that a name-borne colour token matches the material actually assigned in the scene.',
    'Measure any object dimension: no bounds, no mesh, so "6 m" is read from the name token container_6m, never from geometry.',
    'Say anything about objects the dump omitted; it is an inventory of what the selector extracted, not proof of what exists.',
    'Settle any count. Every number here is a candidate to be confirmed against geo-tagged in-game photographs.',
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
 * Scene manifest — the frame strings and the scope box are READ, not copied
 * ------------------------------------------------------------------ */

/**
 * The literals this module exports, in the shape the manifest stores them.
 * Kept as one object so the drift check compares a whole contract, never a
 * hand-picked subset.
 */
export function declaredContract() {
  return {
    frames: {
      source: SOURCE_FRAME,
      runtime: RUNTIME_FRAME,
      runtimeFromSource: RUNTIME_FROM_SOURCE,
    },
    scope: {
      id: RAIL_YARD_SCOPE.id,
      center: { x: RAIL_YARD_SCOPE.center.x, z: RAIL_YARD_SCOPE.center.z },
      widthM: RAIL_YARD_SCOPE.widthM,
      depthM: RAIL_YARD_SCOPE.depthM,
    },
  };
}

/** Pulls just the frame + scope contract out of a parsed scene manifest. */
export function contractFromManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    fail('ERR_SECOND_SOURCE_MANIFEST_SHAPE', 'scene manifest is not an object');
  }
  const frames = manifest.frames;
  const scope = manifest.scope;
  if (!frames || typeof frames !== 'object') {
    fail('ERR_SECOND_SOURCE_MANIFEST_SHAPE', 'scene manifest has no "frames" object');
  }
  if (!scope || typeof scope !== 'object' || !scope.center || typeof scope.center !== 'object') {
    fail('ERR_SECOND_SOURCE_MANIFEST_SHAPE', 'scene manifest has no "scope" object with a "center"');
  }
  return {
    frames: {
      source: frames.source,
      runtime: frames.runtime,
      runtimeFromSource: frames.runtimeFromSource,
    },
    scope: {
      id: scope.id,
      center: { x: scope.center.x, z: scope.center.z },
      widthM: scope.widthM,
      depthM: scope.depthM,
    },
  };
}

/**
 * Compares the module literals against the manifest field by field and THROWS
 * on any disagreement. A silently stale snapshot is exactly the failure this
 * replaces, so there is no tolerant mode: drift is a stop, not a warning.
 */
export function assertManifestAgreement(manifestContract, declared = declaredContract()) {
  const disagreements = [];
  const compare = (path, mine, theirs) => {
    if (mine !== theirs) {
      disagreements.push(`${path}: script literal ${JSON.stringify(mine)} != manifest ${JSON.stringify(theirs)}`);
    }
  };
  compare('frames.source', declared.frames.source, manifestContract.frames.source);
  compare('frames.runtime', declared.frames.runtime, manifestContract.frames.runtime);
  compare('frames.runtimeFromSource', declared.frames.runtimeFromSource, manifestContract.frames.runtimeFromSource);
  compare('scope.id', declared.scope.id, manifestContract.scope.id);
  compare('scope.center.x', declared.scope.center.x, manifestContract.scope.center.x);
  compare('scope.center.z', declared.scope.center.z, manifestContract.scope.center.z);
  compare('scope.widthM', declared.scope.widthM, manifestContract.scope.widthM);
  compare('scope.depthM', declared.scope.depthM, manifestContract.scope.depthM);

  if (disagreements.length > 0) {
    fail(
      'ERR_SECOND_SOURCE_MANIFEST_DRIFT',
      `scene manifest disagrees with this script's frame/scope literals:\n  - ${disagreements.join('\n  - ')}`,
    );
  }
  return { agrees: true, checked: 8, contract: manifestContract };
}

/** Reads the manifest from disk. An unreadable manifest is a hard failure. */
export async function loadSceneManifestContract(path = SCENE_MANIFEST_PATH) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    fail(
      'ERR_SECOND_SOURCE_MANIFEST_UNREADABLE',
      `cannot read the scene manifest at ${path}: ${error?.message ?? error}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('ERR_SECOND_SOURCE_MANIFEST_UNREADABLE', `scene manifest at ${path} is not JSON: ${error?.message ?? error}`);
  }
  return contractFromManifest(parsed);
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
 * Name lexicon — derived from the dump's own name space, not guessed
 * ------------------------------------------------------------------ */

/**
 * Every rolling-stock / container name family the dump actually contains, with
 * the census that put it here. Re-derive with:
 *   grep -oP '"name": "\K[^"]*' <dump> | sort -u
 *
 * Recorded from .local-game-derived/unity-facts/customs-unity-facts.json
 * (481,126 GameObjects, 43,555 distinct names) on 2026-09-01. The counts are
 * raw name occurrences across all scenes, before any root reduction.
 */
export const NAME_SPACE_CENSUS = Object.freeze([
  Object.freeze({ prefix: 'Vagon_tank', role: 'body', note: 'plus _green, _red colour variants' }),
  Object.freeze({ prefix: 'Vagon_hopper', role: 'body', note: 'plus _black' }),
  Object.freeze({ prefix: 'Vagon_shutted_closed', role: 'body', note: 'the closed freight wagon' }),
  Object.freeze({ prefix: 'Vagon_gondola_small', role: 'body', note: 'plus _green; a family the handoff claim never listed' }),
  Object.freeze({ prefix: 'Vagon_gondola_large', role: 'body', note: 'plus _black_02; a family the handoff claim never listed' }),
  Object.freeze({
    prefix: 'Vagon_movable_doors_<colour>',
    role: 'body',
    note:
      'sliding-door boxcar. Owns two Train_wheels bogie sets AND a body mesh (Vagon_movable_door_LOD0 / '
      + '_COLLIDER / _SHADOW_LOD0 / _BALLISTIC_*), so it is a placed wagon, not a door part. Only '
      + 'Vagon_movable_doors_grey exists in this dump.',
  }),
  Object.freeze({ prefix: 'Vagon_movable_door', role: 'part', note: 'singular: the boxcar body/door mesh + its LOD/collider/shadow/ballistic siblings' }),
  Object.freeze({ prefix: 'Vagon_movable_door_slide_0N', role: 'part', note: 'one sliding door leaf' }),
  Object.freeze({
    prefix: 'Locomotive',
    role: 'body',
    note:
      'MISSED ENTIRELY by the pre-repair lexicon. 8 placed roots in the dump, 2 of them inside the scope '
      + 'box; data/customs-prop-features.json lists locomotive_west and locomotive_east as rail-yard features.',
  }),
  Object.freeze({
    prefix: 'Train_wheels',
    role: 'part',
    note:
      'bogie set. Admitted as a PART so that a Train_wheels root with no rail-body ancestor becomes a visible '
      + 'diagnostic: it would mean a bogied vehicle whose body name the lexicon does not know.',
  }),
  Object.freeze({ prefix: 'container_6m', role: 'body', note: 'plus damage/colour/close variants and door_0N_[LR] parts' }),
  Object.freeze({ prefix: 'container_12m', role: 'body', note: 'plus damage/colour/close variants and door_0N_[LR] parts' }),
]);

/**
 * Names in the dump that LOOK like the lexicon but are authored group nodes,
 * not objects: 'vagon_01_indoor Group', 'vagon_02_indoor Group',
 * 'vagon_03_indoor Group', 'platforma_stuff Group'. Unity's authoring
 * convention gives an organisational empty a trailing ' Group'. The pre-repair
 * filter admitted the three vagon_* ones and classified each as a wagon body.
 */
const AUTHORED_GROUP_SUFFIX = /\sgroup$/i;

const INSTANCE_SUFFIX = /\s*\((\d+)\)\s*$/;
/**
 * Trailing renderer / collider / shadow / ballistic decorations.
 *
 * `_col` is in the list because it is this dump's OTHER collider convention
 * (25 distinct names use it: railway_rail_final_col, garage_01_col,
 * Kabina_door_L_col, balistic_col …). Measured 2026-09-01: no name inside the
 * current lexicon ends in `_col`, so adding it changes zero rows on this dump.
 * It is a guard against a latent defect, not a live correction — the previous
 * regex would have classified `Vagon_tank_01_col` as a body, and stripping is
 * iterative so `…_LOD0_col` now reduces correctly too.
 */
const TECHNICAL_SUFFIX =
  /_(?:LOD\d+|COLLIDER|COL|SHADOW_LOD\d+|SHADOW|BALLISTIC_[A-Za-z]+|decal_LOD\d+|decal)$/i;
const COLOUR_WORDS = new Set([
  'red', 'green', 'blue', 'darkblue', 'yellow', 'orange', 'black', 'grey', 'gray', 'white', 'brown',
]);

/** Strips Unity's " (3)" duplicate marker. */
export function stripInstanceSuffix(name) {
  return String(name).replace(INSTANCE_SUFFIX, '').trim();
}

/**
 * Reduces an authored name to its stable body token: duplicate marker off,
 * then every trailing renderer/collider/shadow/ballistic decoration off,
 * repeatedly (names stack them: reciever_1_LOD0_SHADOW_LOD0).
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

/** Families whose members are rail rolling stock (as opposed to containers). */
export const RAIL_BODY_FAMILIES = Object.freeze(new Set([
  'tank-wagon',
  'hopper-wagon',
  'closed-freight-wagon',
  'gondola-wagon',
  'sliding-door-boxcar',
  'locomotive',
]));

export function isRailBodyFamily(family) {
  return RAIL_BODY_FAMILIES.has(family) || String(family).startsWith('rolling-stock-unrecognised:');
}

/**
 * Classifies a body token from the token alone. Returns null for anything that
 * is not rail rolling stock or a shipping container. `role` is 'body' for a
 * placeable body and 'part' for a named sub-assembly (doors, bogies).
 */
export function classifyBodyToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  if (AUTHORED_GROUP_SUFFIX.test(token)) return null;

  if (/^train_wheels$/.test(token)) {
    return { family: 'bogie', role: 'part', part: 'bogie', colour: null, damaged: false, closed: false };
  }

  if (/^locomotive$/.test(token)) {
    return { family: 'locomotive', role: 'body', part: null, colour: null, damaged: false, closed: false };
  }

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
      // 'Vagon_movable_doorS_<colour>' (plural) is the placed boxcar: it owns two
      // Train_wheels bogie sets and a body mesh. 'Vagon_movable_door…' (singular)
      // is that boxcar's own mesh/collider/shadow naming, and
      // 'Vagon_movable_door_slide_0N' is one sliding leaf. Only the plural is a body.
      if (segments[1] === 'doors') {
        return {
          family: 'sliding-door-boxcar',
          role: 'body',
          part: null,
          colour,
          damaged: false,
          closed: false,
        };
      }
      return {
        family: 'wagon-movable-door-assembly',
        role: 'part',
        part: segments.includes('slide') ? 'door-leaf' : 'door-assembly',
        colour,
        damaged: false,
        closed: false,
      };
    }
    // An unrecognised vagon_* head. Surfaced as a body so it cannot be lost, but
    // named so the report can flag it as a name the lexicon does not know.
    return {
      family: `rolling-stock-unrecognised:${head ?? ''}`,
      role: 'body',
      part: null,
      colour,
      damaged: false,
      closed: false,
      unrecognised: true,
    };
  }

  return null;
}

/**
 * Cheap pre-filter run against every streamed name before any parsing work.
 * Widened past the original /^(?:vagon_|container_(?:6m|12m))/i, which could
 * not see a single locomotive or bogie.
 */
const CANDIDATE_PREFIX = /^(?:vagon_|locomotive|container_(?:6m|12m)|train_wheels)/i;

export function isCandidateName(name) {
  const base = stripInstanceSuffix(name);
  if (AUTHORED_GROUP_SUFFIX.test(base)) return false;
  return CANDIDATE_PREFIX.test(base);
}

/* ------------------------------------------------------------------ *
 * Root reduction, dedupe and duplicate detection
 * ------------------------------------------------------------------ */

/**
 * A match is a placed root when no ancestor of it is also a match. That is what
 * collapses container_6m_door_01_L, Vagon_tank_LOD1, Train_wheels and friends
 * into the one object that was actually placed.
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

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Groups rows by a key function and true metric distance to the group
 * representative. The previous implementation quantized each axis into bins,
 * which splits a genuine pair that straddles a bin edge; a distance test does
 * not. Input is sorted first so grouping is order-independent.
 */
function clusterByDistance(rows, keyOf, toleranceM) {
  const sorted = [...rows].sort((a, b) => (
    String(keyOf(a)).localeCompare(String(keyOf(b)))
    || a.world.x - b.world.x
    || a.world.y - b.world.y
    || a.world.z - b.world.z
  ));
  const groups = [];
  const byKey = new Map();
  for (const row of sorted) {
    const key = String(keyOf(row));
    const bucket = byKey.get(key);
    let joined = null;
    if (bucket) {
      for (const group of bucket) {
        if (distance3(group.representative.world, row.world) <= toleranceM) {
          joined = group;
          break;
        }
      }
    }
    if (joined) {
      joined.members.push(row);
    } else {
      const group = { key, representative: row, members: [row] };
      groups.push(group);
      if (bucket) bucket.push(group);
      else byKey.set(key, [group]);
    }
  }
  return groups;
}

/**
 * Collapses the same physical object placed in more than one scene (a multiScene
 * copy and its background/LOD twin) into a single occupancy, keyed by body token
 * plus world proximity.
 */
export function dedupePlacedRoots(rows, { toleranceM = DEFAULT_DEDUPE_TOLERANCE_M } = {}) {
  return clusterByDistance(rows, (row) => row.token, toleranceM).map((group) => {
    const duplicates = group.members.slice(1);
    return {
      ...group.representative,
      duplicateCount: duplicates.length,
      scenes: [...new Set(group.members.map((member) => member.sceneIndex))].sort((a, b) => a - b),
      names: [...new Set(group.members.map((member) => member.name))],
    };
  });
}

/**
 * Finds roots that occupy the same world position REGARDLESS of name. This is
 * the check that catches a decoration anchor sitting on a real object: the
 * name-keyed dedupe above cannot see it, because the two names differ.
 *
 * Returns one entry per cluster of two or more roots, with the hierarchy roots
 * involved, so the reader can tell "one object counted twice" from "two objects
 * genuinely stacked".
 */
export function detectPositionDuplicates(rows, { toleranceM = DEFAULT_DUPLICATE_TOLERANCE_M } = {}) {
  const groups = clusterByDistance(rows, () => 'all', toleranceM)
    .filter((group) => group.members.length > 1);
  return groups.map((group) => {
    let spreadM = 0;
    for (const member of group.members) {
      spreadM = Math.max(spreadM, distance3(group.representative.world, member.world));
    }
    return {
      position: { ...group.representative.world },
      count: group.members.length,
      spreadM,
      hierarchyRoots: [...new Set(group.members.map((member) => hierarchyRootOf(member.hierarchyPath)))].sort(),
      members: group.members.map((member) => ({
        name: member.name,
        token: member.token,
        family: member.family,
        hierarchyPath: member.hierarchyPath,
        sceneIndex: member.sceneIndex,
      })),
    };
  }).sort((a, b) => b.count - a.count || a.position.x - b.position.x);
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
 * Scores the handoff's 3 closed / 2 tank / 1 hopper / 2 red-6m claim, and — as
 * importantly — lists the body families the claim never mentioned at all.
 * Colour is only decidable for containers whose name carries a colour token;
 * any colourless 6 m container in scope forces 'cannot-address' rather than a
 * guess.
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

  const claimedFamilies = new Set(['closed-freight-wagon', 'tank-wagon', 'hopper-wagon', 'container-6m', 'container-12m']);
  const unlisted = [...new Set(bodies.map((row) => row.family))]
    .filter((family) => !claimedFamilies.has(family))
    .map((family) => ({ family, observed: countFamily(family) }))
    .sort((a, b) => b.observed - a.observed || a.family.localeCompare(b.family));

  const verdicts = items.map((item) => item.status);
  return {
    items,
    familiesTheClaimNeverListed: unlisted,
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
 * Frame verification against an in-repo artefact
 *
 * NOTE ON INDEPENDENCE: data/customs-props.json was hand-traced from a
 * satellite render, so it is independent OF THE DUMP for the frame question
 * and nothing else. It carries no wagon identities and cannot confirm a count.
 * ------------------------------------------------------------------ */

/**
 * Nearest-neighbour match between composed world positions and the repository's
 * hand-traced prop table. Agreement with NO transform applied is the evidence
 * that both are expressed in the same frame.
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
 * written in: the reading that actually puts resolved roots inside the box wins.
 *
 * The decision is taken over EVERY resolved root of any family (that is the
 * larger sample); the rail-only tallies are reported alongside so the reader can
 * see the decision does not hang on the container mass. The pre-repair report
 * labelled these numbers "rail bodies", which they never were.
 */
export function resolveWorkingFrame(candidates, scope) {
  let sourceHits = 0;
  let runtimeHits = 0;
  let railSourceHits = 0;
  let railRuntimeHits = 0;
  for (const row of candidates) {
    const rail = row.role === 'body' && isRailBodyFamily(row.family);
    if (isWithinScopeXZ(row.world, scope)) {
      sourceHits += 1;
      if (rail) railSourceHits += 1;
    }
    if (isWithinScopeRuntimeXY(row.runtime, scope)) {
      runtimeHits += 1;
      if (rail) railRuntimeHits += 1;
    }
  }
  return {
    sourceFrame: SOURCE_FRAME,
    runtimeFrame: RUNTIME_FRAME,
    runtimeFromSource: RUNTIME_FROM_SOURCE,
    measuredOver: 'every resolved root of any family',
    resolvedRootsConsidered: candidates.length,
    sourceHits,
    runtimeHits,
    railBodySourceHits: railSourceHits,
    railBodyRuntimeHits: railRuntimeHits,
    chosen: sourceHits >= runtimeHits ? 'source' : 'runtime',
  };
}

/* ------------------------------------------------------------------ *
 * Facts store
 * ------------------------------------------------------------------ */

function nodeKey(asset, pathId) {
  return `${asset}:${pathId}`;
}

export class FactsStore {
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

/**
 * @param {object}  [options]
 * @param {string}  [options.factsPath]           dump on disk
 * @param {Function}[options.createFactsStream]   () => AsyncIterable<string>; test seam
 * @param {string}  [options.sceneManifestPath]   manifest on disk (read, then asserted)
 * @param {object}  [options.sceneManifest]       pre-parsed manifest; test seam
 * @param {string[]}[options.excludeHierarchyRoots] defaults to DEFAULT_EXCLUSIONS
 * @param {string[]}[options.includeHierarchyRoots] re-admits a default exclusion
 * @param {Array}   [options.tracedProps]         pre-loaded traced props; test seam
 */
export async function runSecondSource({
  factsPath = DEFAULT_FACTS_PATH,
  createFactsStream = null,
  scope = RAIL_YARD_SCOPE,
  maxDepth = DEFAULT_MAX_PARENT_DEPTH,
  dedupeToleranceM = DEFAULT_DEDUPE_TOLERANCE_M,
  duplicateToleranceM = DEFAULT_DUPLICATE_TOLERANCE_M,
  highWaterMark = 1 << 24,
  sceneManifestPath = SCENE_MANIFEST_PATH,
  sceneManifest = null,
  excludeHierarchyRoots = null,
  includeHierarchyRoots = [],
  tracedPropsPath = TRACED_PROPS_PATH,
  tracedProps = null,
  onProgress = null,
} = {}) {
  // S5: the frame strings and the scope box are checked against the manifest
  // BEFORE any work, and a disagreement stops the run.
  const manifestContract = sceneManifest
    ? contractFromManifest(sceneManifest)
    : await loadSceneManifestContract(sceneManifestPath);
  const manifestCheck = {
    ...assertManifestAgreement(manifestContract),
    sceneManifestPath: sceneManifest ? '(injected)' : sceneManifestPath,
  };

  const store = new FactsStore();
  const matches = [];
  const scanner = createGameObjectScanner({ arrayKey: 'gameObjects' });

  const stream = createFactsStream
    ? createFactsStream()
    : createReadStream(factsPath, { encoding: 'utf8', highWaterMark });
  let parsed = 0;
  for await (const chunk of stream) {
    for (const raw of scanner.push(String(chunk))) {
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
            unrecognised: classification.unrecognised === true,
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
  if (typeof stream.destroy === 'function') stream.destroy();
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

  // S1: exclusions are named, counted and reported — never silent.
  const readmitted = new Set(includeHierarchyRoots);
  const activeExclusions = (
    excludeHierarchyRoots === null
      ? DEFAULT_EXCLUSIONS.filter((rule) => !readmitted.has(rule.hierarchyRoot))
      : excludeHierarchyRoots.map((hierarchyRoot) => ({
        hierarchyRoot,
        reason: 'requested on the command line',
        falsifier: null,
      }))
  );
  const excludedRoots = new Set(activeExclusions.map((rule) => rule.hierarchyRoot));

  const resolvedInScopeBeforeExclusions = resolved.filter((row) => isWithinScopeXZ(row.world, scope));
  const exclusionReport = activeExclusions.map((rule) => ({
    ...rule,
    excludedInScopeRoots: resolvedInScopeBeforeExclusions
      .filter((row) => hierarchyRootOf(row.hierarchyPath) === rule.hierarchyRoot).length,
    excludedRootsAnywhere: resolved
      .filter((row) => hierarchyRootOf(row.hierarchyPath) === rule.hierarchyRoot).length,
  }));

  const kept = excludedRoots.size === 0
    ? resolved
    : resolved.filter((row) => !excludedRoots.has(hierarchyRootOf(row.hierarchyPath)));
  const inScopeAll = kept.filter((row) => isWithinScopeXZ(row.world, scope));
  const inScopeActive = inScopeAll.filter((row) => row.activeInHierarchy);
  const deduped = dedupePlacedRoots(inScopeActive, { toleranceM: dedupeToleranceM });

  // S1: the position-based detector, run on BOTH readings, so the reader can see
  // what the exclusion removed and whether anything else is stacked.
  const positionDuplicatesBeforeExclusions = detectPositionDuplicates(
    resolvedInScopeBeforeExclusions,
    { toleranceM: duplicateToleranceM },
  );
  const positionDuplicatesAfterExclusions = detectPositionDuplicates(
    deduped,
    { toleranceM: duplicateToleranceM },
  );

  const railBodies = deduped.filter((row) => row.role === 'body' && isRailBodyFamily(row.family));
  const bogieRoots = resolved.filter((row) => row.family === 'bogie');

  let frameCrossCheck = null;
  try {
    const props = tracedProps ?? (JSON.parse(await readFile(tracedPropsPath, 'utf8')).props ?? []);
    const rail = props.filter(
      (prop) => prop.type === 'railcar'
        || prop.type === 'tanker'
        || /rail|locomotive|wagon/i.test(prop.name ?? ''),
    );
    const allRailBodies = resolved.filter((row) => row.role === 'body' && isRailBodyFamily(row.family));
    frameCrossCheck = crossCheckAgainstTracedProps(allRailBodies, rail, { toleranceM: 3 });
    frameCrossCheck.tracedPropsPath = tracedProps ? '(injected)' : tracedPropsPath;
  } catch (error) {
    frameCrossCheck = { unavailable: String(error?.message ?? error), tracedPropsPath };
  }

  return {
    provenance: PROVENANCE_STATEMENT,
    outputKind: 'conservative-candidate-roster',
    factsPath: createFactsStream ? '(injected stream)' : factsPath,
    manifestCheck,
    scope,
    scopeBounds: scopeBounds(scope),
    frame,
    frameCrossCheck,
    exclusions: exclusionReport,
    readmittedHierarchyRoots: [...readmitted],
    positionDuplicates: {
      toleranceM: duplicateToleranceM,
      beforeExclusions: positionDuplicatesBeforeExclusions,
      afterExclusions: positionDuplicatesAfterExclusions,
    },
    consists: groupByHierarchyParent(railBodies),
    colourDecidability: analyseColourDecidability(deduped),
    totals: {
      gameObjectsStreamed: store.size,
      nameMatches: matches.length,
      nestedUnderAnotherMatch: nested.length,
      placedRoots: roots.length,
      placedRootsResolved: resolved.length,
      placedRootsUnresolved: unresolved.length,
      rootsInScopeBeforeExclusions: resolvedInScopeBeforeExclusions.length,
      rootsExcluded: resolvedInScopeBeforeExclusions.length - inScopeAll.length,
      rootsInScope: inScopeAll.length,
      rootsInScopeActive: inScopeActive.length,
      rootsInScopeAfterDedupe: deduped.length,
      positionDuplicateClustersBeforeExclusions: positionDuplicatesBeforeExclusions.length,
      positionDuplicateClustersRemaining: positionDuplicatesAfterExclusions.length,
      railBodiesInScope: railBodies.length,
      orphanTechnicalRoots: roots.filter((row) => row.technicalSuffix).length,
      orphanBogieRoots: bogieRoots.length,
      unrecognisedRollingStockRoots: resolved.filter((row) => row.unrecognised).length,
    },
    unresolved,
    orphanTechnicalRoots: roots.filter((row) => row.technicalSuffix),
    orphanBogieRoots: bogieRoots,
    unrecognisedRollingStock: resolved.filter((row) => row.unrecognised),
    summaryAllRoots: summarizeCounts(resolved),
    summaryInScope: summarizeCounts(deduped),
    rows: deduped.sort((a, b) => a.token.localeCompare(b.token) || a.world.x - b.world.x),
    outOfScope: kept.filter((row) => !isWithinScopeXZ(row.world, scope)),
    verdict: evaluateHandoffClaim(deduped),
    capabilities: CAPABILITY_STATEMENT,
    lexicon: NAME_SPACE_CENSUS,
  };
}

function fixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value);
}

export function formatReport(result) {
  const lines = [];
  const push = (line = '') => lines.push(line);

  const rule = '='.repeat(96);
  push(rule);
  push('CUSTOMS INDUSTRIAL RAIL YARD — CONSERVATIVE CANDIDATE ROSTER (one Unity facts dump, scalar-only)');
  push(rule);
  for (const line of result.provenance) push(line);
  push(rule);
  push();
  push(`facts   : ${result.factsPath}`);
  push(
    `manifest: ${result.manifestCheck.sceneManifestPath} `
    + `(${result.manifestCheck.checked} frame/scope fields agree with this script's literals)`,
  );
  push();
  push('FRAME');
  push(`  source frame declared by scene-manifest   : ${result.frame.sourceFrame}`);
  push(`  runtime frame                             : ${result.frame.runtimeFrame}`);
  push(`  runtimeFromSource                         : ${result.frame.runtimeFromSource}`);
  push(`  measured over                             : ${result.frame.measuredOver} (${result.frame.resolvedRootsConsidered} roots)`);
  push(`  resolved roots, ANY family, inside box as SOURCE x/z : ${result.frame.sourceHits}`);
  push(`  resolved roots, ANY family, inside box as RUNTIME x/y: ${result.frame.runtimeHits}`);
  push(`    of which rail rolling stock, SOURCE x/z            : ${result.frame.railBodySourceHits}`);
  push(`    of which rail rolling stock, RUNTIME x/y           : ${result.frame.railBodyRuntimeHits}`);
  push(`  working frame chosen                      : ${result.frame.chosen}`);
  const cross = result.frameCrossCheck;
  if (cross && !cross.unavailable) {
    push('  frame-only check vs hand-traced data/customs-props.json (no transform applied):');
    push(
      `    ${cross.matched}/${cross.tracedCount} traced rail props matched a composed rail body within `
      + `${cross.toleranceM} m; median residual ${fixed(cross.medianResidualM)} m, max ${fixed(cross.maxResidualM)} m`,
    );
    push('    (this tests the FRAME only. The traced table carries no identities and confirms no count.)');
  } else if (cross) {
    push(`  frame-only check unavailable: ${cross.unavailable}`);
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
  push('EXCLUSIONS APPLIED (nothing is filtered silently)');
  if (result.exclusions.length === 0) {
    push('  none');
  }
  for (const exclusion of result.exclusions) {
    push(`  hierarchy root "${exclusion.hierarchyRoot}" — ${exclusion.excludedInScopeRoots} in-scope root(s) removed `
      + `(${exclusion.excludedRootsAnywhere} anywhere in the dump)`);
    push(`      why      : ${exclusion.reason}`);
    if (exclusion.falsifier) push(`      falsifier: ${exclusion.falsifier}`);
  }
  if (result.readmittedHierarchyRoots.length > 0) {
    push(`  re-admitted by request: ${result.readmittedHierarchyRoots.join(', ')}`);
  }
  push();
  push('POSITION DUPLICATES (same world position, ANY name — the check a name-keyed dedupe cannot make)');
  const dup = result.positionDuplicates;
  push(`  tolerance: ${dup.toleranceM} m`);
  push(`  before exclusions: ${dup.beforeExclusions.length} cluster(s) of 2+ co-located in-scope roots`);
  push(`  after  exclusions: ${dup.afterExclusions.length} cluster(s) remaining`);
  for (const cluster of dup.afterExclusions.slice(0, 20)) {
    push(
      `    ${cluster.count} roots within ${fixed(cluster.spreadM, 4)} m at `
      + `(${fixed(cluster.position.x)}, ${fixed(cluster.position.y)}, ${fixed(cluster.position.z)}) `
      + `[${cluster.hierarchyRoots.join(', ')}]`,
    );
    for (const member of cluster.members) push(`        ${member.name}  ${member.hierarchyPath}`);
  }
  push();
  push('TOTALS');
  for (const [key, value] of Object.entries(result.totals)) {
    push(`  ${key.padEnd(42)} ${value}`);
  }
  push();
  push('LEXICON SELF-CHECK');
  push(
    `  bogie (Train_wheels) roots with no rail-body ancestor: ${result.totals.orphanBogieRoots} `
    + '— a non-zero count would mean a bogied vehicle whose body name this lexicon does not know.',
  );
  push(
    `  vagon_* names with an unrecognised head              : ${result.totals.unrecognisedRollingStockRoots}`,
  );
  for (const row of result.unrecognisedRollingStock.slice(0, 10)) {
    push(`      ${row.name}  ${row.hierarchyPath}`);
  }
  push();
  push('IN-SCOPE ROOTS BY NAME TOKEN (deduped) — CANDIDATES, NOT CONFIRMED OBJECTS');
  for (const [token, count] of result.summaryInScope.byToken) {
    push(`  ${String(count).padStart(4)}  ${token}`);
  }
  push();
  push('IN-SCOPE ROOTS BY BODY FAMILY (deduped) — CANDIDATES, NOT CONFIRMED OBJECTS');
  for (const [family, count] of result.summaryInScope.byFamily) {
    push(`  ${String(count).padStart(4)}  ${family}`);
  }
  push();
  push('IN-SCOPE ROOTS — COMPOSED WORLD POSITIONS (survey targets for photographic confirmation)');
  for (const row of result.rows) {
    push(
      `  ${row.name.padEnd(30)} token=${row.token.padEnd(28)} family=${row.family.padEnd(28)}`
      + ` world=(${fixed(row.world.x)}, ${fixed(row.world.y)}, ${fixed(row.world.z)})`
      + ` scenes=[${row.scenes.join(',')}] dup=${row.duplicateCount}`,
    );
    push(`      path: ${row.hierarchyPath}`);
  }
  push();
  push('RAIL ROLLING STOCK GROUPED BY AUTHORED GROUP (a "consist" is one of these, not the whole box)');
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
  push('THE HANDOFF CLAIM (3 closed / 2 tank / 1 hopper / 2 red 6 m containers), SCORED AGAINST CANDIDATES');
  for (const item of result.verdict.items) {
    push(
      `  ${item.item.padEnd(24)} claimed=${item.claimed}  observed=${item.observed}  ${item.status}`,
    );
    if (item.note) push(`      ${item.note}`);
  }
  push('  BODY FAMILIES THE CLAIM NEVER LISTED:');
  for (const row of result.verdict.familiesTheClaimNeverListed) {
    push(`    ${String(row.observed).padStart(4)}  ${row.family}`);
  }
  push(`  OVERALL: ${result.verdict.overall}`);
  push('  "observed" is a candidate count from ONE dump read by ONE selector. It is not a measurement of the game.');
  push();
  push('WHAT THIS SOURCE CAN ESTABLISH');
  for (const line of result.capabilities.can) push(`  + ${line}`);
  push('WHAT THIS SOURCE CANNOT ESTABLISH');
  for (const line of result.capabilities.cannot) push(`  - ${line}`);
  push();
  push(rule);
  push('REMINDER: shared acquisition layer with the primary extractor. Agreement is not validation.');
  push('Every count above is a candidate awaiting confirmation from geo-tagged in-game photographs.');
  push(rule);

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
    } else if (arg === '--include-hierarchy-root') {
      options.includeHierarchyRoots = [...(options.includeHierarchyRoots ?? []), argv[i + 1]];
    }
  }
  return options;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runSecondSource({
    factsPath: options.factsPath ?? DEFAULT_FACTS_PATH,
    excludeHierarchyRoots: options.excludeHierarchyRoots ?? null,
    includeHierarchyRoots: options.includeHierarchyRoots ?? [],
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
    if (options.allRoots) {
      process.stdout.write('\nALL PLACED ROOTS (any position, exclusions NOT applied)\n');
      for (const [token, count] of result.summaryAllRoots.byToken) {
        process.stdout.write(`  ${String(count).padStart(4)}  ${token}\n`);
      }
    }
  }
}
