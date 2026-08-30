# TarkovZero — project context for Claude

Google-Maps-style interactive Escape from Tarkov map. Live at https://tarkovzero.com (Vercel), repo
https://github.com/writtenonwater99/tarkovzero. v1 = Customs, outdoors only.

## Two machines, two roles (important)
- **Linux dev laptop** (no Tarkov installed): owns **site development** — `src/`, `public/`, `scripts/`, `relay/`,
  Vercel and Fly deploys. This is where the site is built and deployed.
- **Windows game laptop** (Tarkov installed, also the user's main coding machine): owns the **companion app**
  (`companion/`) and all real-game testing. Claude on the game laptop should:
  - run and debug `companion/companion.mjs` against the real game,
  - fix companion-side bugs (filename parsing, folder detection, auto-screenshot, log-based map detection),
  - commit + push those fixes to `main`,
  - **not** change the site/relay unless a fix is required to make live position work; if so, keep the change
    minimal, describe it clearly in the commit message, and the site laptop will deploy it
    (site deploys: `vercel --prod`; relay deploys: `fly deploy --ha=false` from `relay/`).
  Both sides sync through git. Pull before starting work.

## Layout
- `src/main.js` map setup, marker layers, sidebar UI · `src/crs.js` game-coord CRS (lat=z, lng=x, 180° rotation)
- `src/roadmap.js` Google-Maps-style vector layer from tarkov.dev's SVG · `src/labels.js` place labels
- `src/live.js` live positions (WebSocket to relay, multi-code arrows/trails) · `src/icons.js` marker glyphs
- `src/api.js` tarkov.dev GraphQL (live) with fallback to `public/data/customs.json`
- `scripts/build-community-data.mjs` builds `public/data/customs.json` from SPT server DB + EFT Wiki
  (used because the tarkov.dev API was down; calibration pairs inside)
- `relay/server.mjs` WebSocket relay, rooms keyed by 6-char pairing code (`/pub/CODE`, `/sub/CODE`, `POST /pos/CODE`)
  deployed on Fly.io as `tarkovzero-relay` → wss://tarkovzero-relay.fly.dev
- `companion/companion.mjs` game-PC app: watches EFT Screenshots folder → parses position/rotation from
  filename → streams to relay. `--simulate` walks a fake player (no game needed).
- `vite.config.js` dev-only tile cache (`.cache/`, git-ignored) + `/api/graphql` proxy; prod uses assets.tarkov.dev directly.

## Coordinates
Game coords are the single source of truth. Leaflet latLng = [z, x]. Map `coordinateRotation` = 180.
Player heading on screen = yaw + 180 (yaw from the screenshot quaternion, Unity Y-up). **Unverified in-game** —
first real test should confirm the arrow direction.

## Screenshot filename (what the companion parses)
`2026-08-28[21-14]_-136.1, 1.9, 92.3_0.0, -0.4, 0.0, 0.9_11.83 (0).png` → x, y, z then quaternion x, y, z, w.
If the real game's format differs, fix `RE`/`parseScreenshot` in `companion/companion.mjs` and note the real
format here. **Confirmed in-game 2026-08-28** (EFT 1.1.0.1.46911, Customs practice raid):
`2026-08-28[20-58]_651.96, 2.01, 117.51_0.00547, -0.97442, 0.02387, 0.22339_6.83 (0).png` — same layout, 2 decimals
for position, 5 for the quaternion. Position landed correctly; heading is correct with
`yaw = atan2(2(xz+wy), 1-2(x²+y²))` in the companion and the site's `yaw + 180` untouched.
Measured: file write → companion detect 92–180 ms (relay adds a few ms).

## Game laptop facts (observed 2026-08-28, EFT 1.1.0.1.46911, Steam build)
- EFT is the **Steam** version: `C:\Program Files (x86)\Steam\steamapps\common\Escape from Tarkov\build\`.
  Logs are at `build\Logs\log_<date>_<ver>\<ver> {application,backend,output,push-notifications,...}_000.log`
  — **not** `%LOCALAPPDATA%\Battlestate Games\EFT\Logs` (that only holds the BSG launcher on a Steam install).
  Unity `Player.log` lives in `%LOCALAPPDATA%Low\Battlestate Games\EscapeFromTarkov\`.
- Documents is not OneDrive-redirected on this machine; screenshots go to
  `C:\Users\REDACTED\Documents\Escape from Tarkov\Screenshots` (folder is created by EFT on the first screenshot).
- Screenshot key binding is in the application log's settings dump: `"keyName":"MakeScreenshot","variants":[{"keyCode":["SysReq"]}`. Companion reads it for `--auto`.
  **Gotcha:** on Windows 11 PrintScreen is eaten by Snipping Tool / the desktop capture before EFT sees it, even
  with `PrintScreenKeyForSnippingEnabled=0` — EFT writes nothing. Fix: rebind EFT Settings → Controls → Screenshot
  to **F11** (F12 is Steam's). The user's game is now bound to F11.
- Map detection: every raid load logs `scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset`
  (and `[Transit] ... Locations:bigmap -> ...`) in `application_*.log` — works for solo/practice raids; companion
  takes the last `rcid:<id>.scenespreset`. Fallback: `"location": "<id>"` in `push-notifications_*.log`
  (`groupMatchRaidSettings`, group raids only), then `customs`. Raw ids: `bigmap`=customs, `factory4_day/night`,
  `Woods`, `Shoreline`, `Interchange`, `RezervBase`, `Lighthouse`, `TarkovStreets`, `laboratory`, `Sandbox(_high)`.
- Relay caches the last position per code for late joiners: a stale/simulated position sent under a code earlier
  shows up as the trail's first point when the site connects. Not a site bug; "Clear trails" removes it.
- Run the companion with Windows node (`node.exe companion.mjs` from WSL works); it polls the folder (250 ms)
  because `fs.watch` never fires on `/mnt/c`.

## Credits / constraints
Tiles, SVG, labels, coordinate transform: tarkov.dev (the-hideout) — keep the credit in the UI.
Auto-pressing the screenshot key (`--auto`) is input automation — off by default, user's choice.

## Commits
Use conventional short messages; co-author trailer as configured by the harness. Keep `companion.json` (contains the
pairing code) and `.env.local` out of git (already ignored).

## 3D view (beta, deck.gl) — status 2026-08-29
- `scripts/build-3d.mjs` → `public/data/customs-3d.json` (SVG footprints → game coords; heights seeded from tarkov.dev floor extents; 79 buildings, 14 multi-floor).
- `src/map3d.js`: deck.gl OrbitView (perspective, fovy 22, pitch 50), SolidPolygonLayer extrusions with LightingEffect+shadow, PathLayer roads, IconLayer markers from a canvas atlas, TextLayer labels, live players at true height with drop-line + trail. Toggle button next to the map title; `?view=3d`; choice persisted.
- Verified in headless (swiftshader): geometry/roads/trees/labels render, view sync 2D↔3D. NOT verified: marker icons visible (isolated tests pass, in-app they did not show under swiftshader), sharpness at higher zoom (in-app frames looked upscaled although deck reported correct canvas size). Check on a real GPU browser first before debugging further.
- Fidelity pass (2026-08-29): bridges auto-derived (road/rail × river polygons, dedupe, no dirt) with ramps/piers/rails; floor separator lines; ground-contact shade rings; landmark colours + roof colours + building styles (`PLACE_COLORS`, `ROOF_COLORS`, `PLACE_STYLE` in scripts/build-3d.mjs: box | gable | frame | canopy | tank); true-to-scale terrain grid (20 m, IDW over SPT ground spawn points from `scripts/spt-bigmap-base.json`, rooftop/sniper points excluded) with everything draped via `H(x,z)` / `Pg()` in src/map3d.js; building bases sit at centroid terrain height. Player arrows use real game y (never below terrain).
- Icons/labels use `parameters: {depthCompare:'always', depthWriteEnabled:false}` so they draw over geometry; icon atlas anchors at bottom edge.
- Fidelity pass 2 (2026-08-29): props in `data/customs-props.json` (hand-traced from satellite at zoom 5: screen→game = x = cx − (px−820)/7.65, z = cz + (py−450)/7.65 for a 1400×900 window), lattice pylons + cables, road casings (roads were invisible white-on-white in 3D), flat roads cut under bridge decks, fences 1.9 m with gaps at road crossings, subtle rails, floor selector (sidebar, 3D only; caps wall heights, highlights underground), label collision + white badges for major place names.
- Roads (2026-08-29): tarkov.dev SVG roads are incomplete (no yard/service lanes) and its 'small' class mixes paved yard roads with forest trails. `data/customs-roads.json` adds hand-traced roads (fixed class); build reclassifies non-fixed 'small' roads as tracks unless they serve an industrial yard. Check with `http://localhost:5173/?base=satellite&debug=roads` (overlay legend in the sidebar). The SVG flattener had an `s`/`S` reflection bug (fixed) — if roads ever look like straight chords again, suspect the flattener first. Codex (`codex exec -i img... < prompt`) was used to judge overlays vs satellite; report in scratchpad `codex-report.md` (not committed).
- Visual rework (2026-08-29, ultracode design panel + Codex second judge): dark-green hypsometric terrain (HYPSO bands in map3d.js), cliff skirt + void beyond the limit, Barlow Condensed labels with ring/stem/cap pings, new marker glyphs (icons.js) with lettered extract badges (EXTRACT_LETTER), roads grey-olive. deck.gl TextLayer gotchas (deck 9.3): CollisionFilterExtension + sizeUnits 'pixels' hides all text; getAlignmentBaseline breaks rendering; a webfont must be loaded before the atlas is built — we switch fontFamily once document.fonts confirms it (LABEL_FONT()). Labels are thinned by zoom instead of the collision extension. Terrain is TRUE scale (user decision) despite the spec suggesting 2x.
- Codex plugin installed: `codex@openai-codex` (OpenAI official) — /codex:review, /codex:adversarial-review, /codex:rescue. CLI judging still works: `codex exec --skip-git-repo-check -s read-only -i img.png < prompt.txt`.
- Night rework (2026-08-29, opus design panel → implementers): `src/terrain.js` renders the ground as one SimpleMeshLayer (2.5 m mesh, bicubic sampler assigned to map3d's `H`, baked 2048×1110 texture: hypsometry + hillshade + noise + contours; skirt into the void). Site UI rewritten (left rail: header with 2D/3D segmented control, status strip, Find (Ctrl+K), grouped filters, View (base/floors/labels), collapsible Live, HUD zoom/compass/fit, mobile bottom sheet). Building personality via `detailParts()` in map3d.js (plinths, window bands, parapets, doors, roof clutter, per-style recipes). 3D extract names next to badges. Palette/type tokens in style.css `:root`. Codex second-judge report: scratchpad `codex-report3.md`.
- Maps phase: Codex (GPT-5.6-Sol) builds Reserve + Woods on branch `codex/maps` (worktree ~/tarkovzero-codex) from `docs/MAP-BUILD-PLAYBOOK.md`; plans/progress under `docs/plans/`. Review + merge, don't redo.
- Multi-map (2026-08-29, built by Codex GPT-5.6-Sol): registry in `src/mapdata.js` (`MAPS`, `selectMap`), `?map=customs|reserve|woods`, header title = map picker; per-map data `public/data/<map>.json` + `<map>-3d.json`, `data/<map>-props.json`, `<map>-roads.json`; builders take a map key (`node scripts/build-3d.mjs reserve`). Plans/reports: `docs/plans/` (MULTIMAP, reserve, woods, PROGRESS, REVIEW-1). Customs outputs are a byte-identical regression gate (sha256 in PROGRESS.md). Open playtest questions are listed at the end of PROGRESS.md.
- Terrain realism (2026-08-29, Codex fix passes 3–4): heightfield built from samples via `scripts/ingest-elevation.mjs` (SPT spawns + loose-loot positions extracted from the official SPT 4.1.2 release archive + companion `elevation-<map>.jsonl` survey logs; see `docs/plans/ELEVATION.md`), 5 m multi-scale fit, outlier rejection; `TERRAIN_FEATURES` only as sparse-area fallback. Canopy blocks replaced by individual tree crowns (muted, ≥3 m off roads/footprints); Nature toggles (Trees/Rocks, `?trees=0`, `?rocks=0`) in the View section. Marker `level` field (surface/underground/upper) with UNDERGROUND badges/labels. Customs data now changes legitimately per pass — hashes in PROGRESS.md.

## Quest layer (2026-08-29)
- Data: `scripts/build-quests.mjs` → `public/data/quests.json` (517 quests / 1457 objectives / 475 zones, ~750 KB).
  Inputs (all under `scripts/data/tasks/`, git-ignored, auto-fetched when missing):
  `tasks-mirror.json` (from `scripts/crawl-tasks-mirror.mjs` — tarkov.dev `Task` objects scraped off the
  tarkov.muedsa.com mirror because api.tarkov.dev is still 422/down; names + descriptions are **Chinese** there,
  but ids, types, maps and objective **zones with game coordinates** are language-independent),
  `spt-en.json` (SPT server English locale: `<taskId> name`, `<objectiveId>`, `<itemId> Name`, `<traderId> Nickname`),
  `spt-quests.json`, plus `public/data/quest-images.json` (wiki screenshots, built by `scripts/fetch-quest-images.mjs`).
  Re-run `npm run build-quests` after the images file grows.
- English coverage: 464/517 task names and 1219/1457 objective lines come from the SPT locale; the rest are
  synthesised from the structured fields (`synthText()`), and identical synthesised rows inside one quest get
  numbered "(n of m)". No Chinese survives into quests.json (asserted at build).
- Zones: `position` is the centre, `outline` the ground rectangle. tarkov.dev ships a few stale/doubled outlines
  (Woods `bunker1`), so an outline is dropped when its centroid is >40 m from the position. `level`
  (surface/underground/upper) is derived by sampling `<map>-3d.json`'s heightfield against the zone's y.
- UI: `src/quests.js` (rail panel: search → select → objective checklist; 2D Leaflet layer; the shared card),
  `#quest-block` in index.html, `.q*` styles at the end of style.css. Selection order picks the quest colour
  (`QUEST_COLORS`); badges number the quest's points 1..N so "mark 3 tankers" reads 1,2,3. Coincident pins
  (two objectives in one room) are fanned 2.6 m apart for **drawing only** — `position` stays exact.
- Icon: `quest-objective` in `icons.js` — a **hexagon** badge (new `shape:'hex'`), glyph `flag-objective` by
  Delapouite (game-icons.net, CC BY; credit is in the rail footer). Quest colour lives on the ring, not the badge,
  so 3D can reuse one atlas entry per number (`quest-objective:1..12`, built in map3d's `atlasEntries`).
- 3D: `questLayers()` in map3d.js — `quest-zone-fill`/`quest-zone-line` (draped, dashed), `quest-ring`,
  `quest-markers` (IconLayer, pickable → `src.onQuestClick`). Deck has no popups, so the photo card is an HTML
  element (`#quest-card`) positioned each frame from the new `api.project(x, z)` (viewport.project of `Pg()`).
- State: `?quest=slug1,slug2` + localStorage (`tz:quests`, `tz:questDone`, `tz:questsVisible`, `tz:questsOpen`).
  "Quest objectives" is its own toggle row, hidden until a quest is selected. Keyboard: **Q** opens the panel.
- AI hook: `window.tz.quests.{select,deselect,toggle,markObjective,flyTo,points,selected,all,setVisible,open}`
  plus `window.tz.{map,view,setView,flyTo}`.

## Active quests from the game (companion + relay half, 2026-08-29)
Spec: `docs/plans/ACTIVE-QUESTS.md`. The site half (`src/quests.js` "My quests" + auto-select on `map`) is
**not built yet** — the ids are already on the wire.
- `companion/quests.mjs`: parses `build\Logs\log_*\* push-notifications_000.log` (`Got notification |
  ChatMessageReceived` header + pretty-printed JSON; `message.type` 10 started / 11 failed / 12 finished, 14
  = reward mail, ignored). Task id = first token of `templateId`; ids missing from `public/data/quests.json`
  go to `unknown` and are never published. There is no "current quests" snapshot in the game, so the active
  set is a **replay** of every `log_*` session oldest→newest in `dt` order (file order only breaks ties),
  deduped on `message._id`.
- State + cursor in `companion/companion-quests.json` (git-ignored, next to `companion.json`): `{accountId,
  profileId, cursor:{file,offset}, active, done, failed, unknown, seen, since, ts}`. A restart resumes from
  the cursor; an `AccountId`/`ProfileId` change (from `application_000.log`'s
  `PrepareSelectedProfileLocally ProfileId:<hex> AccountId:<digits>`) wipes the reconstruction and replays
  only the current session. `--reset-quests` forces that by hand, `--no-quests` disables the feature.
- Transport: companion `POST <relay http>/quests/CODE` `{active,done,failed,accountId,ts,since}` on change
  and on every (re)connect; relay caches it per room like the last position and forwards it to `/sub/CODE`
  (and to late joiners) as **`{type:'quests', …, code, t}`**. The plan doc says `t:'quests'` — that field is
  already the relay's timestamp on every message, so the discriminator is `type`, like `pos`/`map`/`status`.
- Tests: `npm run test:quests` (`node --test`, no deps) against `companion/test/fixtures/` — three synthetic
  log sessions in the game's exact format (one CRLF), ids taken from quests.json plus one id the real logs
  carry that quests.json does not.
- Known gap: EFT rotates old log folders, so quests started before the oldest kept log are missing from the
  replay — hence `since` in the payload and the manual add/remove the site must keep.
