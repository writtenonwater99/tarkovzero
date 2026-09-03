/**
 * The promoted Customs vegetation package: its codec, its manifest contract, its loader, and the
 * artifacts actually sitting in `public/`.
 *
 * Every assertion here was written to FAIL against a specific wrong implementation, and the ones
 * that carry a `DISCRIMINATION` note say which. The rule this repository keeps relearning (handoff
 * §6) is that a check which cannot fail is worse than no check, so a test that only ever passes
 * because the thing it names is absent is not evidence of anything.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

import {
  CUSTOMS_PROMOTED_PLACEMENT_FORMAT,
  CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES,
  CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES,
  CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE,
  CUSTOMS_PROMOTED_VEGETATION_MANIFEST_PATH,
  CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE,
  CustomsPromotedVegetationError,
  assertCustomsPromotedVegetationHasNoCaptureReference,
  decodeCustomsPromotedVegetationPlacements,
  encodeCustomsPromotedVegetationPlacements,
  validateCustomsPromotedVegetationManifest,
} from '../src/customs-promoted-vegetation.js';
import { loadCustomsPromotedVegetationPackage } from '../src/customs-promoted-vegetation-loader.js';
import {
  classifyCustomsVegetationPrototype,
  loadCustomsLocalVegetation,
} from '../src/customs-local-vegetation.js';
import { buildCustomsLocalVegetationRenderPlan } from '../src/customs-local-vegetation-render.js';
import { normalizeCustomsAuthoredVegetationCatalog } from '../src/customs-authored-vegetation.js';
import { canLoadLocalGameDerivedAssets } from '../src/renderer-gate.js';
import { classifyLocalPath } from './lib/asset-promotion.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = resolve(REPOSITORY_ROOT, 'public/assets/3d/customs/authored/vegetation');
const PUBLIC_MANIFEST = resolve(PUBLIC_DIR, 'vegetation-manifest.json');

/** A page that is emphatically not localhost — the production origin, in a test. */
const PRODUCTION_ORIGIN = 'https://tarkovzero.com';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures: the smallest package that satisfies the contract.

const BINDINGS = [
  { tileId: 'terrain-000', prototypeId: 'terrain-000-vegetation-000', prototypeName: 'pine01', assetId: 'customs.vegetation.pine01' },
  { tileId: 'terrain-000', prototypeId: 'terrain-000-vegetation-001', prototypeName: 'birch01', assetId: 'customs.vegetation.birch01' },
  { tileId: 'terrain-001', prototypeId: 'terrain-001-vegetation-000', prototypeName: 'stump01_update', assetId: 'customs.vegetation.stump01_update' },
];

const INSTANCES = [
  {
    tileId: 'terrain-000',
    index: 0,
    prototypeId: 'terrain-000-vegetation-000',
    // Deliberately NOT float32-representable: the whole reason position is stored as f64.
    worldPosition: { x: -550.8120116973296, y: 1.9, z: 340.5780460834503 },
    rotationRadians: 0.00028162929811514914,
    widthScale: 0.3203974664211273,
    heightScale: 2,
    color: { r: 1, g: 0.6, b: 0.996078431372549, a: 0.6705882352941176 },
  },
  {
    tileId: 'terrain-000',
    index: 1,
    prototypeId: 'terrain-000-vegetation-001',
    worldPosition: { x: 12.5, y: -17.85906982421875, z: -0.25 },
    rotationRadians: 6.281605243682861,
    widthScale: 1,
    heightScale: 1,
    color: null,
  },
  {
    tileId: 'terrain-001',
    index: 7,
    prototypeId: 'terrain-001-vegetation-000',
    worldPosition: { x: 846.4132211208344, y: 25.348506450653076, z: -357.83715822873637 },
    rotationRadians: 3.25,
    widthScale: 1.5,
    heightScale: 0.75,
    color: { r: 0, g: 1, b: 0.5019607843137255, a: 1 },
  },
];

function fixtureBytes() {
  const indexOf = new Map(BINDINGS.map((binding, index) => [`${binding.tileId} ${binding.prototypeId}`, index]));
  return encodeCustomsPromotedVegetationPlacements(
    INSTANCES,
    (instance) => indexOf.get(`${instance.tileId} ${instance.prototypeId}`),
  );
}

