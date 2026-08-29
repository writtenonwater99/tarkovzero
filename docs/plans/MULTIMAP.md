# Multi-map refactor plan

## Goal and invariants

Make Customs, Reserve, and Woods first-class maps without changing the Customs product. The selected map is the `map` query parameter (`?map=customs`, `?map=reserve`, or `?map=woods`); a missing or unknown key safely selects Customs. The existing `view`, `base`, `debug`, `live`, and hash permalink behavior remains available.

The hard regression gate is the current Customs output:

- `public/data/customs-3d.json` and `public/data/customs.json` remain byte-for-byte identical during the refactor. Baseline SHA-256 values are recorded in `/tmp/tarkovzero-customs-baseline.sha256` for the work session and will be copied into `PROGRESS.md` with the post-refactor values.
- 2D and 3D layer order, palette, label behavior, floor behavior, marker defaults, and initial fit remain unchanged for `?map=customs`.
- Generalization must not introduce a second coordinate system. Every map continues to use game `[x,y,z]`, Leaflet `[z,x]`, and deck.gl `[-x,-z,y]`.

## Runtime design

### Map registry

`src/mapdata.js` becomes the registry and selection boundary:

- Export `MAPS`, keyed by `customs`, `reserve`, and `woods`.
- Retain `CUSTOMS` as an alias during the refactor so unrelated imports do not break.
- Each entry contains `key`, display `name`, raid facts, `tileSize`, zoom range, transform, rotation, tile bounds, optional `svgBounds`, SVG URL/layer, tile URL, and available floor buttons.
- Export a selector that reads a normalized key and falls back to Customs. `main.js` will parse `new URLSearchParams(location.search).get('map')` once and pass the selected object downward.
- The vector overlay uses `svgBounds ?? bounds`; this is required for Reserve and is a no-op for Customs and Woods.

`src/labels.js` exports `LABELS` keyed by map plus the existing named arrays. Runtime code binds `const mapLabels = LABELS[mapData.key]` and never imports a map-specific constant directly.

### Data selection

- `src/api.js` is already keyed; retain live-API-first/fallback behavior and fetch `/data/${mapKey}.json`.
- `src/map3d.js` fetches `/data/${mapData.key}-3d.json` instead of the Customs literal.
- The road debug overlay fetches the same per-map 3D URL.
- Static 3D scene recipes (bunker mouths/checkpoints) become either generic marker-name recipes or a small per-map recipe table; no Reserve/Woods name is added to Customs-only logic in a way that changes Customs.
- Raid metadata is read from `mapData.raid`, not the Customs constant.
- Existing live-position map filtering already compares the companion's `m.map` with `mapData.key`; preserve it.

### URL and switcher

Add an accessible map selector in the sidebar header beside/below the title:

- Use a compact native `<select id="map-switcher">` so keyboard/mobile behavior is free and robust.
- The visible `<h1>` and document title update from `mapData.name`.
- Changing the selection constructs a `URL` from `location.href`, sets `map`, preserves meaningful query options (`view`, `base`, `debug`, and `live`), clears the hash because coordinates belong to the old map, and navigates.
- `history.replaceState(..., '#zoom/x/z')` must continue to preserve the query string.
- Keep local preferences shared where that is desirable (base, 2D/3D, density); marker data browser cache remains keyed by map. Floor selection is validated against the selected map's available floors so a Reserve floor cannot leave Woods in an invalid state.

### UI compatibility

- Keep the current Customs header footprint as close as possible. The switcher uses the existing dark rail/condensed typography and does not replace the map title.
- On mobile, it remains inside `rail-head` and does not reduce the 2D/3D hit target.
- Floor buttons are created/hidden based on the registry. Customs retains All/G/1/2/3/U. Reserve adds the levels needed by its extents; Woods shows All/G only (no authoritative floor extents).
- Attribution stays visible and continues to credit tarkov.dev; the marker snapshot source remains visible in the status popover.

## Build-pipeline design

### Commands

All map-producing scripts accept one or more map keys, with Customs as the compatibility default:

- `node scripts/build-community-data.mjs reserve`
- `node scripts/build-3d.mjs reserve`
- `node scripts/warm-tiles.mjs reserve`
- the matching npm commands forward `--` arguments normally.

Unknown keys fail early with the accepted key list. Inputs live at `scripts/data/<map>/`; hand edits remain `data/<map>-props.json` and `data/<map>-roads.json`; outputs remain `public/data/<map>.json` and `public/data/<map>-3d.json`.

### Shared versus per-map code

Refactor the parser/geometry mechanics out of Customs constants, but keep judgment declarative:

- Shared: SVG tokenization, transform stack, path flattening, SVG-to-game conversion, clipping, extent overlap, terrain IDW/noise/smoothing, road edit application, fence gates, bridge intersection helpers, output assembly.
- Per-map config: SVG semantic group aliases, bounds, source files, floor policy, terrain point filter/features, building defaults/identity colours/styles, explicit bridge whitelist, road reclassification, and optional extra geometry.
- Reserve's `svgBounds` is the geometry mapping box. Woods uses normal bounds.
- Waterless Reserve produces empty `water`/`bridges` arrays. Woods uses an explicit crossing whitelist so a road merely touching boundary water cannot create an invented bridge.

The marker builder uses a per-map configuration containing SPT id/input, wiki input, boss-name aliases, calibration transforms, and panel policy. Reserve supports more than one affine panel; Woods uses one affine. The raw API responses are already downloaded so normal builds are reproducible and do not depend on live services.

### Customs byte identity

The sequence for proving the refactor is safe:

1. Keep copies/checksums of both Customs public JSON files and baseline 2D/3D screenshots.
2. Refactor runtime selection without running a generator; compare `sha256sum` immediately.
3. Make the generalized builders preserve the existing `builtAt` when rebuilding an existing output unless `--stamp` is requested. This removes timestamp-only nondeterminism.
4. Run `node scripts/build-3d.mjs customs` and compare the complete bytes with the baseline. If ordering or floating-point formatting differs, restore the legacy ordering before proceeding.
5. Run `node scripts/build-community-data.mjs customs` only against the checked-in raw/current Customs inputs if available; otherwise the public marker snapshot stays untouched and its checksum is the regression proof.
6. Build and capture Customs at the same 2D and 3D URLs. Use image comparison plus visual inspection; software GL black/blur failures are recorded separately from product regressions.

## Verification checklist

- `npm run build` succeeds (the worktree's read-only shared `node_modules/.vite-temp` issue may require the Vite runner config loader in this environment; this is not a site-code failure).
- All three `?map=` URLs load the expected title, bounds, tile/SVG base, labels, marker JSON, and 3D JSON.
- Switching maps clears the coordinate hash and preserves view/base choices.
- Unknown/missing map falls back to Customs.
- Search indexes only the selected map.
- Road debug uses the selected map and draws its selected limit.
- Companion positions display only on their reported map.
- Direct 3D URL and 2D↔3D sync work per map.
- Customs JSON SHA-256 and representative screenshots match the baseline before Reserve construction starts.

