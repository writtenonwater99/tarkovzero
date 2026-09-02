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

## Opt-in mesh local-bounds reader

`scripts/extract-customs-bounds.py` is the separately audited streaming reader
the census note above defers to. It returns the one Mesh-derived fact the census
refuses to compute — `m_LocalAABB` — and nothing else. Walls need measured
heights and buildings need measured footprints; both are this reader's output.

Its contract is `docs/plans/BOUNDS-SPIKE-FINDINGS.md`. Read that before changing
anything here.

### How it avoids the payload

It never calls `parse_as_dict()` on a Mesh. It walks the **pinned typetree with a
logical cursor**: skipping a field is pointer arithmetic, so `m_IndexBuffer`,
`m_VertexData.m_DataSize`, the ten `PackedBitVector`s of `m_CompressedMesh` and
both baked collision meshes are stepped over with no seek, no read, and no
allocation, whatever their size. The only physical reads are 4-byte array/string
counts, the 24-byte `m_LocalAABB`, and one 24-byte `SubMesh.localAABB` per
submesh. On the self-test's 12.8 MiB synthetic object that is **34 reads / 216
bytes — 0.0016%**.

Four bounds enforce that structurally, all inside the stream wrapper rather than
in the walk's good intentions:

| Bound | Value | What it stops |
| --- | --- | --- |
| `MAX_SINGLE_READ_BYTES` | 64 | one bulk read of an array |
| `MAX_TOTAL_READ_BYTES` | 8192 per object | a reader that walks instead of skipping |
| `ALLOWED_READ_WIDTHS` | `{4, 24}` | any read the design does not describe |
| `ALLOWED_READ_KINDS` | `count`, `aabb`, `submesh-aabb` | an untagged read; untagged bytes are counted as `payloadBytesRead` and refuse |

A vertex buffer does not fit in that budget, by construction. The self-test's
negative control replaces the skip primitive with one that reads: the reader does
not produce a slow correct answer, it **refuses**.

### The three non-negotiable guards

1. **The read budget**, above.
2. **`assert_end_offset`** — the walk must traverse the whole object and land
   exactly on its declared last byte. Catches every *length-changing* schema
   divergence.
3. **`assert_submesh_agreement`** — `m_LocalAABB` must equal the union of the
   per-`SubMesh` `localAABB`s (2 cm + 2% tolerance), which are stored before every
   payload array. This is the **only** guard that survives a *length-preserving*
   layout shift. Spike §4 reproduces one: `m_MeshUsageFlags` (4 bytes) moved
   across the AABB satisfies the checksum and emits extents `(0.0, 7.05, 2.15)`
   against a truth of `(7.05, 2.15, 1.52)` — finite, non-negative, plausible, and
   wrong. `test_mutation_removing_the_cross_check_lets_the_wrong_answer_through`
   pins exactly that. A reader with the checksum alone is not safe, it is lucky.

A mesh whose `m_LocalAABB` was authored by hand and legitimately differs from the
submesh union is **refused**. That is the conservative direction, but it means
the refusal ledger is a **coverage gap**, never evidence that no such mesh exists.

Do not tune the plausibility gates (`MAX_ABS_EXTENT_METRES`, the non-finite and
negative-extent checks) against fixtures whose filler is noise: spike §4 shows a
zeroed neighbour — which is what real meshes ship — makes a shift decode into
plausible numbers that every cheap gate passes.

### Abort, never skip

**The schema is per-version, not per-object.** One structural divergence means
the pin is wrong for the whole file. Every refusal except the six in
`SKIP_REASONS` **aborts the run and writes nothing** — a per-object skip would
quietly turn a systematic schema error into a partial roster that looks fine.
`--allow-partial` does not override an abort.

The six ledgered skips are genuinely per-object acquisition facts, and each is
raised either *before* the walk starts (missing declared size, missing object
offset, unavailable typetree, object outside the file, non-positive size) or
*after* all three structural guards have passed. That last case is
`external-stream-reference`: a `.resS` reference is **deferred** rather than
refused where it is detected, because under a wrong schema the four bytes at the
stream-path offset are garbage and non-zero with near-certainty, and refusing
there would let a systematic schema error present itself as a mass of benign
per-object skips. The path bytes are stepped over and never read either way.
`test_skip_reasons_cannot_mask_a_schema_error` pins the ordering.

