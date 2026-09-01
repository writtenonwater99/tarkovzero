import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CUSTOMS_ASSET_FRAMES,
  CUSTOMS_ASSET_SCHEMA_VERSION,
  CustomsAssetManifestError,
  emptyCustomsAssetManifest,
  isCustomsAssetManifestEmpty,
  normalizeCustomsAssetManifest,
  resolveCustomsAssetUrl,
} from '../src/customs-asset-manifest.js';

const SHIPPED_MANIFEST = fileURLToPath(
  new URL('../public/assets/3d/customs/scene-manifest.json', import.meta.url),
);

const hash = (seed) => `sha256:${String(seed).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a')}`;

function source(overrides = {}) {
  return {
    id: 'kenney-industrial',
    kind: 'third-party-asset',
    title: 'Kenney Industrial Kit',
    holder: 'Kenney',
    license: 'CC0-1.0',
    licenseUrl: 'https://kenney.nl/support',
    retrievedAt: '2026-08-29',
    ...overrides,
  };
}

function material(overrides = {}) {
  return {
    id: 'warehouse-albedo',
    kind: 'basecolor',
    file: 'materials/warehouse-albedo.ktx2',
    sha256: hash(1),
    bytes: 240_000,
    colorSpace: 'srgb',
    sourceId: 'kenney-industrial',
    ...overrides,
  };
}

