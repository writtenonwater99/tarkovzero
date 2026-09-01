# TarkovZero

**https://tarkovzero.com** — a Google-Maps-style interactive map for *Escape from Tarkov*: 2D satellite/vector maps and a
true-3D view (terrain, buildings, props, trees), extracts/spawns/loot/stash layers, live player positions streamed from the
game, and (in progress) a quest layer with objective markers and recognition photos.

Maps today: **Customs, Reserve, Woods** (`?map=customs|reserve|woods`).

> **AI agents / new contributors: start with [`docs/AGENT-ONBOARDING.md`](docs/AGENT-ONBOARDING.md).**
> Deep context lives in [`CLAUDE.md`](CLAUDE.md); how a map is built is in [`docs/MAP-BUILD-PLAYBOOK.md`](docs/MAP-BUILD-PLAYBOOK.md);
> per-map plans and the running progress log are in [`docs/plans/`](docs/plans/).

## What's in the box

| Part | Where | Notes |
|---|---|---|
| Site (Vite, vanilla JS) | `index.html`, `src/` | 2D = Leaflet with a game-coordinate CRS; 3D = deck.gl. A Customs-only Three.js renderer proof is available on localhost; see `docs/LOCAL-THREE-POC.md`. |
| Per-map data | `public/data/<map>.json` (markers), `public/data/<map>-3d.json` (geometry/terrain) | generated — never hand-edit |
| Data builders | `scripts/` | `build-community-data.mjs` (extracts/spawns/loot from SPT + EFT Wiki), `build-3d.mjs` (SVG → 3D geometry, terrain, roads, bridges), `ingest-elevation.mjs`, `build-quests.mjs`, `fetch-quest-images.mjs`, `warm-tiles.mjs` |
| Hand-authored inputs | `data/<map>-props.json`, `data/<map>-roads.json`, tables inside `scripts/build-3d.mjs` | traced from the satellite render |
| Live position | `companion/` (runs on the game PC), `relay/` (WebSocket rooms, Fly.io) | pairing code → `?live=CODE` or the Live panel |
| AI quest assistant | `api/assistant.js` (Vercel function), `src/assistant.js` (Ask panel) | DeepSeek, grounded on `quests.json`; returns actions the site runs through `window.tz` |
| Docs | `docs/` | playbook, plans, progress, onboarding; machine setup notes in `docs/setup/` (e.g. LAN Mouse KVM between the two laptops) |

## Run it

```sh
npm install
npm run dev            # http://localhost:5173  (dev server caches tarkov.dev tiles under .cache/)
npm run build && npm run preview   # production build on :4173 (what headless screenshots use)
vercel dev --listen 3000           # optional, in a second shell: serves /api/assistant (the AI Ask panel); npm run dev proxies to it
```

The Ask panel needs `DEEPSEEK_API_KEY` in the Vercel project env (`vercel env pull .env.local` to use it locally — the key
is never bundled into the client). Offline checks for the retrieval/parsing logic: `node scripts/test-assistant.mjs`.

Useful URLs: `?view=3d`, `?map=woods`, `?live=CODE`, `?base=satellite&debug=roads` (road overlay check),
`?relief=1|2|3`, `?trees=0`, `?floor=U`, `?quest=<slug>` (quest layer). On the Vite localhost
development server only, `?map=customs&view=3d&renderer=three` opens the renderer proof. That proof
has no atmospheric fog and is fixed at 2× terrain relief; query, storage, and UI cannot change it.

Data regeneration (all deterministic; commit outputs):

```sh
node scripts/build-community-data.mjs customs   # markers/loot from SPT + wiki (calibrated)
node scripts/build-3d.mjs customs               # geometry + terrain (+ reserve | woods)
node scripts/build-quests.mjs                   # quests.json from the task snapshot + SPT locales
npm run audit:customs                           # independent gate; nonzero until real held-out evidence passes
```

Deploy: `vercel --prod` from the repo root (site, Vercel) · `fly deploy --ha=false` from `relay/` (relay, Fly.io).

## Data sources & credits

Tiles, hand-drawn SVG maps, labels and floor extents: **tarkov.dev / the-hideout** (CC BY-NC-SA). Spawns, bosses, loose-loot
positions, quest structure and English locales: **SPT** server database. Extracts, locks, guns, stashes/containers, quest
recognition photos: **EFT Wiki** (Fandom) interactive maps and quest pages. Icons: **game-icons.net** (CC BY 3.0).
Task objectives/zones: tarkov.dev's task data (via a mirror while their API is down). No BSG game files are used (ToS).

## Status (2026-08-31)

Live product behavior remains multi-map Leaflet/deck.gl. Canonical elevation now displays at 1× by default;
2×/3× are explicit analysis exaggerations. The current local work is intentionally Customs-only: exact-source
rebuild inputs, typed ground/road/deck/water/rock/floor/roof/underground evidence, an independent held-out
accuracy harness, and a localhost Three.js renderer seam for audited GLB/KTX2 assets. Customs is **not accuracy
certified yet**: the executable audit fails until real first-party train and held-out survey observations exist.
Reserve and Woods remain unchanged until Customs passes the standard.
