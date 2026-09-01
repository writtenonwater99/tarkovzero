# `scripts/extract-customs-industrial-roots.py` — implementation specification

**Status (2026-09-01):** implemented and under test (`npm run test:customs-industrial-roots`,
121 synthetic tests, no game file ever opened). **Never run against game files** — the single
gated real run belongs to the operator. This document is the contract a reviewer rejects
against; where it and the code disagree, the code is the defect *or* this document is, and one
of the two is fixed in the same change.

> ## ⚠️ What this tool's output IS — read before quoting any number from it
>
> **Decision 2026-09-01, after an external red team.** There is **no independent identity source
> in this repository**. `extract-customs-industrial-roots.py` imports `census-customs-assets.py`,
> which imports `extract-customs-unity.py` as its selector; and the "second source"
> (`scripts/customs-industrial-second-source.mjs`) reads a dump that *that same selector*
> produced. The two share an acquisition layer, so **agreement between them is not validation**.
>
> The output is therefore redefined. It is no longer "the truth about the Customs rail yard". It
> is a **conservative candidate roster** — a retrieval and coordinate-correlation aid, to be
> confirmed later against **geo-tagged in-game photographs**: EFT writes world position and camera
> quaternion into the screenshot filename (see `CLAUDE.md`, "Screenshot filename"), so a survey
> raid produces independently-sourced evidence that this pipeline cannot manufacture.
>
> Design consequence, and it is the governing one: **an artifact that overstates its own authority
> is the primary failure mode.** Every count carries its uncertainty; nothing may read as a settled
> fact about the game. The artifact says so itself (`artifactKind`, `establishes`,
> `doesNotEstablish`, and `awaitingVisualConfirmation` on the document and on every row), the
> row set is called `candidates`, and a run that lost any geometry is `inconclusive` by
> construction.
>
> The verdict machinery stays, because **contradicting** the claim is exactly what a shared
> acquisition layer can still do honestly: a count this instrument cannot reach is evidence
> against a claim that asserts it. It may never present itself as the final word.
>
> Also established, and not to be re-litigated without evidence:
>
> * The handoff's "3 closed / 2 tank / 1 hopper / 2 six-metre red containers" has no artifact
>   behind it and is contradicted, **in the same direction**, by both instruments.
> * Body type IS explicit in EFT names (`Vagon_tank`, `Vagon_hopper`, `Vagon_shutted_closed`,
>   `Vagon_gondola_small`/`_large`), and colour partly so (`container_6m_Red_close`,
>   `Vagon_tank_green`, `Vagon_hopper_black`). A **gondola** family exists that the claim never
>   listed. But an explicit name proves a **label** is separable, **not** that the GameObject
>   wearing it is a placed wagon rather than a child, a collider shell, an LOD node, or an
>   inactive placeholder.
> * Only this tool's output may drive any rewrite of the two stale landmark mapping literals
>   (§10), and only after a non-inconclusive run. The nine-proxy mapping stays disproven.

---

## 0. Why this tool exists

`docs/CONTINUATION-HANDOFF-2026-08-31.md` §"Important correction: industrial identities" asserts:

> The truthful first set is three closed freight wagons, two tank wagons, one hopper wagon, and
> two 6 m red containers.

That sentence is the **only** place that claim exists. There is no extractor, no receipt, and no
artifact on disk that produces it, and its author confirms it is an assertion rather than a
reproducible pipeline result. Meanwhile two literals still encode the *superseded* nine-proxy
mapping (`scripts/customs-industrial-admission-plan.mjs:90` and
`scripts/industrial-prop-asset-factory/build_proof.py:23`), and three authored asset families
(closed wagon, hopper wagon, 6 m container) are queued to be built against whichever of these two
answers is right.

This tool replaces both with a receipt: a reproducible, scalar-only measurement of **which placed
industrial objects actually stand inside the `customs-industrial-rail-yard` scope**, carrying its
own falsification test so a run can *contradict* the handoff rather than only confirm it.

It is a measuring instrument, not a labeller. Where the available evidence cannot separate two
identities, the correct output is "not separable" — recorded as a first-class result, not papered
over with a plausible guess.

---

## 1. Non-negotiable constraints (restated precisely)

These are copied forward from `docs/CUSTOMS-TRUTH-PIPELINE.md` and from the audited behaviour of
`scripts/census-customs-assets.py`. A reviewer should reject the implementation on any one of them.

### 1.1 Selection — the same audited two-stage selector, unmodified

1. Open **only** `globalgamemanagers`, located by `selector.discover_catalog_files(source_root)`
   (exact filename match, symlink-refusing, `_path_is_inside` bounded). Exactly one catalog must be
   found; two or more is a hard error telling the operator to narrow `--source`.
2. Parse its `BuildSettings` scene catalog. Slash-normalize every scene path; the rows whose path
   contains `/Locations/Custom/` contribute **their actual build indices**.
3. Open **only** the exact `level<N>` and `sharedassets<N>.assets` files those indices name, via
   `selector.discover_customs_scene_files(source_root, catalog["sceneCatalog"])`.

Forbidden, without exception:

- Any hardcoded scene index. The index is data, always.
- Any bundle, `.resS`, `resources.assets`, assembly, `.dll`, or other-map scan.
- Any UnityPy save/export API (`save`, `export`, `Texture2D.image`, `Mesh.export`, …).
- Handing UnityPy an install path. UnityPy sees only `_SafeUnityStream`, whose visible `name` is
  the sanitized basename and whose visible `path` is `""`.
- Widening the file set for any reason, including a dependency pointer. Immediately after each
  `UnityPy.load(stream)` returns and **before** touching `environment.objects`, replace
  `find_file`, `load_file`, `load_files`, `load_folder`, `load_assets` with fail-closed blockers
  and verify the replacement took (`census._disable_dependency_loading`).

Reuse, do not re-implement: import `census-customs-assets.py` the way it imports
`extract-customs-unity.py` —

```python
def _load_census_module() -> Any:
    script = Path(__file__).with_name("census-customs-assets.py")
    spec = importlib.util.spec_from_file_location("census_customs_assets", script)
    ...
census = _load_census_module()
selector = census.selector
```

and take from it: `discover_catalog_files`, `discover_customs_scene_files`,
`load_build_settings_catalog`, `_SafeUnityStream`, `_open_bound_unity_stream`,
`_disable_dependency_loading`, `_capture_file_binding`, `_verified_file_fact`, `_parse_gate`,
`_scrub_payload_fields`, `_forbidden_fields_for`, `FORBIDDEN_FIELD_NAMES`,
`MAX_PARSED_OBJECT_BYTES`, `NEVER_PARSE_TYPES`, `normalized_name`, `_parse_game_object`,
`_parse_transform`, `_parse_renderer`, `_parse_lod_group`, `_parse_material`, `_parse_mesh_filter`,
`_hierarchy`, `_world_transform`, `_finalize_game_objects`, `_link_renderers`, `_link_materials`,
`_publish_json_noclobber`, `_json_payload`, `_safe_error_type`, `_sha256_text`.

Re-implementing any selector or guard is a rejection. A second copy of a security-relevant loop is
a second place to get it wrong.

### 1.2 Scalars only — the four enforcement mechanisms, all four

1. **Never materialize payload-bearing typetrees.** `ROOTS_OBJECT_TYPES` is
   `{GameObject, Transform, RectTransform, MeshFilter, MeshRenderer, SkinnedMeshRenderer,
   Material, LODGroup}`. `Mesh` and `Texture2D` are **not in the set at all** — they are counted
   in `counts.skippedNonRootsObjects` and never reach the parse gate. `NEVER_PARSE_TYPES` is kept
   as a belt-and-braces assertion: if a reader whose type is in it ever reaches `_parse_gate`, that
   is a programming error and must raise, not skip.
   *Consequence worth stating:* unlike the census, a healthy run of this tool is `complete: true`
   and does **not** require `--allow-partial`. The Mesh/Texture2D skip ledger disappears because
   those objects are never selected, not because they are parsed.
2. **Cap every remaining parse.** Before `parse_as_dict()`, the reader must expose a positive
   serialized byte size ≤ `MAX_PARSED_OBJECT_BYTES` (4 MiB). Unknown or oversized → safe-skip with
   a name-free identity, artifact incomplete.
3. **Scrub accepted objects.** `census._scrub_payload_fields(data, dropped, _forbidden_fields_for(type))`
   before any parser reads the dict. Count lands in `diagnostics.droppedForbiddenFieldCount`.
4. **Allowlist on write.** A local `assert_bounded_payload(payload, allowed=ROOTS_ALLOWED_OUTPUT_KEYS)`
   walks the finished artifact and fails closed on any key outside the allowlist, any binary value,
   any string > 1024 characters, any scalar array > 64 entries, and any non-finite number. Nothing
   is written if it trips.
   *Because this walker is a second copy of the census's, a test must assert both walkers behave
   identically on a shared corpus of adversarial payloads.* Divergence between two copies of a
   guard is the failure mode this note exists to catch.

Never emitted, under any flag: vertices, indices, triangles, UVs, normals, tangents, skin/bind-pose
data, blend shapes, texture pixels, `.resS` stream paths, shaders, shader keywords, script/bytecode
references, animation curves, any raw serialized array or blob, and any absolute installation path.

### 1.3 Output boundary

- `--output` and optional `--report` must be **outside `--source`** and **outside this repository**.
  The parent directory must already exist. `--dry-run` validates both before doing anything else.
  - *Finding, reported not fixed here (brief rule 4):* `census-customs-assets.py::_validate_paths_noclobber`
    enforces only "outside `--source`", while `docs/CUSTOMS-TRUTH-PIPELINE.md` requires outside the
    repo too. This tool enforces both by adding
    `if selector._path_is_inside(output_path, REPO_ROOT): raise` where
    `REPO_ROOT = Path(__file__).resolve().parents[1]`. The census gap is left for a separate,
    separately-reviewed change.
- Publication is atomic and no-clobber via `census._publish_json_noclobber`: a fully-written
  `NamedTemporaryFile` in the destination directory, `os.link` to the destination, `FileExistsError`
  → refuse. **There is no `--force`.** An existing destination is never replaced, and a failure
  after the first link unlinks what was published.
- A symlinked output path is refused before anything is written.
- `--dry-run` must validate paths, locate the catalog, and print the plan **without importing
  UnityPy**. A test poisons `sys.modules["UnityPy"]` to raise on import and asserts exit 0.
- `--acknowledge-local-game-files` is required for any non-dry run; without it, exit 2 before any
  filesystem work.
- `--allow-partial` is explicit, marks `complete: false`, and never relaxes catalog trust: if
  `globalgamemanagers` cannot be size-gated, parsed, or proven byte- and stat-identical before and
  after the read, no scene selection is trusted and nothing is published.

### 1.4 Repo-local inputs

Four repo files are read (read-only, scalars only) for cross-checks. None is game-derived; all are
already committed.