### Layout assumptions, and how a wrong one is detected

| # | Assumption | Detected by | Residual |
| --- | --- | --- | --- |
| 1 | Little-endian | explicit refusal in `assert_pins` | none |
| 2 | Exact Unity version | `--pin-unity-version`, compared to the string read off the serialized file | none |
| 3 | Exact `Mesh` field order | end-offset checksum (length-changing) + submesh cross-check (length-preserving) | a shift that preserves length **and** the AABB↔submesh relationship |
| 4 | Typetree provenance | `--pin-typetree-sha256` over the rebuilt node tree; the artifact reports `file-embedded` vs `library-generated` | a stripped-typetree build takes its schema from UnityPy's generated database — a third-party schema for a third-party-selected file (see below) |
| 5 | One typetree for the whole file | the per-object pin comparison, which refuses a second distinct hash as `unpinned-typetree`; `typetree-divergence` is a second layer *behind* it, reachable only if the pin check is removed | none |
| 6 | Align = 4 bytes, base = object start | `--align-base {object,file}`; a wrong base surfaces as an end-offset or count refusal, never a guess | the fixture cannot settle which base UnityPy actually uses — the operator run does |
| 7 | `SubMesh.localAABB` exists (Unity 2017.3+) | `assert_typetree_shape` refuses `no-submesh-crosscheck` before any read | a build without it has **no** length-preserving-shift defence and must not be read |
| 8 | `m_StreamData.path` exists | `typetree-missing-required-node` | a build without it has no `.resS` defence |
| 9 | The declared serialized byte size is trustworthy | `object-outside-file`, `field-overruns-object` | a size that is wrong but self-consistent |

**Row 4 deserves saying out loud in the run's evidence.** If EFT's files ship with
typetrees stripped, the schema does not come from the file — it comes from
UnityPy's version-keyed database, and the same library that selects the files
would also supply the schema for reading them. The mitigation is that schema is
not identity: the *numbers* still come from the file's own bytes, and the submesh
cross-check validates the schema against the file's own internal redundancy
rather than against the library's say-so. The artifact records which provenance
was used. Do not let it pass silently.

**Flipping `--align-base` is a diagnostic, not a fix.** A run that needed it must
say so in its evidence.

### Reader bounds that can abort a legitimate file

Three refusals are limits of *this reader*, not evidence that the pinned schema is
wrong. All three abort the run (they are not in `SKIP_REASONS`), so an operator who
reads them as "the pin is bad" will chase the wrong thing. In rough order of how
likely they are to fire on real Customs meshes:

| Reason | Bound | When a legitimate mesh trips it |
| --- | --- | --- |
| `submesh-count-implausible` | `MAX_SUBMESH_CROSSCHECK` = 64 | Unity permits far more than 64 submeshes. A legitimately multi-material mesh aborts the run. |
| `variable-element-budget-exceeded` | `MAX_VARIABLE_ELEMENTS` = 512 | variable-length array elements must be iterated, not bulk-skipped; a mesh with hundreds of blend-shape channels reaches this. |
| `implausible-bounds-magnitude` | `MAX_ABS_EXTENT_METRES` = 4096 | a mesh authored in centimetre units, or a genuine skybox-scale shell. |

The conservative direction is deliberate — the reader refuses a layout it cannot
police rather than guessing — but the diagnosis differs from a schema error. If
one of these fires, the fix is a reviewed, tested bound change, never a pin
change, and never a demotion of the refusal into `SKIP_REASONS`: raising a bound
widens what the cross-check must police, so it is a change to a guard and gets
the same scrutiny as one.

### Output

`{pathId, localAabb: {center: {x,y,z}, extents: {x,y,z}}}` plus source-file
identity and per-object instrumentation. Every record key is **already** in the
census's `ALLOWED_OUTPUT_KEYS` — no widening of that guard
(`test_record_keys_are_already_in_the_census_allowlist` proves the containment);
spell it `center`, US spelling, because `centre` is not allowlisted. The envelope
adds a small reviewed set of pin, instrumentation and refusal-ledger keys, and
the whole artifact is walked by the same fail-closed allowlist guard before any
write. Publication is a fully-written temporary file plus an atomic no-clobber
hard link, outside both the game tree and this repo, with no `--force`.

