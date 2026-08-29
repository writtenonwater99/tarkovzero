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
| Site (Vite, vanilla JS) | `index.html`, `src/` | 2D = Leaflet with a game-coordinate CRS; 3D = deck.gl (`src/map3d.js`, `src/terrain.js`, `src/trees.js`, `src/water.js`) |
| Per-map data | `public/data/<map>.json` (markers), `public/data/<map>-3d.json` (geometry/terrain) | generated — never hand-edit |
| Data builders | `scripts/` | `build-community-data.mjs` (extracts/spawns/loot from SPT + EFT Wiki), `build-3d.mjs` (SVG → 3D geometry, terrain, roads, bridges), `ingest-elevation.mjs`, `build-quests.mjs`, `fetch-quest-images.mjs`, `warm-tiles.mjs` |
| Hand-authored inputs | `data/<map>-props.json`, `data/<map>-roads.json`, tables inside `scripts/build-3d.mjs` | traced from the satellite render |
| Live position | `companion/` (runs on the game PC), `relay/` (WebSocket rooms, Fly.io) | pairing code → `?live=CODE` or the Live panel |
| Docs | `docs/` | playbook, plans, progress, onboarding |

## Run it

```sh
npm install
npm run dev            # http://localhost:5173  (dev server caches tarkov.dev tiles under .cache/)
npm run build && npm run preview   # production build on :4173 (what headless screenshots use)
```

Useful URLs: `?view=3d`, `?map=woods`, `?live=CODE`, `?base=satellite&debug=roads` (road overlay check),
`?relief=1|2|3`, `?trees=0`, `?floor=U`, `?quest=<slug>` (quest layer).

Data regeneration (all deterministic; commit outputs):

```sh
node scripts/build-community-data.mjs customs   # markers/loot from SPT + wiki (calibrated)
node scripts/build-3d.mjs customs               # geometry + terrain (+ reserve | woods)
node scripts/build-quests.mjs                   # quests.json from the task snapshot + SPT locales
```

Deploy: `vercel --prod` from the repo root (site, Vercel) · `fly deploy --ha=false` from `relay/` (relay, Fly.io).

## Data sources & credits

Tiles, hand-drawn SVG maps, labels and floor extents: **tarkov.dev / the-hideout** (CC BY-NC-SA). Spawns, bosses, loose-loot
positions, quest structure and English locales: **SPT** server database. Extracts, locks, guns, stashes/containers, quest
recognition photos: **EFT Wiki** (Fandom) interactive maps and quest pages. Icons: **game-icons.net** (CC BY 3.0).
Task objectives/zones: tarkov.dev's task data (via a mirror while their API is down). No BSG game files are used (ToS).

## Status (2026-08-29)

Live: multi-map 2D/3D, real terrain from thousands of ground samples (3× relief by default), building personality,
props, roads baked into the ground, trees/rocks toggles, extracts with underground tagging, spawns/bosses, loot and stashes,
live player vision-cone marker + companion app. In progress: flat water with riverbeds (Codex), playable-limit expansion,
quest layer with objective photos, DeepSeek assistant. Open playtest questions: end of `docs/plans/PROGRESS.md`.