| Path | Used for | Missing → |
|---|---|---|
| `public/assets/3d/customs/scene-manifest.json` | scope box, `frames`, Fortress frame witness | **hard fail** — the frame check is load-bearing |
| `public/data/customs-3d.json` | `terrain.{x0,z0,step,cols,rows}` envelope; `railway[].path` polylines | degrade: `frameCheck.terrainEnvelope="unavailable"`, `railAdjacency="unavailable"` |
| `data/customs-prop-features.json` | the nine current anchors, for the contradiction table | degrade: `crossChecks.anchors="unavailable"` |

`--no-cross-check` skips the degradable ones. It never skips the frame witness.

---

## 2. The hard problem, part (a): counting **placed roots**

### 2.1 Why naïve counting is wrong

A prior `/tmp` inventory counted 175 name-references across 24 distinct normalized names for rail
rolling stock, and correctly caveated that name frequency is **not** instance count: LOD children,
collider children, body/frame sub-parts, and inconsistent prefab authoring each multiply one placed
object into many named descendants. Any tool that reports 24 "kinds" or 175 "objects" has measured
the authoring style, not the rail yard.

The unit that matters is the **placement root**: the outermost transform of one placed object.

### 2.2 Available structure

From the parsed set, per `(asset, pathId)` GameObject key:

- `parentGameObjectPathId` (same asset — the census resolves parents with `_pointer_key(key[0], …)`,
  so the forest never crosses files), `transformPathId`, `hierarchyPath`, `hierarchyComplete`
- `transform.{localPosition,localRotation,localScale}` and, when `hierarchyComplete`, the composed
  `world.{position,rotation,scale,worldExact}`
- which GameObjects carry a renderer (`renderers[].gameObjectPathId`) and which carry a LODGroup
  (`lodGroups[].gameObjectPathId`, with `levels[].rendererPathIds`)
- `normalizedName` (clone/index suffixes folded: `Wagon (1)` → `wagon`)

Not available, and therefore not usable: prefab boundaries. The census emits `PrefabInstance`
identity but never links a `PrefabInstance` to the GameObjects it instantiates (`m_Modifications`
is not parsed). **Prefab-root detection is impossible with this evidence** — say so in the output
(`diagnostics.prefabLinkage: "unavailable"`) rather than pretending the hierarchy is a prefab tree.

### 2.3 The algorithm — exactly

**Step 0 — forest.** Build `parent: key -> key|None` and `children: key -> [key]` over all
GameObjects. Keys are `(asset, pathId)`.

**Step 1 — renderable marking.** `renderable(n)` is true iff `n` is named by any
`renderers[].gameObjectPathId` or `lodGroups[].gameObjectPathId` in the same asset. Compute
`hasRenderableDescendant(n)` bottom-up (n itself counts).

**Step 2 — LOD interiors (rule R1).** For each LODGroup on GameObject `g`, resolve every
`levels[].rendererPathIds` entry to its owning GameObject, then mark every node on the path from
`g` (exclusive) down to each such GameObject (inclusive) as `lodInterior`. A `lodInterior` node is
never a root. This is the single strongest structural signal and it fires first.

**Step 3 — the part-name predicate.** `_part_fold_reason(child, parent)` returns **why** a child
folds into its parent, or `None`. It is used by Step 4's exclusions, **not a rule of its own**;
the reason is returned rather than a boolean because §R6 has to know which clause fired.

| Clause | Fires when | Reason |
|---|---|---|
| empty / index | the child's normalized name is `""` or a bare integer | `empty-or-index` |
| **instance** | the two normalized names are **equal** → **not a part** (see below) | `None` |
| segment prefix, qualified | the child's segments start with the parent's and every remaining segment is shell vocabulary or a digit — `Vagon_tank_green -> Vagon_tank_green_collider` | `segment-prefix-part` |
| segment prefix, unqualified | the same, but a remaining segment names something — `Railcar_Long -> Railcar_Long_A`, `Vagon -> Vagon_Long_01` | `segment-prefix-unqualified` (**R6 watches this one**) |
| part token | the child's **whole** name is in `PART_NAME_TOKENS` | `part-token` |
| **shared prefix stem (R5)** | the child shares a leading segment run with the parent and everything after it is shell vocabulary — `Vagon_tank_green -> Vagon_tank_collider` | `shared-prefix-stem` |
| all shell words | **every** segment of the child's name is shell vocabulary — `Shadow_Mesh`, `Collider_Low` | `all-part-tokens` |

`PART_NAME_TOKENS = {lod, lod0, lod1, lod2, lod3, lods, mesh, meshes, model, body, frame, base,
chassis, bogie, bogey, wheels, wheel, collider, colliders, collision, col, shadow, shadowcaster,
lightprobe, probe, bounds, pivot, geo, geometry, render, renderer, group, grp, parts, detail}` is
matched against a **whole** name. `PART_SUFFIX_TOKENS` is the segment-level shell vocabulary the
last three clauses use — `ballistic(s), door(s), doorleaf, leaf, leaves, hatch(es), glass,
window(s), interior, exterior, decal(s), proxy, occluder, occlusion, navmesh, trigger,
physic(s)/phys, cap(s), lid, paint, logo, low, high, hi, lo, mid, inner, outer, shell(s), dummy,
helper, socket, attach` — and `FOLDABLE_PART_TOKENS` is the union of the two.

> **Decision 2026-09-01 — an identical name is an INSTANCE, never a part.** Because
> `normalized_name` folds the trailing index, `Container -> {Container_01, Container_02}` — Unity's
> ordinary way of authoring two placements under one wrapper — presented as `container` under
> `container` and both children were swallowed as parts of the wrapper. Nothing is ever named
> exactly what it is a part OF; a body is `Body`, not `Vagon`.

> **Decision 2026-09-01 (R5) — folding is by shared prefix STEM, not by exact parent prefix, and
> the prefix test is segment-aware.** The published clause was the raw-text
> `child.startswith(parent)`. A colour variant breaks it: `Vagon_tank_green`'s own collider,
> shadow, ballistic and door-leaf shells are authored `Vagon_tank_<shell>`, and
> `vagon_tank_collider` does not start with `vagon_tank_green`. **Nine of the twenty-six in-box
> rail placements carry such a suffix** (`Vagon_tank_green`, `Vagon_hopper_black`,
> `Vagon_gondola_small_green`, `Vagon_movable_doors_grey`), so each fragmented into its shells:
> the placement was rejected as a multi-branch group and its four shells were elected as four
> "objects". Raw-text prefixing was wrong in the other direction too — it made `vagon_tanker` a
> part of `vagon_tank`, which is two different words — so the clause now compares **segments**.

> **Decision 2026-09-01 — rule R2 is deleted, not repaired.** The published rule read
> `if parent(n) is elected and isPartOf(n, parent(n)): return`. It could never fire: election stops
> the descent (Step 5), so a dequeued node's parent is never an elected node. The only reading that
> *would* make it fire — "nearest **examined** ancestor", i.e. the group node we descended through —
> is falsified by this document's own §8 test 5: a 24 m object split by `--max-placement-span-m 20`
> must yield **two** roots, yet both children are named `Railcar_Long_*` and therefore read as parts
> of the parent that R5 just rejected, so the repaired rule would fold them back into one and lose
> the split. Reinstating R2 in that form is carried as a mutation (`N7`) and turns §8 test 5 red.
> The "deep prefab, no LODGroup" case R2 was written for is handled structurally instead: the
> outermost survivor is elected and its whole subtree is left alone.

**Step 4 — group rejection (rules R4 + R5).** A candidate `n` is a **group**, not a placement, when
any of:

- **R4-multi-family:** `not renderable(n)` **and** its renderable descendants span ≥ 2 distinct
  `normalized_name` values that are not `isPartOf(·, n)`; or
- **R4-group-name:** `normalized_name(n)` ∈ `GROUP_NAME_TOKENS = {root, scene, static, statics,
  props, prop, objects, environment, env, yard, railyard, rail, rails, railway, industrial, zone,
  area, sector, block, decor, level, geometry_root}`, or `container`/`containers` when it has ≥2
  renderable children of differing names; or
- **R5-span:** the axis-aligned XZ span of the *world positions* of `n`'s renderable
  descendants exceeds `--max-placement-span-m` (default **26 m**); or
- **R4-multi-branch:** `not renderable(n)` **and** `n`'s **placement frontier** (below) holds ≥ 2
  nodes.

> **Decision 2026-09-01 — why R4-multi-branch exists.** The distinct-name rule counts *names*, and
> `isPartOf` is ancestor-blind in its last clause: a descendant literally named `Mesh` reads as a
> part of whatever stands above it. So `Containers -> {Container_01 -> Mesh, Container_02 -> Mesh}`,
> two placements 7 m apart, presented the distinct-name rule with one folded family and nothing
> else fired — the conditional `containers` rule needs renderable *children* and the renderers are
> on grandchildren, and 7 m is well under the span guard. The wrapper was elected as **one** root.
> That is an **undercount**, the exact error that would falsely "confirm" a low claimed count, so
> the rule now also counts *branches*: how many things underneath `n` carry geometry and do not
> read as parts of `n`. Counting branches instead of names is what separates two containers behind
> two `Mesh` nodes from `Vagon_02 -> Body -> Mesh`, which has one part-named branch and stays one
> root.

**Step 4a — the placement frontier (R1).** `branches(n)` is the **nearest non-part descendant
frontier**, not the direct-child set. Starting from `n`'s children, the walk **descends through**

* a child that folds into `n` by name (Step 3) — its own children are re-tested **against `n`'s
  name**, which is what keeps `Vagon -> Body -> Mesh` one placement; and
* a child a grouping rule already rejected — a group is by definition not a placement, so the
  placements are the things underneath it;

and **stops**, contributing one branch, at everything else. A LOD interior is never a branch (R1
owns it), a subtree with no renderer anywhere is not a branch, and a node whose hierarchy is
incomplete is **opaque** — the election ledgers it, so the walk must not pretend to see past it.
The walk is bounded by `MAX_HIERARCHY_DEPTH` and by a visited set, so a parent cycle cannot loop it.

Frontier and grouping rule are mutually recursive (a frontier reads its descendants' rules; a rule
reads its own frontier), so both are computed **once, bottom-up** in reverse topological order by
`compute_placement_structure(forest, max_span=…)`. Nodes made unreachable by a cycle sit at the end
of the order and are visited first; their descendants' rules default to `None`, which is safe
because the election ledgers that whole component anyway.

> **Decision 2026-09-01 (R1) — the frontier is not the direct-child set.** Measured on the
> published implementation: inserting **one** ordinary intermediate node —
> `Depot_A -> Stack -> {Container_01 -> Mesh, Container_02 -> Mesh}` — dropped `electedRoots` from
> **2 to 1**, *silently*, with `complete: true` and `rootCountIsLowerBound: false`. `Depot_A` saw a
> single direct branch (`Stack`); the distinct-name rule saw one folded family, because `mesh`
> reads as a part of anything; 7 m is far under the span guard. One wrapper was elected for two
> containers and no ledger said a word. A rule that only survives when the authoring happens to be
> flat is not a rule.

