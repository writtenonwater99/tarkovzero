# Customs Asset Factory — Manifest v2 foundation

**Status:** landed as a tested seam. Catalogs ship empty; Customs draws its procedural scene.

## Why v2

v1's `scene-manifest.json` was a flat `chunks` array whose only real invariant was "has a `url`
and a `stableId`". That is enough to drop a GLB into a scene, and not nearly enough to let
near-1:1 authored geometry into a scene that is *already* drawing a procedural approximation of
the same ground. The failure modes v1 could not prevent, all of which look like "the map is
broken" to a player:

- **Overlapping proxies.** An authored warehouse lands on top of the procedural one. Two meshes,
  two shadows, two raycast hits, and a marker that seats on whichever floor won.
- **Broken floors.** A chunk with no floor tag is invisible to `visibleForFloor` and the floor
  resolver, so the 2/3/U floor filter silently stops applying to a third of the map.
- **Broken picking.** A 120k-triangle authored mesh becomes the raycast target because nothing
  said it should not be.
- **Silent budget blowout.** Nothing declared bytes or triangles, so the only way to discover a
  40 MB LOD0 was to ship it.
- **A hole in the map.** The nastiest one: hide the procedural building, then fail the download.

## Shape

```
schemaVersion: 2, map, frames, scope, budgets, generator?, notes?
evidence   { sources[], observations[] }          <- truth data. Never fetched by the renderer.
delivery   { baseUrl, materials[], assets[], instances[], cells[], replacements[] }
```

Evidence and delivery are separated on purpose, and the separation has teeth: **delivery may only
reference evidence by ID.** Every material and every asset carries a `sourceId` that must resolve
into `evidence.sources`, and the licence receipt (holder, licence, licence URL, retrieval date)
lives only on the evidence side. A test asserts no licence receipt leaks into `delivery`. Survey
and measurement records live in `evidence.observations`, keyed to the same sources, so "what we
measured" never travels as if it were "what we ship".

`normalizeCustomsAssetManifest()` returns a deep-frozen, fully-resolved document: rotations and
scales are materialized to their defaults, bounds carry derived `sizeM`/`centerM`, cells carry
derived `boundsM`, and `totals` carries declared bytes and LOD0 triangles.

### What is checked, and why

| Area | Rejected |
|---|---|
| Version / map | anything but `schemaVersion: 2`, `map: "customs"`; any unknown field at any level |
| Frames | any deviation from `eft-unity-world-metres-y-up` → `three-z-up-metres` via `[-x, -z, y]` |
| URLs | schemes, absolute paths, `..`, `%`-escapes (which hide `..`), backslashes, queries, fragments, empty/dot segments, and anything but a self-contained `.glb` LOD. Evidence URLs must be credential-free https |
| Cross-origin | `resolveCustomsAssetUrl` re-checks at resolve time: same origin as the document *and* under `delivery.baseUrl` — the second gate is against a hostile base, not a hostile string |
| Identity | duplicate IDs at every level, duplicate instance `stableId`, one LOD URL claimed by two assets, or a `kind: "unique"` asset placed anything other than exactly once |
| References | unknown source / material / asset / cell / instance / LOD level; an instance whose `floor` its asset does not declare |
| Cells | an instance not claimed by exactly the cell it names, an instance claimed by two cells, an instance outside its cell's XZ or Y range, a cell outside `scope` |
| Axes | `upAxis` and `forwardAxis` sharing an axis letter (ambiguous — leaves the third axis undetermined), non-metre units, missing pivot |
| Pivot | a `base-center` pivot whose bounds are not seated at the origin, a `bounds-center` pivot whose bounds are not centred. A pivot declaration that disagrees with the bounds makes seating a guess |
| Bounds | inverted, degenerate, non-finite, or beyond ±4 km |
| Transforms | zero or negative asset-local scale, rotations beyond ±360°, non-finite positions. The required EFT→runtime handedness reflection is carried by the complete matrix and is not expressed as a negative instance scale |
| LOD | a chain whose triangles or bytes do not **strictly fall**, or whose switch distance does not strictly rise; levels out of order; an empty chain |
| Proxies | `lod-mesh` picking with no level, a level with a non-mesh shape, a shadow LOD on an asset that does not cast, a missing collision declaration |
| Masks | empty, unknown, or duplicated floor tags; a non-boolean `interior` |
| Replacements | unresolved instance IDs, an empty instance list, two entries retiring the same feature, a target feature claimed with the wrong instance feature identity, **and an instance that claims a `featureId` with no replacement entry** — otherwise the procedural original draws underneath it forever. One authored instance may legitimately retire several distinct procedural fragments of the same real object |
| Budgets | declared bytes over `totalBytes`; per-cell bytes or LOD0 triangles over the per-cell budgets; per-cell budgets over the totals. Prototype bytes are charged once per cell, triangles once per instance, which is what the GPU actually draws |

An empty v2 manifest is valid and sets `proceduralFallback: true`.

## Runtime (`src/customs-asset-runtime.js`)

Pure except for one small mutable ledger.

- `createCustomsAssetRegistry` — indexes assets, cells, instances, prototypes and replacements.
- `planCustomsAssetFrame` — visible cells and a per-instance LOD for a camera position, plus the
  deduplicated fetch list and its byte/triangle cost against the manifest's own budgets.
- **Hysteresis on both decisions**, 8%: going coarser needs `d > maxDistance × 1.08`, going finer
  needs `d ≤ maxDistance × 0.92`, and the same band guards cell visibility. A long jump walks the
  chain one *confirmed* step at a time, so it still lands on the right level. A test dithers a
  camera 3% either side of a boundary forty times and asserts the LOD never moves.
