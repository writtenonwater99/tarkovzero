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
  `C:\Users\zeque\Documents\Escape from Tarkov\Screenshots` (folder is created by EFT on the first screenshot).
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
- Icons/labels use `parameters: {depthCompare:'always', depthWriteEnabled:false}` so they draw over geometry; icon atlas anchors at bottom edge.