**Rule order is observable and therefore fixed:** R4-multi-family → R4-group-name → R5-span →
R4-multi-branch. Only R5 writes a `diagnostics.spanRejected[]` row, and that ledger exists because
R5 is the one rule whose threshold is a CLI parameter — a node it rejects must stay traceable to
`parameters.maxPlacementSpanM`, so R5 is reported ahead of the weaker branch heuristic. R4-multi-branch
runs last because it is the most fallible of the four (a single object authored as `Cab` + `Trailer`
trips it), so a node a stronger rule already rejected is labelled by that stronger rule.

R5 is the decisive, geometry-free discriminator and deserves its own paragraph. No mesh, bounds, or
vertex data is available, so "how big is this thing" cannot be answered — but "how far apart are the
pivots of the renderers underneath it" can, from transforms alone. A four-axle freight wagon is
~14 m over buffers and a locomotive ~14–17 m, so a genuine single placement's descendant pivots
span well under 26 m; a grouping node holding five wagons spans 60–100 m. R5 therefore bounds the
outward walk **in metres** instead of trusting authoring conventions.

R5 is a *rejection* test only, and it is fallible in one direction: a genuinely long placed object —
`data/customs-props.json` carries a traced "Rail cars" prop with `l: 24` — could be split into two
roots. Every node rejected by R5 is recorded (`diagnostics.spanRejected[]`, with its span and
resulting child count) and `counts.spanRejectedCount` is surfaced in the report so the operator
reviews those rows by hand. The threshold is a CLI flag and its effective value is pinned in the
artifact (`parameters.maxPlacementSpanM`), so two runs that disagree can be told apart.

**Step 5 — election.** Breadth-first from the forest roots:

```
elect(n):
    if not hasRenderableDescendant(n):        return            # nothing here
    if not hierarchyComplete(n):              ledger(n); return  # §2.4, fail closed
    if lodInterior(n):                        return            # R1: already owned
    if isGroup(n):                                              # R4/R5
        for c in children(n): elect(c)
        return
    roots.append(n)                                             # outermost survivor
```

The outermost surviving node wins, and election stops the descent — that is precisely "deduplicate
to the outermost transform of each placed object, not every named descendant".

### 2.3a The accounting invariant — nothing may vanish

**Every renderer in the scene ends up attributed to exactly one elected root, or to a named
diagnostic row.** Until this invariant exists and is asserted, a green suite means only that the
submitted fixtures pass: the election can drop geometry and no count moves.

The universe is `facts["renderers"]`. Each elected root claims the renderers on the members it
**owns** (its subtree, minus any nested placements it was split from). A second claim on the same
renderer is a programming error — the ownership partition must be disjoint — and raises rather than
being reconciled. Whatever is left over is unattributed, and each unattributed renderer is grouped
by its owning node into a `diagnostics.unattributedRenderers[]` row carrying `{objectId, asset,
pathId, hierarchyPathHash, reason, rendererCount}` — never a name — with `reason` one of:

| reason | what happened |
|---|---|
| `rejected-node-own-geometry` | a grouping rule rejected a node that carried its own renderer; rejection only ever happens **above** the roots a descent produces, so nothing owns it |
| `rejection-elected-nothing` | the renderer hangs under a rejected node whose descent elected nothing |
| `unrootable-node` / `unrootable-ancestor` | the owner, or an ancestor of it, is in `unrootableNodes[]` |
| `renderer-owner-not-in-scene` | the renderer's `gameObjectPathId` names a GameObject that never parsed — **the one loss no node-level ledger can see, because there is no node to ledger** |

`counts.renderersAttributed + counts.renderersUnattributed == counts.renderersTotal` is arithmetic,
not a claim, and the builder refuses a document where it does not hold. `unattributedRenderers[]`
is capped at 500 rows (`unattributedRenderersTruncated` says so); the counts are never capped.

> **Decision 2026-09-01 (R2) — the A1 ledger asked the wrong question.** A rejection was ledgered
> only when its descent elected **nothing**. That test cannot see the commoner loss: a rejected
> node carrying its **own** renderer or LODGroup. `Yard` (a renderer) over `Vagon_Yardside` (a
> renderer) elected one root, threw the yard's geometry away, and reported `complete: true` with an
> empty ledger, because a child had survived. `diagnostics.unresolvedRejections[]` now asks both
> halves — `reason` is `descent-elected-nothing`, `own-geometry-unattributed`, or both — and
> carries `rendererCount`. The renderer accounting above is the same question asked of geometry
> instead of of nodes, and it is the half that catches a *future* rule change that quietly stops
> attributing something.

### 2.3b R6 — a fold names alone cannot justify is named, never picked

`Vagon -> {Vagon_Long_01, Vagon_Long_02}` standing 8 m apart folds to **one** root through the
unqualified segment-prefix clause, because `vagon_long` genuinely is `vagon` plus a qualifier — and
two identically-named siblings standing apart is equally the spelling of **two** placements. There
is no name evidence that settles it. The tool therefore does **not** split them and does **not**
pretend the fold was settled: it writes a `diagnostics.ambiguousFolds[]` row
(`{objectId, asset, pathId, hierarchyPathHash, nameHash, foldedChildCount, spanM, rule}`) and the
roster's count becomes a lower bound.

The row fires only when, under an **elected** root, ≥ 2 renderable children of one node fold by
`segment-prefix-unqualified`, carry the **same** normalized name as each other, and stand further
apart than `--coincident-root-m`. Deliberately excluded: `Vagon_tank_green -> Vagon_tank_collider`
(the shell vocabulary settles it), `Railcar_Long -> {Railcar_Long_A, Railcar_Long_B}` (differently
named children read as two parts of one object), and shells stacked at the same pivot.

### 2.4 Recognising a root when the hierarchy is incomplete — **fail closed, per node**

`hierarchyComplete` is false when a parent transform is missing, two transforms name each other, or
the chain exceeds `MAX_HIERARCHY_DEPTH` (128). Such a node has **no `world` block at all**, so it
cannot be placed, cannot be span-tested, and cannot be scoped.

Rule: a renderable node with `hierarchyComplete: false` is **neither elected nor treated as an
interior**. It goes to `diagnostics.unrootableNodes[]` with `{objectId, asset, pathId,
hierarchyPathHash, reason}` — never a name, never a path. Consequences, all mandatory:

- `complete` becomes `false` (so a normal run refuses to publish without `--allow-partial`);
- `counts.rootCountIsLowerBound` becomes `true`. **R3:** so does any *unattributed renderer*
  (§2.3a) and any *ambiguous fold* (§2.3b) — a count that might be missing objects is a floor
  whatever the mechanism — and a floor forces `claimVerdict.overall: "inconclusive"` regardless of
  the component verdicts, which stay computed and readable. An unattributed renderer does **not**
  make `complete` false: the *read* was complete, the *attribution* was not, and conflating the two
  would hide a load failure behind a rule bug;
- if any unrootable node's *known* partial ancestor chain contains an elected root that is inside
  the scope box, `scopeIntegrity` becomes `"suspect"`. **That walk terminates on a visited-set, not
  on a hop budget.** Bounding it by `MAX_HIERARCHY_DEPTH` (as the first implementation did) made the
  verdict decorative: a node that loses `hierarchyComplete` *to* the depth cap always stands more
  than `MAX_HIERARCHY_DEPTH` hops below the top of its chain, so a capped walk returned `"sound"`
  for every input that could ever have produced `"suspect"`. The visited-set both breaks parent
  cycles and memoises chains already proven clean, so the sweep stays linear in the node count.

Never silently drop and never silently promote. A count that might be missing objects must say so
in the artifact, not in a reviewer's memory.

A node whose `world.worldExact` is `false` (non-uniform parent scale under rotation, or a NaN/Inf
transform component) keeps its position but carries `positionExact: false`, is listed in
`diagnostics.inexactRoots[]`, and takes a confidence penalty (§4.3).

### 2.5 Deduplication is by identity, never by proximity

Elected roots are unique by `objectId` (`asset + type + pathId`). There is **no merge step**. Two
roots 0.4 m apart are two roots; they are reported as
`diagnostics.coincidentRootGroups[]` when within `--coincident-root-m` (default 1.5 m) so the
operator sees the classic double-count, and they are left alone.

Auto-merging coincident roots is explicitly forbidden: it is the one edit that could silently
manufacture the handoff's tidy 3/2/1/2 out of a messier truth.

---

## 3. The hard problem, part (b): the spatial frame

### 3.1 The answer

**The `customs-industrial-rail-yard` scope box is expressed in the SOURCE frame,
`eft-unity-world-metres-y-up` — the same canonical EFT world metres that a Unity scene transform
carries. The extractor applies NO frame transform.** `runtimeFromSource = [-x, -z, y]` is applied
later, by the renderer, to an already-correct number.

Containment test, in full:

```
scope = manifest.scope            # {center:{x:230,z:-110}, widthM:360, depthM:300}
halfW = scope.widthM / 2          # 180
halfD = scope.depthM / 2          # 150
inScope(p) := abs(p.x - 230) <= 180  and  abs(p.z - (-110)) <= 150
            # x in [50, 410], z in [-260, 40]; p is world.position, source frame, unmodified
```

No Y bound: the manifest scope declares none. `y` is reported per root so the reader can see it.

### 3.2 Why that is the right frame — in-repo evidence, not assumption

1. `src/customs-asset-runtime.js:155` — `customsAssetWorldPosition({x,y,z})` returns `[-x,-z,y]`,
   converting an instance's `transform.position` **into** runtime coordinates. Therefore manifest
   instance positions are source-frame.
2. `src/customs-asset-manifest.js:932 assertCellsWithinScope` compares cell bounds — derived from
   the same `center/widthM/depthM` shape as `scope` — against `scope.boundsM`, in the same
   coordinates as instance positions. By (1), `scope` is source-frame.
3. The one shipped instance, `fortress-shell-main`, sits at
   `{x: 202.898880005, y: 1.729503632, z: -127.68775177}`, and the evidence observation
   `fortress-shell-pivot` repeats those numbers with `toleranceM: 0.001`, described as reviewed
   scalar EFT placement. That (x, z) is inside the source-frame box.
4. `data/customs-prop-features.json`'s nine anchors (e.g. `locomotive_west` at `[251.6, -184]`) are
   game coordinates traced with the documented screen→game formula in `CLAUDE.md`, and all nine
   fall inside the source-frame box.

### 3.3 Getting it backwards is not obviously wrong — which is why it must be *verified*

