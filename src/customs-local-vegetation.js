import {
  CUSTOMS_LOCAL_TERRAIN_MANIFEST_PATH,
  CustomsLocalTerrainInvalidError,
  CustomsLocalTerrainUnavailableError,
} from './customs-local-terrain-loader.js';
import { validateCustomsLocalTerrainManifest } from './customs-local-terrain.js';

export const CUSTOMS_LOCAL_VEGETATION_CLASSES = Object.freeze([
  'pine',
  'deciduous',
  'shrub',
  'stump',
  'ground-plant',
]);

const SOURCE_FRAME = 'eft-unity-world-metres-y-up';
const MAP_ID = 'customs';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PROTOTYPE_KIND = 'terrain-tree-or-plant';

function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

function invalid(message, details = {}) {
  throw new CustomsLocalTerrainInvalidError(message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectAt(value, path) {
  if (!isPlainObject(value)) invalid(`${path} must be an object.`, { resource: path });
  return value;
}

function exactKeys(value, required, optional, path) {
  const object = objectAt(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      invalid(`${path} is missing required field ${key}.`, { resource: path });
    }
  }
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    invalid(
      `${path} contains unsupported field(s): ${unexpected.join(', ')}.`,
      { resource: path },
    );
  }
  return object;
}

function text(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    invalid(`${path} must be a non-empty, already-trimmed string.`, { resource: path });
  }
  return value;
}

function finiteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${path} must be a finite number.`, { resource: path });
  }
  return Object.is(value, -0) ? 0 : value;
}

function positiveNumber(value, path) {
  const number = finiteNumber(value, path);
  if (!(number > 0)) invalid(`${path} must be greater than zero.`, { resource: path });
  return number;
}

function safeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`${path} must be a non-negative safe integer.`, { resource: path });
  }
  return value;
}

function vector3(value, path, { normalized = false } = {}) {
  const vector = exactKeys(value, ['x', 'y', 'z'], [], path);
  const result = {
    x: finiteNumber(vector.x, `${path}.x`),
    y: finiteNumber(vector.y, `${path}.y`),
    z: finiteNumber(vector.z, `${path}.z`),
  };
  if (normalized && Object.values(result).some((component) => component < 0 || component > 1)) {
    invalid(`${path} components must be normalized to the inclusive range 0 through 1.`, {
      resource: path,
    });
  }
  return result;
}

function color4(value, path) {
  // The producer preserves whichever scalar channels Unity exposes. Most
  // builds provide RGBA, but accepting a non-empty exact subset keeps this
  // consumer aligned with that lossless scalar contract.
  const color = exactKeys(value, [], ['r', 'g', 'b', 'a'], path);
  const channels = Object.keys(color);
  if (channels.length === 0) {
    invalid(`${path} must contain at least one color channel.`, { resource: path });
  }
  return Object.fromEntries(channels.map((channel) => [
    channel,
    finiteNumber(color[channel], `${path}.${channel}`),
  ]));
}

/** Classify an authored prototype deterministically using its name and no other data. */
export function classifyCustomsVegetationPrototype(nameValue) {
  const name = text(nameValue, 'prototype name').normalize('NFKC').toLowerCase();
  if (/(stump|dead[\s_-]*log|fallen[\s_-]*log)/u.test(name)) return 'stump';
  if (/(pine|spruce|\bfir\b|conifer|cedar)/u.test(name)) return 'pine';
  if (/(shrub|bush|brush|filbert|hazel|thicket)/u.test(name)) return 'shrub';
  if (/(grass|fern|plant|weed|flower|reed|moss|herb|groundcover)/u.test(name)) {
    return 'ground-plant';
  }
  if (/(birch|oak|maple|poplar|aspen|willow|alder|elm|beech|deciduous|tree)/u.test(name)) {
    return 'deciduous';
  }
  return 'ground-plant';
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('The Customs local vegetation request was aborted.');
  error.name = 'AbortError';
  throw error;
}

function rethrowAbort(error, signal) {
  if (error?.name === 'AbortError') throw error;
  if (signal?.aborted) throwIfAborted(signal);
}

function validatePackage(localPackage) {
  const packageObject = objectAt(localPackage, 'localPackage');
  let manifest;
  try {
    manifest = validateCustomsLocalTerrainManifest(packageObject.manifest);
  } catch (cause) {
    invalid(`localPackage.manifest failed validation: ${cause.message}`, {
      cause,
      resource: 'localPackage.manifest',
    });
  }

  if (typeof packageObject.manifestUrl !== 'string') {
    invalid('localPackage.manifestUrl must be a URL string.', {
      resource: 'localPackage.manifestUrl',
    });
  }
  let manifestUrl;
  try {
    manifestUrl = new URL(packageObject.manifestUrl);
  } catch (cause) {
    invalid('localPackage.manifestUrl must be a valid URL.', {
      cause,
      resource: 'localPackage.manifestUrl',
    });
  }
  if (
    !['http:', 'https:'].includes(manifestUrl.protocol)
    || !LOOPBACK_HOSTNAMES.has(manifestUrl.hostname.toLowerCase())
    || manifestUrl.username
    || manifestUrl.password
    || manifestUrl.pathname !== CUSTOMS_LOCAL_TERRAIN_MANIFEST_PATH
    || manifestUrl.search
    || manifestUrl.hash
  ) {
    invalid('localPackage.manifestUrl must be the fixed loopback Customs manifest URL.', {
      resource: 'localPackage.manifestUrl',
      url: manifestUrl.href,
    });
  }

  if (!Array.isArray(packageObject.assets) || packageObject.assets.length !== manifest.tiles.length) {
    invalid('localPackage.assets must contain exactly one entry per manifest tile.', {
      resource: 'localPackage.assets',
    });
  }
  const assetsByTile = new Map();
  for (let index = 0; index < packageObject.assets.length; index += 1) {
    const asset = objectAt(packageObject.assets[index], `localPackage.assets[${index}]`);
    const tileId = text(asset.tileId, `localPackage.assets[${index}].tileId`);
    if (assetsByTile.has(tileId)) {
      invalid(`localPackage.assets duplicates tile ${tileId}.`, {
        resource: `localPackage.assets[${index}].tileId`,
      });
    }
    assetsByTile.set(tileId, asset);
  }

  const packageBaseUrl = new URL('./', manifestUrl);
  const vegetationRequests = [];
  for (const tile of manifest.tiles) {
    const asset = assetsByTile.get(tile.id);
    if (!asset) {
      invalid(`localPackage.assets is missing manifest tile ${tile.id}.`, {
        resource: 'localPackage.assets',
      });
    }
    if (!tile.vegetation) {
      if (asset.vegetation !== null && asset.vegetation !== undefined) {
        invalid(`Tile ${tile.id} exposes vegetation that is not declared by the manifest.`, {
          resource: `localPackage.assets:${tile.id}`,
        });
      }
      continue;
    }
    const vegetationAsset = objectAt(
      asset.vegetation,
      `localPackage.assets:${tile.id}.vegetation`,
    );
    if (typeof vegetationAsset.url !== 'string') {
      invalid(`Vegetation URL for tile ${tile.id} must be a string.`, {
        resource: `vegetation:${tile.id}`,
      });
    }
    let vegetationUrl;
    try {
      vegetationUrl = new URL(vegetationAsset.url);
    } catch (cause) {
      invalid(`Vegetation URL for tile ${tile.id} is malformed.`, {
        cause,
        resource: `vegetation:${tile.id}`,
      });
    }
    const expectedUrl = new URL(tile.vegetation.file, packageBaseUrl);
    if (
      vegetationUrl.href !== expectedUrl.href
      || vegetationUrl.origin !== manifestUrl.origin
      || !vegetationUrl.pathname.startsWith(packageBaseUrl.pathname)
      || vegetationUrl.username
      || vegetationUrl.password
      || vegetationUrl.search
      || vegetationUrl.hash
    ) {
      invalid(`Vegetation URL for tile ${tile.id} is not the declared same-origin package URL.`, {
        resource: `vegetation:${tile.id}`,
        url: vegetationUrl.href,
      });
    }
    vegetationRequests.push({ tile, url: vegetationUrl.href });
  }

  for (const tileId of assetsByTile.keys()) {
    if (!manifest.tiles.some((tile) => tile.id === tileId)) {
      invalid(`localPackage.assets contains unknown tile ${tileId}.`, {
        resource: 'localPackage.assets',
      });
    }
  }
  return { manifest, vegetationRequests };
}

function requestOptions(signal) {
  return {
    method: 'GET',
    mode: 'same-origin',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
  };
}

async function fetchVegetation(fetchImplementation, request, signal) {
  throwIfAborted(signal);
  let response;
  try {
    response = await fetchImplementation(request.url, requestOptions(signal));
  } catch (cause) {
    rethrowAbort(cause, signal);
    throw new CustomsLocalTerrainUnavailableError(
      `Could not load local Customs vegetation for tile ${request.tile.id}.`,
      { cause, resource: `vegetation:${request.tile.id}`, url: request.url },
    );
  }
  if (!response || typeof response.ok !== 'boolean') {
    invalid(`Vegetation for tile ${request.tile.id} returned an invalid fetch response.`, {
      resource: `vegetation:${request.tile.id}`,
      url: request.url,
    });
  }
  if (!response.ok) {
    throw new CustomsLocalTerrainUnavailableError(
      `Local Customs vegetation for tile ${request.tile.id} is unavailable (HTTP ${response.status}).`,
      {
        resource: `vegetation:${request.tile.id}`,
        status: response.status,
        url: request.url,
      },
    );
  }
  if (typeof response.json !== 'function') {
    invalid(`Vegetation for tile ${request.tile.id} cannot be decoded as JSON.`, {
      resource: `vegetation:${request.tile.id}`,
      url: request.url,
    });
  }
  try {
    const payload = await response.json();
    throwIfAborted(signal);
    return { request, payload };
  } catch (cause) {
    rethrowAbort(cause, signal);
    invalid(`Vegetation for tile ${request.tile.id} is not valid JSON.`, {
      cause,
      resource: `vegetation:${request.tile.id}`,
      url: request.url,
    });
  }
}

function normalizePrototype(value, index, tile, expectedById) {
  const path = `vegetation:${tile.id}.prototypes[${index}]`;
  const prototype = exactKeys(
    value,
    ['index', 'name', 'kind', 'id'],
    ['bendFactor', 'navMeshLod'],
    path,
  );
  const id = text(prototype.id, `${path}.id`);
  const name = text(prototype.name, `${path}.name`);
  const expected = expectedById.get(id);
  if (!expected) invalid(`${path}.id references undeclared prototype ${id}.`, { resource: path });
  if (name !== expected.name) {
    invalid(`${path}.name does not match manifest prototype ${id}.`, { resource: path });
  }
  if (prototype.kind !== PROTOTYPE_KIND) {
    invalid(`${path}.kind must be ${PROTOTYPE_KIND}.`, { resource: path });
  }
  const normalized = {
    tileId: tile.id,
    id,
    name,
    index: safeInteger(prototype.index, `${path}.index`),
    kind: PROTOTYPE_KIND,
    classification: classifyCustomsVegetationPrototype(name),
  };
  if (Object.prototype.hasOwnProperty.call(prototype, 'bendFactor')) {
    normalized.bendFactor = finiteNumber(prototype.bendFactor, `${path}.bendFactor`);
  }
  if (Object.prototype.hasOwnProperty.call(prototype, 'navMeshLod')) {
    normalized.navMeshLod = finiteNumber(prototype.navMeshLod, `${path}.navMeshLod`);
  }
  return normalized;
}

function normalizeInstance(value, position, tile, prototypesById) {
  const path = `vegetation:${tile.id}.instances[${position}]`;
  const instance = exactKeys(
    value,
    ['index', 'prototypeId', 'positionNormalized', 'worldPosition'],
    ['widthScale', 'heightScale', 'rotationRadians', 'color', 'lightmapColor'],
    path,
  );
  const prototypeId = text(instance.prototypeId, `${path}.prototypeId`);
  const prototype = prototypesById.get(prototypeId);
  if (!prototype) {
    invalid(`${path}.prototypeId references unknown prototype ${prototypeId}.`, {
      resource: `${path}.prototypeId`,
    });
  }
  return {
    tileId: tile.id,
    index: safeInteger(instance.index, `${path}.index`),
    prototypeId,
    prototypeName: prototype.name,
    classification: prototype.classification,
    positionNormalized: vector3(instance.positionNormalized, `${path}.positionNormalized`, {
      normalized: true,
    }),
    worldPosition: vector3(instance.worldPosition, `${path}.worldPosition`),
    widthScale: Object.prototype.hasOwnProperty.call(instance, 'widthScale')
      ? positiveNumber(instance.widthScale, `${path}.widthScale`)
      : 1,
    heightScale: Object.prototype.hasOwnProperty.call(instance, 'heightScale')
      ? positiveNumber(instance.heightScale, `${path}.heightScale`)
      : 1,
    rotationRadians: Object.prototype.hasOwnProperty.call(instance, 'rotationRadians')
      ? finiteNumber(instance.rotationRadians, `${path}.rotationRadians`)
      : 0,
    color: Object.prototype.hasOwnProperty.call(instance, 'color')
      ? color4(instance.color, `${path}.color`)
      : null,
    lightmapColor: Object.prototype.hasOwnProperty.call(instance, 'lightmapColor')
      ? color4(instance.lightmapColor, `${path}.lightmapColor`)
      : null,
  };
}

function normalizeTilePayload(payloadValue, tile, schemaVersion) {
  const path = `vegetation:${tile.id}`;
  const payload = exactKeys(
    payloadValue,
    ['schemaVersion', 'map', 'localOnly', 'sourceFrame', 'tileId', 'prototypes', 'instances'],
    [],
    path,
  );
  if (payload.schemaVersion !== schemaVersion) {
    invalid(`${path}.schemaVersion must be ${schemaVersion}.`, { resource: path });
  }
  if (payload.map !== MAP_ID) invalid(`${path}.map must be ${MAP_ID}.`, { resource: path });
  if (payload.localOnly !== true) invalid(`${path}.localOnly must be true.`, { resource: path });
  if (payload.sourceFrame !== SOURCE_FRAME) {
    invalid(`${path}.sourceFrame must be ${SOURCE_FRAME}.`, { resource: path });
  }
  if (payload.tileId !== tile.id) {
    invalid(`${path}.tileId must be ${tile.id}.`, { resource: path });
  }
  if (!Array.isArray(payload.prototypes)) {
    invalid(`${path}.prototypes must be an array.`, { resource: path });
  }
  if (!Array.isArray(payload.instances)) {
    invalid(`${path}.instances must be an array.`, { resource: path });
  }
  if (payload.prototypes.length !== tile.vegetation.prototypes.length) {
    invalid(`${path}.prototypes count does not match the manifest declaration.`, {
      resource: `${path}.prototypes`,
    });
  }
  if (payload.instances.length !== tile.vegetation.count) {
    invalid(`${path}.instances count does not match the manifest declaration.`, {
      resource: `${path}.instances`,
    });
  }

  const expectedById = new Map(tile.vegetation.prototypes.map((prototype) => [
    prototype.id,
    prototype,
  ]));
  const prototypes = payload.prototypes.map((prototype, index) => (
    normalizePrototype(prototype, index, tile, expectedById)
  ));
  const prototypesById = new Map();
  const prototypeIndexes = new Set();
  for (const prototype of prototypes) {
    if (prototypesById.has(prototype.id)) {
      invalid(`${path}.prototypes duplicates ID ${prototype.id}.`, {
        resource: `${path}.prototypes`,
      });
    }
    if (prototypeIndexes.has(prototype.index)) {
      invalid(`${path}.prototypes duplicates index ${prototype.index}.`, {
        resource: `${path}.prototypes`,
      });
    }
    prototypesById.set(prototype.id, prototype);
    prototypeIndexes.add(prototype.index);
  }
  for (const expectedId of expectedById.keys()) {
    if (!prototypesById.has(expectedId)) {
      invalid(`${path}.prototypes is missing manifest prototype ${expectedId}.`, {
        resource: `${path}.prototypes`,
      });
    }
  }

  const instances = payload.instances.map((instance, index) => (
    normalizeInstance(instance, index, tile, prototypesById)
  ));
  const instanceIndexes = new Set();
  for (const instance of instances) {
    if (instanceIndexes.has(instance.index)) {
      invalid(`${path}.instances duplicates index ${instance.index}.`, {
        resource: `${path}.instances`,
      });
    }
    instanceIndexes.add(instance.index);
  }
  prototypes.sort((a, b) => a.index - b.index);
  instances.sort((a, b) => a.index - b.index);
  return { tileId: tile.id, prototypes, instances };
}

function buildInstancingIndex(manifest, tilePayloads) {
  const prototypes = [];
  const instances = [];
  const groups = [];
  const tiles = [];
  const groupByTileAndPrototype = new Map();

  for (const tile of tilePayloads) {
    const tileInstanceIndexes = [];
    for (const prototype of tile.prototypes) {
      const groupIndex = groups.length;
      const group = {
        groupIndex,
        tileId: tile.tileId,
        prototypeId: prototype.id,
        prototypeName: prototype.name,
        classification: prototype.classification,
        instanceIndexes: [],
      };
      groups.push(group);
      groupByTileAndPrototype.set(`${tile.tileId}\0${prototype.id}`, group);
      prototypes.push(prototype);
    }
    for (const instance of tile.instances) {
      const flatIndex = instances.length;
      const group = groupByTileAndPrototype.get(`${tile.tileId}\0${instance.prototypeId}`);
      const normalized = {
        flatIndex,
        groupIndex: group.groupIndex,
        ...instance,
      };
      instances.push(normalized);
      group.instanceIndexes.push(flatIndex);
      tileInstanceIndexes.push(flatIndex);
    }
    tiles.push({
      tileId: tile.tileId,
      instanceIndexes: tileInstanceIndexes,
    });
  }

  return freezeTree({
    schemaVersion: manifest.schemaVersion,
    map: MAP_ID,
    localOnly: true,
    sourceFrame: SOURCE_FRAME,
    count: instances.length,
    prototypes,
    instances,
    groups,
    tiles,
  });
}

/** Fetch and atomically validate scalar, local-only vegetation for every declared tile. */
export async function loadCustomsLocalVegetation(localPackage, {
  fetch: fetchImplementation = globalThis.fetch,
  signal,
} = {}) {
  throwIfAborted(signal);
  const { manifest, vegetationRequests } = validatePackage(localPackage);
  if (typeof fetchImplementation !== 'function') {
    throw new CustomsLocalTerrainUnavailableError(
      'Customs local vegetation requires the browser Fetch API.',
      { resource: 'fetch' },
    );
  }

  const fetched = await Promise.all(vegetationRequests.map((request) => (
    fetchVegetation(fetchImplementation, request, signal)
  )));
  throwIfAborted(signal);
  const payloadByTile = new Map(fetched.map(({ request, payload }) => [request.tile.id, payload]));
  const tilePayloads = vegetationRequests.map(({ tile }) => (
    normalizeTilePayload(payloadByTile.get(tile.id), tile, manifest.schemaVersion)
  ));
  return buildInstancingIndex(manifest, tilePayloads);
}
