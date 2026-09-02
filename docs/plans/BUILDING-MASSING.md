# Building massing — accurate silhouette, original detail

**Date:** 2026-09-01 · **Lane:** buildings · **Status:** plan + one landed gate
**Founder decision this serves:** buildings get a **measured footprint and height** so the massing and
skyline are right, with **facades authored, not referenced**.

This document answers five things: where building heights actually come from today, which twelve
buildings are worth authoring first, how a measured footprint and height reach the renderer, what has
to change in `scripts/building-asset-factory/` before it can author more than one building, and what
the two open Crackhouse defects really are.

Everything below is read off the repository at `05ae863`. No game file was opened.

---

## 0. The headline

`CLAUDE.md` says building heights are "seeded from tarkov.dev floor extents". That sentence is
technically true of the mechanism and badly misleading about the result.

Of the **71** buildings in `public/data/customs-3d.json` (not 79 — see §1.5):

| Where the number comes from | Count |
| --- | ---: |
| A per-group constant, no per-building evidence whatsoever | **55** |
| A tarkov.dev floor band, but the value emitted is the **3.3 m clamp**, not the band | **9** |
| A constant hand-written into `data/customs-features.json` | **6** |
| An actual tarkov.dev floor-extent top | **1** |

One building in seventy-one has a height that is a measurement of anything. It is the Depot
(`chemical warehouse sniper scav`, 15.5 m), and even that number is the ceiling of a *marker-visibility
band* for a sniper position, not a roof.

Separately, three buildings are drawn **shorter** than their JSON height because
`floorSurfaces` carries a bound roof observation that the renderer prefers. All three corrections are
downward, by 1.06 m, 1.19 m and 1.98 m. So the constants are not merely unevidenced; on the only three
we can check, they are systematically too tall.

The measured pass has an easy baseline to beat. The risk is not that it fails to improve on this — it
is that it lands a better number against the **wrong datum** and nobody notices, because that has
already happened twice (§3.1).

---

## 1. Where heights come from today

### 1.1 The mechanism

`scripts/build-3d.mjs:167-191`:

```js
const floorBoxes = [];            // from tarkov.dev's map entry: layer -> extents -> bounds
const FLOOR_H = 3.3;
...
const covering = floorBoxes.filter((f) => !underground && overlap(bbox, f) > 0.5);
const topY = covering.reduce((m, f) => Math.max(m, Math.min(f.y[1], f.y[0] + FLOOR_H)), 0);
const floors = covering.length ? 1 + new Set(covering.map((f) => f.layer)).size : 1;
const height = topY > 0 ? +(topY + 0.5).toFixed(1) : tank ? 6 : defaultHeight[grp];
```

Three things about this are load-bearing and none of them is a measurement.

**The extents are floor-switch bands, not buildings.** tarkov.dev's `layers[].extents[].height` is the
`[low, high]` Y range in which that floor's *markers* should be shown on the 2D map. Customs ships
twelve distinct bands. Four of them are open-topped:

```
2nd Floor: 2.7..6.5 · 5.7..1000 · 14..15 · 3.9..7.6 · 4.4..6.5 · 4.6..7.9
3rd Floor: 5.7..1000 · 7.7..11.3 · 6.7..11.6 · 8..11.1
4th Floor: 11.2..54.7
Underground: -1000..0.5
```

`5.7..1000` means "anything above 5.7 m is on this floor". It is not a roof.

**`FLOOR_H = 3.3` is what actually produces the number.** `Math.min(f.y[1], f.y[0] + FLOOR_H)` exists
to tame the `1000`s. It succeeds — and in doing so it becomes the source of the height. Nine of the ten
buildings that reach a floor band get a height that is `band.low + 3.3 + 0.5`, i.e. a nominal storey
plus a parapet allowance, with the band contributing only its floor level. Every `9.5 m` on the map is
`5.7 + 3.3 + 0.5`. Skeleton, Warehouse 7, Streamer House, Old Construction and both Dorms all get
`9.5` from the same open band, and they are not the same height as each other in the game.

**One building escapes the clamp.** The Depot's band is `14..15`, narrower than 3.3 m, so
`min(15, 17.3) = 15` survives and the height is `15.5`. That is the single band-derived height on
Customs.

### 1.2 Provenance, per building

Reproduced by replaying the exact `build-3d.mjs` derivation against the shipped
`customs-3d.json` and `scripts/tarkov-dev-maps.json`.

| Class | n | Value | What it is |
| --- | ---: | --- | --- |
| `GROUP-CONSTANT` | 55 | 3.5 / 4 / 9 / 22 / 6 / 4.8 | `cfg.buildingHeights` by SVG group, plus the `tank` and `canopy` style constants |
| `CLAMP-ARTEFACT` | 9 | 6.5 / 9.5 / 11.5 / 15 | `band.low + 3.3 + 0.5` |
| `MANIFEST-OVERRIDE` | 6 | 7.2 / 9.5 / 18.1 / 30 ×3 | `set.heightM` in `data/customs-features.json` |
| `BAND-TOP` | 1 | 15.5 | Depot, band `14..15` |

`cfg.buildingHeights` for Customs is one line (`build-3d.mjs:21`):

```js
buildingHeights: { 'Garages-2': 4, 'Big_Buildings-2': 9, 'Small_Buildings-2': 3.5, 'Powerline_Towers': 22 }
```

Every warehouse on Customs — Warehouse 3 (2075 m²), Warehouse 4 (2027 m²), Repair Shop (1921 m²),
Big Red (1906 m²) — is 9 m because it is in the `Big_Buildings-2` SVG group. Twenty-eight small
buildings are 3.5 m for the same reason.

The six manifest overrides are honest about themselves. `data/customs-features.json` records
`"status": "shell-needs-survey"` for Dorms 2-Story, `"reviewed-shell"` for Dorms 3-Story, and
`"30m fallback needs first-party survey"` for the cooling towers. Only the Fortress claims measured
provenance (`read-only-unity-transform-census`), and §3.1 shows what that claim costs.

### 1.3 The one channel that does carry evidence

`public/data/customs-3d.json` also ships `floorSurfaces`: 120 rows classified `floor` (62), `roof`
(30) and `underground` (28), each with an **absolute** `surfaceY`, a `stableId`, and an
`evidenceSourceIds` list (SPT spawns, SPT loose loot, tarkov.dev loot containers). This is a real
measurement channel — it is Y clustering over things that stand on surfaces.

`createFloorSurfaceResolver` in `src/surfaces.js` binds those rows to buildings and
`buildingProfile()` prefers a bound roof row over `building.height`. Both renderers call it
(`src/map3d.js:949`, `src/map3d-three.js:1765`). So `building.height` is **not** necessarily the number
on screen.

Three buildings currently get a measured roof:

| Building | `height` in JSON | Height drawn | Δ |
| --- | ---: | ---: | ---: |
| Warehouse 4 | 9.0 | 7.94 | −1.06 |
| Repair Shop | 9.0 | 7.02 | −1.98 |
| Warehouse 7 (`dead scav warehouse`) | 9.5 | 8.31 | −1.19 |

Three, out of thirty roof rows. The other 27 are discarded: **21** are scoped `cell:` and
`src/surfaces.js:20-22` deliberately refuses them —

> Cell rows have measured Y but no trustworthy footprint and therefore remain evidence-only; inventing
> a 20 m square would be false geometry.

— and 6 are `extent:` scoped. That is the single strongest argument for the measured-footprint lane:
**there are already 21 measured roof altitudes on Customs that cannot be used because nothing knows
what shape sits under them.** A measured footprint does not just improve one building; it unlocks
observations that already exist.

### 1.4 Floors

`floors = 1 + (number of distinct non-underground layers covering >50 % of the footprint bbox)`.
Distribution: 58 × 1 floor, 10 × 2, 2 × 3, 1 × 4. The bbox overlap test is coarse enough to
mis-assign: the **Fortress** picks up the `skeleton` band (its bbox overlaps by more than half) and
would derive 9.5 m if the manifest did not override it. The overlap test is on axis-aligned bounding
boxes of rotated footprints, so a diagonal building claims a lot of ground it does not occupy.

### 1.5 Two stale facts in `CLAUDE.md`

- "79 buildings, 14 multi-floor" — the shipped file has **71 buildings, 13 multi-floor**.
- "heights seeded from tarkov.dev floor extents" — true for 10 of 71, and 9 of those 10 are the clamp.

Worth correcting when someone next touches that file; not corrected here, because `CLAUDE.md` is not
in this brief.

---

## 2. The twelve worth authoring first

Ranked on three axes the founder named. Two of them are measured here; one is not, and is labelled.

- **Player importance** — proxied by *quest zone points inside or within 30 m of the footprint*,
  counted from `public/data/quests.json` (83 Customs zone points across all quests). This is a proxy:
  it does not count loot density, spawn proximity, or how often people fight in a place.
- **Silhouette prominence** — footprint area × height. A proxy for mass, not for what a camera sees.
  Nobody has measured what actually breaks the skyline from the default orbit; that is a real gap and
  a cheap one to close with a render pass.
- **How wrong it looks** — the height's provenance class, plus whether the drawn form (a single
  extruded prism with `detailParts()` banding) can represent the real building at all.

Grouped into **authoring cells**, because several of these read as one object to a player and because
grouping is what makes twelve buildings into seven archetypes (§4.2).

| # | Cell | Parts | Area m² | Height today | Provenance | Quest zones | Why it is here |
| ---: | --- | ---: | ---: | --- | --- | ---: | --- |
| 1 | **Dorms** (3-Story + 2-Story) | 3 | 1 640 | 9.5 / 7.2 | manifest constant | **10** | The most trafficked building on Customs by a wide margin. Floor counts are exact (lock clusters); the shell is admitted as unsurveyed. Two blocks, one silhouette. |
| 2 | **Big Red** | 1 | 1 906 | 9.0 | group constant | 1 | The map's signature landmark, drawn at the default warehouse height. Its own measured floor sits **2.61 m** above the fitted terrain on 84 evidence points — the seat is wrong before the height is. |
| 3 | **Warehouses 3 + 4** | 3 | 4 120 | 9.0 | group constant | 1 | The two largest footprints on the map, both at the group default. Warehouse 4 measures **7.94 m**. One archetype, two instances — the cheapest mass-per-hour on the list. |
| 4 | **Repair Shop** | 1 | 1 921 | 9.0 | group constant | 4 | 14-vertex footprint (not a box), measures **7.02 m** — the largest known error on the map — on a floor row with 196 evidence points. |
| 5 | **Depot** | 1 | 1 904 | 15.5 | **band top** | 6 | The only evidence-derived height on Customs, and the tallest large-footprint building. Authoring it tests whether the one good number survives contact. |
| 6 | **Oil Rig** | 1 | 1 835 | 15.0 | clamp artefact | 5 | Four floors off a `11.2..54.7` band. Its measured floor sits **3.83 m below** the fitted terrain — the worst datum disagreement on the map. |
| 7 | **Skeleton** | 4 | 1 572 | 9.5 | clamp artefact | 0 | An unfinished concrete frame with a bespoke renderer path (`openFrame`, `map3d-three.js:1771`) and *zero* floor-surface rows. Height is `5.7 + 3.3 + 0.5` and the form is the point of the building. |
| 8 | **Fortress** | 1 | 1 538 | 18.1 | manifest, census-derived | 4 | The only height traceable to a Unity transform census — and the only case where two lanes in this repo disagree about the same building by 0.71 m (§3.1). It already has an authored factory. **Author it second, not first: it is the calibration case.** |
| 9 | **Warehouse 17** | 2 | 1 555 | 11.5 | clamp artefact | 3 | 10-vertex footprint, `7.7..11.3` band clamped to 11.0. Tall enough that the error is visible from the road. |
| 10 | **Water Pump cooling towers** | 3 | 838 | 30.0 | manifest constant | 0 | The tallest structures on Customs by 12 m, at a number the manifest itself calls a fallback needing survey. Zero quest zones and the highest silhouette leverage on the map — this is where "the skyline is right" is won or lost. |
| 11 | **Streamer House / USEC 2nd** | 2 | 1 171 | 9.5 / 6.0 | clamp artefact | 3 | Two parts drawn at two unrelated constants that a player reads as one house. |
| 12 | **Gas stations** (New Gas + Old Gas) | 4 | 986 | 4.8 | canopy constant | 6 | `b.style === 'canopy'` overwrites the height with a literal `4.8` regardless of evidence (`build-3d.mjs:466`). The canopy archetype, and the busiest small structure on the map. |

**Not on the list, deliberately:**

- **Crackhouse** — already authored. It stays as the *regression anchor*: any change to the shared
  factory must leave its three GLBs byte-identical.
- **The 28 `3.5 m` small buildings and 12 `4 m` garages** — 55 % of the building count, ~8 % of the
  visible mass. They are what a parameterised archetype gets you for free later; authoring them by
  hand first would be the worst possible order.
- **Powerline towers** (4 × 22 m) — lattice structures, not buildings; they belong to the prop lane.

---

## 3. The massing contract

The bounds lane will produce measured numbers. This section defines the shape they land in and where
they enter, so the output has somewhere to go that is not another constant.

### 3.1 The bug the contract exists to prevent

A height is meaningless without its datum, and this repository already carries two silent datum
disagreements:

**Fortress.** `scripts/asset-factory/fortress_factory.py` pins measured world elevations:
ground floor top `2.447`, roof truss `17.7 .. 19.8`. `data/customs-features.json` pins
`heightM: 18.1`. The terrain fit puts the ground under the Fortress centroid at `1.740`, so the
renderer draws its roof at `1.740 + 18.1 = 19.840` — within **40 mm** of the factory's measured truss
top. The two lanes agree almost exactly about where the roof is in the world, and disagree by
**0.707 m** about where the floor is. Nothing detects this, because one lane speaks in absolute Y and
the other in height-above-fitted-terrain.

**Crackhouse.** `crackhouse_facts.json` records ground `surfaceY = 1.983`. The terrain fit under the
same centroid gives `1.433`. The authored shell, seated by `seatBuilding()`, would stand **0.55 m**
below its own measured floor.

This is not two unlucky buildings. Across the **47** buildings that have a measured `floorIndex: 0`
row, the disagreement between that measured elevation and the fitted terrain at the footprint centroid
is:

```
median |Δ| 0.589 m      p90 2.612 m      max 3.825 m
30 of 47 over 0.5 m     15 of 47 over 1.0 m
```

Some of that is real — buildings sit on plinths and loading docks, and the terrain fit is deliberately
*outside grade* (roof/floor/bridge buckets never bend it). Some of it is fit error. Some of it is
misclassification: an interior mezzanine banked as `floorIndex: 0`. **The contract's job is to make
that number visible, not to absorb it.** Today it is absorbed silently, which is exactly how 0.707 m
went unnoticed on the one building we supposedly measured.

### 3.2 Shape

A massing record is **absolute**, **datum-named**, and **derived-height-only**.

```jsonc
{
  "featureId": "customs.building.fortress.main",
  "sourceKey": "svg:Ground_Level/Buildings/Big_Buildings-2:element-196:subpath-0",

  "footprint": {
    "eftXZ": [[x, z], ...],            // measured or SVG, never mixed
    "method": "svg-trace" | "measured-oobb" | "measured-polygon",
    "sourceIds": ["..."]
  },
  "oobb": {                             // the box the authored asset is built in
    "centerXZ": [x, z],
    "lengthM": 61.277, "widthM": 25.107, "yawDeg": -10.342808,
    "method": "mean-opposing-edge" | "min-area-rect"
  },

  "baseY":  { "m": 2.447,  "method": "floor-surface-cluster", "toleranceM": 0.15, "sourceIds": [...] },
  "eaveY":  { "m": 17.700, "method": "mesh-local-aabb", "toleranceM": 0.30, "worldExact": false, ... },
  "roofY":  { "m": 19.800, "method": "mesh-local-aabb", "toleranceM": 0.30, "worldExact": false, ... },
  "floorYs": [ { "index": 0, "m": 2.447, ... }, { "index": 1, "m": 8.183, ... } ],

  "heightM": 17.353,                    // DERIVED: roofY - baseY. Never authored.
  "confidence": "measured" | "derived" | "assumed",
  "terrainDisagreementM": 0.707         // DERIVED: baseY - H(centroid) at relief 1
}
```

Six rules, each of which is a test:

1. **`heightM` is never authored.** It is `roofY.m − baseY.m`, recomputed at build. A massing file
   containing a literal `heightM` that disagrees is a build failure, not a warning. This is the rule
   that kills the whole class of bug in §3.1.
2. **Every altitude names its datum and its method.** `"the terrain"` is not a datum. A record whose
   `baseY.method` is absent is refused.
3. **`eaveY` is separate from `roofY`.** A gable's single "height" collapses its form. The Crackhouse
   factory already hardcodes `EAVE_LOCAL_Z_M = 5.24` against `RIDGE = 6.5` as an authored guess; the
   contract makes that a measurable field instead of a constant in a Python file.
4. **`terrainDisagreementM` is published, per building.** It is not applied. Seating stays the
   renderer's job (§3.4). A build that produces a disagreement over a threshold prints it; it never
   quietly moves a floor.
5. **`confidence: "assumed"` must reproduce today's number exactly.** Adopting the schema is a no-op
   on the shipped JSON. If introducing the contract changes one height, the contract is wrong, not the
   data.
6. **Bounds-derived altitudes carry `worldExact`.** Straight from the bounds spike (§6 of
   `BOUNDS-SPIKE-FINDINGS.md`): `m_LocalAABB` is local and pre-transform, and a rotated non-uniform
   world scale makes the transformed AABB an over-estimate. A derived world extent is labelled derived
   and carries `worldExact: false`. And a bound is a property of a mesh **resource**, so a massing
   record sourced from bounds names which placed object it was attributed to, and how.

### 3.3 Where it enters

Two channels already exist. The contract uses both, for different halves.

**Altitudes go through `floorSurfaces`.** This is the existing measured channel and it is already
right in the ways that matter: `surfaceY` is absolute; `evidenceSourceIds` carries provenance;
`createFloorSurfaceResolver` translates to displayed metres correctly at relief 2 and 3
(`src/surfaces.js:56-61` — relief exaggerates the terrain datum, never the height of a room); and
`buildingProfile()` already prefers a bound roof row over `building.height` in **both** renderers.

The bounds lane therefore emits new `floorSurfaces` rows — `classification: "roof"`, a real
`buildingSourceKey`, a `method`, and its instrumentation — and **no renderer change is needed for
height at all**. Three buildings already prove the path works end to end. As a bonus, the 21
cell-scoped roof rows that are currently unusable become bindable the moment a measured footprint
exists for what is under them.

**Footprint, yaw and eave go through a new reviewed input.** `floorSurfaces` has no footprint field
and should not grow one. Add `data/customs-massing.json` (schema-versioned, same shape discipline as
`data/customs-features.json`), read by `build-3d.mjs` next to the feature manifest, emitting
`building.massing` onto the row.

**Do not extend `set.heightM`.** That is the channel that produced the Fortress disagreement: a bare
scalar with no datum, applied twice (`build-3d.mjs:256` before the terrain fit exists, and again at
`:772` after). It stays for reviewed identity overrides and stops being a place heights are invented.
There is already a better precedent one block down — `heightSource: "exact-top-or-fallback"` writes
`building.heightEvidence` with a method and a reason code (`build-3d.mjs:773-786`). The contract is
that idea, generalised, and with the datum fixed: that code still computes
`row.raw.top − terrainHeight(...)`, which is the §3.1 bug in miniature.

### 3.4 What the contract does **not** change

`src/buildings.js` keeps its job. Massing decides how tall a building is and where its floors are, in
absolute EFT Y. `seatBuilding()` decides where the walls meet the *displayed* terrain, which is a
different question with a different answer at relief 2 and 3, and which exists to stop the 19.3 m
plinth bug from coming back. The two must not be merged. What changes is that their disagreement gets
a name and a number instead of being invisible.