If the box were mistakenly read as runtime-frame, the inverse map `x = -X, z = -Y` would place it at
`x ∈ [-410, -50], z ∈ [-40, 260]`. That mirrored box is **also entirely inside** the Customs
terrain envelope (`x0=-412, z0=-347, step=5, cols=231, rows=126` → `x ∈ [-412, 738]`,
`z ∈ [-347, 278]`), so "the roots landed on the map" proves nothing. The wrong 360 × 300 m would be
selected silently, and three asset families would be built for objects on the other side of Customs.

Three checks run inside the extractor and are recorded in `frameCheck`:

**V1 — Fortress witness (gating).** At least one elected root's world position must lie within
`--frame-witness-tolerance-m` (default **12 m**) of the Fortress pivot `(202.898880005, -127.68775177)`
read from `scene-manifest.json`. 12 m is loose enough for the authored pivot to differ from the
game object's pivot on a ~60 m building, and far tighter than the 200–800 m error a wrong frame
produces. Fields: `frameCheck.fortressWitness ∈ {"confirmed","failed"}`,
`frameCheck.fortressWitnessDistanceM`, `frameCheck.fortressWitnessRootId`. On `"failed"` the run
**refuses to publish** unless `--allow-partial`, and the artifact carries `frameVerified: false`.

**V2 — mirror test (the falsifier).** Compute every scope-dependent quantity twice: once on `p`,
once on `p' = (-p.x, -p.z)`. Emit `frameCheck.sourceFrameRootCount`,
`frameCheck.mirroredFrameRootCount`, `frameCheck.sourceFrameWitnessDistanceM`,
`frameCheck.mirroredFrameWitnessDistanceM`, and the industrial-lexicon hit density under each. The
correct frame is the one that both contains the Fortress witness *and* yields the higher industrial
density. If the mirrored reading wins on either measure, `frameCheck.verdict = "contradicted"` and
the run fails closed. The frame choice is then decided by the data, not by this document.

**V3 — terrain envelope.** Every elected root's source position must lie inside the terrain envelope
inflated by `--terrain-margin-m` (default 50 m). `frameCheck.outsideTerrainEnvelopeCount` and
`frameCheck.outsideTerrainEnvelopeFraction`. A large fraction outside is a frame or unit error.

`frameCheck.verdict ∈ {"confirmed", "contradicted", "unverified"}`. Only `"confirmed"` publishes
without `--allow-partial`.

**Informative, non-gating:** `crossChecks.anchors[]` — for each of the nine
`data/customs-prop-features.json` anchors, the distance to the nearest elected root of a compatible
class, plus that root's id and class. This table is the direct, human-readable falsifier of the
current mapping.

---

## 4. The hard problem, part (c): classification without geometry

### 4.1 What is genuinely available — and what is not

Available per root (aggregated over its subtree): `normalizedName`, `name`, `hierarchyPath` and its
segments, `materialSlotCount`, slot-aligned resolved `materialNames`, material `scalarProperties` /
`colorProperties` / `textureProperties` names + tiling, `lodCount` and per-level
`screenRelativeTransitionHeight`, renderer flags (`enabled`, `castShadows`, `receiveShadows`,
`staticBatch`, `motionVectors`), `layer`, `tag`, world `scale`, descendant count, descendant pivot
span (§2.3 R5), and distance to the nearest rail polyline.

**Not available.** `docs/CUSTOMS-TRUTH-PIPELINE.md` states it plainly: *"This release emits no mesh
name, vertex/submesh count, or local bounds and no texture name or dimensions."* So there is **no
silhouette, no length, no height, no volume, no profile.** A wagon cannot be classified by its
shape, and no future edit may quietly re-enable Mesh parsing to make classification easier — that
would need a separately audited streaming scalar reader, which is out of scope here.

Classification is therefore a **lexical and material match, scored, with an explicit ceiling.**

### 4.2 Classes and lexicon

Classes (slug form used in IDs):

`rail-locomotive` · `rail-wagon-covered` · `rail-wagon-tank` · `rail-wagon-hopper` ·
`rail-wagon-flat` · `rail-wagon-gondola` · `rail-wagon-unspecified` · `container-iso-6m` ·
`container-iso-12m` · `container-unspecified` · `industrial-tank-static` · `unclassified`

> **Decision 2026-09-01 — `industrial-other` is removed, not given tokens.** It carried no token set,
> so no input could ever be classified into it: it was a slot in the schema that the scorer could not
> reach, and a schema that can express an identity nothing can produce is a schema that invites a
> later hand-edit to fill it. `unclassified` already covers "no lexical identity", and
> `counts.otherIndustrialRootsInScope` still counts every `industrial-*` class (today, only
> `industrial-tank-static`). §8 test 36 pins the invariant: every class in `CLASS_ORDER` other than
> `unclassified` has a non-empty token set.

Tokens are matched case-insensitively against the punctuation-split union of the root's own
`normalizedName`, **the `normalizedName` of every renderer- or LODGroup-bearing node in its subtree**,
its `hierarchyPath` segments, and its descendants' resolved material names. Which of those a token
was found on decides whether it scores at N or at P — see §4.3. EFT asset names are frequently
transliterated Russian, so both vocabularies are carried:

| Group | Tokens |
|---|---|
| rail generic | `wagon, vagon, wag, railcar, rail_car, railwagon, train, poezd, zhd, rzd` |
| locomotive | `locomotive, loco, teplovoz, elektrovoz, shunter, diesel` |
| covered | `covered, closed, box, boxcar, kryt, kryty, tovarn, freight, gruz, gruzov` |
| tank | `tank, tanker, cistern, cisterna, fuel, toplivo, neft, oil, gas` |
| hopper | `hopper, hoper, bunker, dump, ore, coal, ugol, gravel, ballast, shcheben` |
| flat | `flat, platforma, flatcar, flatbed` — the bare English `platform` is **not** here; see the negative lexicon |
| gondola | `gondola, poluvagon, polu, opentop` |
| container | `container, konteyner, kontejner, cont, iso` |
| length hint | `6m, 20ft, 20f, 12m, 40ft, 40f` — counted **only** adjacent to a container token |
| static tank | `tank` + one of `static, ground, storage, rezervuar, bak, silo` |

`GENERIC_NAMES = {prop, props, object, obj, mesh, model, static, group, item, thing, new, gameobject}`
— a root whose normalized name is one of these has no lexical identity and is penalised.

**The negative lexicon (channel D, added 2026-09-01).** The positive lexicon is a set of words that
RAISE a reading; it had no counterpart, so a name that names a completely different object could
only ever be scored on the words it happened to share.

> **Measured:** a real `Metal_barrel_04_closed_old_blue` standing three metres from the rails
> scored `closed` on its own name (N +0.35) and on its material (M +0.20), shared its name with a
> sibling (F +0.05) and sat 1 m from the track (R+ +0.10) = **0.70, `established`,
> `rail-wagon-covered`** — channel-identical to a genuine `Vagon_shutted_closed`. At least **34**
> such barrels, plus roughly **700** railings and platforms, stand inside the scope box.

`NEGATIVE_NAME_TOKENS = {barrel, barrels, bochka, cylinder, cylinders, railing, railings, handrail,
perila, stepladder, ladder, ladders, lestnica, lestnitsa, platform, platforms, fence, fences,
zabor, stair, stairs, staircase, scaffold, scaffolding}`.

This is a **channel with a pinned weight, not a blocklist bolted on the side**: the token is
evidence, it is reported in `confidenceChannels.D` and in `evidenceChannelsFired`, and it lowers a
score exactly as a positive token raises one. The class is not deleted from the candidate set — the
row still reads `rail-wagon-covered`, at a confidence that says nobody should build on it — because
suppressing the reading would hide the ambiguity the channel exists to report.

Like every other suppression decision, D reads the root's **own** evidence only (its name, its
renderable subtree's names, its material names) and never an ancestor's: a wrapper called
`Barrels_Zone` must not disqualify a genuine wagon under it, exactly as `Kryt_Zone` must not
promote one. D never fires on `unclassified`, which is the residual rather than a reading, so
nothing contradicts it.

### 4.3 Confidence score — exact arithmetic

Each channel contributes at most once. The score is deterministic and must be pinned by unit tests
to the exact value, not a range.

| Code | Channel | Δ |
|---|---|---|
| N | class token on a node that **carries a renderer or LODGroup** — the root's own `normalizedName` when the root does, plus the `normalizedName` of each renderable node in its subtree | **+0.35** |
| P | class token on a node that carries **no** renderer — the root's own `normalizedName` when the root is a bare wrapper, or an ancestor segment of `hierarchyPath` | **+0.20** |
| M | class token in ≥1 resolved material name on the root's descendants | **+0.20** |
| L | root carries a LODGroup with ≥2 levels | **+0.10** |
| S | root has ≥2 renderable descendants **and** its pivot span ≤ the class's band | **+0.10** |
| F | ≥2 elected roots share this `normalizedName` | **+0.05** |
| R+ | rail class and `railDistanceM ≤ 4`; or non-rail class and `railDistanceM > 4` | **+0.10** |
| R− | rail class and `railDistanceM > 12` | **−0.20** |
| A | a competing class scores ≥ 0.35 on N+P+M alone | **−0.25** |
| X | `world.worldExact == false` | **−0.20** |
| G | `normalizedName` empty or in `GENERIC_NAMES` | **−0.30** |
| D | a `NEGATIVE_NAME_TOKENS` word in the root's **own** evidence, on any class but `unclassified` | **−0.60** |

`confidence = round(clamp(sum, 0.0, 0.95), 3)`.

**Why D is −0.60, and why that number is checkable rather than tasteful.** The requirement is that
a name naming a *different object* defeats every channel a name can earn on its own. The strongest
score reachable without an ancestor-path hit is `MAX_OWN_NAME_POSITIVE = N + M + L + S + F + R+ =
0.90`, and `0.90 + D = 0.30` must land below `probable` (0.40). It does, with 0.10 to spare;
`test_negative_evidence_defeats_every_own_name_channel` pins the arithmetic against the constants
themselves, so the weight cannot be softened without a red test. Applied to the measured barrel:
`0.70 − 0.60 = 0.10`, `unresolved`; with an LODGroup and a second renderable descendant (L and S
firing too) `0.90 − 0.60 = 0.30`, still `unresolved`. The `Vagon_shutted_closed` standing beside
it is untouched at 0.45, `probable` — the channel discriminates rather than blanket-penalising.

Each row also carries `evidenceChannelsFired`: the channel codes that actually moved its score, in
table order, with `R` reported as `R+` or `R−` because the two readings are different evidence.

The **0.95 hard ceiling is deliberate**: no name-only identification is ever certain, and the
schema must not be able to express certainty about something nobody looked at.

Span bands for S (metres, *pivot* span, not object length):
`rail-locomotive ≤ 20` · `rail-wagon-* ≤ 16` · `container-iso-6m ≤ 7` · `container-iso-12m ≤ 13` ·
`industrial-tank-static ≤ 16`. S never fires on a single-renderer root, where span is trivially 0
and therefore meaningless.

