# TarkovZero 3D renderer visual-realism plan

**Status:** research and implementation plan only; no renderer or data changes made  
**Research date:** 2026-08-29 (America/Los_Angeles)  
**Target:** a grounded, almost-real overcast-autumn skin and a vector skin over exactly the same geometry, feature IDs, picking model, and 2D/3D synchronization

## Executive decision

Stay on deck.gl. The current scene is not blocked by deck.gl's geometry, instancing, picking, or glTF support; it is blocked by an intentionally cartographic material language, sparse/abstract asset choices, and the absence of a shared material/atmosphere system. The high-leverage route is a small TarkovZero rendering kit on top of deck.gl: one style contract, one custom terrain material, instanced glTF vegetation/props, generated building meshes with real UVs, a focused water shader, and conservative atmosphere/contact shading.

Do **not** switch to three.js or Babylon for this target. Those engines would buy mature off-the-shelf cascaded shadows, reflection/post stacks, and broader material tooling, but only after replacing or bridging the deck-owned OrbitView, Cartesian transform, 2D↔3D state sync, feature picking/tooltips, label and icon atlases, quest/extract/player overlays, floor filtering, playable-limit behavior, and layer lifecycle. A full parity migration is roughly **180–300 fleet-hours before new visual work**; a hybrid shared-canvas renderer is roughly **60–100 fleet-hours of integration plus a permanent two-renderer tax** around depth, GL state, picking, and resource ownership. Neither is justified unless true volumetric weather, cascaded shadows, screen-space reflections, and portal/occlusion-managed interiors become non-negotiable product requirements.

The first implementation stage should remove the strongest diagram signals—contours, high-chroma hypsometry, hard semantic shading—and establish the muted light/fog/material contract. That is the largest perceived gain per hour and it creates the realistic/vector switch before expensive asset work begins.

## Baseline and planning assumptions

- The installed lockfile resolves deck.gl packages at **9.3.11**, luma.gl engine/shadertools at **9.3.6**, and loaders.gl glTF at **4.4.5**. Conclusions below are based on those exact sources, not on a newer docs site's feature set.
- `src/terrain.js` builds one 2.5 m `SimpleMeshLayer` and one 2048×1110 baked color texture. Its current single texture plus Phong material cannot express splats, normal/ORM maps, or wetness without a subclass/custom shader.
- `src/trees.js` is already GPU-instanced and deterministically varies conifer/broadleaf crown meshes. The replacement should preserve that instance data and hashing behavior.
- Buildings remain `SolidPolygonLayer` extrusions plus procedural `detailParts`; roads/rails/pavement are largely baked into terrain; water is a flat polygon surface over a carved bed; rocks and props are procedural forms.
- `src/map3d.js` already has `LightingEffect` and the shadow path is known, but current comments/code avoid general casting because terrain self-shadow acne is visible across kilometer extents. Stage 7 treats that as an unresolved precision/filtering problem, not a switch waiting to be flipped.
- The camera is currently inline in `src/map3d.js`; there is no `src/camera.js` in this checkout. The plan names `src/map3d.js` as the camera owner unless a later refactor deliberately creates `src/camera.js`.
- The requested Fix pass 10 section is not present in this checkout's `docs/plans/PROGRESS.md` (the file ends at Fix pass 9). Per the brief, this plan nevertheless treats exact-data ingest, exhaustive elevation buckets, the Woods hard-rock layer, canonical 1× scale, and feature assertions as **done baseline**, not work to repeat. Before implementation, regenerate/rebase onto the canonical Fix pass 10 outputs so visual changes are not evaluated against stale generated JSON.
- There is no browser in this task. GPU milliseconds, draw calls, and VRAM below are **planning deltas**, not measurements. The first implementation stage must establish the real baseline with deck/luma stats and a GPU trace.

“Almost real” here means convincing at the map's normal oblique overview and useful near inspection—not a first-person photoreal game scene. Geometry must remain truthful to evidence. Materials may supply surface frequency and weathering, but must not invent landmark shapes, lanes, openings, rooms, or prop identities.

---

## Part A — what deck.gl 9.3.11 and luma.gl 9.3.6 can actually do

### Verified platform facts

