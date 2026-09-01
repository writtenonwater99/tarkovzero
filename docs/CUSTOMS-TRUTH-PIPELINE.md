# Customs truth pipeline

## Opt-in local Unity scalar inventory

`scripts/extract-customs-unity.py` is a read-only evidence tool for a directory of
local Unity game data that the operator is authorized to inspect. It never starts
the game, never loads game assemblies, never calls UnityPy save/export APIs, and
never emits meshes, textures, or raw serialized arrays. Its JSON contains only
scene/object identity, hierarchy, local transforms, and TerrainData resolution,
scale, and aggregate raw-height facts. Keep generated inventories outside both the
game-data directory and this repository; do not commit them.

Install UnityPy in a dedicated Python environment outside the game-data directory:

```bash
python -m venv /path/to/tarkovzero-unitypy-venv
/path/to/tarkovzero-unitypy-venv/bin/python -m pip install UnityPy
```

First validate discovery and the write boundary without importing UnityPy:

```bash
python scripts/extract-customs-unity.py \
  --source /path/to/local/game-data \
  --output /path/outside/game-and-repo/customs-unity-facts.json \
  --acknowledge-local-game-files \
  --dry-run
```

Dry-run is deliberately catalog-only: it searches by exact filename for one
`globalgamemanagers` catalog and does not inspect bundle headers or identify
arbitrary `.bundle`, `.resS`, `resources.assets`, or other serialized files.

Then run the inventory with the environment's Python, removing `--dry-run`. A real
run has two bounded phases:

1. Load only `globalgamemanagers` and parse its BuildSettings scene catalog.
2. Find scene paths containing `/Locations/Custom/`, then load only the exact
   `levelN` and `sharedassetsN.assets` files for those discovered indices.

There is intentionally no broad bundle-scan mode. The output's `sceneFiles` ledger
records each authorized file, role, discovered scene index, and scene path; emitted
scene objects repeat that association as `sourceFile`, `sourceRole`, `sceneIndex`,
and `scenePath`.

The output path must already have an existing parent directory and must be outside
the source tree. Existing output is preserved unless `--force` is explicit. Any
file or relevant-object parse error fails closed without writing; `--allow-partial`
is an explicit override and marks the JSON `complete: false`.

Customs discovery is data-driven: BuildSettings scene paths are slash-normalized,
and paths containing `/Locations/Custom/` contribute their actual build indices to
`customsSceneIndices`. No scene index is hardcoded.

## Opt-in Customs asset census

`scripts/census-customs-assets.py` is the broader companion to the inventory
above. Where the inventory answers "which scenes and terrains exist", the census
answers "what has to be rebuilt, where does it sit, and how often does it
repeat" — enough metadata to reconstruct Customs from original artwork, and
deliberately not enough to reuse any shipped asset.

It reuses the exact same audited two-stage selector (`globalgamemanagers`, then
only the `levelN` / `sharedassetsN.assets` files whose BuildSettings scene path
contains `/Locations/Custom/`). There is no bundle, `.resS`, `resources.assets`,
assembly, or other-map scan, and no code path invokes an executable or a UnityPy
save/export API.

UnityPy never receives an installation path. Each authorized file is opened by
the census through a seekable read-only wrapper whose visible `name` is only the
safe selected basename and whose visible `path` is `""`. Immediately after the
initial `UnityPy.load(stream)` returns—and before object enumeration or parsing—
the environment's `find_file`, `load_file`, `load_files`, `load_folder`, and
`load_assets` methods are replaced with fail-closed blockers. A serialized
pointer can therefore be measured and ledgered but cannot cause UnityPy to open
a dependency.

### What it emits

| Area | Facts |
| --- | --- |
| Identity | object id, path id, name, `normalizedName`, `nameHash` |
| Hierarchy | `hierarchyPath`, `hierarchyPathHash`, `hierarchyComplete`, parent path id |
| Transforms | local position/rotation/scale plus composed `world` TRS |
| Renderers | enabled/shadow flags, `materialSlotCount`, mesh pointer, and resolved material names |
| Meshes | safe name-free skip identity (`asset`, type, path id, reason, serialized byte size when known); no Mesh is parsed |
| Materials | scalar, color and texture-slot properties (names + tiling/offset) |
| Textures | safe name-free skip identity; no Texture2D is parsed |
| LOD groups | level count, per-level screen-relative thresholds, member renderer ids |
| Lights | type, color, range, intensity |
| Source files | role, byte size, SHA-256, and hashed stable-stat identity, verified before and after parsing for both the catalog and every selected scene file |

### What it refuses to emit

Vertices, indices, triangles, UVs, normals, tangents, skin/bind-pose data,
blend shapes, texture pixels, `.resS` stream paths, shaders, shader keywords,
script/bytecode references, animation curves, any raw serialized array or blob,
and absolute installation paths. Four independent mechanisms enforce this:

1. **Never materialize payload-bearing typetrees.** `Mesh` and `Texture2D`
   readers never call `parse_as_dict()`. Each one is recorded in
   `diagnostics.skippedObjects` with a safe, name-free identity and reason. Their
   presence makes `complete: false` and therefore requires `--allow-partial`.
2. **Cap every remaining parse.** Before `parse_as_dict()`, the reader must
   expose a positive serialized byte size no larger than 4 MiB. Unknown or
   oversized objects are safe-skipped before allocation and also make the
   artifact incomplete.
3. **Scrub accepted scalar objects.** Every remaining parsed object is stripped
   of known payload fields (`FORBIDDEN_FIELD_NAMES`) before a census parser reads
   it. The count lands in `diagnostics.droppedForbiddenFieldCount`.