Bands: **established ≥ 0.70** · **probable 0.40–0.699** · **unresolved < 0.40**.
Only `established` rows may drive an authored asset family. `probable` rows go to the founder as
questions. `unresolved` rows are reported and built against by nobody.

Worked sanity check: N alone = 0.35 (unresolved). N+M = 0.55 (probable). N+P+M = 0.75
(established). N+M+L+S = 0.75 (established). Two independent channels plus corroboration is the
floor for "established" — which is the intent.

> **Decision 2026-09-01 — a renderer-less wrapper is the root, but its name is weak evidence.**
> Two questions had to be answered together. *Which node is the root when a non-renderable wrapper
> has exactly one renderable family?* **The wrapper.** It is the outermost transform of the
> placement, and descending past it would split §8 test 3 (`Vagon_02 -> Body -> Mesh`) into two
> roots. *Whose name may drive classification?* **Only a name that belongs to geometry, at N
> strength.** The failing case was `Kryt_Vagony` (no renderer) over `Vagon_02` (renderer, material
> `Cisterna_Metal`): the wrapper's incidental `kryt` scored the full +0.35 while the material that
> actually clothes the geometry could not outvote it, so the run reported `rail-wagon-covered` with
> a confidence the evidence does not support. Under the split above the wrapper's `kryt` scores
> +0.20 (P) and the material's `cisterna` scores +0.20 (M), the two readings sit level at 0.20, and
> the row lands in `unresolved` with `rail-wagon-tank` beside it in `competingClasses` — which is the
> honest answer to "we do not know". The same tokens on a node that does render still score +0.35.

If `railway` polylines are unavailable, R is **omitted and recorded** as
`railAdjacency: "unavailable"`, never silently scored 0.

### 4.4 What this method can and cannot establish — the founder-facing finding

**Can establish:**

- **How many placed roots stand in the scope, and their per-name-family counts.** This is a
  *measurement*, not an inference, and it is the actual deliverable.
- Rail rolling stock vs shipping container vs neither — different lexical families, different
  materials, usually different LOD structure.
- Locomotive vs wagon — `teplovoz` / `locomotive` / `shunter` is its own word.
- Container size class **only** when a length token (`6m`, `20ft`, `12m`, `40ft`) is literally
  present in a name or material name.
- Colour, weakly and only sometimes: the census does emit material `colorProperties` (`m_Colors` is
  exempted from the scrub for `Material`). A non-neutral `_Color`-style property on a root's
  descendants is reported as `colorEvidence: {property, r, g, b, a}`. A white/neutral value means
  the colour lives in a texture, which this pipeline never reads — then `colorEvidence: "none"`.
  **"Red" is not establishable from a white tint.**

**Cannot establish — state this to the founder as a finding, not a gap:**

- **Closed wagon vs hopper wagon vs gondola is not separable from names alone**, unless the author
  happened to encode the body type in the name. These are the same chassis with different bodies;
  a name like `vagon_gruz_02` discriminates nothing, and there is no mesh, no bounds, and no height
  to fall back on. If the run returns a single normalized family spanning all rail bodies, then the
  handoff's 3-closed / 1-hopper split is **unsupported by this pipeline** and must not be built
  against.
- Exact container length without a length token.
- Tank wagon vs static ground tank when the name says only `tank` — resolved *only* by the rail
  adjacency test, and if `railAdjacency` is unavailable it is not resolved at all.
- Any dimension, silhouette, profile, condition, or weathering.

The extractor must publish this itself rather than leave it to inference:

```json
"classification": {
  "separability": {
    "railBodyType":   {"verdict": "not-separable", "reason": "…", "familiesObserved": 1},
    "containerSize":  {"verdict": "not-separable", "reason": "no length token in any name or material"},
    "tankWagonVsStaticTank": {"verdict": "separable", "reason": "rail adjacency available"}
  }
}
```

---

## 5. The hard problem, part (d): falsifiability

The handoff's claim — *three closed freight wagons, two tank wagons, one hopper wagon, two 6 m red
containers* — is **pre-registered verbatim inside the artifact** before any verdict is computed, so
a reader cannot re-read the numbers to fit the output:

```json
"claimUnderTest": {
  "source": "docs/CONTINUATION-HANDOFF-2026-08-31.md",
  "statement": "three closed freight wagons, two tank wagons, one hopper wagon, and two 6 m red containers",
  "components": {
    "closedFreightWagons": 3, "tankWagons": 2, "hopperWagons": 1, "redContainers6m": 2,
    "railStockTotal": 6, "containerTotal": 2
  }
}
```

Each component gets a verdict ∈ `supported` | `contradicted` | `unfounded`:

| # | Output that **disproves** the claim | Verdict written |
|---|---|---|
| D1 | `counts.railRootsInScope` (established + probable) ≠ 6 | `railStockTotal: contradicted` |
| D2 | `separability.railBodyType == "not-separable"` | `closedFreightWagons`, `hopperWagons`: **`unfounded`** — the split has no evidentiary basis, which for build purposes is the same verdict as "wrong". **`tankWagons` is NOT in this row** — see below |
| D3 | `counts.containerRootsInScope` ≠ 2, **or** no container root carries a length token and `separability.containerSize == "not-separable"`, **or** every container root's `colorEvidence == "none"` | `redContainers6m: contradicted` / `unfounded` |
| D4 | The nearest compatible root to **every** one of the nine `customs-prop-features.json` anchors is > 25 m away | `crossChecks.anchorsVerdict: "anchors-contradicted"` — both the old nine-proxy plan *and* the new claim are placed against fiction |
| D5 | 6 rail roots + 3 container roots land within 2 m of the nine anchors with matching classes | `claimVerdict.overall: "nine-proxy-plan-supported"` — **the handoff's correction is itself wrong and the old plan stands** |

D5 exists on purpose. A test that can only confirm the new claim is not an experiment. The tool must
be able to return "the thing that superseded the old plan was itself unsupported".

> **Decision 2026-09-01 — `unfounded` never reaches `tankWagons`.** The first implementation set
> `tankWagons: "unfounded"` unconditionally whenever `railBodyType` was not-separable, which is
> wider than the D2 row above and wider than the evidence. §4.4 is explicit about *why* closed vs
> hopper vs gondola is not separable: they are the same chassis with different bodies and this
> pipeline reads no mesh, bounds or height. A tank wagon is not in that set — `cisterna`/`tank` is
> its own word with its own material vocabulary, and §4.4 lists tank-wagon-vs-static-tank as
> *separable* whenever rail adjacency is available. So a run that finds no tank-classed rail root
> has found evidence, not an absence of it, and the claim of two tank wagons is **`contradicted`**.
> On the brief's failing shape — six roots named `Vagon_NN` plus two supported red containers —
> the artifact now reads `closedFreightWagons: unfounded`, `hopperWagons: unfounded`,
> `tankWagons: contradicted`, which is the difference between "we cannot tell" and "we looked and
> they are not there".

`claimVerdict.overall ∈ {"supported", "partially-contradicted", "contradicted", "unfounded",
"nine-proxy-plan-supported", "inconclusive"}`. `"inconclusive"` is required whenever
`complete == false`, `frameVerified == false`, or `rootCountIsLowerBound == true` — an incomplete
run may never render a verdict on anyone's claim.

---

## 6. Output schema

### 6.1 `--output` — the candidate roster

```jsonc
{
  "schemaVersion": 2,
  "generator": {
    "name": "tarkovzero-customs-industrial-candidate-roster",
    "unityPyVersion": "…",
    "selectionMode": "catalog-first-customs-only"
  },
  // The honesty block.  A reader who quotes a number from this file without
  // reading these four fields is quoting something the artifact does not claim.
  "artifactKind": "conservative-candidate-roster",
  "awaitingVisualConfirmation": true,
  "establishes": ["…", "…"],
  "doesNotEstablish": [
    "That any row is a placed wagon rather than a child, a collider shell, an LOD node, or an
     inactive placeholder. An explicit name proves only that a LABEL is separable.",
    "Body type, colour, size, or condition beyond what a literal token states; …",
    "An independently sourced identity. The extractor and the repository's second source share one
     acquisition layer, so their agreement is not validation.",
    "Anything at all until each row is confirmed against geo-tagged in-game photographs …"
  ],
  "parameters": {                       // every knob that could change the answer, pinned
    "scopeId": "customs-industrial-rail-yard",
    "scopeCenter": {"x": 230, "z": -110}, "scopeWidthM": 360, "scopeDepthM": 300,
    "frameId": "eft-unity-world-metres-y-up",
    "maxPlacementSpanM": 26, "coincidentRootM": 1.5,
    "frameWitnessToleranceM": 12, "terrainMarginM": 50, "railOnTrackM": 4, "railOffTrackM": 12
  },
  "source": {                            // identical shape to the census's
    "rootName": "…", "catalogFiles": [...], "catalogFileFacts": [...],
    "sceneFiles": [{"file","role","sceneIndex","scenePath","byteSize","sha256",
                    "digestComplete","bindingVerified","statIdentityHash"}],
    "loadedCatalogFileCount": 1, "loadedSceneFileCount": 2, "loadedFileCount": 3
  },
  "sceneIndices": [ ... ],
  "complete": true,
  "frameVerified": true,
  "scopeIntegrity": "sound",             // "sound" | "suspect"
  "frameCheck": { ... },                 // §3.3
  "claimUnderTest": { ... },             // §5
  "claimVerdict": { ... },               // §5
  "classification": { "separability": { ... } },
  "counts": {
    "gameObjectsParsed": 0, "renderablesParsed": 0,
    "electedRoots": 0, "rootsInScope": 0,
    "railRootsInScope": 0, "containerRootsInScope": 0, "otherIndustrialRootsInScope": 0,
    "establishedRootsInScope": 0, "probableRootsInScope": 0, "unresolvedRootsInScope": 0,
    "spanRejectedCount": 0, "unrootableNodeCount": 0, "unresolvedRejectionCount": 0,
    "coincidentRootGroupCount": 0,
    "rootCountIsLowerBound": false,
    "skippedNonRootsObjects": 0, "skippedObjects": 0,
    // the accounting invariant, in three numbers a reader can add up (§2.3a)
    "renderersTotal": 0, "renderersAttributed": 0, "renderersUnattributed": 0,
    "unattributedRendererOwnerCount": 0,
    "ambiguousFoldCount": 0,             // §2.3b
    "negativeEvidenceRootsInScope": 0    // rows where channel D fired
  },
  "candidates": [                        // NOT `roots`: every row is a candidate
    {
      "rootId": "customs.root.<12-hex-of-objectId-hash>",
      "objectId": "…", "asset": "level__", "pathId": 0, "sourceFile": "…",
      "sourceRole": "level", "sceneIndex": 0,
      "normalizedName": "vagon", "nameHash": "…",
      "hierarchyPathHash": "…", "hierarchyDepth": 3,
      "world": {"position": {"x":0,"y":0,"z":0},
                "rotation": {"x":0,"y":0,"z":0,"w":1},
                "scale":    {"x":1,"y":1,"z":1}},
      "positionExact": true,
      "inScope": true, "railDistanceM": 1.83,
      "descendantCount": 7, "renderableDescendantCount": 3, "pivotSpanM": 11.42,
      "lodCount": 3, "materialSlotCount": 2, "materialNames": ["…","…"],
      "colorEvidence": {"property": "_Color", "r": 0.61, "g": 0.11, "b": 0.09, "a": 1.0},
      "class": "rail-wagon-unspecified",
      "confidence": 0.55, "band": "probable",
      "confidenceChannels": {"N": 0.35, "P": 0, "M": 0.20, "L": 0, "S": 0, "F": 0,
                             "R": 0, "A": 0, "X": 0, "G": 0, "D": 0},
      "evidenceChannelsFired": ["N", "M"],
      "competingClasses": [{"class": "rail-wagon-tank", "score": 0.20}],
      "awaitingVisualConfirmation": true   // unconditionally; see the header
    }
  ],
  "families": [                          // grouped by (normalizedName, class); the count that matters
    {"normalizedName": "vagon", "class": "rail-wagon-unspecified",
     "instanceCount": 6, "inScopeCount": 6, "meanConfidence": 0.55,
     "exampleRootIds": ["…","…","…"]}   // ≤3
  ],
  "crossChecks": {
    "anchors": [{"featureId": "customs.prop.industrial_rail_yard.tanker_1",
                 "anchor": {"x": 262.1, "z": -174.6},
                 "nearestRootId": "…", "nearestClass": "rail-wagon-tank",
                 "distanceM": 1.42, "compatible": true}],
    "anchorsVerdict": "anchors-supported"
  },
  "diagnostics": {
    "fileLoadFailures": [], "objectParseFailures": [], "skippedObjects": [],
    "dependencyFailures": [], "droppedForbiddenFieldCount": 0,
    "unrootableNodes": [],
    "unresolvedRejections": [            // §2.3a; `reason` names WHICH half fired
      {"objectId": "…", "asset": "…", "pathId": 0, "hierarchyPathHash": "…",
       "rule": "R4-group-name", "reason": "own-geometry-unattributed",
       "rendererCount": 1, "renderableDescendantCount": 2}
    ],
    "unattributedRenderers": [           // §2.3a; capped at 500 rows
      {"objectId": "…", "asset": "…", "pathId": 0, "hierarchyPathHash": "…",
       "reason": "rejected-node-own-geometry", "rendererCount": 1}
    ],
    "unattributedRenderersTruncated": false,
    "ambiguousFolds": [                  // §2.3b
      {"objectId": "…", "asset": "…", "pathId": 0, "hierarchyPathHash": "…",
       "nameHash": "…", "foldedChildCount": 2, "spanM": 8.0,
       "rule": "R6-ambiguous-prefix-fold"}
    ],
    "inexactRoots": [], "spanRejected": [],
    "coincidentRootGroups": [], "prefabLinkage": "unavailable"
  }
}
```