function asset(overrides = {}) {
  return {
    id: 'warehouse',
    kind: 'unique',
    name: 'Customs warehouse',
    sourceId: 'kenney-industrial',
    gltf: { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' },
    bounds: { min: { x: -12, y: 0, z: -20 }, max: { x: 12, y: 9, z: 20 } },
    materialIds: ['warehouse-albedo'],
    masks: { floors: ['ground', 'floor-1'], interior: true },
    proxies: {
      picking: { shape: 'box', inflateM: 0.2 },
      shadow: { mode: 'both', lodLevel: 1 },
      collision: { shape: 'box' },
    },
    lods: [
      { level: 0, url: 'warehouse/lod0.glb', sha256: hash(2), bytes: 900_000, triangles: 120_000, maxDistanceM: 80 },
      { level: 1, url: 'warehouse/lod1.glb', sha256: hash(3), bytes: 300_000, triangles: 30_000, maxDistanceM: 200 },
    ],
    ...overrides,
  };
}

function instance(overrides = {}) {
  return {
    id: 'warehouse-a',
    assetId: 'warehouse',
    cellId: 'cell-core',
    stableId: 'customs.authored.warehouse.a',
    featureId: 'customs.building.warehouse',
    transform: { position: { x: 230, y: 4, z: -110 }, rotation: { yawDeg: 90 } },
    floor: 'ground',
    ...overrides,
  };
}

function cell(overrides = {}) {
  return {
    id: 'cell-core',
    center: { x: 230, z: -110 },
    widthM: 120,
    depthM: 120,
    minY: -20,
    maxY: 40,
    instanceIds: ['warehouse-a'],
    loadPriority: 10,
    ...overrides,
  };
}

function replacement(overrides = {}) {
  return {
    id: 'retire-warehouse',
    target: { kind: 'building', featureId: 'customs.building.warehouse' },
    instanceIds: ['warehouse-a'],
    policy: 'hide-mesh',
    ...overrides,
  };
}

/** A fully populated, valid manifest. Every rejection test mutates exactly one thing in it. */
function populated(mutate = (value) => value) {
  const value = {
    ...emptyCustomsAssetManifest(),
    evidence: { sources: [source()], observations: [] },
    delivery: {
      baseUrl: 'assets/3d/customs/authored/',
      materials: [material()],
      assets: [asset()],
      instances: [instance()],
      cells: [cell()],
      replacements: [replacement()],
    },
  };
  return mutate(structuredClone(value)) ?? value;
}

function rejects(t, code, mutate) {
  let error = null;
  try {
    normalizeCustomsAssetManifest(populated(mutate));
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, `${t}: expected ${code} but the manifest validated`);
  assert.ok(error instanceof CustomsAssetManifestError, `${t}: expected a manifest error, got ${error}`);
  assert.equal(error.code, code, `${t}: expected ${code}, got ${error.code} (${error.message})`);
  assert.ok(error.path, `${t}: error must carry a JSON path`);
  return error;
}

test('the empty v2 manifest is valid and declares the procedural fallback', () => {
  const normalized = normalizeCustomsAssetManifest(emptyCustomsAssetManifest());
  assert.equal(normalized.schemaVersion, CUSTOMS_ASSET_SCHEMA_VERSION);
  assert.equal(normalized.map, 'customs');
  assert.equal(normalized.proceduralFallback, true);
  assert.equal(isCustomsAssetManifestEmpty(normalized), true);
  assert.deepEqual(normalized.frames, { ...CUSTOMS_ASSET_FRAMES });
  assert.deepEqual(normalized.delivery.assets, []);
  assert.equal(normalized.totals.instances, 0);
});

test('the shipped scene manifest admits only the reviewed Fortress shell baseline', async () => {
  const shipped = JSON.parse(await readFile(SHIPPED_MANIFEST, 'utf8'));
  assert.equal(shipped.schemaVersion, 2, 'scene-manifest.json must be migrated to schemaVersion 2');
  const normalized = normalizeCustomsAssetManifest(shipped);
  assert.equal(isCustomsAssetManifestEmpty(normalized), false);
  assert.equal(normalized.proceduralFallback, false);
  assert.equal(normalized.scope.id, 'customs-industrial-rail-yard');
  assert.equal(normalized.totals.assets, 1);
  assert.equal(normalized.totals.instances, 1);
  assert.equal(normalized.delivery.assets[0].id, 'fortress-shell-original-baseline');
  assert.equal(normalized.delivery.instances[0].stableId, 'customs.authored.fortress.shell.main');
  assert.equal(normalized.delivery.assets[0].proxies.collision.shape, 'none');
  assert.equal(normalized.delivery.replacements.length, 3);
  assert.ok(normalized.budgets.maxConcurrentLoads >= 1);
});

test('a validated manifest is deep-frozen', () => {
  const normalized = normalizeCustomsAssetManifest(populated());
  assert.throws(() => { normalized.delivery.assets.push({}); }, TypeError);
  assert.throws(() => { normalized.delivery.assets[0].lods[0].bytes = 1; }, TypeError);
});

test('a populated manifest normalizes into resolved, indexed records', () => {
  const normalized = normalizeCustomsAssetManifest(populated());
  assert.equal(normalized.proceduralFallback, false);
  assert.equal(normalized.totals.assets, 1);
  assert.equal(normalized.totals.instances, 1);
  assert.equal(normalized.totals.declaredBytes, 1_200_000);
  assert.equal(normalized.totals.lod0Triangles, 120_000);

  const [only] = normalized.delivery.assets;
  assert.deepEqual(only.bounds.sizeM, { x: 24, y: 9, z: 40 });
  assert.deepEqual(only.bounds.centerM, { x: 0, y: 4.5, z: 0 });
  assert.deepEqual(only.gltf, { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' });
  assert.equal(only.proxies.picking.shape, 'box');
  assert.deepEqual(only.masks.floors, ['ground', 'floor-1']);

  const [placed] = normalized.delivery.instances;
  // Rotation and scale defaults are materialized, so the renderer never reads undefined.
  assert.deepEqual(placed.transform.rotation, { yawDeg: 90, pitchDeg: 0, rollDeg: 0 });
  assert.deepEqual(placed.transform.scale, { x: 1, y: 1, z: 1 });
  assert.equal(placed.pickable, true);

  const [only_cell] = normalized.delivery.cells;
  assert.deepEqual(only_cell.boundsM, { minX: 170, maxX: 290, minZ: -170, maxZ: -50 });
});

test('evidence is separate from delivery and delivery may only reference it by ID', () => {
  const normalized = normalizeCustomsAssetManifest(populated());
  assert.deepEqual(Object.keys(normalized.evidence).sort(), ['observations', 'sources']);
  assert.equal(normalized.delivery.assets[0].sourceId, 'kenney-industrial');
  // No delivery record may carry an inline licence receipt — the receipt lives in evidence.
  const deliveryText = JSON.stringify(normalized.delivery);
  assert.ok(!deliveryText.includes('licenseUrl'));
  assert.ok(!deliveryText.includes('kenney.nl'));
});

test('evidence observations resolve to a source and may cite a feature', () => {
  const normalized = normalizeCustomsAssetManifest(populated((value) => {
    value.evidence.observations = [{
      id: 'obs-1',
      sourceId: 'kenney-industrial',
      subject: 'warehouse north-west corner',
      positionM: { x: 218, y: 4, z: -130 },
      toleranceM: 0.5,
      featureId: 'customs.building.warehouse',
    }];
    return value;
  }));
  assert.equal(normalized.evidence.observations[0].sourceId, 'kenney-industrial');
  rejects('unknown evidence source', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.evidence.observations = [{
      id: 'obs-1',
      sourceId: 'nope',
      subject: 'corner',
      positionM: { x: 218, y: 4, z: -130 },
      toleranceM: 0.5,
    }];
    return value;
  });
});

// ---------------------------------------------------------------------------
// top-level

test('rejects a non-v2 schema version and a foreign map', () => {
  rejects('v1', 'ERR_ASSET_MANIFEST_VERSION', (value) => { value.schemaVersion = 1; return value; });
  rejects('v3', 'ERR_ASSET_MANIFEST_VERSION', (value) => { value.schemaVersion = 3; return value; });
  rejects('map', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => { value.map = 'woods'; return value; });
});

test('rejects unknown top-level and nested fields', () => {
  rejects('top-level', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => { value.chunks = []; return value; });
  rejects('delivery', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => { value.delivery.extra = 1; return value; });
  rejects('asset', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => { value.delivery.assets[0].url = 'x.glb'; return value; });
});

test('rejects a manifest that is not an object', () => {
  for (const bad of [null, [], 'x', 3]) {
    assert.throws(() => normalizeCustomsAssetManifest(bad), CustomsAssetManifestError);
  }
});

test('rejects an ambiguous or altered frame declaration', () => {
  rejects('source frame', 'ERR_ASSET_MANIFEST_AMBIGUOUS_AXES', (value) => {
    value.frames.source = 'z-up-metres';
    return value;
  });
  rejects('runtime mapping', 'ERR_ASSET_MANIFEST_AMBIGUOUS_AXES', (value) => {
    value.frames.runtimeFromSource = '[x, y, z]';
    return value;
  });
});

// ---------------------------------------------------------------------------
// URLs and paths

test('rejects unsafe delivery paths', () => {
  const cases = [
    ['traversal', '../../secrets/lod0.glb'],
    ['absolute', '/etc/passwd.glb'],
    ['scheme', 'https://evil.example/lod0.glb'],
    ['protocol relative', '//evil.example/lod0.glb'],
    ['data uri', 'data:model/gltf-binary;base64,AAAA.glb'],
    ['javascript', 'javascript:alert(1).glb'],
    ['encoded traversal', '%2e%2e/lod0.glb'],
    ['backslash', '..\\lod0.glb'],
    ['query', 'lod0.glb?token=1'],
    ['fragment', 'lod0.glb#a'],
    ['dot segment', 'a/./lod0.glb'],
    ['empty segment', 'a//lod0.glb'],
  ];
  for (const [label, url] of cases) {
    rejects(label, 'ERR_ASSET_MANIFEST_UNSAFE_URL', (value) => {
      value.delivery.assets[0].lods[0].url = url;
      return value;
    });
  }
});

test('accepts only self-contained GLB LOD files and texture materials', () => {
  rejects('lod extension', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].lods[0].url = 'warehouse/lod0.obj';
    return value;
  });
  rejects('external gltf package', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].lods[0].url = 'warehouse/lod0.gltf';
    return value;
  });
  rejects('material extension', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.materials[0].file = 'materials/warehouse.exe';
    return value;
  });
});