And the caveat from the bounds spike stands verbatim: **bounds are a filter that removes
size-impossible candidates and a source of dimensions, not a promoter that creates confirmed
objects.** For "how tall is this warehouse" that is exactly enough. No artifact produced by this lane
may claim more.

### 3.5 Manifest v2

An authored building enters the scene through `docs/plans/ASSET-MANIFEST-V2.md`, unchanged. Two
existing rules bind the massing lane specifically:

- The `base-center` pivot rule — a declared pivot whose bounds are not seated at the origin is
  rejected, because "a pivot declaration that disagrees with the bounds makes seating a guess". A
  massing record's `baseY` is what that pivot means in the world.
- The replacement rule — an authored instance that claims a `featureId` with no replacement entry is
  rejected, "otherwise the procedural original draws underneath it forever". Twelve authored buildings
  is twelve replacement records, and several are multi-part cells retiring more than one procedural
  fragment, which the schema already allows.

One gate is **added** by this pass: §5.1.

---

## 4. Generalising `building-asset-factory`

### 4.1 The premise is already wrong, and that is the finding

The brief says the factory authors exactly one building. It authors one; the repo authors **three**
assets across **three** copy-pasted factories:

| Factory | Lines | Assets |
| --- | ---: | --- |
| `scripts/asset-factory/fortress_factory.py` | 2 230 | `fortress-shell`, `zb013-basement` |
| `scripts/building-asset-factory/crackhouse_factory.py` | 1 398 | `crackhouse-shell` |
| `scripts/industrial-prop-asset-factory/industrial_prop_factory.py` | 1 090 | industrial props |

All three define their own `hash01`, `smoothstep`, `create_image`, `create_material`, `tag_object`,
`create_box`, `export_glb`. All three validators define their own `glb_json`, `node_matrix`,
`multiply4`/`matrix_multiply`, `geometry_stats`, `sha256_file`.

**The copies have already diverged.** `hash01`, the function that seeds every procedural texture:

```python
# fortress_factory.py and crackhouse_factory.py
value = (x * 0x1F123BB5 + y * 0x5F356495 + seed * 0x6C8E9CF5) & 0xFFFFFFFF
# industrial_prop_factory.py
value = (x * 0x1F123BB5) ^ (y * 0x5F356495) ^ (seed * 0x6C8E9CF5)      # + -> ^, and no mask
```

`smoothstep` clamps its input in one of the three and not in the other two. Three functions, one name,
three behaviours. Nothing tests that they agree, because nothing knows they are the same function.

Scaling this way to twelve buildings means roughly **15 000 lines with twelve divergent copies of the
noise function**, and a texture that silently changes character depending on which file authored it.
That is the argument for parameterisation, and it does not depend on any opinion about clean code.

#### 4.1.1 Consolidated 2026-09-01 — and the count above was low

Steps 1, 2 and most of 4 have landed in `scripts/lib/` (see `scripts/lib/README.md`). The pass
rebuilt all 24 assets the three factories produce, before and after: **21 of 24 GLBs are
byte-identical**, and the three that are not carry a *pre-existing* exporter nondeterminism
(below), verified structurally instead. Zero regressions.

Two corrections to the finding above:

1. **There were four output-affecting divergences, not two.** Beyond `hash01` and `smoothstep`:
   - the tiling value noise closes its bilinear as `a + (b-a)*t` in fortress and `a*(1-t) + b*t`
     in crackhouse — algebraically equal, **not** equal in IEEE-754;
   - `create_box` ships two different face tables — fortress and crackhouse agree, industrial
     walks the side faces as a ring, emitting a different index order for the same box.

   Also, `apply_identity` (fortress) and `apply_scale` (crackhouse) are the same function under
   two names, which is why a name-matched scan misses it.

2. **It is five factory families, not three.** `scripts/vegetation-asset-factory/` (13 files) and
   `scripts/terrain-pbr-factory/` carry their own copies of `sha256_file`, `require`, `glb_json`,
   `create_image`, `create_material` and `export_glb`. They are out of this pass's scope and
   untouched; `terrain_pbr_factory.smoothstep` is a third, GLSL-style two-edge signature.

None of the divergences was resolved. Each is a **named variant** with no default, so a new
factory has to choose in the open. `scripts/lib/test_lib_core.py` pins each variant to a verbatim
copy of its original body and also asserts the variants still *disagree*, so a later "tidy-up"
that collapses them fails loudly instead of silently re-baselining an admitted asset.

**Which `hash01` should win is still open** — see §4.5 step 2, which remains unstarted.

#### 4.1.2 Three fortress outputs are not byte-reproducible (pre-existing)

`fortress-shell-lod0`, `fortress-shell-lod1` and `zb013-basement-lod0` produce a different SHA-256
on every build from unmodified code on the same machine. Byte length, triangle count, bounds, the
entire JSON chunk and every embedded image are stable; only `TEXCOORD_0` (≤ 9.54e-07, ~1 ULP) and
`TANGENT` (≤ 3.1e-03) move. Not fixed by `-t 1` or `PYTHONHASHSEED=0`.

Consequence: the pinned `fortress-shell` lod0/lod1 digests in `scene-manifest.json` **cannot be
reproduced by rebuilding.** The manifest still proves the shipped bytes are the admitted bytes, but
"rebuild and confirm" is unavailable for those two LODs. `fortress-shell-lod2` rebuilds to its
shipped digest exactly, as do all crackhouse and all industrial outputs.

This blocks §5.1's measurement discipline more than it blocks authoring, and it needs its own lane.

### 4.2 The seven archetypes

Twelve buildings are not twelve factories. Sorted by form:

| Archetype | Cells | Exists today |
| --- | --- | --- |
| **A** Pitched-roof masonry house | Crackhouse, Streamer House | ✅ crackhouse |
| **B** Long-span industrial shed | W3, W4, W7, Repair Shop, Depot, Warehouse 17 | ❌ |
| **C** Flat-roof concrete block | Dorms 2 & 3, Big Red | ❌ |
| **D** Open unfinished frame | Skeleton, Fortress | ◐ fortress-shell |
| **E** Canopy on posts | New Gas, Old Gas, Bus Station | ❌ |
| **F** Vertical cylinder / hyperboloid | Water Pump towers ×3, tanks | ❌ |
| **G** Lattice tower | powerline towers | prop lane, out of scope |

Six archetypes cover the twelve. That is the shape of the work: **parameterise one archetype at a
time**, not one building at a time.

### 4.3 What is crackhouse-shaped, by name

Read from `scripts/building-asset-factory/crackhouse_factory.py` at `05ae863`.

**Hard blockers — the factory cannot author a second building without these changing.**