Notes that a reviewer must check:

- **No names of ancestors, no `hierarchyPath` string, no material *texture* names, no file
  paths beyond the sanitized `sourceFile` relative name.** `hierarchyPathHash` carries the
  identity; the path itself is authoring text with no analytical value here and is dropped to keep
  the surface small. `materialNames` **is** emitted (it is a scored evidence channel), bounded to
  64 entries and 1024 chars each by the payload guard.
- `rootId` is `"customs.root." + sha256(objectId)[:12]` — stable across runs, lowercase hex, and it
  satisfies the truth-graph `ID_PATTERN`. The `root` in the id names the *election* (a placement
  root), not a claim about the object; the row set it indexes is `candidates`.
- `candidates` is sorted by `(class, position.x, position.z, objectId)`; `families` by
  `(-instanceCount, normalizedName)`. Deterministic ordering is asserted by test.
- `ROOTS_ALLOWED_OUTPUT_KEYS` is the exact set of keys above and nothing else.

### 6.2 `--report` — the operator roster

A second artifact, same publication rules, that answers "what do I build?": the `families` table
ranked by in-scope instance count, the `claimVerdict` block, the `separability` block, the anchor
cross-check table, and the diagnostic counts (`spanRejectedCount`, `unrootableNodeCount`,
`unresolvedRejectionCount`, `coincidentRootGroupCount`, `outsideTerrainEnvelopeCount`). No new
facts — a projection of `--output` only, so the two can never disagree.

Two things travel with it deliberately, because the roster is the artifact an operator actually
reads and a caveat one indirection away is the same overstatement:

- the whole honesty block (`artifactKind`, `awaitingVisualConfirmation`, `establishes`,
  `doesNotEstablish`); and
- `counts.rootCountIsLowerBound` plus the accounting numbers (`renderersTotal`,
  `renderersAttributed`, `renderersUnattributed`, `ambiguousFoldCount`,
  `negativeEvidenceRootsInScope`) — a count that is a floor must say so **where the count is read**.

---

## 7. Normalizing into `customs-truth-graph.mjs` schema v1

The Python tool never emits the graph — the schema lives in JS. A **new** module,
`scripts/lib/customs-industrial-roots-graph.mjs`, exports
`industrialRootsToTruthGraph(rootsDocument)` and is validated by
`normalizeCustomsTruthGraph()`. It is separate, separately reviewed work; the extractor itself is
complete without it.

Mapping:

| Graph field | Value |
|---|---|
| `schemaVersion` | `1` |
| `graphId` | `customs.truth.industrial.roots` |
| `map` | `customs` |
| `coordinates` | `{frameId: "customs.frame.eft-unity-world-metres-y-up", units: "metre", handedness: "left-handed", axes: {x: "east", y: "up", z: "north"}, quaternionOrder: "xyzw", matrixConvention: "column-major-parent-times-local"}` |
| `sources[]` | one per authorized file. `sourceId = "source.customs." + role + "." + sceneIndex` (catalog → `source.customs.catalog.0`); `kind: "local-unity-serialized-file"`; `capturedAt` = the run's ISO-8601 UTC timestamp; `digest = "sha256:" + sceneFiles[].sha256`; `payloadExcluded: true` |
| `evidence[]` | one per elected root: `evidenceId = "evidence." + rootId.slice("customs.".length)` → `evidence.root.<hash12>`; `sourceId` = the file it came from; `kind: "placed-root-transform"`; `featureId` = the node's featureId; `confidence` = the §4.3 score; `position = [x, y, z]` source-frame |
| `assets[]` | **`[]`** — this extractor authors nothing |
| `sceneNodes[]` | one per *placeable* elected root: `nodeId = "customs.node.industrial." + classSlug + "." + ordinal`; `featureId = "customs.feature.industrial." + classSlug + "." + ordinal`; `parentId: null`; `assetId: null`; `evidenceIds: [its evidence row]`; `localTransform = {translation, rotation, scale}` from `world` |
| `terrainTiles[]` | `[]` |

Rules the converter must enforce, each with a test:

- `parentId` is **always `null`**. The game's parent chain is deliberately *not* re-imported: with
  `parentId: null`, `localMatrix === worldMatrix`, which is the honest statement — we know where the
  object stands in the world and assert nothing about a parent we did not fully verify.
- A root is **excluded** from `sceneNodes` when `world` is missing, `positionExact` is false, or any
  `scale` component is 0 (the schema rejects a zero scale and a zero-length quaternion). Excluded
  roots remain in the roster's `candidates[]` and are counted in `graph.excludedRootCount` in the
  converter's own return value — never dropped silently.
- Ordinals are assigned after sorting on `(classSlug, x, z, objectId)` and start at 1, so a re-run
  over the same bytes yields byte-identical `canonicalCustomsTruthGraphJson(...)`. Pin that digest
  in the test.
- `featureId` uniqueness across `sceneNodes` is enforced by the schema; the ordinal scheme
  guarantees it. Ids are lowercase and match `ID_PATTERN` (`rail-wagon-tank` hyphenated inside a
  dotted segment is valid).
- Every `sourceId`/`evidenceId`/`featureId` prefix requirement in the schema
  (`source.`, `evidence.`, `customs.`, `customs.node.`, `customs.feature.`) is satisfied by
  construction; a test asserts a deliberately malformed input is rejected rather than repaired.

---

## 8. Test plan — synthetic fixtures only

New suite `scripts/test_extract_customs_industrial_roots.py`, wired as
`"test:customs-industrial-roots": "python3 -m unittest scripts/test_extract_customs_industrial_roots.py"`
and appended to the `test` chain in `package.json`. The graph converter gets
`scripts/customs-industrial-roots-graph.test.mjs` under `node --test`.

**Absolute rule, identical to the three existing extractors:** every fixture is an in-memory fake
(`FakeReader` / `FakeEnvironment` / `FakeUnityPy` in the style of
`scripts/test_census_customs_assets.py`). The suite **never needs, and must never be pointable at,
real game files.** Three tests enforce that structurally:

- `FakeUnityPy.load` is the only loader ever invoked, and `fake.load_calls` equals exactly
  `["globalgamemanagers", "<level>", "<sharedassets>"]`;
- every path handed to `discover_*` is under a `tempfile.TemporaryDirectory()`;
- `selector._import_unitypy` is never called — UnityPy arrives only through the injected
  `unitypy_module` parameter.

### Counting (§2)

1. `one_wagon_with_lods` — root + LODGroup + LOD0/1/2 renderer children → **1** root, not 4 (R1).
2. `five_wagons_under_one_group` — non-renderable `RailYard_Wagons` over five wagons 12 m apart →
   **5** roots, group not elected (R4/R5).
3. `deep_prefab_no_lodgroup` — `Vagon_02` → `Body` → `Mesh` (renderer) + sibling `Collider` →
   **1** root (R2).
4. `long_group_split` — group whose renderable descendants span 80 m → rejected,
   `spanRejectedCount == 1`, children elected.
5. `oversized_single_object` — a real 24 m object → **1** root; rerun with
   `--max-placement-span-m 20` → **2** roots, and `parameters.maxPlacementSpanM` differs in the
   artifact. Proves the threshold is the only thing that moved and that it is recorded.
6. `incomplete_hierarchy` — renderer whose GameObject's parent transform is missing → **0** roots,
   1 `unrootableNodes` row, `complete: false`, `rootCountIsLowerBound: true`, exit 2 without
   `--allow-partial`, nothing written.
7. `cyclic_parents` — two transforms naming each other → same handling, no crash, no recursion
   blow-up, depth cap respected.
8. `coincident_roots` — two roots 0.4 m apart → **2** roots and 1 `coincidentRootGroups` row.
   Asserts no auto-merge.