test('rejects non-https and credentialed evidence URLs', () => {
  rejects('http', 'ERR_ASSET_MANIFEST_UNSAFE_URL', (value) => {
    value.evidence.sources[0].licenseUrl = 'http://kenney.nl/support';
    return value;
  });
  rejects('credentials', 'ERR_ASSET_MANIFEST_UNSAFE_URL', (value) => {
    value.evidence.sources[0].licenseUrl = 'https://user:pw@kenney.nl/support';
    return value;
  });
  rejects('file', 'ERR_ASSET_MANIFEST_UNSAFE_URL', (value) => {
    value.evidence.sources[0].licenseUrl = 'file:///etc/passwd';
    return value;
  });
});

test('resolveCustomsAssetUrl keeps delivery on-origin and under the delivery root', () => {
  const normalized = normalizeCustomsAssetManifest(populated());
  const base = 'https://tarkovzero.example/map/customs';
  assert.equal(
    resolveCustomsAssetUrl(normalized, 'warehouse/lod0.glb', base),
    'https://tarkovzero.example/map/assets/3d/customs/authored/warehouse/lod0.glb',
  );
  for (const escape of ['../../../etc/passwd', 'https://evil.example/x.glb', '//evil.example/x.glb']) {
    assert.throws(
      () => resolveCustomsAssetUrl(normalized, escape, base),
      (error) => error.code === 'ERR_ASSET_MANIFEST_UNSAFE_URL',
      `${escape} must not resolve`,
    );
  }
  assert.throws(
    () => resolveCustomsAssetUrl(normalized, 'warehouse/lod0.glb', 'file:///tmp/index.html'),
    (error) => error.code === 'ERR_ASSET_MANIFEST_UNSAFE_URL',
  );
});