| Location | Assumption | Why it blocks |
| --- | --- | --- |
| `derive_transform()` :163 | `require(len(poly) == 4, "canonical derivation requires a four-point footprint")` | **16 of 71** buildings are not quads, including 8 of the 12 largest: Repair Shop (14), Depot (12), Oil Rig (10), Warehouse 17 (10), Streamer House (8), Big Red (6), Dorms 3-Story (6), New Gas (14). |
| `CANONICAL = derive_transform(SOURCE_FOOTPRINT_EFT_XZ)` :192 | Evaluated at **module import**, bound to one literal footprint | Every geometry function reads the module global `CANONICAL`. There is no seam to pass a different building through. |
| `SOURCE_*` :35-52 | `SOURCE_KEY`, `SOURCE_FOOTPRINT_EFT_XZ`, `SOURCE_HEIGHT_M`, `SOURCE_FLOORS`, `SOURCE_GROUND_WORLD_Y_M`, `SOURCE_UPPER_WORLD_Y_M`, `EAVE_LOCAL_Z_M`, `RIDGE_LOCAL_Z_M` | Module constants, not parameters. |
| `load_facts()` :124 | Asserts `place == "Crackhouse"`, `style == "gable"`, `floors == 2`, `height == 6.5`, exactly two floor surfaces, `sourceKey == SOURCE_KEY` | The facts file is a **pinning device for one building**, not an input format. This is correct for what it is and must not be loosened in place — it must be split (§4.4). |
| `spatial_batch_band()` :1098 | Two bands split at `UPPER_LOCAL_Z_M` | Dorms 3-Story has three floors; Oil Rig four. Needs `n` bands from the massing record's `floorYs`. |
| `REFERENCE_MIN/MAX` in `render_crackhouse_preview.py` :28 | `(-12.70, -8.70, -0.18) .. (12.70, 8.70, 6.50)` and `require_inside_envelope()` | The QA camera rig is frozen to the Crackhouse's envelope by design (that freeze is what made the contact sheets trustworthy). A second building fails the render rather than being framed out of it — correct behaviour, wrong granularity: the envelope must come from the asset's massing record. |

**Shape assumptions — parameterisable, but only for archetype A.**

| Location | Assumption |
| --- | --- |
| `all_openings()` :623, `LOD1_OMIT` / `LOD2_KEEP` :648 | Literal per-facade opening lists keyed `"S-U1"`, `"N-G2"` …; four facades named S/N/E/W, i.e. a rectangular box |
| `add_roof()` :877 | One ridge along local +X, symmetric two-slope gable, `rows × columns` tiles. No mono-pitch, sawtooth, flat, or curved roof — which is archetypes B, C, E and F |
| `add_upper_slab()` :938 | `hole = (2.35, 7.45, -1.15, 1.15)` — a stairwell void in metres from the Crackhouse pivot |
| `add_stairs()`, `add_interior()`, `add_gables()`, `add_contact_plinth()` | Literal coordinates throughout |
| `add_damage_and_boards()` :1003 | `patch_specs` with literal `±width*.5 ± 0.146` offsets — see §5.2 |
| `MATERIAL_SPECS` :65 | Nine materials, house-flavoured (plaster/brick/timber/roof_tile). Archetype B needs corrugated steel and cement board; F needs weathered concrete |

**Validator, `validate_crackhouse_outputs.py`.** `ASSET_ID`, `SOURCE_KEY`, `SOURCE_FOOTPRINT`,
`SOURCE_HEIGHT`, `GROUND_WORLD_Y`, `UPPER_WORLD_Y` are module constants, and
`EXPECTED_OPENINGS` / `EXPECTED_DOORS` / `EXPECTED_WINDOWS` / `EXPECTED_ROOF_TILES` /
`EXPECTED_STAIR_STEPS` / `EXPECTED_TEXTURE` are per-LOD literal tables. Budgets are literals
(`meshes ≤ 32`, `nodes ≤ 96`) sized for a 395 m² house; Warehouse 3 is 5× that footprint.

### 4.4 The target shape

Three layers, and the split is what does the work:

```
scripts/lib/blender/           # imported by every factory, NO building knowledge
    noise.py         hash01, smoothstep, tile_noise      <- ONE definition, tested
    materials.py     create_image, create_material, material_set from a spec dict
    primitives.py    create_box, create_prism, create_cylinder, create_beam_between,
                     append_oriented_box, assign_metric_uv, apply_scale, tag_object
    export.py        batch_meshes_for_export(bands), blender_bounds, export_glb, receipt_document

scripts/lib/gltf/              # pure stdlib, no bpy — usable by validators and CI
    read.py          read_glb_json, node_local_matrix, matmul, scene_bounds
    lod.py           containment, evaluate            <- landed this pass (§5.1)

scripts/building-asset-factory/
    massing.py       oriented_footprint(poly) for N-gons; batch bands from floorYs
    archetypes/a_pitched_house.py ... f_cylinder.py    # one module per archetype
    factory.py       CLI: --massing <record> --archetype <id> --lod n
    <asset>_facts.json                                  # one pinning file per building
    validate_outputs.py  --expect <asset>_expectations.json
```

The pinning discipline is **kept, per asset**. `load_facts()` today is doing something valuable —
refusing to build if the public truth it was authored against has moved. The generalisation is not to
loosen those assertions; it is to move them out of the code and into one `<asset>_facts.json` +
`<asset>_expectations.json` pair per building, with the *derivation contract* named in the file
(exactly as `crackhouse_facts.json` already does with its `derivationContract` block).

### 4.5 Order of work

Each step is independently shippable, and each has a green-test definition.