- `customsAssetLinearMatrix` — the complete asset-local → EFT → runtime transform. It maps the
  declared authored up/forward axes into EFT, applies Unity's Z-X-Y instance rotation, then applies
  the exact `[-x, -z, y]` frame map. The result has determinant **−1**, preserving the source's
  asymmetric left/right detail across the required handedness change; a quaternion cannot represent
  it, so the renderer assigns the full matrix with `matrixAutoUpdate = false`. Positive scale is
  applied in asset-local axes. Cardinal yaws, arbitrary rotations, orthogonality, determinant, and
  mirrored point motion are pinned by tests rather than by eyeballing a building in the browser.
- `createCustomsAssetAttachmentLedger` / `resolveProceduralSuppression` — **the point of the
  module.** A procedural feature is suppressed only when *every* authored instance replacing it is
  in state `attached`. Loading, failed, never-requested, or detached all leave the proxy standing,
  with the reason. The failure mode of authored assets is "you see the old approximation", never
  "you see a hole".

## Loading (`src/customs-asset-loader.js`)

- `createCustomsAssetLoaderHost` — GLTFLoader + KTX2Loader + MeshoptDecoder built **once**, lazily,
  and only if something will actually be fetched. v1 built a KTX2 transcoder (worker pool + wasm)
  per manifest load and disposed it in a `finally`. Disposal is idempotent, and disposal that lands
  while `create()` is still in flight still tears the loaders down.
- `runCustomsAssetLoadPass` — bounded concurrency (asserted by a peak-in-flight counter), abortable,
  and every request gets exactly one outcome. One failure does not cancel the pass, because a
  partially loaded scene is the normal case. Aborts are reported as `aborted`, never as `failed`:
  a torn-down view must not look like a broken one.
- `createCustomsAssetCache` — a prototype placed forty times is fetched once, in-flight promises
  included. A failed fetch is evicted so the next pass can retry.
- `loadVerifiedCustomsGlb` — fetches with same-origin credentials, checks an optional response
  `content-length`, then binds the received byte length and SHA-256 to the manifest receipt **before**
  handing any bytes to `GLTFLoader.parseAsync`. A mismatch never reaches the glTF parser.
- `applyCustomsAssetPlan` — drives the ledger. An `attach` hook that throws is a **failure**, not a
  silent success, or the proxy would be retired under geometry that never entered the scene.

## Renderer integration (`src/map3d-three.js`)

`createAuthoredAssetStreamer` is a view-lifetime controller holding the validated manifest,
registry, attachment ledger, current hysteretic plan, and one coalesced pending camera update. The
real `OrbitControls.target` is mapped back from runtime `[-x,-z,y]` to canonical EFT x/z on every
controlled or user camera change. Passes never overlap: a newer target replaces the pending target,
then runs immediately after the in-flight pass settles.

Plan diffs detach leaving or re-LODing nodes synchronously, restore their procedural fallback before
the next loader await, and suppress again only after the replacement is attached. Suppression is a
full synchronization, not an ever-growing set; floor changes and world rebuilds restore baseline
visibility and then reapply only the ledger's current justified set. Loader-host, byte/hash, parse,
and attach failures are collected from the ledger without duplicates in
`renderStats().authored.errors`.

Each attached node uses the complete reflected affine matrix, carries `stableId`, `featureId`, floor,
interior and LOD metadata, follows the floor selector, applies its declared shadow policy, and either
uses its declared mesh-picking LOD or a real invisible box/sphere raycast proxy. The loader host and
decoded cache live for the whole view and are disposed exactly once by the view owner.

## Staged for the next pass

Named honestly rather than faked:

1. **Instanced procedural suppression.** Buildings, props and floor surfaces are individual nodes
   and are retired now. Trees, rocks and understory are `InstancedMesh`; removing one instance
   means rebuilding the buffer. Suppression synchronization retains those proxies and the feature
   is reported as retained.
2. **`hide-mesh` vs `hide-mesh-and-picking`.** `visibleInteractionData` walks ancestors for
   `visible === false`, so hiding a node currently removes its hit too. Both policies validate and
   round-trip; a hidden-but-still-pickable path is not yet distinct in this renderer.
3. **Refcounted cache eviction.** Prototype placements are `clone(true)` and share the cached
   glTF's geometry and materials, so `detach` removes without disposing. Real eviction needs
   refcounting against the cache.
4. **Authored floor-surface contribution.** The measured resolver still owns quest/player seating.
   An authored model may replace a floor proxy visually, but it does not yet publish navigable
   floor planes back into that resolver.
5. **Collision execution.** Collision policy is declared and carried to the attached node/picking
   proxy; this overview renderer has no physics/navmesh consumer yet.
6. **Independent proxy LOD fetches.** A shadow or `lod-mesh` picking policy only activates when its
   declared LOD is the currently streamed visual LOD. The fail-safe is no cast/pick, not a separate
   hidden fetch.
7. **GPU-side instancing.** `registry.instancesByAsset` groups placements per prototype; the
   renderer still adds one node per placement.

## Tests

```bash
npm run test:asset-manifest   # validation and cross-entity contract
npm run test:asset-runtime    # planning, hysteresis, transforms, loading, integrity, the gate
npm run test:assets-v2        # both
npm run test:three-renderer   # seating, camera streaming, suppression, floor and UI integration
```

The pure manifest/runtime/loader suites use no network, game files, or local-derived package. The
renderer suite imports Three for matrix/raycast integration but still uses no browser GPU or network;
the streamer takes manifest, fetch, loader and attach behaviour by injection, which is why camera
coalescing, abort, failures, hysteresis and fallback restoration are deterministic tests.