test('rejects a content hash that is not a lowercase sha256', () => {
  for (const bad of ['deadbeef', 'sha256:XYZ', 'sha1:'.padEnd(45, 'a'), `sha256:${'A'.repeat(64)}`]) {
    rejects(`hash ${bad}`, 'ERR_ASSET_MANIFEST_HASH', (value) => {
      value.delivery.assets[0].lods[0].sha256 = bad;
      return value;
    });
  }
});

// ---------------------------------------------------------------------------
// identity

test('rejects duplicate IDs at every level', () => {
  rejects('asset', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.delivery.assets.push(asset({ lods: asset().lods.map((lod) => ({ ...lod, url: `alt/${lod.url}` })) }));
    return value;
  });
  rejects('material', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.delivery.materials.push(material({ file: 'materials/other.ktx2' }));
    return value;
  });
  rejects('evidence source', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.evidence.sources.push(source());
    return value;
  });
  rejects('instance', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.delivery.instances.push(instance());
    value.delivery.cells[0].instanceIds = ['warehouse-a'];
    return value;
  });
  rejects('cell', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.delivery.cells.push(cell({ instanceIds: [] }));
    return value;
  });
  rejects('replacement', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.delivery.replacements.push(replacement());
    return value;
  });
});

test('rejects duplicate instance stable IDs and duplicate LOD urls across assets', () => {
  rejects('stableId', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.delivery.instances.push(instance({ id: 'warehouse-b', featureId: undefined }));
    value.delivery.cells[0].instanceIds = ['warehouse-a', 'warehouse-b'];
    return value;
  });
  rejects('lod url', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.delivery.assets.push(asset({ id: 'warehouse-2' }));
    return value;
  });
});

test('a unique asset must have exactly one instance', () => {
  const missing = rejects('unplaced unique asset', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.instances = [];
    value.delivery.cells = [];
    value.delivery.replacements = [];
    return value;
  });
  assert.match(missing.message, /exactly one instance \(found 0\)/);

  const repeated = rejects('repeated unique asset', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.instances.push(instance({
      id: 'warehouse-b',
      stableId: 'customs.authored.warehouse.b',
      featureId: undefined,
      transform: { position: { x: 240, y: 4, z: -120 }, rotation: { yawDeg: 0 } },
    }));
    value.delivery.cells[0].instanceIds.push('warehouse-b');
    return value;
  });
  assert.match(repeated.message, /exactly one instance \(found 2\)/);
});

test('rejects a malformed feature ID', () => {
  rejects('missing map prefix', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.replacements[0].target.featureId = 'woods.building.warehouse';
    value.delivery.instances[0].featureId = 'woods.building.warehouse';
    return value;
  });
  rejects('undotted', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.replacements[0].target.featureId = 'customs';
    value.delivery.instances[0].featureId = 'customs';
    return value;
  });
});