4. **Allowlist on write.** `assert_bounded_payload` walks the finished artifact
   and fails closed on any key outside `ALLOWED_OUTPUT_KEYS`, any binary value,
   any string over 1024 characters, and any scalar array longer than 64 entries.
   Nothing is written if that guard trips.

### Deliberate exclusions

Mesh/Texture2D typetrees are excluded in full because UnityPy materializes their
payload arrays before a post-parse scrub can remove them. Shadow *type* is also
outside the light facts the contract enumerates. The renderer flags that are
emitted (`enabled`, `castShadows`, `receiveShadows`, `motionVectors`,
`staticBatch`) are scalar scene-authoring metadata, not asset payload, and are
kept because reconstruction needs them.

### Running it

Catalog/dry-run mode first — it validates both output paths and locates the
single `globalgamemanagers` without importing UnityPy, loading any scene file,
or writing anything:

```bash
python scripts/census-customs-assets.py \
  --source /path/to/local/game-data \
  --output /path/outside/game-and-repo/customs-asset-census.json \
  --report /path/outside/game-and-repo/customs-asset-audit.json \
  --acknowledge-local-game-files \
  --dry-run
```

Then drop `--dry-run` and use the Python environment that has UnityPy installed.
Both `--output` and `--report` must sit outside the source tree, their parent
directories must already exist, and each destination name must be new. There is
no `--force`: publication uses a fully-written temporary file plus an atomic
no-clobber hard link, so an existing file or a destination race is never
replaced. The safe first release deliberately skips all Mesh and Texture2D
objects, so a normal real run must explicitly include `--allow-partial`:

```bash
python scripts/census-customs-assets.py \
  --source /path/to/local/game-data \
  --output /path/outside/game-and-repo/customs-asset-census.json \
  --report /path/outside/game-and-repo/customs-asset-audit.json \
  --acknowledge-local-game-files \
  --allow-partial
```

`--allow-partial` never relaxes catalog trust: if `globalgamemanagers` cannot be
size-gated, parsed, or proven byte/stat-identical before and after the read, no
scene selection is trusted and nothing is published. For selected scene files,
every load failure, parse failure, safe skip, source-binding failure, and denied
dependency is recorded in the incomplete artifact's diagnostics.

### Audit report

`--report` writes a second artifact that ranks repeated asset families. A family
is keyed by the SHA-256 of `{normalizedName, materialSlotCount, submeshCount,
vertexCount, rounded bounds extents}` — with the Mesh-derived fields absent in
this safe release — so `Barrier_Concrete` and
`Barrier_Concrete (1)` collapse into one family with `instanceCount: 2`. Each
row carries its instance count, scene spread, and at most three example
hierarchy paths; no payload, pointer blob, or absolute path appears. Use it to
decide which props to model first: the top rows are the ones that repeat most
across Customs.

### Known limitations of Unity serialized references

- Pointers carry `{fileId, pathId}`. This matters more than it sounds: Unity
  keeps the scene graph in `levelN` but the `Mesh`/`Material`/`Texture2D`
  objects in `sharedassetsN.assets`, so essentially every renderer pointer in a
  real build has a **non-zero** `fileId`. The census resolves those through the
  serialized file's external-reference table, but only when its full normalized,
  owner-relative path identity exactly names another file already inside the
  authorized Customs selection. A basename match elsewhere in the tree never
  resolves. Missing, inconsistent, malformed, out-of-range, or unauthorized
  external identities are ledgered in `diagnostics.dependencyFailures`, make the
  artifact incomplete, and never widen the files opened.
- A pointer naming any other file is classified `external`, counted in
  `references.externalPointerCount`, and never opened. A pointer into an
  authorized file can still fail to resolve if its target type is outside
  `CENSUS_OBJECT_TYPES` or the id dangles;
  `references.unresolvedInternalPointerCount` reports that separately. An empty
  slot (`pathId == 0`) is not a reference at all and is counted as neither.
- The ledger covers renderer mesh/material and material texture pointers.
  LODGroup member and GameObject component pointers are emitted as identity but
  are not counted in it.
- `materialIds` and `materialNames` are **slot-aligned**: index *i* is always
  material slot *i*, with `null` where the slot is empty or unresolved. Do not
  compact them.
- `world` transforms are composed from the local TRS chain and are only emitted
  when `hierarchyComplete` is true. Where a rotated parent has non-uniform
  scale, the composed scale is a lossy approximation and `world.worldExact` is
  `false` — the same caveat Unity's own `lossyScale` carries.
- Parent chains are not trusted. A transform whose parent is missing, or a pair
  of transforms that name each other, yields `hierarchyComplete: false` and no
  `world` block rather than a crash; chains deeper than `MAX_HIERARCHY_DEPTH`
  (128) are truncated the same way.
- This release emits no mesh name, vertex/submesh count, or local bounds and no
  texture name or dimensions. Consequently renderer mesh pointers and material
  texture pointers remain unresolved even when their target file identity is
  authorized. That loss is intentional: a streaming scalar-only reader would
  need a separately audited implementation before those facts can return.
- `hierarchyPath` is truncated to 1000 characters (keeping the most specific
  tail, prefixed `…/`) so that a deeply nested prefab chain cannot trip the
  payload guard and abort the run. `hierarchyPathHash` always covers the full
  untruncated path, so it stays a reliable identity.
- A transform component that fails to parse (NaN/Inf/missing) never silently
  becomes an identity value: the composed `world` block is marked
  `worldExact: false` instead.
- Names are not unique identifiers in Unity. `normalizedName` is a grouping aid,
  not an asset key; `objectId` (asset + type + path id) is the stable identity.

Tests use only synthetic in-memory fake objects — `npm run test:customs-census`
never needs, and must never be pointed at, real game files.