function fixtureManifest(bytes = fixtureBytes(), overrides = {}) {
  return {
    schemaVersion: 1,
    documentType: 'tarkovzero-customs-promoted-vegetation-manifest',
    map: 'customs',
    localOnly: false,
    distribution: 'promoted-public',
    status: 'promoted-public-live',
    sourceFrame: 'eft-unity-world-metres-y-up',
    placements: {
      file: CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE,
      format: CUSTOMS_PROMOTED_PLACEMENT_FORMAT,
      stride: CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES,
      count: INSTANCES.length,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    },
    arrays: { indexFile: CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE },
    prototypeBindings: BINDINGS,
    ...overrides,
  };
}

/** A `fetch` that serves exactly the two documents the promoted loader asks for. */
function packageFetch({ manifest = null, placements = null, origin = PRODUCTION_ORIGIN } = {}) {
  const bytes = placements ?? fixtureBytes();
  const document = manifest ?? fixtureManifest(bytes);
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    const path = new URL(String(url)).pathname;
    if (path === CUSTOMS_PROMOTED_VEGETATION_MANIFEST_PATH) {
      return {
        ok: true,
        status: 200,
        json: async () => document,
        headers: { get: () => 'application/json' },
      };
    }
    if (path.endsWith(`/${CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE}`)) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        headers: { get: () => 'application/octet-stream' },
      };
    }
    return { ok: false, status: 404, headers: { get: () => null } };
  };
  impl.seen = seen;
  impl.origin = origin;
  return impl;
}