### Running it — the two commands

Stage 1 opens no serialized file, imports no UnityPy, and writes nothing. It
validates the paths and the pins and runs every synthetic guard case **in the
same process at the same commit** — a reader whose guards are not exercised in
the run has not demonstrated them.

```bash
python scripts/extract-customs-bounds.py \
  --source /path/to/local/game-data \
  --output /path/outside/game-and-repo/customs-mesh-bounds.json \
  --acknowledge-local-game-files \
  --pin-unity-version <exact version string> \
  --pin-typetree-sha256 <64 hex chars of the reviewed Mesh node tree> \
  --self-test \
  --dry-run
```

Stage 2 is the same command with the environment's UnityPy Python, minus
`--dry-run`. Add `--allow-partial` only if stage 2 reports ledgered skips you
have read and accepted.

```bash
/path/to/tarkovzero-unitypy-venv/bin/python scripts/extract-customs-bounds.py \
  --source /path/to/local/game-data \
  --output /path/outside/game-and-repo/customs-mesh-bounds.json \
  --acknowledge-local-game-files \
  --pin-unity-version <exact version string> \
  --pin-typetree-sha256 <64 hex chars of the reviewed Mesh node tree> \
  --self-test
```

Getting the two pin values is part of the run, not a prerequisite: the version
string comes from the catalog, and the typetree hash is what stage 2 reports when
it refuses with `unpinned-typetree` — review the node tree that produced it
before pinning it.

**Evidence the run must produce, or it does not count:** the self-test block all
green (including `f/checksum-alone-is-blind`, `f/crosscheck-catches-shift` and
both negative controls); the exact Unity version string and its equality
assertion; the typetree provenance and SHA-256; per object `pathId`, `center`,
`extents` and `physicalReads` / `bytesRead` / `maxSingleRead` /
`payloadBytesRead: 0`; the aggregate `bytesReadRatio` (expect < 0.0001 — a ratio
in the percent range means the reader is walking something and the run is void);
the refusal ledger with reason counts; and the before/after SHA-256 plus
stat-identity binding on every file touched.

### What a clean run does and does not establish

**Does.** That these mesh *resources* have these local bounds. It kills the
barrel-scored-as-wagon failure outright (0.9 m vs 14.1 m), turns "6 m container"
from a name token into a measurement, and makes part-vs-placement a physical
question rather than a lexical one.

**Does not.** It does not establish **placement** — an AABB is a property of the
mesh asset and does not prove a matching GameObject is placed, active and visible
rather than a child, collider, LOD node or inactive placeholder. It does not give
a **world footprint** directly: `m_LocalAABB` is local and pre-transform, so a
world extent needs the census's composed world scale, must be labelled derived,
and over-estimates under a rotated non-uniform scale — carry `worldExact`
alongside it. It does not give **independence**: same acquisition layer, same
selector, same library, so agreement with the second source is still not
validation. Bounds are a **filter that removes size-impossible candidates**, never
a promoter that creates confirmed objects. A measured 14.1 m object is a better
candidate, not a confirmed wagon.

Tests are synthetic fixtures written into a temp directory plus fake in-memory
Unity objects — `npm run test:customs-bounds` never needs, and must never be
pointed at, real game files. Every refusal reason the reader can raise has a test,
and every guard is mutation-proved: the suite patches the guard away and asserts
what the mutation actually costs. That cost is not the same for all of them, and
the tests say which is which — removing the submesh cross-check lets a *wrong
answer* through (`test_mutation_removing_the_cross_check_lets_the_wrong_answer_through`),
while removing the non-finite submesh check only degrades the *reason code* from
`non-finite-submesh-bounds` to `submesh-bounds-disagree`, because `min`/`max` drop
a NaN and the partial union still disagrees. A guard that merely sharpens a
diagnosis is still worth having — a structural reason code tells the operator the
pin is wrong for the whole file — but the suite does not claim it prevents a wrong
answer.