// ---------------------------------------------------------------------------
// references

test('rejects missing references', () => {
  rejects('asset source', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.delivery.assets[0].sourceId = 'ghost';
    return value;
  });
  rejects('asset material', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.delivery.assets[0].materialIds = ['ghost'];
    return value;
  });
  rejects('instance asset', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.delivery.instances[0].assetId = 'ghost';
    return value;
  });
  rejects('instance cell', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.delivery.instances[0].cellId = 'ghost';
    return value;
  });
  rejects('cell instance', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.delivery.cells[0].instanceIds = ['warehouse-a', 'ghost'];
    return value;
  });
  rejects('picking lod', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.delivery.assets[0].proxies.picking = { shape: 'lod-mesh', lodLevel: 5 };
    return value;
  });
  rejects('shadow lod', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.delivery.assets[0].proxies.shadow = { mode: 'cast', lodLevel: 4 };
    return value;
  });
});

test('an instance must be claimed by exactly the cell it names', () => {
  rejects('unclaimed', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.delivery.cells[0].instanceIds = [];
    return value;
  });
  rejects('claimed twice', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.delivery.cells.push(cell({ id: 'cell-two', center: { x: 290, z: -110 }, widthM: 60, depthM: 60 }));
    return value;
  });
});

test('rejects an instance whose declared floor the asset does not carry', () => {
  rejects('floor mask', 'ERR_ASSET_MANIFEST_MISSING_REF', (value) => {
    value.delivery.instances[0].floor = 'roof';
    return value;
  });
});

// ---------------------------------------------------------------------------
// geometry, transforms, axes

test('rejects invalid bounds', () => {
  rejects('inverted', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.assets[0].bounds = { min: { x: 1, y: 0, z: 0 }, max: { x: -1, y: 9, z: 1 } };
    return value;
  });
  rejects('degenerate', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.assets[0].bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 9, z: 1 } };
    return value;
  });
  rejects('planet sized', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.assets[0].bounds = { min: { x: -9000, y: 0, z: 0 }, max: { x: 9000, y: 9, z: 1 } };
    return value;
  });
  rejects('non-finite', 'ERR_ASSET_MANIFEST_NON_FINITE', (value) => {
    value.delivery.assets[0].bounds.max.y = Number.POSITIVE_INFINITY;
    return value;
  });
});

test('the pivot declaration must agree with the declared bounds', () => {
  rejects('base-center off the floor', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.assets[0].bounds.min.y = 3;
    return value;
  });
  rejects('base-center off axis', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.assets[0].bounds.min.x = -5;
    return value;
  });
  rejects('bounds-center not centred', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.assets[0].gltf.pivot = 'bounds-center';
    return value;
  });
  // `origin` makes no claim, so an off-centre box is fine.
  const free = normalizeCustomsAssetManifest(populated((value) => {
    value.delivery.assets[0].gltf.pivot = 'origin';
    value.delivery.assets[0].bounds.min.y = 3;
    return value;
  }));
  assert.equal(free.delivery.assets[0].gltf.pivot, 'origin');
});

test('rejects ambiguous glTF axes and non-metre units', () => {
  rejects('parallel axes', 'ERR_ASSET_MANIFEST_AMBIGUOUS_AXES', (value) => {
    value.delivery.assets[0].gltf.forwardAxis = '-y';
    return value;
  });
  rejects('identical axes', 'ERR_ASSET_MANIFEST_AMBIGUOUS_AXES', (value) => {
    value.delivery.assets[0].gltf.forwardAxis = '+y';
    return value;
  });
  rejects('unit', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].gltf.unit = 'centimetre';
    return value;
  });
  rejects('unknown axis', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].gltf.upAxis = 'up';
    return value;
  });
  rejects('missing pivot', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    delete value.delivery.assets[0].gltf.pivot;
    return value;
  });
});

