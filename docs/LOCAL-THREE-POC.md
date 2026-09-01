# Customs Three.js proof — localhost only

This proof replaces only the 3D presentation layer. Leaflet, map coordinates, marker filtering,
quests, live tracking, floors, UI, camera hand-off, and generated Customs data stay in the existing
application.

It is intentionally unavailable in production builds and unavailable for Reserve/Woods.

## Renderer decision

Do not move TarkovZero to Unity or Unreal. Keep the web application and replace only the renderer
behind the existing interface. Three.js is the primary path because it can consume the metric
GLB/KTX2 asset pipeline directly inside the current JavaScript UI. `WebGPURenderer` is exercised
with its WebGL2 fallback; the fallback remains mandatory while Three's WebGPU renderer is
experimental. Babylon.js is the contingency only if the same audited GLBs expose a demonstrated
renderer limitation. An engine migration cannot repair source geometry, elevation, material scale,
or object placement.

Official references:

- https://threejs.org/manual/en/webgpurenderer
- https://threejs.org/docs/#examples/en/loaders/GLTFLoader
- https://www.khronos.org/gltf/pbr
- https://www.khronos.org/ktx/

## Start

```sh
npm run prepare-three-assets
npm run dev -- --host 127.0.0.1
```

Open:

```text
http://127.0.0.1:5173/?map=customs&view=3d&renderer=three&look=realistic#4.4/230/-110
```

Force the fallback backend:

```text
http://127.0.0.1:5173/?map=customs&view=3d&renderer=three&threeBackend=webgl2&look=realistic#4.4/230/-110
```

The proof is one fixed visual target: Real mode by default, no atmospheric fog, and 2× terrain
relief. The Relief control and Fog control are absent in this mode. A query string, saved Deck
preference, or runtime call cannot change the 2× relief. Deck retains its existing analysis
controls on Customs, Reserve, and Woods.

Inspect the proof through `window.tz.renderer`, `window.tz.renderStats()`, and
`document.querySelector('#map3d').__tz3d.diagnostics()`.

## Truth boundary

The renderer's terrain, positions, elevations, and source IDs come from the canonical Customs JSON.
The source artifact remains canonical 1× metric truth; this renderer deliberately presents terrain
at a fixed 2× vertical scale. Object and storey heights remain unscaled. This visual choice is not
an accuracy claim and does not alter the independent audit.

The current golden cell is the industrial rail yard around `(230,-110)`. The renderer consumes the
shared 2048×1098 semantic ground bake with an explicit game-space UV contract, then adds close-range
physical rails and 1,818 instanced sleepers over the reviewed track center-lines. Roads, ballast,
grass, compacted dirt, concrete, and shoulders therefore follow evidence-aligned boundaries rather
than random color noise. Flat legacy road/rail overlays are hidden in Real mode so they cannot mask
the atlas.

The original procedural landmark kit currently distinguishes ribbed shipping containers, storage
tanks, locomotives, freight and tanker wagons, road trailers, crane trucks, a yard crane, and the
open-frame Skeleton building. The red container stack and west locomotive have stable IDs, fixed
callouts, and nested hover selection. Linear walls drape all four footprint corners over terrain;
asset yaw and declared dimension envelopes are regression-tested.

The green groundcover is now data-aligned rather than invented: all 37 SVG-derived understory
polygons (6,346 reviewed vertices) are draped over the measured terrain. Its deterministic green
albedo and normal texture is separate from the dirt terrain material, so the vegetation remains
readable at overview distance instead of looking like tinted soil. Inside those same polygons,
12,000 deterministic instanced tufts provide actual Z-up blade geometry at near and medium range.
Tuft centres are inset 0.4 m from every reviewed boundary; no centre or blade footprint is placed on
unreviewed terrain.

The grass budget is explicit and inspectable in renderer diagnostics. The near LOD is six triangles
per tuft (72,000 total), the medium LOD is two triangles per tuft (24,000 total), and the overview
LOD is the polygon carpet alone. Only one tuft LOD and one instanced draw call are active at a time.
Tufts do not cast into the full-map shadow map. Both instanced LOD buffers together cost about 1.8
MiB for matrices and per-instance colors, before small geometry buffers. This remains provisional
generic groundcover, not species-accurate EFT vegetation.

Procedural buildings, props, tree forms, and groundcover remain provisional and are labelled as
such. They are not evidence of visual correspondence with EFT.

The Re3mr/GameMaps Customs artwork is a lawful visual benchmark only. Its raster, tiles, and traced
geometry are not shipped. Original TarkovZero geometry must be derived from canonical map data,
permitted references, and measured observations; attribution or permission must be recorded before
any third-party asset enters the project.

Audited assets enter through `public/assets/3d/customs/scene-manifest.json`. Every enabled chunk
must provide a stable ID, EFT-space origin, authored/licensed GLB URL, and any required yaw. KTX2
textures use the local Basis transcoder under `public/assets/3d/vendor/basis/`; no game-extracted
meshes or textures belong in the project.