const load = (options = {}) => loadCustomsPromotedVegetationPackage({
  fetch: options.fetch ?? packageFetch(),
  location: options.location ?? `${PRODUCTION_ORIGIN}/?renderer=three`,
  crypto: 'crypto' in options ? options.crypto : webcrypto,
  ...options.rest,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The codec.

test('the placement codec round-trips every scalar bit for bit', async () => {
  const bytes = fixtureBytes();
  assert.equal(
    bytes.byteLength,
    CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES + INSTANCES.length * CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES,
  );
  const decoded = decodeCustomsPromotedVegetationPlacements(bytes, {
    bindings: BINDINGS,
    classify: classifyCustomsVegetationPrototype,
    expected: INSTANCES.length,
  });
  assert.equal(decoded.count, INSTANCES.length);
  decoded.instances.forEach((instance, row) => {
    const source = INSTANCES[row];
    assert.equal(instance.flatIndex, row, 'flatIndex is the row ordinal and is not stored');
    assert.equal(instance.tileId, source.tileId);
    assert.equal(instance.prototypeId, source.prototypeId);
    assert.equal(instance.index, source.index);
    // `Object.is`, not `assert.equal`: the point of f64 storage is BIT identity, and
    // -550.8120116973296 vs its float32 neighbour would pass a tolerance comparison happily.
    assert.ok(Object.is(instance.worldPosition.x, source.worldPosition.x), `row ${row} x`);
    assert.ok(Object.is(instance.worldPosition.y, source.worldPosition.y), `row ${row} y`);
    assert.ok(Object.is(instance.worldPosition.z, source.worldPosition.z), `row ${row} z`);
    assert.ok(Object.is(instance.rotationRadians, source.rotationRadians), `row ${row} rotation`);
    assert.ok(Object.is(instance.widthScale, source.widthScale), `row ${row} widthScale`);
    assert.ok(Object.is(instance.heightScale, source.heightScale), `row ${row} heightScale`);
    if (source.color === null) {
      assert.equal(instance.color, null, 'an absent colour must decode as absent, never as white');
    } else {
      assert.deepEqual({ ...instance.color }, source.color);
    }
  });
});

test('DISCRIMINATION: storing position as float32 would break the round-trip', () => {
  // The mutation this test stands in for is "use setFloat32 for x/y/z". Rather than edit the
  // module, apply the exact lossy step to the fixture and prove the assertion above notices.
  const lossy = Math.fround(INSTANCES[0].worldPosition.x);
  assert.notEqual(lossy, INSTANCES[0].worldPosition.x, 'the fixture must not be float32-clean');
  assert.ok(
    Math.abs(lossy - INSTANCES[0].worldPosition.x) > 0,
    'a float32 store moves the tree; Object.is above is what refuses it',
  );
});

test('a truncated, mis-magicked or mis-counted placement table is refused, not half-read', () => {
  const bytes = fixtureBytes();
  const options = { bindings: BINDINGS, classify: classifyCustomsVegetationPrototype };

  assert.throws(
    () => decodeCustomsPromotedVegetationPlacements(bytes.slice(0, bytes.byteLength - 1), options),
    /is \d+ bytes; \d+ rows need/,
  );
  const wrongMagic = Uint8Array.from(bytes);
  wrongMagic[0] = 'X'.charCodeAt(0);
  assert.throws(() => decodeCustomsPromotedVegetationPlacements(wrongMagic, options), /does not start with/);
  assert.throws(
    () => decodeCustomsPromotedVegetationPlacements(bytes, { ...options, expected: INSTANCES.length + 1 }),
    /the manifest declares/,
  );
  const strayBinding = Uint8Array.from(bytes);
  new DataView(strayBinding.buffer).setUint16(CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES + 40, 900, true);
  assert.throws(
    () => decodeCustomsPromotedVegetationPlacements(strayBinding, options),
    /names prototype binding 900, which does not exist/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest contract, and the two packages that must never be interchangeable.

test('the promoted manifest must declare localOnly: false — the local package is not servable here', () => {
  assert.throws(
    () => validateCustomsPromotedVegetationManifest(fixtureManifest(undefined, { localOnly: true })),
    (error) => error instanceof CustomsPromotedVegetationError
      && error.code === 'ERR_CUSTOMS_PROMOTED_VEGETATION_LOCAL_ONLY',
  );
  // ...and the mirror half of the pair, asserted here so the property is stated in one place:
  // `loadCustomsLocalVegetation` requires `localOnly: true` on every tile payload it reads, so a
  // promoted document cannot travel through the gated loader either.
  const localVegetationSource = readFileSync(resolve(REPOSITORY_ROOT, 'src/customs-local-vegetation.js'), 'utf8');
  assert.match(localVegetationSource, /payload\.localOnly !== true/);
  assert.match(localVegetationSource, /must be the fixed loopback Customs manifest URL/);
});

test('THE CAPTURE RULE: no promoted document may name the raw Unity vegetation dump', () => {
  for (const [label, document] of [
    ['a placement file', fixtureManifest(undefined, {
      placements: { ...fixtureManifest().placements, file: 'terrain-000-vegetation.json' },
    })],
    ['an array index', fixtureManifest(undefined, { arrays: { indexFile: 'terrain-001-vegetation.json' } })],
    ['a nested note', fixtureManifest(undefined, {
      provenance: { placements: { derivedFrom: [{ capture: 'terrain-000-vegetation.json' }] } },
    })],
    ['an object KEY', fixtureManifest(undefined, { 'terrain-000-vegetation.json': true })],
  ]) {
    assert.throws(
      () => validateCustomsPromotedVegetationManifest(document),
      (error) => error.code === 'ERR_CUSTOMS_PROMOTED_VEGETATION_CAPTURE',
      `${label} must be refused`,
    );
  }
  // The scan is a whole-document walk, not a list of fields somebody remembered.
  assert.throws(
    () => assertCustomsPromotedVegetationHasNoCaptureReference({ a: [{ b: { c: 'terrain-123-vegetation.json' } }] }),
    /is a registered raw capture and is never promoted/,
  );
  assert.doesNotThrow(() => assertCustomsPromotedVegetationHasNoCaptureReference({ a: ['terrain-000-height-world-y.f32le'] }));
});

test('the raw capture is still a capture, and therefore still unpromotable', () => {
  // The registry, not this test, is what refuses it — but a promotion pass that widened the
  // registry would make every other assertion in this file quietly weaker, so the tier is pinned.
  for (const name of ['terrain-000-vegetation.json', 'terrain-001-vegetation.json']) {
    const tier = classifyLocalPath(`.local-game-derived/customs/${name}`);
    assert.equal(tier.tier, 'raw-capture', `${name} must stay a raw capture`);
    assert.equal(tier.id, 'unity-vegetation-instances');
  }
  // ...while the surfaces beside them in the same directory stay promotable, so the assertion
  // above is discriminating rather than a blanket "everything local is a capture".
  assert.equal(
    classifyLocalPath('.local-game-derived/customs/terrain-000-height-world-y.f32le').tier,
    'promotable',
  );
});

test('a shape the contract does not admit is refused with the field named', () => {
  const bytes = fixtureBytes();
  const cases = [
    [{ documentType: 'something-else' }, /documentType/],
    [{ schemaVersion: 2 }, /schemaVersion/],
    [{ map: 'woods' }, /must target Customs/],
    [{ distribution: 'local-package' }, /distribution/],
    [{ sourceFrame: 'three-z-up-metres' }, /sourceFrame/],
    [{ arrays: { indexFile: 'arrays/veg-layers.json' } }, /arrays\.indexFile/],
    [{ placements: { ...fixtureManifest(bytes).placements, bytes: 17 } }, /is not header/],
    [{ placements: { ...fixtureManifest(bytes).placements, sha256: 'nope' } }, /sha256/],
    [{ prototypeBindings: [] }, /prototypeBindings/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(
      () => validateCustomsPromotedVegetationManifest(fixtureManifest(bytes, overrides)),
      pattern,
      JSON.stringify(overrides).slice(0, 90),
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The loader, in a simulated production context.

test('THE POINT OF ALL THIS: the pack loads on tarkovzero.com while the local gate stays shut', async () => {
  // A production page: not localhost, and no Vite dev flag. The gate that governs the raw dumps is
  // asked directly, in the same test, so "vegetation ships" and "the boundary moved" cannot be
  // confused for one another.
  assert.equal(
    canLoadLocalGameDerivedAssets({ dev: false, hostname: 'tarkovzero.com' }),
    false,
    'the local game-derived gate must still be shut in production',
  );
  assert.equal(
    canLoadLocalGameDerivedAssets({ dev: undefined, hostname: 'tarkovzero.com' }),
    false,
    'an absent dev flag must never read as permission',
  );

  const fetchImpl = packageFetch();
  const result = await load({ fetch: fetchImpl });
  assert.equal(result.distribution, 'promoted-public');
  assert.equal(result.vegetation.localOnly, false);
  assert.equal(result.vegetation.count, INSTANCES.length);
  assert.equal(result.placements.verified, true, 'the sha256 receipt was actually checked');
  assert.equal(result.baseUrl, '/assets/3d/customs/authored/vegetation/');
  assert.equal(result.arrayBaseUrl, '/assets/3d/customs/authored/vegetation/arrays/');
  // Exactly two requests, both same-origin, both under the package directory.
  assert.equal(fetchImpl.seen.length, 2);
  for (const url of fetchImpl.seen) {
    assert.ok(url.startsWith(`${PRODUCTION_ORIGIN}/assets/3d/customs/authored/vegetation/`), url);
  }

  // DISCRIMINATION: the same gate is still TRUE on a dev loopback page, so the assertion above is
  // measuring the environment rather than a constant `false`.
  assert.equal(canLoadLocalGameDerivedAssets({ dev: true, hostname: 'localhost' }), true);
});

test('a placement table that does not match its receipt is refused, and a missing digest says so', async () => {
  const bytes = fixtureBytes();
  const tampered = Uint8Array.from(bytes);
  // Move one tree by a metre. Nothing about the length changes.
  new DataView(tampered.buffer).setFloat64(CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES, 1234.5, true);
  await assert.rejects(
    load({ fetch: packageFetch({ manifest: fixtureManifest(bytes), placements: tampered }) }),
    (error) => error.code === 'ERR_CUSTOMS_PROMOTED_VEGETATION_INTEGRITY',
  );

  // A page with no `crypto.subtle` (an insecure non-loopback origin) cannot check the digest. It
  // must still load — and must SAY it did not verify, rather than reporting a check that never ran
  // as a check that passed.
  const unverified = await load({ crypto: null });
  assert.equal(unverified.placements.verified, false);
});

test('a short body is refused before it is decoded', async () => {
  const bytes = fixtureBytes();
  await assert.rejects(
    load({ fetch: packageFetch({ manifest: fixtureManifest(bytes), placements: bytes.slice(0, 96) }) }),
    /placement table is 96 bytes; the manifest declares/,
  );
});

test('the promoted loader has no loopback rule, and no credentialed page may drive it', async () => {
  // Four different production-shaped origins all load. This is the assertion that would fail if
  // somebody "hardened" the promoted loader by copying the local one's LOOPBACK_HOSTNAMES set.
  for (const origin of ['https://tarkovzero.com', 'https://tarkovzero.vercel.app', 'http://192.168.1.40:4173']) {
    const result = await load({
      fetch: packageFetch({ origin }),
      location: `${origin}/`,
    });
    assert.equal(result.distribution, 'promoted-public', origin);
  }
  await assert.rejects(
    load({ location: 'https://user:pass@tarkovzero.com/' }),
    /plain http\(s\) page URL/,
  );
  await assert.rejects(load({ location: 'file:///tmp/index.html' }), /plain http\(s\) page URL/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The artifacts actually in `public/`. Skipped only when the promotion has not been run on this
// machine — and the skip is loud, because a silently-skipped check is the failure mode.

const SHIPPED = existsSync(PUBLIC_MANIFEST);

test('THE SHIPPED PACKAGE: the public manifest, the table and the catalog all agree', { skip: SHIPPED ? false : 'public/assets/3d/customs/authored/vegetation/vegetation-manifest.json is absent — run `npm run promote:vegetation`' }, () => {
  const manifest = JSON.parse(readFileSync(PUBLIC_MANIFEST, 'utf8'));
  const validated = validateCustomsPromotedVegetationManifest(manifest);
  const bytes = readFileSync(resolve(PUBLIC_DIR, CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE));
  assert.equal(sha256(bytes), validated.placements.sha256, 'the shipped table matches its own receipt');

  // The catalog half is consumed by the SAME normalizer the localhost path uses, so the promoted
  // package gets the identical 31-family / 58-binding strictness rather than a looser copy.
  const catalog = normalizeCustomsAuthoredVegetationCatalog(manifest);
  assert.equal(catalog.currentFactoryCoverage.complete, true);
  assert.equal(catalog.assets.length, 31);
  assert.equal(catalog.bindings.length, 58);
  assert.equal(catalog.livePromotion, true, 'the promoted package is live, and says so');

  const decoded = decodeCustomsPromotedVegetationPlacements(new Uint8Array(bytes), {
    bindings: validated.bindings,
    classify: classifyCustomsVegetationPrototype,
    expected: validated.placements.count,
  });
  assert.equal(decoded.count, 8805, 'all 8,805 placements ship');

  // Every GLB the catalog names must actually be on disk at the digest it declares — the check
  // that separates "a manifest listing 93 files" from "93 files".
  for (const asset of catalog.assets) {
    for (const lod of asset.lods) {
      const file = resolve(PUBLIC_DIR, ...lod.file.split('/'));
      assert.ok(existsSync(file), `${lod.file} is missing from public/`);
      assert.equal(sha256(readFileSync(file)), lod.sha256, lod.file);
    }
  }

  // The plan the browser will build from this table. `renderedCount` is what the release banner is
  // allowed to claim, and it comes from the shipped bytes rather than from a number typed here.
  const plan = buildCustomsLocalVegetationRenderPlan(decoded, { reliefOriginYM: 0 });
  assert.equal(plan.sourceCount, 8805);
  assert.ok(plan.renderedCount > 8000, `the unscoped plan renders ${plan.renderedCount}`);
});

test('THE SHIPPED PACKAGE: nothing in it is named after, or reachable from, a raw capture', { skip: SHIPPED ? false : 'promotion not run on this machine' }, () => {
  const text = readFileSync(PUBLIC_MANIFEST, 'utf8');
  assert.doesNotMatch(text, /terrain-\d{3}-vegetation\.json/, 'the manifest must not name the capture');
  assert.doesNotMatch(text, /\.local-game-derived|\.local-candidates/, 'nor a local root');
  // `veg-layers.json` and `pack-index.json` are on the verifier's FORBIDDEN_FILE_NAMES; the
  // promoted package regenerates both documents under different names.
  assert.ok(!existsSync(resolve(PUBLIC_DIR, 'pack-index.json')));
  assert.ok(!existsSync(resolve(PUBLIC_DIR, 'arrays/veg-layers.json')));
  assert.ok(existsSync(resolve(PUBLIC_DIR, ...CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE.split('/'))));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The two loaders, driven against each other's package.

test('NEITHER LOADER ACCEPTS THE OTHER PACKAGE', async () => {
  // The promoted loader, handed the LOCAL vegetation shape (a per-tile payload that declares
  // localOnly: true and is not even this document type).
  await assert.rejects(
    load({
      fetch: packageFetch({
        manifest: {
          schemaVersion: 1, map: 'customs', localOnly: true, sourceFrame: 'eft-unity-world-metres-y-up',
          tileId: 'terrain-000', prototypes: [], instances: [],
        },
      }),
    }),
    /documentType/,
  );

  // The local loader, handed the PROMOTED manifest URL. It refuses on the URL alone, before it has
  // looked at a single field — `loadCustomsLocalVegetation` validates the package's `manifestUrl`
  // against the fixed loopback path.
  await assert.rejects(
    loadCustomsLocalVegetation({
      manifest: { schemaVersion: 1, map: 'customs', localOnly: false, sourceFrame: 'eft-unity-world-metres-y-up', reliefOriginYM: 0, tiles: [] },
      manifestUrl: `${PRODUCTION_ORIGIN}${CUSTOMS_PROMOTED_VEGETATION_MANIFEST_PATH}`,
      assets: [],
    }, { fetch: async () => { throw new Error('the local loader must not reach the network here'); } }),
    /manifest failed validation|fixed loopback Customs manifest URL/,
  );
});