test('rejects invalid canonical transforms', () => {
  rejects('zero scale', 'ERR_ASSET_MANIFEST_TRANSFORM', (value) => {
    value.delivery.instances[0].transform.scale = 0;
    return value;
  });
  rejects('mirrored scale', 'ERR_ASSET_MANIFEST_TRANSFORM', (value) => {
    value.delivery.instances[0].transform.scale = { x: 1, y: -1, z: 1 };
    return value;
  });
  rejects('runaway rotation', 'ERR_ASSET_MANIFEST_TRANSFORM', (value) => {
    value.delivery.instances[0].transform.rotation.yawDeg = 4000;
    return value;
  });
  rejects('non-finite position', 'ERR_ASSET_MANIFEST_NON_FINITE', (value) => {
    value.delivery.instances[0].transform.position.x = Number.NaN;
    return value;
  });
  rejects('missing yaw', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    delete value.delivery.instances[0].transform.rotation.yawDeg;
    return value;
  });
  const scaled = normalizeCustomsAssetManifest(populated((value) => {
    value.delivery.instances[0].transform.scale = { x: 1, y: 2, z: 1.5 };
    return value;
  }));
  assert.deepEqual(scaled.delivery.instances[0].transform.scale, { x: 1, y: 2, z: 1.5 });
});

test('rejects instances and cells that leave their container', () => {
  rejects('instance outside cell', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.instances[0].transform.position.x = 500;
    return value;
  });
  rejects('instance above cell', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.instances[0].transform.position.y = 900;
    return value;
  });
  rejects('cell outside scope', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.cells[0].widthM = 1000;
    return value;
  });
  rejects('cell height inverted', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.cells[0].minY = 40;
    value.delivery.cells[0].maxY = -20;
    return value;
  });
});

// ---------------------------------------------------------------------------
// LOD

test('rejects LOD chains whose cost does not strictly fall', () => {
  rejects('equal triangles', 'ERR_ASSET_MANIFEST_LOD', (value) => {
    value.delivery.assets[0].lods[1].triangles = 120_000;
    return value;
  });
  rejects('rising triangles', 'ERR_ASSET_MANIFEST_LOD', (value) => {
    value.delivery.assets[0].lods[1].triangles = 200_000;
    return value;
  });
  rejects('equal bytes', 'ERR_ASSET_MANIFEST_LOD', (value) => {
    value.delivery.assets[0].lods[1].bytes = 900_000;
    return value;
  });
  rejects('non-increasing distance', 'ERR_ASSET_MANIFEST_LOD', (value) => {
    value.delivery.assets[0].lods[1].maxDistanceM = 80;
    return value;
  });
  rejects('empty chain', 'ERR_ASSET_MANIFEST_LOD', (value) => {
    value.delivery.assets[0].lods = [];
    return value;
  });
  rejects('level out of order', 'ERR_ASSET_MANIFEST_LOD', (value) => {
    value.delivery.assets[0].lods[1].level = 3;
    return value;
  });
});

test('a single-LOD asset is fine', () => {
  const normalized = normalizeCustomsAssetManifest(populated((value) => {
    value.delivery.assets[0].lods = [value.delivery.assets[0].lods[0]];
    value.delivery.assets[0].proxies.shadow = { mode: 'both' };
    return value;
  }));
  assert.equal(normalized.delivery.assets[0].lods.length, 1);
});

// ---------------------------------------------------------------------------
// proxies

test('proxy policy must be explicit and internally consistent', () => {
  rejects('lod-mesh without level', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].proxies.picking = { shape: 'lod-mesh' };
    return value;
  });
  rejects('level without lod-mesh', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].proxies.picking = { shape: 'box', lodLevel: 1 };
    return value;
  });
  rejects('shadow lod without casting', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].proxies.shadow = { mode: 'none', lodLevel: 1 };
    return value;
  });
  rejects('missing collision', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    delete value.delivery.assets[0].proxies.collision;
    return value;
  });
  rejects('unknown shadow mode', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].proxies.shadow = { mode: 'maybe' };
    return value;
  });
  rejects('negative picking inflation', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.assets[0].proxies.picking.inflateM = -0.01;
    return value;
  });
  rejects('unbounded picking inflation', 'ERR_ASSET_MANIFEST_BOUNDS', (value) => {
    value.delivery.assets[0].proxies.picking.inflateM = 101;
    return value;
  });
});