| Step | Work | Gate |
| ---: | --- | --- |
| 0 | ✅ **`lod_silhouette.py`** — the cross-LOD invariant (§5.1) | Landed. 19 tests. Refuses the current candidate. |
| 0b | ✅ **Gate wired + crackhouse/tanker fixed** (§5.1.0–5.1.3, §5.2) | **Landed 2026-09-01.** Rule moved to `lib/gltf/lod.py`; all three validators call it; `lib/blender/lod_grid.py` holds both fix patterns. Crackhouse and tanker measure 0.0000 mm growth; `fortress-shell` is pinned as a known defect awaiting the founder. `npm run test:building-lod-silhouette` in `npm test`; `test:factory-core` now 62 tests. |
| 1 | ✅ Extract `scripts/lib/gltf/read.py` from the three validators; each validator imports it | **Landed 2026-09-01.** All three validator suites green; each validator's JSON output byte-identical to its pre-refactor self on the same receipts. |
| 2 | ◐ Extract `scripts/lib/blender/noise.py` and **resolve the `hash01` divergence** — decide which of the two behaviours is correct, then re-derive both existing assets against it | **Extracted, NOT resolved.** Both behaviours ship as named variants with no default; nothing converged and no asset moved. Choosing a winner remains open — see the recommendation in §4.5.1. |
| 3 | `massing.py::oriented_footprint()` — N-gon → oriented box via convex hull + rotating calipers. Must agree with `derive_transform()` on the Crackhouse quad to a stated tolerance; the Crackhouse keeps its pinned derivation | New unit tests; Crackhouse untouched |
| 4 | ◐ Extract `primitives.py` / `materials.py` / `export.py`; Crackhouse becomes their first consumer | **Landed for `primitives.py` / `materials.py` and the frozen export settings** (`export.py`'s batching/receipt half is not extracted — those are per-factory contracts, see `scripts/lib/README.md`). Gate met: `verify_crackhouse_reproducibility.py` **PASS** on two post-refactor builds, and all three crackhouse GLBs are byte-identical to their pre-refactor digests. |
| 5 | Parameterise the QA rig envelope from a massing record | Contact sheets regenerate identically for the Crackhouse |
| 6 | Archetype **B** (industrial shed) + Warehouse 4 as the first instance | Full admission chain incl. §5.1 |
| 7 | Archetype **C**, then D, E, F | — |

Steps 1–5 author **zero** new buildings and are the whole cost of making twelve possible. That is the
honest sequencing: the expensive part of the second building is the first building's assumptions.

#### 4.5.1 What a new building factory writes, after steps 1/2/4

**Inherited, already written and tested — a new factory writes none of this:**
GLB parsing and scene traversal (`lib.gltf.read`); the hash / smoothstep / tiling-noise kernels in
all their variants (`lib.blender.noise`); image packing, the height-field → tangent-normal kernel
and the `glTF Material Output` occlusion group (`lib.blender.materials`); box vertices and both
winding tables, metric planar UV projection, scale baking, the metre/EEVEE scene defaults, and the
**24-keyword frozen glTF export block** (`lib.blender.primitives`). That last one matters most for
twelve buildings: a stray `export_tangents=False` in one file would silently change one asset.

**Still per-building, and this is the real cost:** the material family table and its sampler
(`surface_sample` / `material_sample` — ~130 lines each today and genuinely different per
archetype); `create_material`'s node graph; `tag_object`'s extras contract; the massing/geometry
functions; the batching bands; `receipt_document`; the CLI; and one
`<asset>_facts.json` + `<asset>_expectations.json` pair per §4.4.

**Honest estimate:** consolidation removed ~370 lines of duplicated helper from the six files and
replaced it with ~1 200 lines of tested shared core. A thirteenth building no longer inherits a
copied noise function, but the *per-building* cost is dominated by the sampler, the node graph and
the geometry — none of which this pass touched. The twelve-building plan should be costed on §4.3's
hard blockers (step 3 and step 5), not on helper duplication, which is now largely paid off.

#### 4.5.2 The `hash01` decision, for the founder

Two behaviours, and one of them has to lose whenever step 2 is actually completed:

| | `HASH01_MASKED_SUM` (fortress + crackhouse) | `HASH01_XOR_UNMASKED` (industrial) |
| --- | --- | --- |
| Mixing | `+`, masked to 32 bits before the avalanche | `^`, **unmasked** — the intermediate is an unbounded Python int |
| Assets at stake | `fortress-shell` ×3 (**admitted, digests pinned in `scene-manifest.json`**), `zb013-basement` ×3, `crackhouse-shell` ×3 | 15 industrial prop GLBs (offline proof only, **not admitted**) |

**Recommendation: keep `HASH01_MASKED_SUM` and re-derive the industrial props against it.**
Three reasons. It is the intended implementation — the constants are a known 32-bit avalanche
(`0x7FEB352D` / `0x846CA68B`), which only behaves as designed on a 32-bit input word; the unmasked
variant feeds it a ~63-bit value, so its first `>> 16` folds bits the design assumes are gone. It
is the majority, covering 9 of the 12 assets. And critically, the losing side is the side with
**nothing admitted**: the industrial props are offline-proof-only by their own README, so they can
be re-derived without a re-admission.

**Cost of that choice:** rebuild the 15 industrial GLBs (~30 s), regenerate the proof root and its
contact sheets, and have the founder re-run the fixed-camera visual review — the textures will
shift in character, not just in bytes. `scene-manifest.json` is untouched, and the admitted
fortress asset never moves. The reverse choice would re-baseline an admitted asset and cost a full
GPU re-admission, which is strictly worse for the same benefit.

The same argument decides `smoothstep` (clamping is the safer behaviour, and the industrial
sampler is the only caller that can pass an out-of-range value) and the tile-noise lerp form.
`create_box`'s winding is the one where the industrial table is arguably better authored, but it is
also the one with the least reason to converge — no shared consumer reads it — so leaving both
tables named is fine indefinitely.

---

## 5. The two open Crackhouse defects

Both were reported in `docs/GPU-SITTING.md`. Both are reproduced here from the shipped GLBs in
`.local-candidates/crackhouse-fixedrig/`, and neither is a one-off.

### 5.1 LOD1 is 26.34 mm wider than LOD0 — **systemic, confirmed by measurement**

#### 5.1.0 Landed 2026-09-01 — the scope was measured first, and "systemic" is right

Every LOD chain the three factories produce was measured before anything was
fixed. Worst growth per asset, in millimetres, against the rule
`bounds(LOD n) ⊆ bounds(LOD n-1) ∩ bounds(LOD 0)`:

| Asset | Worst growth | Where | Verdict |
| --- | ---: | --- | --- |
| **`fortress-shell`** (ADMITTED) | **40.000** | LOD1 +15.6681 `y.max`; LOD2 +40.0000 `x.max`, +15.5926 `y.max` (+31.2607 vs LOD0) | 🔴 FAIL — **founder decision, §5.1.3** |
| `crackhouse-shell` | 13.183 | LOD1 +13.1551 `z.min`, +13.1826 `z.max` — the 26.34 mm | ✅ FIXED |
| `tanker-wagon` | 15.000 | LOD1 +15.0000 on `z.min` *and* `z.max` | ✅ FIXED |
| `zb013-basement` | 0.000 | — | PASS |
| `diesel-shunter` | 0.000 | — | PASS |
| `shipping-container` ×3 | 0.000 | — | PASS |

Three of the four multi-part assets grew, in three factories, from three
*different* authoring mistakes. §5.1's "systemic" claim survives contact.

It is worse than three factories. The same sweep over the shipped
`.local-candidates/vegetation-full/` set — the fifth factory family (§4.1.1), out
of this lane's scope and untouched — found **29 of its 31** chains growing, up to
**867.6 mm** (`pine02`, LOD2). Vegetation is billboard-heavy and a decimated
crown may legitimately spill, so those numbers are not automatically defects; but
nothing there has ever been asked the question either, and 29 of 31 is not a
distribution you get by accident. That lane needs its own pass, and this gate is
already importable from it.

#### 5.1.1 The mechanism is two mechanisms, not one

§5.1 traced the defect to roof-tile row placement. That is one of two.

**(a) A per-LOD grid of overlapping parts, laid on cell centres.** The Crackhouse
roof, described below. Also `add_stairs()`, whose treads are `run*1.04` on a
centre grid at 15 steps and 8 — the same overhang, invisible only because the
flight sits deep inside the footprint.

**(b) A member that gets thicker at a coarser LOD, positioned by its
centre-line.** Half of every thickness increase goes outward. This is what
`tanker-wagon` has (tank-band tube 0.045 → 0.060 m, `industrial_prop_factory.py`;
ladder stiles 0.028 → 0.038 m) and it is what `fortress-shell` has (girder chords
0.20 → 0.28 m, `fortress_factory.py:1356`). Fortress adds a third variant of the
same carelessness: its coarse roof panels shrink by 0.08 m at LOD1 and by nothing
at LOD2, so LOD2's panels are 40 mm wider than LOD1's.

Both mechanisms now have a named helper with no bpy dependency, in
`scripts/lib/blender/lod_grid.py`:

- `overlapping_band(index, count, span, overlap)` — lays a course band by its
  **edges**, clipping the lap at the two ends, so the union of the parts spans
  exactly the band whatever `count` is. `test_lod_gate.BandLayoutTests` pins that
  property at 1, 2, 3, 6, 12, 24 and 37 parts, and reproduces the old
  centre-based formula to show its overshoot doubling as the count halves.
- `outer_anchored_center(outer, thickness)` — the centre-line for a member whose
  **outer face** must not move.

#### 5.1.2 The gate, and where it lives now

The invariant moved into the shared core as **`scripts/lib/gltf/lod.py`** — the
§4.4 location — because it is not one factory's problem.
`scripts/building-asset-factory/lod_silhouette.py` keeps its CLI, its reader and
all 19 of its tests, and now delegates the rule. All three validators call
`assert_contained()`:

| Validator | Wiring | Waiver |
| --- | --- | --- |
| `validate_crackhouse_outputs.validate_set` | on the three LOD `boundsM` it already measures | none |
| `validate_industrial_props.validate_lod_progression` | per family/variant, on `boundsGltfM` | none |
| `validate_fortress_outputs.validate_set` | on the three LOD `boundsM` | **pinned known defect, §5.1.3** |

No second scene walk: the gate takes the bounds records the validators already
compute. `npm run test:building-lod-silhouette` is wired into `npm test`.

#### 5.1.3 🔴 `fortress-shell` — founder decision, with the cost

**The fix is not applied and must not be applied by an agent.** `fortress-shell`
is the one admitted asset in the repo; its three LOD digests are pinned in
`public/assets/3d/customs/scene-manifest.json`. Changing that geometry breaks
those digests and un-admits an asset the founder reviewed on a GPU.

**Exact cost of taking the fix:** three new SHA-256 digests + byte counts +
triangle counts in `scene-manifest.json`; a corrected `bounds` block (see below);
a fresh fixed-camera GPU review. And it lands on the *one* asset whose LOD0/LOD1
are **not byte-reproducible** (§4.1.2), so the new digests can be pinned but never
re-derived — a rebuild will produce a third set. That makes this a
"cut it once, review it, pin it" operation, not an iterative one.

**What the defect already cost, silently.** The asset's declared bounds in
`scene-manifest.json` are `max.y = 18.230173` — that is **LOD2's** grown top, not
LOD0's `18.198912`. The manifest is sized to the union of the chain rather than
to LOD0, so the picking box and the shadow proxy are already 31.26 mm taller than
the asset's finest level. Nobody chose that; it is the defect being absorbed.

Until the founder rules, the fortress validator carries an **exact, pinned**
table of the five measured escapes. It is a tripwire, not a mute button: any
growth not in the table fails, and any pinned growth that changes value — *or
disappears because someone fixed it* — fails. Five tests in
`test_validate_fortress_outputs.LodSilhouetteWaiver` hold that behaviour, and the
validator prints `KNOWN DEFECT, PINNED:` on stderr on every run.

Note that a plain rebuild of `fortress-shell` on this machine does **not**
reproduce the shipped chain at all (61.646 m long vs the shipped 61.606, and no
LOD2 `x.max` escape) because the shipped set was authored against a scalar
census that is not reachable from this lane. The pin is against the *shipped
bytes*, which is what the validator exists to check.

---

Measured, from the shipped candidate:

```
LOD0  size  25.088226  6.680000  17.088829
LOD1  size  25.088226  6.680000  17.115167      <- +26.338 mm on Z
LOD2  size  25.088226  6.680000  17.004969
LOD1 vs LOD0: GREW, worst 13.1826 mm   (+13.1551 z.min, +13.1826 z.max)
```

**Mechanism.** `add_roof()` lays `rows × columns` tiles at cell *centres* spanning the full slope
(`t = (row + .5) / rows`) and gives each tile `tile_slope * 1.08` of length so courses overlap. The
outer half of that overlap on the outermost course escapes the roof plane by

```
0.04 / rows  ×  slope_run   metres per side
```

which **doubles every time the row count halves**. At LOD0 (12 rows) the tiles reach z = 8.52928 and
tuck behind the gutter at 8.54441. At LOD1 (6 rows) they reach 8.55760 and become the silhouette. The
X axis has the same construction with the opposite sign — `tile_x * .95` leaves a *gap*, so tiles sit
26.1 mm inside the roof edge at LOD0 and 52.3 mm inside at LOD1 — and only escapes notice because the
roof base slab covers it.

**Why systemic.** The defect is not roof tiles. It is *any* authored detail whose count changes per
LOD and whose size is a fixed fraction of the cell it occupies. Every archetype in §4.2 has such a
grid: shed cladding ribs, block window bands, canopy purlins, tower staves. Authoring twelve buildings
with the current pattern would reproduce it twelve times.

**Why nothing caught it.** `validate_crackhouse_outputs.py::validate_set` checks that bytes and
triangles strictly fall, and that each LOD's declared bounds match its own actual bounds. It never
compares one LOD's bounds against another's. The guard did not fail — it did not exist.

**Landed this pass:** `scripts/building-asset-factory/lod_silhouette.py` and
`test_lod_silhouette.py`. Pure stdlib, no bpy, no network. It reads only the glTF JSON chunk and the
POSITION accessors' declared `min`/`max` (which glTF requires), so it decodes no vertices, and it
refuses external buffers, missing accessor bounds, truncated containers and non-consecutive LOD
chains. The rule it enforces:

> `bounds(LOD n)` must be contained in `bounds(LOD n-1)` **and** in `bounds(LOD 0)`, on every axis.

Both comparisons are needed: a level that shrinks relative to a grown parent still escapes LOD0, and
consecutive containment alone would pass it. A test pins that case.

```bash
python3 scripts/building-asset-factory/lod_silhouette.py \
  --glb 0=<dir>/crackhouse-shell-lod0.glb \
  --glb 1=<dir>/crackhouse-shell-lod1.glb \
  --glb 2=<dir>/crackhouse-shell-lod2.glb \
  --output <dir>/qa/lod-silhouette.json

python3 scripts/building-asset-factory/test_lod_silhouette.py            # 19 tests
TZ_CRACKHOUSE_QA_GLBS="<lod0>,<lod1>,<lod2>" \
  python3 scripts/building-asset-factory/test_lod_silhouette.py RealCandidateTests
```

The last of those asserts the gate **refuses the shipped candidate**. A gate that has never rejected
the artefact it was written for has not been tested.

**Fixed 2026-09-01.** Tiles are laid by *edges*, not centres: `band_fraction(row, rows, 0.08)`
returns a course band clipped at the ridge and at the eave, so the tiles span exactly
`[0, slope_length]` at 12 rows and at 6. The absolute silhouette stopped being a function of `rows`,
which is the property that was missing.

```
                      LOD1 Z size    worst growth
  before   17.115167 m   13.1826 mm
  after    17.088829 m    0.0000 mm     (= LOD0 exactly)
```

`crackhouse-shell-lod2.glb` is **byte-identical** to its pre-fix self — LOD2 has no roof tiles, no
damage patches and a ramp instead of treads — so the change is confined to the two LODs that carried
the defect. Two consecutive rebuilds are byte-identical to each other
(`verify_crackhouse_reproducibility.py` PASS), and the Crackhouse is an offline candidate, so nothing
needed re-admission.

### 5.2 Damage patches sit 146 mm outboard — **one-off literal, systemic cause**

Measured, LOD0:

```
plaster facade exterior face   z = ±8.11442   (= ±width/2, exactly)
exposed-brick patches          z = ±8.26141   (= ±(width/2 + 0.146))
```

`add_damage_and_boards()` :1007-1014 hardcodes the offset in every row of `patch_specs`:

```python
("S", -6.1, -width*.5 - .146, 2.75, 1.65, 1.05),
("N", -1.9,  width*.5 + .146, 2.25, 2.15, 1.20),
...
("S", 1.8, -width*.5 - .147, 5.28, 1.05, .58),      # and .147 for the LOD0-only extras
```

`0.146` appears nowhere else in the factory and is derived from nothing — it is close to half of
`WALL_THICKNESS_M = 0.28`, which is the only plausible origin, but the code does not say so. The patch
floats a hand's width in front of the plaster it is supposed to be showing *through*, which is why it
reads as a decal stuck on the wall rather than as missing render.

**The literal is a one-off. The cause is not.** The factory has no named facade-plane datum. Every
facade-attached element re-derives its own offset from `±width*.5 ± <literal>`, and the literals
disagree: glass at `width/2 − 0.05`, window boards at `width/2 + 0.23`, brick at `width/2 + 0.146`.
Nothing asserts that a surface-attached family lies on the surface it is attached to. Twelve buildings
× four facades × several decal families is where that becomes unmanageable.

**Fixed 2026-09-01 — the literal and, as far as one building can, the cause.**

The symptom: `0.146` (and the `0.147` on the two LOD0-only extras) → `BRICK_PATCH_PROUD_M = 0.004`.
Measured on the rebuilt LOD0, the patches now sit at `z = ±8.118415` against a facade plane at
`±8.114415` — 4.0 mm proud, down from 146.0 mm.

The cause: the Crackhouse factory has a **named facade datum** instead of a plane every family
re-derived inline. `facade_plane_local_y(facade)` returns the exterior plaster face (which is where
`add_wall_cells()` actually puts it: cell centred at `±(width/2 − WALL_THICKNESS/2)` with
`WALL_THICKNESS` of depth); `facade_offset_local_y(facade, clearance)` is the only way a part is
positioned against it; and `tag_facade_datum()` records the claim on the object and in the receipt's
new `surfaceDatums` block, in the **exported glTF frame**. The window boards keep their real 0.23 m
clearance — a board is nailed *on* the wall — but state it as a named clearance rather than a bare
literal, and their bytes are unchanged.

The QA contract: `validate_crackhouse_outputs.validate_surface_datums()` re-derives the facade half-
width from the public footprint (it does not read the receipt) and refuses a build whose brick family
is more than 5 mm off the plane, or which carries damage at LOD2 where there should be none. It
rejects the pre-fix build with `LOD0 exposed brick is 143.0 mm off its facade datum`, and
`test_validate_crackhouse_outputs.test_exposed_brick_must_lie_on_its_facade_datum` pins both
directions.

**What is deliberately still open.** The general registry §5.2 asked for — `facade_plane(f)`,
`floor_plane(i)`, `roof_plane()` for *every* surface-attached family — belongs in the `massing.py` of
§4.4 and was not invented here on a building that has no massing record yet. What landed is one
family, one datum, one check, plus the declaration channel (`surfaceDatums`) the general version will
use. Glass at `width/2 − 0.05` is still a literal inside `add_frame_and_void()`; it is a reveal
inset, it is inboard, and it does not touch the silhouette, so it was left for the registry.

---

## 6. What this pass does not establish

- **No measured height exists yet for any building.** The bounds lane has not run. Everything in §2
  and §3 is preparation for numbers that do not exist, and §3.2 rule 5 exists so that adopting the
  schema before the numbers arrive changes nothing on screen.
- **The quest-zone count is a proxy for player importance, not a measurement of it.** It does not
  count loot, spawns, sightlines, or where fights happen.
- **Silhouette prominence is unmeasured.** Footprint × height is a mass proxy. Nobody has rendered the
  default orbit and asked which twelve shapes actually break the skyline. That is a cheap pass and it
  should be run before authoring hour one, because it could reorder §2.
- **Axis-aligned containment is necessary, not sufficient.** §5.1's gate cannot tell you whether LOD1
  looks like LOD0 from any camera. It tells you it did not grow.
- **The `terrainDisagreementM` numbers in §3.1 are a disagreement, not an error attribution.** Which
  side is wrong — the terrain fit, the floor-row classification, or neither, because the building
  really does sit on a 2.6 m dock — is not settled by anything in this document.
- **Nothing here changes what is drawn.** No renderer file, no build script, and no shipped data file
  was modified. `public/data/customs-3d.json` is byte-identical; the Crackhouse factory is untouched
  and its outputs remain byte-reproducible.