1. [`SimpleMeshLayer`](https://deck.gl/docs/api-reference/mesh-layers/simple-mesh-layer) is instanced and supports positions, orientation, scale, color, one optional texture, wireframe, picking, and a Phong-style `material`. Its [9.3.11 source](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/mesh-layers/src/simple-mesh-layer/simple-mesh-layer.ts) and [fragment shader](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/mesh-layers/src/simple-mesh-layer/simple-mesh-layer-fragment.glsl.ts) expose one color sampler, not base-color + normal + ORM splatting.
2. [`ScenegraphLayer`](https://deck.gl/docs/api-reference/mesh-layers/scenegraph-layer) loads glTF, GPU-instances a scene, preserves deck picking/projection, exposes per-instance transform/color accessors, and has experimental `_lighting: 'pbr'`, `_imageBasedLightingEnvironment`, and animation props. The [exact source](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/mesh-layers/src/scenegraph-layer/scenegraph-layer.ts) uses luma's PBR material path. Core glTF metallic-roughness, base color, normal, occlusion, and emissive maps are viable; experimental props and exotic material extensions need a spike rather than blind reliance.
3. [`TerrainLayer`](https://deck.gl/docs/api-reference/geo-layers/terrain-layer) creates a mesh from a height map and drapes a single texture. It does not add multi-material splatting, and replacing the existing 2.5 m world-space mesh with it would discard useful TarkovZero-specific sampling/carving logic.
4. [`PolygonLayer`](https://deck.gl/docs/api-reference/layers/polygon-layer)/`SolidPolygonLayer` natively fill and extrude polygons with simple materials. They do not generate facade UVs, window/door holes, eaves, rooms, or roof-specific material topology.
5. [`PathLayer`](https://deck.gl/docs/api-reference/layers/path-layer) and [`PathStyleExtension`](https://deck.gl/docs/api-reference/extensions/path-style-extension) make stroked paths with dash/offset options. They are not crowned road meshes, ballast beds, curb cross-sections, or PBR surfaces.
6. deck.gl supports layer subclassing, luma `Model` ownership in a [primitive custom layer](https://deck.gl/docs/developer-guide/custom-layers/primitive-layers), and documented shader hooks through [`getShaders` injection](https://deck.gl/docs/developer-guide/custom-layers/writing-shaders). A custom layer can retain deck projection, transitions, picking, layer filtering, and effects while supplying new samplers/varyings/material logic.
7. [`LightingEffect`](https://deck.gl/docs/developer-guide/using-effects) supports ambient, point, camera, directional, and sun lights. A [`DirectionalLight`](https://deck.gl/docs/api-reference/core/directional-light) can enable experimental shadows. In 9.3.11, each directional light gets a viewport×device-pixel-ratio RGBA8 shadow framebuffer plus depth16 attachment; sampling is single-tap with a depth smoothstep, not cascaded PCF soft shadows. The exact [`ShadowPass`](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/core/src/passes/shadow-pass.ts) also treats `shadowEnabled: false` as neither cast nor receive, which is why “terrain receives but does not self-cast” needs custom work.
8. [`PostProcessEffect`](https://deck.gl/docs/api-reference/core/post-process-effect) is a color-buffer screen pass. Its [9.3.11 source](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/core/src/effects/post-process-effect.ts) exposes `texSrc`, not scene depth or normals. The exact luma.gl 9.3.6 effects package (not currently installed in this repo) offers color controls, noise/sepia/vibrance/vignette, FXAA, several blurs, edgework/ink, pixelation, and warps; it does **not** provide production SSAO, SSR, depth fog, or a deferred G-buffer.
9. loaders.gl documents preprocessing for [`KHR_texture_basisu`, Draco, and meshopt](https://loaders.gl/docs/modules/gltf/formats/gltf). This is enough to test GLB + KTX2/Basis + compressed geometry, but actual browser transfer and resident-GPU savings must be measured because the loader preprocesses/decompresses extensions before luma consumes them.
10. deck's [performance guide](https://deck.gl/docs/developer-guide/performance) identifies vertex work, fragment overdraw, and the additional picking render as key costs. “One instance per tree” is fine; “one layer/material per tree” is not.

### Capability matrix

| Element | Native in the pinned stack | Focused custom deck/luma work | When three.js/Babylon would actually be warranted |
|---|---|---|---|
| **Terrain surface** | The current `SimpleMeshLayer` efficiently draws the truthful mesh, one texture, normals, picking, Phong light. `TerrainLayer` could generate a mesh from a height map but adds no material blend advantage. | Subclass `SimpleMeshLayer`; add world-space/triplanar UVs, two deterministic splat masks, texture-array or atlas samplers, base/normal/ORM inputs, macro tint, wetness, and fog varying. Keep the current mesh and height sampler. | Only for an off-the-shelf virtual-texture/tessellation terrain system. The target does not need it; current map extents and 2.5 m geometry are bounded enough for a custom material. |
| **Roads, rails, paths** | `PathLayer`, dash/offset extension, and filled polygons can draw alignments/markings. Existing terrain baking is cheap and coherent. | Rasterize material masks from current road/yard/pavement/rail data. Where silhouette matters, generate a swept surface mesh with metric UVs; instance rail sleepers and draw paired rails by class. | Only if physics-grade splines, live terrain deformation, or an editor-driven road system becomes required. Engine switching does not solve missing surveyed widths/profiles. |
| **Buildings: facades and roofs** | Extruded polygon walls/roofs, simple Phong material, depth, picking, and floor filtering. `ScenegraphLayer` can draw repeated authored buildings. | A `BuildingMeshLayer` should triangulate the same footprints into wall/roof faces with metric UVs, material IDs, per-floor clipping, and stable picking IDs. Group by atlas/material. Real openings require explicit hole geometry or surveyed glTF modules. | An engine helps if the product requires CSG editing, portal/room visibility, baked lightmaps, and many authored interiors. It does not justify replacing deck for textured exteriors. |
| **Openings/interiors seen through floor cut** | deck can show prebuilt glTF rooms or separate per-floor meshes and can filter them with the existing floor state. It has no automatic interiors or portal system. | Build surveyed wall openings, slabs, stairs, and room shells into deterministic per-floor buffers; keep feature IDs tied to source evidence. Do not use generic dark boxes as fake rooms. | A mature engine becomes attractive only for many traversable interiors with portal/occlusion culling, light baking, probes, and authoring tools. This is data-blocked before it is renderer-blocked. |
| **Vegetation: trees, understory, grass, forest edge** | `SimpleMeshLayer` and `ScenegraphLayer` are instanced, pickable, and transformable; glTF supports alpha-masked foliage and PBR materials. Existing deterministic instance hashing is reusable. | Batch 3–5 species; add near/mid/far LOD selection, a camera-facing billboard atlas for far trees, alpha-to-coverage/dither if viable, ground tint, and sparse near-camera grass/understory. No wind is needed. | Only for a mature vegetation package with impostor baking, GPU culling, seasonal growth, and wind simulation. At current counts, a deck layer per species/LOD is sufficient. |
| **Rocks and cliffs** | Instanced `SimpleMeshLayer`/`ScenegraphLayer` can draw glTF rock forms with picking and PBR/Phong lighting. | Use 4–8 decimated rock variants, deterministic transform selection, triplanar material, ground blend, and the completed hard-rock evidence layer. Preserve authored landmark forms instead of randomizing them away. | Only for runtime erosion/tessellation or a megascans/virtual-texture pipeline. Neither is necessary. |
| **Water: shore, depth, reflection** | A translucent `PolygonLayer` supplies a flat surface. Native blending and lighting are enough for a cartographic plane, not convincing water. | Custom water mesh/shader: bank-distance/depth tint, shallow sediment, Fresnel sky tint, two subtle scrolling normal samples, wet shoreline, fog, and deterministic screenshot phase. A reflected sky color is cheap; true scene reflection is not. | Planar reflections require a mirrored second scene render; SSR needs depth/normals; volumetric water needs still more buffers. These can be custom effects but are substantially easier in a mature engine. They are not needed for “almost real” overhead map water. |
| **Props and clutter** | `ScenegraphLayer` is the right native primitive: GPU-instanced glTF, PBR option, per-instance transform/color, picking. Procedural fallback boxes/cylinders can remain for unresolved archetypes. | Curate/retopo/atlas GLBs, batch per archetype/LOD, preserve source pose and feature ID, and add a low-detail silhouette fallback. | Only if skeletal vehicles, destruction, physics, or complex animation is required. Static map props do not justify a switch. |
| **Sky, fog, atmosphere** | deck exposes canvas clear color but no native sky model, aerial perspective, height fog, clouds, or volumetrics. Scenegraph IBL affects glTF objects; it is not a global sky/fog solution. | Use a background gradient or sky dome and a shared shader extension that writes a camera-distance/height varying in the vertex stage and mixes fog at the fragment hook. Apply it to world layers, never labels/icons/UI. | Volumetric clouds, local fog volumes, weather, and physically coupled sky/atmosphere are mature engine features. A light exponential map fog is small custom work and adequate here. |
| **Lighting, shadows, AO/contact** | Ambient/directional/point/sun lights and experimental single-map directional shadows are native. Phong materials cover most custom layers; glTF scenes can use luma PBR/IBL. There is no native SSAO or cascaded shadow map. | Prefer baked terrain/vertex AO, wet/dirt contact masks, and small deterministic contact decals. If dynamic shadows survive a spike, use one key light, a constrained caster set, custom receive-only terrain behavior, and a small PCF kernel/bias tuned at canonical 1×. | Cascaded soft shadows over kilometers, SSAO/GTAO, GI, reflection probes, and deferred lighting favor an engine. They are expensive and not required for the initial target. |
| **Post effects** | Color-only `PostProcessEffect`; pinned luma effects include FXAA, grading-like controls, vignette, blur, edge/ink/pixel effects. | One combined color-grade/vignette/grain pass is enough. Depth-aware fog/DOF/SSAO/SSR requires custom render targets and passes, not a simple shader module. | Choose an engine if a mature cinematic post stack is mandatory. Do not switch engines to gain bloom on an overhead map. |

### Deck-vs-engine boundary

The recommended boundary is deliberately narrow:

- **Use native deck layers** for labels, icons, paths/markings, pickable glTF instances, and simple overlays.
- **Subclass official deck layers** for terrain/fog/water where a few additional attributes, samplers, and shader hooks solve the problem.
- **Use a primitive custom layer** for unique generated building meshes or any layer whose buffer layout no longer fits `SolidPolygonLayer`.
- **Do not build a general renderer inside deck.** Reject SSR, deferred SSAO, volumetric fog, real-time GI, and unconstrained shadow cascades unless screenshot evidence proves the simpler stack cannot meet the product bar.
- **Reconsider three/Babylon only after a written requirement crosses the boundary**: many traversable interiors, portal visibility, cinematic weather, or physically reflected/volumetric water. At that point, budget a product migration, not a rendering-library swap.

---

## Part B — licence-clean asset sources and a concrete acquisition budget

### Hard licensing gate

Allowed: **CC0, CC BY, MIT, or TarkovZero-created assets**. Record author/source even where attribution is optional. Excluded: BSG files or extracted assets; proprietary community map art; Editorial/Standard marketplace assets; CC BY-NC, CC BY-NC-SA, CC BY-SA, CC BY-ND; assets whose uploader plausibly does not own the depicted model, branding, or scan.

Every acquired item gets an immutable manifest record:

```json
{
  "id": "source-stable-id",
  "sourceUrl": "https://...",
  "author": "...",
  "license": "CC0-1.0",
  "licenseUrl": "https://...",
  "retrievedAt": "2026-08-29",
  "sourceBytes": 0,
  "sourceSha256": "...",
  "derivatives": [{"path": "...", "sha256": "...", "toolchain": "pinned versions"}]
}
```

Store the license text/snapshot and attribution record in the repository when assets are actually acquired. Never load a marketplace/API asset directly at runtime.

### 1. ambientCG — primary material source

The official [license page](https://docs.ambientcg.com/license/) says all downloadable files and previews are CC0 1.0, including commercial copying, modification, distribution, and inclusion of raw files. The official [`full_json` API](https://docs.ambientcg.com/api/v2/full_json/) publishes maps and exact download sizes. Material ZIPs are offered as JPG or PNG at 1K/2K/4K/8K. The recommended source set deliberately starts at 1K because these are repeating map materials, not hero close-ups.

| Candidate | Coverage | Maps in source | 1K JPG ZIP |
|---|---|---|---:|
| [Ground106](https://ambientcg.com/a/Ground106) | wet soil, forest floor, muddy shore | color, displacement, normal, roughness, AO | 9.26 MiB |
| [Grass005](https://ambientcg.com/a/Grass005) | muted grass base | color, displacement, normal, roughness, AO | 9.96 MiB |
| [Gravel043](https://ambientcg.com/a/Gravel043) | rail ballast, shoulders, yards | color, displacement, normal, roughness, AO | 9.92 MiB |
| [Asphalt033](https://ambientcg.com/a/Asphalt033) | worn/wet asphalt | color, displacement, normal, roughness, AO | 9.27 MiB |
| [Concrete034](https://ambientcg.com/a/Concrete034) | slabs, panels, plinths | color, displacement, normal, roughness | 3.49 MiB |
| [Bricks097](https://ambientcg.com/a/Bricks097) | dorm/urban brick facade | color, displacement, normal, roughness, AO | 4.93 MiB |
| [RoofingTiles013A](https://ambientcg.com/a/RoofingTiles013A) | pitched residential roof test | color, displacement, normal, roughness, opacity, AO | 4.15 MiB |
| [CorrugatedSteel007A](https://ambientcg.com/a/CorrugatedSteel007A) | industrial wall and roof | color, displacement, normal, roughness, AO, metalness | 4.86 MiB |
| [Metal063](https://ambientcg.com/a/Metal063) | rusted/oxidized metal accents | color, displacement, normal, roughness, metalness | 5.36 MiB |
| **Source subtotal** |  |  | **61.20 MiB** |

These are candidates, not an art-director-approved final palette. Inspect tiling and hue before acquisition; process displacement into subtle macro/normal information rather than runtime parallax.

### 2. Poly Haven — primary HDRI, realistic model, and individual prop source

Poly Haven's official [asset license](https://polyhaven.com/license) states that its HDRIs, textures, and 3D models are CC0 and may be modified, redistributed, or used commercially without attribution. Its [public API description](https://polyhaven.com/our-api) exposes hashes and file sizes; live-API use has separate User-Agent/credit terms, so TarkovZero should download approved files once and serve its own derivatives.

Model sizes below are the complete 1K glTF dependency set—`.gltf`, `.bin`, and referenced textures—not merely the tiny descriptor. Formats offered vary by item but generally include glTF, FBX, Blend, and USD; HDRIs offer HDR/EXR.

| Candidate | Coverage and disposition | Source variant | Complete source size |
|---|---|---|---:|
| [Autumn Crossing](https://polyhaven.com/a/autumn_crossing) | overcast, low-contrast autumn IBL/sky reference; use ambient environment and add a separate low key light | 1K HDR | 1.80 MiB |
| [Boulder 01](https://polyhaven.com/a/boulder_01) | weathered/lichen rock source; decimate 123,976-poly source into several LODs | 1K glTF set | 5.50 MiB |
| [Pine Sapling Small](https://polyhaven.com/a/pine_sapling_small) | conifer source/atlas reference; must be retopologized and rebaked | 1K glTF set | 20.88 MiB |
| [Shrub 03](https://polyhaven.com/a/shrub_03) | bush/forest-edge card cluster | 1K glTF set | 1.55 MiB |
| [Fern 02](https://polyhaven.com/a/fern_02) | sparse understory | 1K glTF set | 1.09 MiB |
| [Barrel 01](https://polyhaven.com/a/Barrel_01) | industrial clutter | 1K glTF set | 0.66 MiB |
| [Covered Car](https://polyhaven.com/a/covered_car) | unbranded abandoned vehicle archetype | 1K glTF set | 2.24 MiB |
| [Modular Chainlink Fence](https://polyhaven.com/a/modular_chainlink_fence) | fence source; atlas and reduce before shipping | 1K glTF set | 6.95 MiB |
| [Old Military Crate](https://polyhaven.com/a/old_military_crate) | generic crate clutter; inspect markings before approval | 1K glTF set | 2.38 MiB |
| [Container Side](https://polyhaven.com/a/container_side) | CC0 corrugated freight-container surface for a simple TarkovZero-authored container mesh | 1K JPG diffuse + normal-GL + ARM | 1.52 MiB |
| **Source subtotal** |  |  | **44.59 MiB** |

Reject raw hero assets that fail the web budget. For example, Poly Haven's `fir_tree_01` 1K glTF dependency set is about **464.78 MiB** and the source mesh is millions of polygons; it is an authoring reference, not a browser asset.

### 3. Quaternius — CC0 glTF prototypes and vector-skin vegetation

The official [FAQ](https://quaternius.com/faq.html) says all models are CC0, commercially usable, modifiable, and combinable without attribution. The [Ultimate Stylized Nature Pack](https://quaternius.com/packs/ultimatestylizednature.html) contains 63 textured models in FBX, OBJ, Blend, and glTF with seamless textures/normal maps.

Use this source for the vector skin, LOD experimentation, or as retopology reference—not as the realistic skin's final near-tree art. The public Drive exposes individual files rather than one stable archive size. The audited Birch 1–5 + shared bark/leaf source subset is **22.90 MiB**: the five `.bin` meshes are only 137–428 KB each, but the shared bark normal alone is 21.7 MB. That is a useful demonstration of why every source must be repacked to a shared 1K KTX2 atlas.

The older [Ultimate Nature Pack](https://quaternius.com/packs/ultimatenature.html) has 150 CC0 models in FBX/OBJ/Blend but no advertised glTF; conversion is required. Do not download it merely to increase variety.

### 4. Kenney — CC0 prop kits and stylized fallback

Kenney's official [support page](https://kenney.nl/support) says all game assets on asset pages are CC0, commercial use is allowed, and attribution is optional. Current 3D archives expose GLB/OBJ/MTL/PNG, with FBX in the newer factory/car/survival packs. They are coherent and tiny, but their low-poly style makes them better for vector mode, blockout, or far LOD than realistic hero props.

| Pack | Coverage | Files / formats | ZIP size |
|---|---|---|---:|
| [Nature Kit](https://kenney.nl/assets/nature-kit) | tree/rock/foliage prototypes | 330; GLB, OBJ/MTL, PNG | 10.05 MiB |
| [Factory Kit](https://kenney.nl/assets/factory-kit) | industrial machinery and warehouse clutter | 140; FBX, GLB, OBJ/MTL, PNG | 4.30 MiB |
| [Car Kit](https://kenney.nl/assets/car-kit) | vehicle silhouettes and debris | 45; FBX, GLB, OBJ/MTL, PNG | 4.59 MiB |
| [Survival Kit](https://kenney.nl/assets/survival-kit) | camp/outdoor clutter | 80; FBX, GLB, OBJ/MTL, PNG | 1.86 MiB |
| [Skyboxes](https://kenney.nl/assets/skyboxes) | vector/stylized alternate skies | 5; PNG | 4.74 MiB |
| **Optional pack subtotal** |  |  | **25.54 MiB** |

### 5. Sketchfab — per-item exception path, not a trusted catalog

Sketchfab's official [license filter explanation](https://sketchfab.com/blogs/community/refine-downloadable-model-searches-with-new-license-filters/) distinguishes CC0, CC BY, NC, ND, SA, Standard, and Editorial licenses. Its [download API](https://sketchfab.com/developers/download-api/downloading-models) returns glTF archives and USDZ after authenticated download requests; source format and size vary by model.

Use only the [downloadable CC0/CC-BY search](https://sketchfab.com/search?features=downloadable&licenses=322a749bcfa841b29dff1e8a1bb74b0b&licenses=7c23a1ba438d4306920229c12afcb5f9&type=models), then approve each item manually. Capture the model page, uploader, exact license, attribution string, archive byte count, and hash. Reject NC/SA/ND/Standard/Editorial results and reject branded vehicles, military hardware, or “game rip” uploads even when the uploader selected CC0. No Sketchfab item is selected, so **0 bytes** from it are in the budget.

### 6. three.js examples and Khronos sample assets — loader fixtures only

The three.js repository is [MIT-licensed](https://github.com/mrdoob/three.js/blob/dev/LICENSE), but its own [contribution guide](https://github.com/mrdoob/three.js/blob/dev/.github/CONTRIBUTING.md) asks contributors to provide a proper license for added assets. Example models originate from multiple authors and frequently carry model-specific README/license terms. The repository's MIT license is therefore not a safe blanket asset provenance claim.

Use three.js/Khronos sample models only to validate glTF material extensions, KTX2, Draco/meshopt, and animation loading after checking the specific model README. Ship **0 production world assets** from these repositories unless separately approved.

### Audited source weight versus shipped weight

The selected/audited source material is **154.22 MiB**:

- ambientCG material candidates: 61.20 MiB
- Poly Haven realistic candidates: 44.59 MiB
- Quaternius Birch subset: 22.90 MiB
- optional Kenney packs: 25.54 MiB

That number is an art-source workspace budget, not a web payload. The production budget should be:

| Budget | Target |
|---|---:|
| New realistic assets required for first meaningful 3D frame | **≤18 MiB compressed transfer** |
| Additional assets after selecting a map | **≤12 MiB compressed transfer per map** |
| Entire realistic-skin CDN library | **≤45 MiB**, all lazy-loadable |
| Incremental resident GPU memory on desktop/Woods | **≤128 MiB** |
| Incremental resident GPU memory in a low-memory mode | **≤80 MiB** |

Enforce the budget through:

1. **Texture resolution by projected use.** Repeating terrain/facade sets start at 1K. Use 2K only for a shared vegetation or facade atlas that demonstrably needs it.
2. **KTX2/Basis with mipmaps.** Prefer UASTC for normals and high-frequency masks; ETC1S can suit color/ORM where artifacts pass. A 1K RGBA8 texture with mips is about 5.33 MiB uncompressed versus about 1.33 MiB in an 8-bpp block format; verify the actual adapter format in the Stage 1 spike.
3. **Pack maps.** Base color is sRGB; normal and ORM are linear. Put occlusion/roughness/metalness in one ORM texture. Share atlases across species/archetypes.
4. **GLB + mesh compression.** Decimate before compression, remove unseen triangles, merge compatible primitives, use meshopt or Draco only after the pinned loader path is tested, and report both transfer bytes and decompressed vertex/index bytes.
5. **Instancing.** One `ScenegraphLayer` batch per species/archetype/LOD, not per feature. Reuse one geometry/material across thousands of transforms.
6. **Three LOD bands.** Near low-poly mesh; mid cheaper mesh/cards; far camera-facing billboard atlas. Fade/dither across a short band to prevent popping. Do not animate wind.
7. **Lazy loading and release discipline.** Load only the vector skin or realistic skin in use; fetch map-specific assets after map selection; retain a procedural fallback while an asset is pending; fail CI when manifest totals exceed the agreed budget.

---

## Part C — the look and the shared material system

### Art-direction target

The target is a damp, broken-overcast Russian autumn day with a low weak sun—not a sunny game board and not a gray visibility-killing filter.

| Role | Starting color / behavior |
|---|---|
| Sky / far fog | blue-gray `#A6AEAC` / `#979F9B`; low chroma |
| Grass | olive `#586149`, darker wet `#46513F` |
| Forest litter | leaf/mud brown `#615445` with desaturated green remnants |
| Dirt / mud | `#685A49` / wet `#49433A` |
| Asphalt | dry `#4A4E4D`, wet patches `#33393A` |
| Concrete | cool weathered `#7A7970` |
| Brick | muted red-brown `#745148` |
| Corrugated metal | blue/gray paint with `#7C4A32` rust accents |
| Conifers | `#39483B`; broadleaf autumn range `#596047` to `#756247` |
| Water | shallow tea/olive `#52635D`, deep blue-gray `#344A4C` |

Use a fixed map-space key direction so screenshots and navigation are deterministic: begin around **18–24° elevation** and **220–240° azimuth**, with a cool broad ambient and a weak slightly warm key. “Soft” should initially come from low contrast, baked/contact AO, and fog; deck's stock shadow is not a physically soft area-light shadow. Tune exposure so asphalt/concrete still separate under overcast light and UI colors remain untouched.

Fog should begin after the useful inspection range, not hide the map. Derive it from playable-map diagonal `D`: start near `max(250 m, 0.12D)`, reach approximately 65–75% by `0.65D`, and add a mild near-ground height term. Fog applies only to world layers; labels, extracts, quests, players, controls, and selection highlights stay crisp.

### One material contract

The current `building.style` values (`box`, `gable`, `tank`, `canopy`, `frame`) describe form, not reliable surface material. Do not overload them. Resolve a separate deterministic `materialClass` from, in priority order:

1. explicit evidence-backed feature override;
2. source `kind` + map + form `style`;
3. a conservative map default;
4. visible “unresolved” fallback in development, never random silent inference.

All renderable world elements consume the same conceptual material entry:

```js
{
  id: 'industrial-corrugated-rust',
  real: {
    baseColorTexture: 'corrugated-base.ktx2',
    normalTexture: 'corrugated-normal.ktx2',
    ormTexture: 'corrugated-orm.ktx2',
    baseColorFactor: [0.58, 0.60, 0.58, 1],
    uvMeters: [2.0, 2.0],
    roughnessFactor: 0.72,
    metallicFactor: 0.35,
    normalScale: 0.55,
    wetness: 0.12,
    macroVariation: 0.08,
    alphaMode: 'opaque',
    alphaCutoff: 0.5,
    fog: true,
    castShadow: true,
    receiveShadow: true,
    contactAO: 0.35
  },
  vector: {
    fill: [104, 111, 109, 255],
    outline: [45, 49, 48, 235],
    outlineWidthPx: 0.9
  }
}
```

For glTF assets, author these values into standard metallic-roughness materials and let `ScenegraphLayer` use PBR. For terrain/building/water custom layers, bind equivalent uniforms/samplers. The goal is visual consistency, not a claim that every custom surface is a full physically based renderer.

Wetness is a mask, not a global gloss slider: darken albedo slightly, lower roughness most on asphalt/painted metal, strengthen shallow contact, and leave porous dirt/brick relatively rough. Use map-stable seeded macro breakup so repetition is hidden without moving feature boundaries.

### Terrain splatting

Keep the completed 2.5 m geometry. Replace the current cartographic baked texture with deterministic material weights generated from existing evidence:

- **Mask A:** grass, forest litter, dirt/mud, rock.
- **Mask B:** asphalt, gravel/ballast, concrete/yard, wet shore/bed.
- **Priority:** water bed/wet bank → pavement/road → yard → hard rock/steep slope → forest litter → grass base.
- Current `roads.kind` supplies conservative width presets for `highway`, `main`, `small`, `dirt`, and `track`; current rail/pavement/yard/water/forest/understory/hard-rock features contribute masks. Keep the preset nature explicit until surveyed profiles exist.
- Feather boundaries in metric units, then add only a small seeded edge breakup. A texture-noise boundary must not move a road or shoreline beyond its evidence envelope.
- Sample near detail in world space; use triplanar blending on steep faces to avoid stretched UVs. Add a separate low-frequency macro tint so tiled 1K textures do not reveal repetition across Woods.
- Do not use runtime displacement/parallax on the 2.5 m terrain. It costs GPU time, breaks map truth at grazing angles, and does not create missing cliffs.

### Roads, rails, paths, markings, and edges

- Main/highway: asphalt material, darker irregular wetness in shallow/low-slope areas, 0.5–1.5 m gravel/dirt shoulder mask where the current evidence supports it.
- Dirt/track: compacted center, slightly greener raised edges, puddle-darkening only from deterministic low/slope mask.
- Rail: gravel ballast mask first. Add paired steel strips and instanced sleepers only where the exact current alignment survives inspection; batch them by map.
- Markings: retain only evidence-backed or class-conservative markings. Do not invent a Russian lane plan from a centerline. Use a thin decal/path layer with worn alpha breakup and metric dash spacing.
- Road surface meshes/crossfall, ditches, curbs, exact shoulders, and bridge approach grades wait for survey-dependent road profiles.

### Vegetation and forest edges

Use 3–5 visual species/archetypes while preserving the current data's `conifer`/`broadleaf` truth:

1. Scots-pine-like tall conifer;
2. spruce/fir dense conifer;
3. birch/aspen broadleaf with muted late-autumn leaves;
4. low shrub/young sapling;
5. optional dead snag shared across maps.

Each archetype has near, mid, and far representations. Near/mid are low-poly glTF with alpha-masked shared foliage atlases; far is a camera-facing billboard chosen from 4–8 baked azimuth frames. One deterministic hash of stable feature ID selects approved variant, yaw, scale, and tint. LOD selection may depend on camera distance, but it must never change the underlying feature position/identity. Use a short dither/fade transition and keep wind disabled.

Understory is clustered cards/low meshes concentrated by existing polygons and tree neighborhoods. Grass geometry is sparse and near-camera only; the terrain normal/albedo does most ground work. Never attempt a blade field across Woods. Accurate forest density, species distribution, clearings, and edge shapes remain survey data work.

### Rocks and cliffs

- Retopologize 4–8 license-clean rock sources into roughly 1k/4k/12k-triangle LODs; share one or two rock material sets.
- Deterministically select form/orientation/scale from feature ID, but keep landmark hard-rock outlines and scale controlled by their evidence, not by random variation.
- Use triplanar rock material plus a ground-color blend over the bottom 10–20 cm to eliminate the “placed plastic object” seam.
- The completed Woods hard-rock layer supplies the macro mountain. Rock assets add surface vocabulary; they must not become a second invented mountain.

### Water and shore

- Render one surface per body at its evidence-backed level.
- Derive a shoreline-distance field from the water polygon. Tint shallow water toward muddy/olive sediment, deepen toward blue-gray, and add a narrow dark wet-bank band on terrain.
- Use two low-amplitude normal samples moving in different fixed directions. Motion is a pure function of `time`; visual tests set `time=0`.
- Use Fresnel to blend toward fog/sky color at grazing angle and slightly reveal the carved bed near shore. This is a convincing environmental reflection cue, not a true scene reflection.
- Avoid bright foam except at specifically turbulent water; still lakes/rivers should have only rare, subtle edge breakup.
- Accurate water level, bank shape, and bathymetry remain survey-dependent. Current carved beds can drive a first shader but cannot substantiate exact depth.

### Buildings, facades, roofs, and floor cut

Create facade/roof faces from the same building footprints and height/floor data, with UVs measured in meters. Batch geometry by material while writing a stable feature/picking ID attribute.

Initial material families:

- brick dorm/urban block;
- precast panel/concrete reserve block;
- corrugated/painted industrial metal;
- plaster/timber rural gable;
- concrete bunker/plinth;
- painted/rusted tank and steel frame;
- tar/felt, corrugated metal, weathered tile, and concrete roof classes.

Use explicit landmark overrides where evidence exists; generic map/kind defaults elsewhere. Add restrained base grime, rain streaks, roof-edge darkening, and contact AO in texture/vertex masks. Remove or strongly demote the current continuous window-band language in realistic mode—it reads as a diagram. Do not punch generic windows everywhere. Real window/door openings, balconies, stairs, and visible rooms require surveyed facade/floor data and come last.

The floor cut must continue to use the same geometry and source floors. Before surveyed interiors exist, show real slabs/roof/wall cut faces, not invented room furniture.

### Props and clutter

Map current archetypes (`railcar`, `tanker`, `container`, `vehicle`, `wall`, `crane`, `tank`, `plane`, `pier`) to an approved asset registry. Scenegraph batches are per archetype/LOD; instance transforms remain those in `data/*-props.json`/generated data. Preserve procedural boxes/cylinders as an explicit unresolved fallback. For containers, the safer first production asset is a small TarkovZero-authored, dimensioned mesh using the CC0 Container Side material—not an unverified branded marketplace model.

Add small clutter only where evidence supports an area/archetype. A pile of plausible barrels in the wrong place decreases map fidelity. Avoid logos and recognizable branded/military designs unless independently licensed and evidence-backed.

### AO, contact, fog, and post

- Bake terrain cavity/shore/footprint contact into deterministic masks.
- Use small projected contact decals or vertex AO beneath trees, rocks, props, and buildings. This is cheaper and softer than turning every object into a shadow caster.
- Add one combined post pass for muted grade, very subtle vignette, and optional tiny monochrome grain. FXAA is acceptable if it materially reduces foliage/rail shimmer. No depth of field at an information map scale.
- Treat runtime deck shadows as a later gated enhancement. One key light only; constrain casters; test canonical 1× across kilometer extents; fall back to baked/contact shading if acne, peter-panning, or Woods cost fails.

### Vector skin: exact parameter flip, same geometry

`skin` changes material/style state only. Geometry buffers, transforms, relief, LOD positions, floor filtering, feature IDs, picking colors, source data, and camera state are invariant. The geometry cache key must exclude `skin`; only material uniforms/textures and a same-buffer outline pass may change.

| Parameter | Realistic | Vector |
|---|---|---|
| Base color texture | enabled | disabled |
| Normal/detail texture and scale | enabled; material-specific | disabled / `0` |
| ORM texture | enabled | disabled |
| `roughnessFactor`, `metallicFactor`, `wetness` | material values | ignored / `0` |
| Color | texture × muted tint × macro variation | semantic flat `vector.fill` |
| Lighting model | Phong-ish custom or glTF PBR + ambient/key | unlit or near-unlit high ambient |
| Image-based environment | enabled for approved glTF | disabled |
| Fog | distance + mild height fog | off, or a fixed 10–15% far fade only if labels need separation |
| Dynamic shadows | selectively enabled after Stage 7 | disabled |
| Baked/contact AO and grime | enabled, restrained | disabled |
| Terrain material weights | grass/dirt/rock/asphalt/etc. textures | semantic category fill from the same weights |
| Contours | off | optional, thin and low-contrast |
| Geometry outlines | none except selection | `vector.outline`, 0.7–1.2 px from the same vertex buffers |
| Road marking wear | textured/worn | solid semantic dash/edge |
| Water | depth/Fresnel/normal animation | flat fill + shoreline stroke; animation off |
| Foliage alpha/material | natural atlas and tints | flat species colors; same instance/LOD transforms |
| Post grade/grain/vignette | subtle combined pass | disabled; optional ink/edge pass only if it does not duplicate outlines |
| Sky/background | gray atmospheric gradient | flat neutral background |

The toggle must be instantaneous after both small material packages are loaded and must not refetch/rebuild map JSON or move a picked object.

---

## Part D — ranked implementation plan

### Estimation and regression contract

A **fleet-hour** is one focused implementation/review/verification hour. Ranges include asset processing and deterministic tests but exclude new field/manual survey data unless explicitly stated. Parallel work only shortens elapsed time when file ownership is clean; it does not reduce total fleet-hours.

Performance deltas assume 1440×900, DPR 1, WebGL2, canonical 1× geometry, one selected map, labels/markers at normal app settings, and a mid-range discrete GPU. Record low-power/integrated results separately. VRAM estimates include resident textures/buffers with mips, not browser/JS overhead. The Stage 1 implementation must replace these estimates with measurements.

The per-stage GPU ranges are pre-optimization risk envelopes, not permission to add every upper bound. Cumulative Woods targets relative to the measured pre-realism renderer are **≤4 ms by R2**, **≤6 ms by R3**, and **≤8 ms by R4 with dynamic shadows** (≤5 ms if shadows are rejected). The active desktop asset set must remain within the 128 MiB incremental cap through shared atlases, LOD residency, and lazy loading.

Every stage has the same non-visual gates:

1. generated bytes are identical across two clean runs;
2. feature counts, stable IDs, picking payloads, transforms, and geometry truth assertions remain unchanged unless the stage explicitly owns a reviewed data migration;
3. Customs passes first as the mixed-feature regression gate;
4. Woods then passes as the worst-case performance/overdraw gate;
5. realistic↔vector toggling changes no geometry buffer hashes or camera/selection state;
6. no BSG/proprietary asset enters the manifest.

### Fixed screenshot comparison specification

Create this harness during Stage 1 and use it for all later work:

- **Capture:** 1440×900, DPR 1, same pinned Chromium build, canonical relief 1×, `time=0`, labels/quests/loot/players off for the clean world plate, then a second UI-on plate. Wait for `deck.isLoaded` and two settled frames.
- **Cameras:** JSON bookmarks containing exact OrbitView `target`, `zoom`, `rotationX`, and `rotationOrbit`. Minimum suite: `customs-wide`, `customs-dorms-industrial`, `customs-river-rail`, `reserve-wide-courtyard`, `woods-wide`, `woods-forest-edge`, `woods-mountain-lake`.
- **Outputs:** before/after side-by-side, realistic/vector pair, opaque PNG, manifest hash, map-data hash, geometry-buffer hash, layer/draw-call count, resident texture estimate, median/p95 GPU frame time after warm-up.
- **Comparison:** intentional pixel diff is expected, so pass on a written visual rubric plus hard invariants. Material-only stages must keep silhouette/depth-edge masks and picked feature IDs invariant. No missing layer, black asset, texture seam, z-fight, fogged UI, sudden LOD hole, or unbounded shimmer.
- **Performance pass:** median and p95 are both reported. A stage fails if Woods exceeds its stage budget or loses more than 20% from the measured Stage 1 baseline without an approved quality trade.

### Stage 1 — atmosphere and anti-diagram reset

**Why first / expected gain:** biggest gain per hour. It changes the read of every square meter and every object before expensive geometry work. Expected perceived gain **very high (5/5)**.

**Work:** introduce the shared `realistic`/`vector` render-style contract; remove contours and strong hypsometric bands in realistic mode; mute the existing terrain bake; apply a single restrained ground detail/macro treatment; tune cool ambient + weak low key; add world-only exponential/height fog and matching background; add one combined grade/vignette pass and optional FXAA. Include a KTX2 + glTF PBR compatibility spike and instrument actual draw/GPU/texture metrics.

**Proposed files touched:** `src/map3d.js`, `src/terrain.js`, `src/style.css`, new `src/render-style.js`, new `src/atmosphere.js`, new `scripts/prepare-render-assets.mjs`, `package.json`, lockfile, `public/assets/3d/materials/*`, `public/assets/3d/environment/*`, and visual-test bookmarks/harness files.

**New assets:** processed `Ground106` detail subset and `Autumn Crossing` 1K environment/derived sky reference; own-made LUT/noise if used. Do not ship raw source packs.

**Expected cost:** **+1–2 main/post draws**, **+6–10 MiB VRAM**, **+0.4–1.1 ms GPU**. KTX2/glTF spike must reveal actual adapter residency.

**Determinism/regression:** no source data or geometry changes. Freeze fog/light/style constants; screenshot phase is zero. Customs is the first gate; Woods wide validates fog precision and fill cost.

**Effort:** **16–24 fleet-hours**.

**Acceptance screenshots:** Customs wide and dorm/industrial before-after must lose visible contour/map-board language while roads/buildings remain readable; Woods wide must show layered aerial depth without hiding mountain/lake; vector pair must retain the old information clarity with identical silhouette/picks.

### Stage 2 — deterministic terrain splats and transport surfaces

**Expected gain:** converts the largest pixel area from a colored relief texture to recognizable grass/forest/dirt/gravel/asphalt/concrete/wet-bank surfaces. **Very high (5/5).**

**Work:** generate Mask A/Mask B from current roads, rail, pavement, yards, water, forest/understory, slope, and hard-rock evidence; subclass the terrain mesh for world/triplanar base/normal/ORM sampling; add macro variation, wetness, road edges, rail ballast, and evidence-conservative worn markings. Add rail strips/sleepers only after alignment inspection.

**Proposed files touched:** `src/terrain.js`, `src/map3d.js`, `src/render-style.js`, `scripts/build-3d.mjs`, new `scripts/build-render-masks.mjs`, `scripts/prepare-render-assets.mjs`, generated `public/data/*-3d.json` references or deterministic mask assets, and `public/assets/3d/materials/*`.

**New assets:** the nine ambientCG candidates reduced to an approved 6–8 material 1K KTX2 array/atlas; own-made deterministic splat masks.

**Expected cost:** **0–2 additional main draws**, **+24–36 MiB VRAM**, **+0.8–1.9 ms GPU**. Preserve one terrain draw if sampler limits and target adapters allow it; otherwise split opaque terrain into two coherent passes, not one layer per material.

**Determinism/regression:** mask compiler is seeded/pure, records input hashes, and produces byte-identical output. Existing feature assertions and 1× heights remain the authority. Customs road/rail/yard/water mix is mandatory before Woods.

**Effort:** **24–40 fleet-hours**.

**Acceptance screenshots:** Customs highway/industrial/rail and river approaches must show distinct material/edge language without invented lanes; Woods forest road/track/lake approach must transition plausibly with no repeating 1K checkerboard at wide or near bookmark.

**Survey dependency:** exact road width/crossfall, curb/ditch/shoulder, rail-bed profile, bridge approaches, and lane markings remain blocked on road survey. Stage 2 uses documented class presets and must label them as such.

### Stage 3 — instanced vegetation and forest-depth system

**Expected gain:** removes the most obvious procedural blob signature, especially on Woods, and adds depth/scale cues. **High (4.5/5).**

**Work:** build 3–5 approved archetypes with near/mid meshes and far billboard atlas; use `ScenegraphLayer` PBR where it passes the spike; preserve stable instance transforms and hashes; add dithered LOD, muted species tints, sparse understory/near grass, and forest-ground contact.

**Proposed files touched:** `src/trees.js`, `src/map3d.js`, `src/render-style.js`, `scripts/prepare-render-assets.mjs`, `public/assets/3d/vegetation/*.glb`, KTX2 atlases, and visual LOD tests. Touch `scripts/build-3d.mjs` only if adding an explicit deterministic archetype field—not to move existing trees.

**New assets:** retopologized CC0 pine/sapling/shrub/fern sources, own-made spruce/birch/dead-snag derivatives and billboard atlas; Quaternius/Kenney only for vector/prototype variants.

**Expected cost:** **+8–14 main draws** (species×LOD batches, not instances), **+18–28 MiB VRAM**, **+1.2–3.2 ms GPU on Woods**. Keep alpha overdraw bounded; billboard cutoff must engage before trees become subpixel.

**Determinism/regression:** stable feature ID alone chooses approved variant/yaw/scale/tint. Camera changes only LOD representation. Count and position hashes remain fixed. Customs proves sparse/mixed vegetation; Woods proves worst-case count and alpha overdraw.

**Effort:** **32–52 fleet-hours**.

**Acceptance screenshots:** Woods forest-edge near/mid/far sequence must show no crown blobs, no obvious simultaneous pop, no bright cutout halos, and a believable closed edge where data supports it; Customs vegetation must not become an implausible forest.

**Survey dependency:** accurate density, species distribution, clearings, undergrowth, and forest-edge polygons are blocked on land-cover survey. The renderer/LOD can ship against current points; claiming realistic forest structure cannot.

### Stage 4 — building facade/roof materialization

**Expected gain:** replaces clean extruded blocks and diagram window bands with weathered, correctly scaled surfaces. **High (4/5).**

**Work:** create `BuildingMeshLayer` buffers from the same footprint/height/roof inputs; generate metric wall/roof UVs; batch brick/panel/concrete/corrugated/plaster/timber/tank classes; add restrained grime/contact; preserve roof/floor cut and picking. Switch the vector skin on the same buffers.

**Proposed files touched:** new `src/buildings.js`, `src/map3d.js`, `src/render-style.js`, `scripts/build-3d.mjs` for reviewed `materialClass`/override references, `scripts/prepare-render-assets.mjs`, building asset atlases, and generated JSON only when the mapping is data-owned.

**New assets:** processed brick, concrete, corrugated steel, rusted metal, and approved roof materials from ambientCG; own-made grime/trim atlas.

**Expected cost:** **+6–12 main draws**, **+10–18 MiB VRAM**, **+0.8–2.0 ms GPU**. Reuse terrain concrete/brick/metal sets, batch by material/LOD, and retain one pickable feature index; do not create one layer per building.

**Determinism/regression:** triangulation and UV generation are deterministic; input footprint, height, floor, roof, and feature IDs are unchanged. Customs gates dorm/industrial/tank/canopy/frame styles; Reserve checks dense block/roof repetition.

**Effort:** **36–60 fleet-hours**.

**Acceptance screenshots:** Customs dorm and industrial bookmarks must show meter-consistent brick/panel/corrugation with no swimming UVs, implausible gloss, or continuous window bands; Reserve wide/courtyard must not reveal atlas repetition; floor cut must still select/show the same building and floors.

**Survey dependency:** material overrides for landmarks can be evidence-backed now; real openings, balconies, roof machinery, exact roof forms, and interiors wait for facade/building survey.

### Stage 5 — rocks, cliffs, water, and shoreline integration

**Expected gain:** makes Woods mountain/lakes and Customs river stop reading as extruded forms plus colored sheets. **Medium-high (3.5/5).**

**Work:** instance decimated rock forms over existing rock/hard-rock evidence with triplanar/ground blend; implement water depth/shore/Fresnel/normal/fog shader; generate wet-bank and shoreline-distance masks; keep water body levels and carved beds intact.

**Proposed files touched:** new `src/rocks.js`, `src/water.js`, `src/terrain.js`, `src/map3d.js`, `src/render-style.js`, `scripts/build-render-masks.mjs`, `scripts/prepare-render-assets.mjs`, and rock/water assets.

**New assets:** decimated `Boulder 01` derivatives, approved rock material, two own-made tileable water normals or CC0 equivalents, shoreline masks.

**Expected cost:** **+6–10 main draws**, **+6–12 MiB VRAM**, **+0.7–1.8 ms GPU**.

**Determinism/regression:** rock choice/rotation uses stable IDs; shoreline field is pure from body geometry; screenshot water time is zero. Woods validates hard-rock silhouette at canonical 1×; Customs validates bridges/river and transparent ordering.

**Effort:** **28–46 fleet-hours**.

**Acceptance screenshots:** Woods mountain/lake must keep the Fix pass 10 macro silhouette while rock bases blend and water reads shallow-to-deep; Customs river/bridges must have no z-fight, bright plastic sheen, visible polygon seam, or reflection of nonexistent scenery.

**Survey dependency:** accurate cliff-face form, shoreline/bank location, water level, and bathymetry remain blocked on survey. Generic material integration is not blocked.

### Stage 6 — prop and clutter asset registry

**Expected gain:** improves close landmark recognition and scale after the broad scene already reads correctly. **Medium (3/5).**

**Work:** create a manifest-backed archetype registry and instanced `ScenegraphLayer` batches; map existing prop records to approved GLBs; retopo/atlas assets; retain explicit procedural fallback; add distance LOD and ground contact.

**Proposed files touched:** new `src/props.js`, `src/map3d.js`, `src/render-style.js`, `scripts/prepare-render-assets.mjs`, `public/assets/3d/props/*`, and attribution/asset manifests. `data/*-props.json` changes only through separate reviewed evidence work.

**New assets:** approved Poly Haven barrel, covered car, fence, crate, and Container Side material; selected Kenney factory/car/survival assets only where stylized fallback is acceptable; own-made container/rail/tanker/crane forms as needed.

**Expected cost:** **+10–18 main draws**, **+8–16 MiB VRAM**, **+0.6–1.6 ms GPU**. One archetype/material batch may represent many instances; props reuse the building metal/concrete atlases.

**Determinism/regression:** prop count, transform, type, and pick ID stay fixed unless source data changes separately. Missing assets render the known fallback, never disappear. Customs rail/industrial yard is the main gate; Reserve checks dense vehicles/tanks; Woods checks sparse landmark props.

**Effort:** **24–44 fleet-hours**.

**Acceptance screenshots:** Customs rail yard/industrial and Reserve vehicle areas must have recognizable but unbranded silhouettes, consistent scale, grounded contact, and no per-instance draw explosion; vector mode must use the same props with flat materials.

**Survey dependency:** exact prop identity, pose, variant, stacking, wreck state, and clutter distribution remain survey-dependent.

### Stage 7 — contact and shadow hardening

**Expected gain:** adds final grounding and long-light structure, but has lower gain/cost and the highest renderer risk. **Medium (2.5/5).**

**Work:** improve baked/vertex AO and contact decals first; then spike one dynamic directional shadow, custom terrain receive-only behavior, constrained casters, slope-aware bias, and small PCF. Keep the weak overcast key. Do not add a second shadow light.

**Proposed files touched:** `src/map3d.js`, `src/terrain.js`, `src/trees.js`, `src/atmosphere.js`, custom building/rock/prop layers, `src/render-style.js`, and shadow visual/perf tests.

**New assets:** none beyond small own-made contact/noise masks.

**Expected cost:** baked/contact route **+1–2 draws, +0.2–0.6 ms**. Stock one-light shadow at 1440×900 DPR 1 allocates about **7.4 MiB** for RGBA8+depth16 targets (about **29.7 MiB at DPR 2**) and re-renders caster draws; plan for **+20–45 shadow-pass draws and +1.8–4.5 ms on Woods**. Ship dynamic shadows only inside this cap.

**Determinism/regression:** fixed light and bias parameters; canonical 1× only. Customs exercises the mixed terrain/building/tree/prop caster stack first; then test every Woods elevation extreme and all camera bookmarks for acne/peter-panning. If any map fails or p95 budget regresses, ship baked/contact AO without dynamic shadows.

**Effort:** **20–34 fleet-hours**.

**Acceptance screenshots:** all wide and near bookmarks must show soft-looking contact/long direction without terrain acne, detached feet, flicker, or dark UI; compare shadow-off/on and prove the gain is worth the measured Woods cost.

### Stage 8 — surveyed openings and visible interiors

**Expected gain:** high only for floor-cut/close-building users; low for map-wide views. **Conditional (2–5/5 by workflow).**

**Work:** after survey, add evidence-backed doors/windows/roof openings, per-floor slabs/walls/stairs, and limited interior materials/props visible through the existing floor cut. Add coarse interior LOD/culling and keep external feature identity.

**Proposed files touched:** `scripts/build-3d.mjs`, new surveyed building source files under the project's chosen evidence path, `src/buildings.js`, `src/map3d.js`, `src/render-style.js`, interior materials/models, generated JSON, and floor-cut tests.

**New assets:** own-made modular opening/trim/interior kit plus CC0 surface materials; no game-extracted meshes/textures.

**Expected cost:** **+12–28 main draws near surveyed buildings**, **+18–40 MiB VRAM when interiors are loaded**, **+1.2–3.5 ms GPU in floor-cut close views**. Interiors must lazy-load and disappear from wide LODs.

**Determinism/regression:** source survey/provenance for every opening/floor; stable building/floor IDs; exterior geometry remains authoritative. Customs gets the first complete representative building before Reserve/Woods expansion.

**Effort:** **56–96 fleet-hours for renderer/asset integration, excluding survey/data authoring**.

**Acceptance screenshots:** paired exterior and floor-cut views of a surveyed Customs building must show openings aligned on both sides, plausible slab/wall thickness, no invented inaccessible rooms, no light leaks/transparent sorting faults, and unchanged building selection/floor behavior.

**Blocker:** this stage does not start until facade/opening/floor/interior survey exists.

### Stage totals and release cuts

| Release cut | Included stages | Effort | Outcome |
|---|---|---:|---|
| **R1 — scene stops looking like a diagram** | 1 | **16–24 FH** | muted atmosphere, no realistic-mode contours, shared skin switch, measured baseline |
| **R2 — credible outdoor world** | 1–3 | **72–116 FH cumulative** | real terrain/roads plus believable vegetation/LOD |
| **R3 — credible built world** | 1–6 | **160–266 FH cumulative** | buildings, rock/water, and props use coherent materials/assets |
| **R4 — grounded polish** | 1–7 | **180–300 FH cumulative** | contact and optional bounded dynamic shadows |
| **R5 — surveyed interiors** | 1–8 | **236–396 FH cumulative, plus survey** | openings/interiors work with the floor cut |

Stages are releaseable individually. Do not hold R1/R2 for survey-dependent interiors.

### Survey-dependent data work from the earlier audit

| Data dependency | What can proceed now | What must wait |
|---|---|---|
| Road/rail profiles | material masks, conservative class widths, ballast/asphalt/dirt treatment | exact crossfall, shoulders, curbs, ditches, sleepers/rail spacing, bridge approaches, markings |
| Land cover/forest | tree asset/LOD swap, current-point understory, terrain forest material | true density, species mix, forest edges, clearings, grass/understory coverage |
| Hard rock/cliffs | completed Fix pass 10 hard-rock silhouette, rock materials/instances | surveyed cliff faces, ledges, landmark boulder geometry |
| Water | shader, current body level/bed, shoreline distance field | exact water level, bank geometry, shoreline, bed/depth/bathymetry |
| Buildings | material families, UVs, exterior weathering, existing floor cut | doors/windows, balconies, exact roof details, slabs/stairs/rooms/interior props |
| Props | asset registry and current archetype replacements | exact identity, pose, variant, wreck state, stacking, clutter placement |

### Explicitly out of the initial plan

- screen-space reflections, planar scene reflections, SSAO/GTAO, volumetric fog/clouds, real-time GI;
- runtime terrain displacement/parallax and kilometer-scale grass blades;
- per-feature layers/draw calls;
- invented openings/interiors/road markings/prop clusters;
- any BSG or extracted game asset;
- a second vector geometry scene or separate data pipeline;
- switching render engines to solve art-direction problems.

---

## Top look decisions

1. **Remove diagram signals before adding detail:** no contours or strong hypsometry in realistic mode; preserve them as optional vector parameters.
2. **Make surface identity cover the map:** deterministic terrain splats and material-scale normals do more than adding hero props first.
3. **Use broken-overcast light plus distance fog:** cool broad ambient, weak low key, restrained contrast, crisp UI.
4. **Spend geometry where silhouettes matter:** 3–5 instanced vegetation archetypes/LODs, generated facade UVs, decimated rock forms; never one draw per feature.
5. **Treat vector as a material state:** same geometry buffers, transforms, IDs, picking, camera, floors, and LOD placement; only textures/material/outline/fog/shadow parameters flip.

---

## Appendix — verified URLs and dates

All pages below were checked on **2026-08-29 America/Los_Angeles** (network responses crossing midnight UTC may report 2026-08-30). Exact local package sources were also inspected at the installed versions.

### deck.gl / luma.gl / loaders.gl

- [`SimpleMeshLayer` API](https://deck.gl/docs/api-reference/mesh-layers/simple-mesh-layer)
- [`ScenegraphLayer` API](https://deck.gl/docs/api-reference/mesh-layers/scenegraph-layer)
- [`TerrainLayer` API](https://deck.gl/docs/api-reference/geo-layers/terrain-layer)
- [`PolygonLayer` API](https://deck.gl/docs/api-reference/layers/polygon-layer)
- [`PathLayer` API](https://deck.gl/docs/api-reference/layers/path-layer)
- [`PathStyleExtension` API](https://deck.gl/docs/api-reference/extensions/path-style-extension)
- [Using effects / lighting](https://deck.gl/docs/developer-guide/using-effects)
- [`DirectionalLight` API](https://deck.gl/docs/api-reference/core/directional-light)
- [`PostProcessEffect` API](https://deck.gl/docs/api-reference/core/post-process-effect)
- [Custom layers](https://deck.gl/docs/developer-guide/custom-layers)
- [Primitive custom layers](https://deck.gl/docs/developer-guide/custom-layers/primitive-layers)
- [Shader modules and public injection hooks](https://deck.gl/docs/developer-guide/custom-layers/writing-shaders)
- [deck.gl performance guide](https://deck.gl/docs/developer-guide/performance)
- [deck.gl 9.3.11 `SimpleMeshLayer` source](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/mesh-layers/src/simple-mesh-layer/simple-mesh-layer.ts)
- [deck.gl 9.3.11 simple-mesh fragment source](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/mesh-layers/src/simple-mesh-layer/simple-mesh-layer-fragment.glsl.ts)
- [deck.gl 9.3.11 `ScenegraphLayer` source](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/mesh-layers/src/scenegraph-layer/scenegraph-layer.ts)
- [deck.gl 9.3.11 `PostProcessEffect` source](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/core/src/effects/post-process-effect.ts)
- [deck.gl 9.3.11 `ShadowPass` source](https://github.com/visgl/deck.gl/blob/v9.3.11/modules/core/src/passes/shadow-pass.ts)
- [luma.gl 9.3.6 PBR material parser](https://github.com/visgl/luma.gl/blob/v9.3.6/modules/gltf/src/parsers/parse-pbr-material.ts)
- [luma.gl 9.3.6 postprocessing pass sources](https://github.com/visgl/luma.gl/tree/v9.3.6/modules/effects/src/passes/postprocessing)
- [loaders.gl glTF formats/extensions](https://loaders.gl/docs/modules/gltf/formats/gltf)

### Asset licenses, catalogs, and download metadata

- [ambientCG license](https://docs.ambientcg.com/license/)
- [ambientCG v2 full JSON API](https://docs.ambientcg.com/api/v2/full_json/)
- [ambientCG v2 download CSV API](https://docs.ambientcg.com/api/v2/downloads_csv/)
- [Poly Haven asset license](https://polyhaven.com/license)
- [Poly Haven public API](https://polyhaven.com/our-api)
- [Poly Haven API root/schema](https://api.polyhaven.com/)
- [Quaternius FAQ/license statement](https://quaternius.com/faq.html)
- [Quaternius Ultimate Stylized Nature](https://quaternius.com/packs/ultimatestylizednature.html)
- [Quaternius Ultimate Nature](https://quaternius.com/packs/ultimatenature.html)
- [Kenney support/license statement](https://kenney.nl/support)
- [Kenney Nature Kit](https://kenney.nl/assets/nature-kit)
- [Kenney Factory Kit](https://kenney.nl/assets/factory-kit)
- [Kenney Car Kit](https://kenney.nl/assets/car-kit)
- [Kenney Survival Kit](https://kenney.nl/assets/survival-kit)
- [Kenney Skyboxes](https://kenney.nl/assets/skyboxes)
- [Sketchfab license filter explanation](https://sketchfab.com/blogs/community/refine-downloadable-model-searches-with-new-license-filters/)
- [Sketchfab license API](https://api.sketchfab.com/v3/licenses)
- [Sketchfab download API](https://sketchfab.com/developers/download-api/downloading-models)
- [three.js MIT repository license](https://github.com/mrdoob/three.js/blob/dev/LICENSE)
- [three.js asset-contribution licensing warning](https://github.com/mrdoob/three.js/blob/dev/.github/CONTRIBUTING.md)

File sizes in the candidate tables came from the sites' official APIs, Drive metadata, or HTTP `Content-Length` on the listed official download as observed on the verification date. Recheck and hash at acquisition; upstream catalogs can change.