Do not add a chunk until its geometry has a survey/reference receipt and passes the Customs object
accuracy gate. An empty manifest is valid and keeps the procedural fallback visible.

The realism work is therefore an asset/evidence pipeline: survey control points and dimensions,
QGIS registration, metric Blender modeling or lawful photogrammetry, stable feature IDs, physically
scaled PBR materials, authored interiors/doors/stairs/fences/props, spatial GLB chunks, KTX2
textures, mesh compression, instancing, LOD, lighting, and performance gates. The renderer only
shows the quality that this pipeline supplies.

## Local game-derived truth boundary

User-owned, game-derived Customs truth (the package written by
`scripts/extract-customs-terrain-local.py`) lives in the gitignored repo-local directory
`.local-game-derived/`, **outside `public/`**. That single fact is the boundary: Vite copies
`public/` into `dist/`, so a root outside `public/` cannot be copied into a production build no
matter what the renderer asks for.

The browser reaches it only through a fixed dev-only route:

```text
/@local-game-derived/customs/manifest.json   ->  .local-game-derived/customs/manifest.json
```

`scripts/lib/local-game-derived-dev.mjs` implements that route as an `apply: 'serve'` Vite plugin
with only a `configureServer` hook, so it exists during `npm run dev` and in no other command —
`vite build` never installs it, and `vite preview` (which serves the built `dist/`) never gains it.
The handler is deny-by-default: GET/HEAD only, loopback client socket **and** loopback `Host`
required, any `X-Forwarded-*` header refused, per-segment percent-decoding that rejects `..`,
encoded separators and NUL, `realpath` containment so no symlink escapes the root, regular files
only (no directory listing), an extension allowlist (`.json`, `.png`, `.f32le`), and
`Cache-Control: no-store` plus `X-Content-Type-Options: nosniff` on every response.

`scripts/verify-build-boundary.mjs` runs automatically after `vite build` (`npm run build`) and
proves the boundary held. It walks `dist/` recursively and fails on any of:

- a path segment or file name that is local-derived (`local-game-derived`, `extraction-report.json`,
  a `.f32le` payload) — or any symbolic link in the build output;
- an absolute EFT-install string (drive-letter or UNC path into `Escape from Tarkov` /
  `Battlestate`, `EscapeFromTarkov_Data`, `EscapeFromTarkov.exe`) or the local root name
  `.local-game-derived`, scanned in both UTF-8 and UTF-16LE;
- a file whose SHA-256 matches the local package — either a hash declared in
  `manifest.json`/`extraction-report.json`, or the digest of an actual file under
  `.local-game-derived/`, so a renamed copy is caught byte-for-byte.

A failure prints a JSON report, leaves `dist/` in place for inspection, and exits non-zero. Run it
alone with `npm run verify:build-boundary`; point it at fixtures with `--dist-dir` / `--local-root`.
`npm run test:local-boundary` covers both the route and the verifier.

The loopback URL constant `/@local-game-derived/customs/manifest.json` is application source and is
still bundled into `dist/`; that is intentional and is not a leak. In production it resolves to
nothing, and `loadCustomsLocalTerrainPackage` refuses any non-loopback page origin before fetching.

### Migrating an existing package

Nothing is moved for you. If your checkout still has the package at the previous location, move it
once, from the repository root:

```sh
mkdir -p .local-game-derived
mv public/local-game-derived/customs .local-game-derived/customs
rmdir public/local-game-derived
```

Then confirm the move with `npm run audit:customs-local-terrain` (it now defaults to
`.local-game-derived/customs`, and takes `--package-dir` for any other location) and `npm run build`.
Both locations stay in `.gitignore`, so an un-migrated checkout still cannot commit or deploy the
package.

## Every-asset contract

“Create every asset” means every canonical Customs asset family receives an owned, auditable visual
definition; it does not mean duplicating a unique mesh for every repeated barrel, tree, or fence
post. Unique landmarks are custom-authored. Repeated objects use measured reusable variants and
instanced placements.

Every authored asset must carry:

- a stable feature ID plus measured origin, yaw, dimensions, and elevation;
- a reference/source receipt and held-out placement validation;
- metric visual GLB meshes for near, medium, and far LODs;
- separate collision, picking, and shadow proxies where required;
- base-color, normal, ORM, and selective emissive KTX2 textures at a declared texel scale;
- fixed-camera screenshots, validation output, and a payload/performance receipt.

The inventory covers terrain and land cover; roads, rails, bridges, and water; grass, bushes, trees,
and deadfall; landmark exteriors and tactical interiors; doors, windows, stairs, roofs, and damage;
fences, powerlines, pipes, and industrial structures; vehicles, containers, and tanks; cover,
clutter, and debris; decals and signage; interaction volumes; and lighting/emissives.

At runtime, the browser loads coarse terrain and landmark silhouettes first, then streams nearby
spatial GLB cells. High detail exists near the camera; medium and far LODs replace it with simpler
geometry and textures. Instancing is for repeated assets, not a substitute for measured placement.