9. `name_frequency_trap` — 24 distinct names / 175 name references arranged as 6 real placements →
   exactly **6** roots. This encodes the `/tmp` inventory's exact failure mode as a regression test.

### Scope and frame (§3)

10. `scope_boundary` — roots at exactly `x=410`/`z=40` are in; `+0.01 m` out.
11. `frame_witness_present` — a root at the Fortress pivot → `frameVerified: true`.
12. `frame_witness_absent` — refuses to publish, exit 2, nothing written.
13. **`mirrored_scene`** — every root's `(x, z)` negated → `frameCheck.verdict == "contradicted"`,
    refuses to publish. *This is the test that would have caught a reversed frame.*
14. `outside_terrain_envelope` — roots at `x = 5000` → counted and flagged, not silently dropped.
15. `no_cross_check` — with `--no-cross-check`, envelope/anchor checks degrade to `"unavailable"`
    but the Fortress witness still gates.

### Classification (§4)

16. `lexicon_hits` — one root per class, asserting the **exact** class and the **exact** confidence
    value (pin the arithmetic, never a range).
17. **`ambiguous_body_type`** — six roots all named `vagon`, no body token → all
    `rail-wagon-unspecified`, every confidence < 0.70,
    `separability.railBodyType == "not-separable"`,
    `claimVerdict.closedFreightWagons == "unfounded"` and `claimVerdict.hopperWagons == "unfounded"`,
    and `claimVerdict.tankWagons == "contradicted"` (§5's D2 decision). *This encodes the
    founder-facing finding.* The field is `closedFreightWagons` — the name used by §5's JSON and by
    `CLAIM_COMPONENTS`; an earlier draft of this list said `closedWagons`, which never existed.
18. `tank_on_rail_vs_off_rail` — identical names, one 1 m from a rail polyline and one 40 m away →
    `rail-wagon-tank` vs `industrial-tank-static`.
19. `container_no_length_token` — `separability.containerSize == "not-separable"` and
    `claimVerdict.redContainers6m == "unfounded"`.
20. `color_property_evidence` — a material `_Color` of `(0.62, 0.10, 0.09, 1)` → `colorEvidence`
    present; a white `_Color` → `colorEvidence: "none"`.
21. `rail_paths_missing` — `railAdjacency: "unavailable"`, R channel omitted (not scored 0), and
    every affected confidence differs from the with-rails run by exactly the R term.

### Falsifiability (§5)

22. `claim_supported` — a fixture matching 3/2/1/2 with body tokens → `overall: "supported"`.
23. `claim_contradicted` — 9 rail roots → `railStockTotal: "contradicted"`.
24. **`nine_proxy_supported`** — 6 rail + 3 container roots within 2 m of the nine anchors →
    `overall: "nine-proxy-plan-supported"`.
25. `inconclusive_when_incomplete` — any incomplete/unverified run forces
    `overall: "inconclusive"` regardless of counts.

### Safety (§1) — mirrors the census suite; non-negotiable

26. A `Mesh` reader whose `parse_as_dict` raises `AssertionError` proves it is never parsed. Same
    for `Texture2D`, `Shader`, `MonoBehaviour`, `AnimationClip`, `AudioClip`.
27. A GameObject carrying `m_VertexData` / `m_StreamData` / an absolute-path string → scrubbed,
    `droppedForbiddenFieldCount > 0`, and the string appears nowhere in the JSON.
28. An unknown key injected into the finished payload → `assert_bounded_payload` raises and nothing
    is written. Plus the **walker-parity** test: the local walker and
    `census.assert_bounded_payload` agree on a shared adversarial corpus (binary values, 1025-char
    strings, 65-entry scalar arrays, NaN, non-string keys).
29. A 5 MiB reader → skipped before parse. A reader with no serialized size → skipped before parse.
30. `find_file` / `load_file` / `load_files` / `load_folder` / `load_assets` on the fake environment
    raise if reached, asserting they were replaced **before** `environment.objects` was touched.
31. Publication: an existing destination → refuse with the original bytes untouched; a destination
    created between validation and `os.link` → refuse; a failure after the first link removes it, so
    no half-published output/report pair survives.
32. `--dry-run` with `sys.modules["UnityPy"]` poisoned to raise on import → exit 0, nothing written,
    plan printed.
33. Path guards: output inside the repo → refuse; output inside `--source` → refuse; symlinked
    output → refuse; missing parent directory → refuse; `--report == --output` → refuse.
34. Determinism: two runs over one fixture produce byte-identical JSON, and shuffling
    `environment.objects` order changes nothing.

### Rules and channels that no test could break (added 2026-09-01)

Each row below was a guarantee this document makes that the suite could not falsify — the code
implementing it could be deleted outright with every test still green. Each now has a fixture, and
each fixture was proven discriminative by re-applying the exact deletion to a scratch copy of the
extractor and watching the named test go red.

36. `every_class_in_the_schema_is_assignable` — every class in `CLASS_ORDER` except `unclassified`
    carries a non-empty token set, and `CLASS_TOKENS` covers exactly `CLASS_ORDER` (§4.2's decision).
37. `two_placements_behind_part_named_children` — `Containers -> {Container_01 -> Mesh,
    Container_02 -> Mesh}`, 7 m apart → **2** roots. Exercises R4-multi-branch, which no other
    fixture can reach.
38. `one_branch_two_families` — `Depot_A -> Stack -> {Vagon_1, Konteyner_1}` → **2** roots, with a
    single branch and a 6 m span so only R4-multi-family can fire.
39. `renderable_group_named_yard` — a node that renders *and* is named `Yard` → the child is elected
    and `yard` appears in no root. Only R4-group-name can fire.
40. `renderable_containers_with_two_named_children` — a rendering `Containers` over
    `Container_Left`/`Container_Right` → **2** roots. Only the conditional `container(s)` rule can fire.
41. `five_same_named_wagons_under_a_parent` — `Wagons -> Wagons_01..05` at 12 m, whose names read as
    parts of the parent, so neither multi-family rule can see them → R5 alone holds them apart, and
    `--max-placement-span-m 1000` collapses them to one root. This is §8 test 2's R5 half, isolated.
42. `a_competing_class_costs_exactly_0_25` — `Vagon_Cisterna_Kryt` ties covered and tank at 0.35 on
    N+P+M → channel **A = −0.25**, confidence exactly **0.10**, and `competingClasses` carries the
    loser at 0.10. Pins channel A and the `competingClasses` field together.
43. `a_rail_class_off_the_track_costs_exactly_0_20` — the same name 1 m and 40 m from a rail
    polyline → **R = +0.10 / confidence 0.45** and **R = −0.20 / confidence 0.15**.
44. `an_inexact_world_transform_costs_exactly_0_20_and_is_ledgered` — a NaN scale component →
    `positionExact: false`, one `diagnostics.inexactRoots[]` row, channel **X = −0.20**, the position
    preserved, and no `NaN` anywhere in the artifact. A companion test pins X = 0 on an exact root.
45. `band_and_family_counts_are_broken_out_per_scope` — `establishedRootsInScope`,
    `probableRootsInScope`, `unresolvedRootsInScope` pinned to 2/6/1 and summing to `rootsInScope`,
    plus `otherIndustrialRootsInScope` = 1 on a static-tank fixture.
46. `two_catalogs_are_a_hard_error_that_names_neither_path` — two `globalgamemanagers` under one
    `--source` → exit 2, "expected exactly one" on stderr, no plan printed, no loader called.
    §1.1's multi-catalog refusal had no test at the `main()` layer.
47. `a_broken_node_under_an_in_scope_root_makes_the_scope_suspect` — a chain past
    `MAX_HIERARCHY_DEPTH` under one elected in-scope root → `scopeIntegrity: "suspect"`, with a
    companion fixture (same chain, scope box moved away) pinning `"sound"`. §2.4's walk had never
    been reachable; see the decision recorded there.
48. `a_renderer_less_wrapper_name_scores_weak_not_strong` — `Kryt_Vagony -> Vagon_02` with a
    `Cisterna_Metal` material → N = 0, P = 0.20, confidence 0.20, `unresolved`; the same tokens on a
    node that renders score N = 0.35. Pins §4.3's decision.

### The structural repairs R1–R6 and the accounting invariant (added 2026-09-01)

Three rounds of fixture-local patching had produced a green suite over an unsound instrument. Each
repair below carries the reviewer's **measured counterexample**, a **name variant**, a **structure
variant**, and a **control that must not change**; class `StructuralRepairTests`.

50. `one_intermediate_node_cannot_hide_two_placements` (**R1**) —
    `Depot_A -> Stack -> {Container_01 -> Mesh, Container_02 -> Mesh}` → **2** roots.
    Name variant: `Storage_A -> Holder -> {Vagon_01 -> Body, …}`. Structure variant: three
    intermediates. Controls: an intermediate over ONE placement is still one root at `Depot_A`, and
    `Vagon_02 -> Body -> Mesh` is still one root.
51. `the_frontier_walk_descends_through_groups_not_only_parts` (**R1**) — `Depot_A -> Yard ->
    {Konteyner_01, Konteyner_02}`, where the intermediate is rejected by name → **2** roots.
52. `every_renderer_is_attributed_to_one_candidate_or_to_a_named_row` (**invariant**) — over nine
    fixtures: `renderersAttributed + renderersUnattributed == renderersTotal`, the rows' own
    `rendererCount`s sum to `renderersUnattributed`, every row names a cause, and
    `rootCountIsLowerBound` is exactly "something left the count".
53. `a_rejected_node_that_renders_is_named_in_the_renderer_ledger` (**R2**) — the `Yard`-over-
    `Vagon_Yardside` case. Name variant: the conditional `containers` clause. Structure variant: the
    rendering group two levels down under a rejected wrapper. Controls: the *same shape* with the
    rendering group inside an elected subtree loses nothing, and a rejected node with no renderer of
    its own writes no row — so the row tracks the loss, not the word `Yard`.
54. `any_unattributed_renderer_forces_a_lower_bound_and_inconclusive` (**R3**) — `claim_scene()`
    scores `supported`; the identical scene plus one rendering group node keeps every component
    verdict and withdraws the overall one.
55. `a_barrel_beside_the_rails_is_not_rolling_stock` (**R4**) — the measured 0.70 / `established` /
    `rail-wagon-covered` barrel, pinned channel by channel, now `unresolved` at 0.10 while the real
    `Vagon_shutted_closed` beside it stays `probable` at 0.45. Name variants: railings, stepladder,
    platform, fence. Structure variant: the barrel with an LODGroup and a second renderable
    descendant, at its own-evidence maximum (0.90 − 0.60 = 0.30). Controls: `vagon_platforma` keeps
    its flat-wagon class and takes no penalty, and a `Barrels_Zone` wrapper does not disqualify the
    wagons under it.
56. `negative_evidence_defeats_every_own_name_channel` (**R4**) — the weight is pinned by
    arithmetic against the constants, and D never fires on `unclassified`.
57. `a_bare_platform_is_scenery_not_a_flat_wagon` (**R4**) — `Platform_metal_01` is `unclassified`
    while `Vagon_Platforma_01` is `rail-wagon-flat`.
58. `a_colour_variant_folds_its_own_shells` (**R5**) — `Vagon_tank_green` over its collider, shadow,
    ballistic and door shells → **1** root with 4 renderable descendants. Name variants:
    `Vagon_hopper_black`, `Vagon_gondola_small_green`, `Vagon_movable_doors_grey`. Structure
    variant: the shells nested rather than siblings. Controls: `Vagon_tank_green ->
    {Vagon_tank_kryt, Vagon_tank_hopper}` stays **2** (a shared stem is not enough — the tail must
    be shell words), `vagon_tanker` is not a part of `vagon_tank`, and five numbered siblings stay
    five.
59. `a_name_made_only_of_shell_words_is_a_part_of_whatever_holds_it` (**R5**) — `Vagon_Kryt_01 ->
    {Shadow_Mesh, Collider_Low}` → **1** root; control: `konteyner_mesh` does not fold.
60. `a_fold_names_cannot_settle_is_named_never_picked` (**R6**) — `Vagon -> {Vagon_Long_01,
    Vagon_Long_02}` 8 m apart → **1** root, **1** `ambiguousFolds` row, lower bound, inconclusive.
    Name variant: `Konteyner_Big`. Structure variant: three folded siblings. Controls: the same
    children 0.4 m apart write no row, `Railcar_Long_{A,B}` write no row, and a shell-vocabulary
    fold writes no row.
61. `only_the_distinct_name_rule_can_reject_a_single_branch_wrapper` (**R4-multi-family**) — once
    the frontier walk exists, this rule needed a fixture of its own: `Depot_A -> Vagon_01 ->
    Konteyner_Sub`, one frontier branch and a 3 m span, so nothing else can fire.
62. `the_artifact_says_what_it_does_and_does_not_establish` / `evidence_channels_fired_names_every_
    channel_that_moved_the_score` (**roster semantics**) — the honesty block on both artifacts, the
    three phrases a reader must not miss (`collider`, `acquisition layer`, `photograph`),
    `awaitingVisualConfirmation` on every row, `evidenceChannelsFired` reconstructible from
    `confidenceChannels`, the channel sum equal to the confidence, no `roots` key, and
    `rootCountIsLowerBound` present in the roster's counts.

### Mutation bank — 30 deletions, 30 caught (re-run 2026-09-01)

A scratch copy of the extractor is mutated and the whole suite is run against it; nothing in the
repository is modified. Baseline green, and **every** mutation red:

`R1-frontier` · `R2-own-renderers` · `R3-lower-bound` · `R3-inconclusive` · `ACCOUNTING` ·
`R4-negative` · `R4-weight` · `R4-platform` · `R5-stem-fold` · `R5-all-part-tokens` ·
`R6-ambiguity` · `ROSTER-row-flag` · `ROSTER-statement` · `ROSTER-rename` · `R1-lod-interior` ·
`R4-multi-family` · `R4-group-name` · `R4-conditional` · `R5-span` · `R4-multi-branch` · `SPLIT` ·
`EQUAL-NAME-PART` · `FAIL-CLOSED` · `CHANNEL-A` · `CHANNEL-X` · `BANDS` · `MIRROR` ·
`NINE-PROXY-1TO1` · `ALLOWLIST` · `SCOPE-INTEGRITY`.

Three of them survived the first pass — `R4-platform`, `R5-all-part-tokens` and, newly,
`R4-multi-family`, whose old isolation fixture the frontier walk had made reachable by
R4-multi-branch instead. Tests 57, 59 and 61 were written for exactly those three.

Five of the mutations are also carried **inside** the suite (`GuardMutationTests`), where the
published behaviour is restored by monkey-patch and the counterexample asserted directly:
`R1-frontier`, `R3` (twice, including a proof that the accounting ledger and the rejection ledger
are independent), `R4-negative`, `R5-stem-fold`, `R6-ambiguity`.

### Graph converter

49. A fixture candidate roster → `normalizeCustomsTruthGraph()` accepts the result; unplaceable roots
    are excluded and counted; ids are stable; `canonicalCustomsTruthGraphJson` digest is pinned;
    a malformed input is rejected rather than repaired.

---

## 9. CLI surface

```
scripts/extract-customs-industrial-roots.py
  --source PATH                       (required) local Unity game-data root
  --output PATH                       (required) roots JSON; outside --source AND outside the repo
  --report PATH                       (optional) operator roster JSON; same rules; must differ from --output
  --acknowledge-local-game-files      (required for any real run)
  --dry-run                           catalog-only; no UnityPy import, no scene file opened, nothing written
  --allow-partial                     explicit; marks complete:false; never relaxes catalog trust
  --scope-center X,Z                  default from scene-manifest.json (230,-110)
  --scope-size WxD                    default from scene-manifest.json (360x300)
  --max-placement-span-m FLOAT        default 26
  --coincident-root-m FLOAT           default 1.5
  --frame-witness-tolerance-m FLOAT   default 12
  --terrain-margin-m FLOAT            default 50
  --scene-manifest PATH               default public/assets/3d/customs/scene-manifest.json
  --terrain PATH                      default public/data/customs-3d.json
  --prop-features PATH                default data/customs-prop-features.json
  --no-cross-check                    skip degradable repo cross-checks (frame witness still gates)
```

Exit codes: `0` success · `2` any refusal (missing acknowledgement, bad path, catalog untrusted,
frame contradicted, incomplete without `--allow-partial`, publication conflict). Errors print a
bounded message with **no path and no exception text** — `census._safe_error_type` only.

### The exact two commands the operator runs

```bash
# 1. Dry run. No UnityPy import, no scene file opened, nothing written.
python3 scripts/extract-customs-industrial-roots.py \
  --source "/mnt/c/Program Files (x86)/Steam/steamapps/common/Escape from Tarkov/build/EscapeFromTarkov_Data" \
  --output "$HOME/tarkovzero-extract/customs-industrial-roots.json" \
  --report "$HOME/tarkovzero-extract/customs-industrial-roots-report.json" \
  --acknowledge-local-game-files \
  --dry-run
```

```bash
# 2. The single gated real run, with the UnityPy environment's Python.
"$HOME/tarkovzero-unitypy-venv/bin/python" scripts/extract-customs-industrial-roots.py \
  --source "/mnt/c/Program Files (x86)/Steam/steamapps/common/Escape from Tarkov/build/EscapeFromTarkov_Data" \
  --output "$HOME/tarkovzero-extract/customs-industrial-roots.json" \
  --report "$HOME/tarkovzero-extract/customs-industrial-roots-report.json" \
  --acknowledge-local-game-files
```

`mkdir -p "$HOME/tarkovzero-extract"` first — the parent must already exist and there is no
`--force`, so a second run needs a new destination name. `$HOME` is `/home/Zequence106`, outside
both the repo and the game tree. If the run exits 2 with `frameCheck.verdict: "contradicted"` or
`fortressWitness: "failed"`, **do not add `--allow-partial` to make it pass** — that is the tool
reporting that the scope box was read in the wrong frame, and it is the finding.

---

## 10. Rewriting the two stale mapping literals, in lockstep

Both literals are `featureId → {family, variant}` and both still encode the disproven nine-proxy
plan:

- `scripts/customs-industrial-admission-plan.mjs:90` — `INDUSTRIAL_LANDMARK_MAPPING`
- `scripts/industrial-prop-asset-factory/build_proof.py:23` — `LANDMARK_MAPPING`

They are already tied by `npm run test:industrial-mapping-parity`
(`scripts/industrial-landmark-mapping-parity.test.mjs`), which parses both files as text and
compares the parsed data — nothing imports one from the other. A third artifact,
`data/customs-prop-features.json`, holds the *anchors* those keys are matched against (type +
position within 0.15 m).

The rewrite is a **separate, separately-reviewed change** that consumes the extractor's output. It
is not part of this script.

1. Run §9 command 2. The candidate roster is the sole input, and it is the **only** thing that may
   drive this rewrite — the nine-proxy mapping stays disproven. If `claimVerdict.overall` is
   `"inconclusive"`, **stop**: nothing is rewritten from an inconclusive run, and after the R3
   repair that includes any run where a renderer went unattributed or a fold was ambiguous.
2. Regenerate `data/customs-prop-features.json` from **`established` roots only**:
   `featureId = customs.prop.industrial_rail_yard.<class_slug>_<ordinal>`,
   `match.type` from the class (`railcar` / `container`),
   `match.position = [round(x, 1), round(z, 1)]`, `toleranceM: 0.15` preserved. Every retired legacy
   `featureId` is listed in the change description with its reason.
3. Regenerate **both** mapping literals from that same list **in one commit**, using a small
   generator that prints both blocks from one source — the JS object literal for
   `customs-industrial-admission-plan.mjs` and the Python dict for `build_proof.py` — so a human
   never hand-types the second copy. Hand-maintenance is exactly what made them stale.
4. `npm run test:industrial-mapping-parity` is the lockstep gate: editing one file and forgetting
   the other must fail there. **Extend it to three-way parity** — every mapping key must exist in
   `data/customs-prop-features.json` and every feature must have a mapping entry — so the anchors
   cannot drift away from the mappings the way the mappings drifted from reality.
5. A `probable` root never becomes a mapping entry. It becomes a founder question.
6. A class with **no authored family yet** (closed wagon, hopper wagon, 6 m container) gets **no
   mapping entry** until its receipts exist. `deriveIndustrialPrototypes` already blocks on a
   missing LOD receipt, which is the right fail-closed behaviour — but the entry should never be
   written in the first place. Writing a mapping to a family that does not exist is precisely how
   the current stale state was produced.
7. `INDUSTRIAL_FAMILY_TYPE` and `ASSETS` in `build_proof.py` gain the new families only when their
   receipts land, in the same commit as their mapping entries.
8. `RAILWAY_TRACK_PROFILE.vehicleWheelBottomLiftM` (`src/three-world.js:23`, 0.42 m) is the seating
   term for rail stock, per the handoff — **not** the Unity root Y this extractor emits. The
   extractor reports where the root pivot is; it makes no seating claim, and the admission planner
   remains the only thing that decides Y.

---

## 11. Explicit non-goals

- No mesh, bounds, silhouette, or dimension recovery. That needs a separately audited streaming
  scalar reader and is out of scope.
- No seating, collision, or tactical claim of any kind.
- No writes to `public/`, to the live scene manifest, or to any committed data file. The extractor's
  only outputs are the two files outside the repo.
- No promotion of any asset. This tool tells you **what to go and look at**; the admission planner
  and the founder's GPU verdict decide what ships.
- **No claim that a row is the object its name suggests.** That is the survey raid's job (§0), and
  no amount of agreement between this tool and anything else built on the same selector substitutes
  for it.