test('floor and interior masks must be declared, non-empty and unique', () => {
  rejects('empty floors', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].masks.floors = [];
    return value;
  });
  rejects('unknown floor', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].masks.floors = ['basement'];
    return value;
  });
  rejects('duplicate floor', 'ERR_ASSET_MANIFEST_DUPLICATE_ID', (value) => {
    value.delivery.assets[0].masks.floors = ['ground', 'ground'];
    return value;
  });
  rejects('interior not boolean', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.delivery.assets[0].masks.interior = 'yes';
    return value;
  });
});

// ---------------------------------------------------------------------------
// replacements

test('rejects unresolved and duplicate replacement targets', () => {
  rejects('unknown instance', 'ERR_ASSET_MANIFEST_UNRESOLVED_REPLACEMENT', (value) => {
    value.delivery.replacements[0].instanceIds = ['ghost'];
    return value;
  });
  rejects('empty', 'ERR_ASSET_MANIFEST_UNRESOLVED_REPLACEMENT', (value) => {
    value.delivery.replacements[0].instanceIds = [];
    return value;
  });
  rejects('same feature twice', 'ERR_ASSET_MANIFEST_UNRESOLVED_REPLACEMENT', (value) => {
    value.delivery.replacements.push(replacement({ id: 'retire-again' }));
    return value;
  });
});

test('one attached authored instance may retire several distinct procedural features', () => {
  const normalized = normalizeCustomsAssetManifest(populated((value) => {
    value.delivery.replacements.push(replacement({
      id: 'retire-floor',
      target: { kind: 'surface', featureId: 'customs.surface.warehouse.floor-1' },
    }));
    return value;
  }));
  assert.deepEqual(
    normalized.delivery.replacements.map((entry) => entry.target.featureId),
    ['customs.building.warehouse', 'customs.surface.warehouse.floor-1'],
  );
});

test('an instance claiming a featureId with no replacement entry is rejected', () => {
  rejects('orphan claim', 'ERR_ASSET_MANIFEST_UNRESOLVED_REPLACEMENT', (value) => {
    value.delivery.replacements = [];
    return value;
  });
});

// ---------------------------------------------------------------------------
// budgets

test('rejects manifests that overrun their own declared budgets', () => {
  rejects('total bytes', 'ERR_ASSET_MANIFEST_BUDGET', (value) => {
    value.budgets.totalBytes = 1000;
    value.budgets.perCellBytes = 1000;
    return value;
  });
  rejects('per-cell bytes', 'ERR_ASSET_MANIFEST_BUDGET', (value) => {
    value.budgets.perCellBytes = 1000;
    return value;
  });
  rejects('per-cell triangles', 'ERR_ASSET_MANIFEST_BUDGET', (value) => {
    value.budgets.perCellTriangles = 100;
    return value;
  });
  rejects('total triangles', 'ERR_ASSET_MANIFEST_BUDGET', (value) => {
    value.budgets.totalTriangles = 100;
    value.budgets.perCellTriangles = 100;
    return value;
  });
  rejects('per-cell over total', 'ERR_ASSET_MANIFEST_BUDGET', (value) => {
    value.budgets.perCellBytes = value.budgets.totalBytes + 1;
    return value;
  });
  rejects('concurrency', 'ERR_ASSET_MANIFEST_SCHEMA', (value) => {
    value.budgets.maxConcurrentLoads = 0;
    return value;
  });
});

test('prototype bytes are charged once per cell, triangles once per instance', () => {
  const normalized = normalizeCustomsAssetManifest(populated((value) => {
    value.delivery.assets[0].kind = 'prototype';
    value.delivery.instances.push(instance({
      id: 'warehouse-b',
      stableId: 'customs.authored.warehouse.b',
      featureId: undefined,
      transform: { position: { x: 240, y: 4, z: -120 }, rotation: { yawDeg: 0 } },
    }));
    value.delivery.cells[0].instanceIds = ['warehouse-a', 'warehouse-b'];
    return value;
  }));
  // Two instances of one 120k prototype: 240k triangles, but still only 1.2 MB of bytes.
  assert.equal(normalized.totals.lod0Triangles, 240_000);
  assert.equal(normalized.totals.declaredBytes, 1_200_000);
});
