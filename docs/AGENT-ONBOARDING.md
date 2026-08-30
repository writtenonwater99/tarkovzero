# AI agent onboarding — start here

You are picking up **TarkovZero** (https://tarkovzero.com) cold. This page gets you productive in ten minutes and tells you
how work is done here. Read in this order: this file → `README.md` → `CLAUDE.md` (deep log of decisions and gotchas) →
`docs/MAP-BUILD-PLAYBOOK.md` (how a map is built) → `docs/plans/PROGRESS.md` (what Codex built for Reserve/Woods and
what's open).

## 1. What the product is

An interactive Tarkov map that should feel like a real map, not a PNG: 2D (Leaflet, satellite + vector) and 3D (deck.gl:
terrain mesh, buildings with identity, props, trees, water, cliffs at the playable limit), with toggleable layers —
extracts (with underground tags and letter badges), spawns, bosses, loot/stashes, locks, switches — place labels with
light-beam pings, live player positions streamed from the game (companion app → Fly relay → site), and a quest layer
(objective markers/zones + recognition photos). Three maps: Customs, Reserve, Woods.

## 2. Non-negotiables

- **Game coordinates are the single source of truth.** Leaflet latLng = `[z, x]`; deck cartesian = `[-x, -z, y]`;
  everything drapes on `H(x, z)` (terrain sampler). See playbook §1 before touching anything positional.
- **Terrain is true scale**; the *view* applies a relief factor (1×/2×/3×, default 3×) once at the sampler. Object heights stay real.
- **No BSG game files** (ToS). Sources: tarkov.dev assets, SPT database, EFT Wiki, our own screenshots. Keep credits in the footer.
- **Never hand-edit `public/data/*.json`** — regenerate with the scripts; builders must stay deterministic.
- **Customs is the regression gate**: shared-pipeline changes must keep Customs output identical unless the change is intended
  (record the sha256 in `docs/plans/PROGRESS.md`).
- deck.gl 9.3 TextLayer traps (all real, all cost hours): no `CollisionFilterExtension` with pixel sizing; never
  `getAlignmentBaseline`; build the font atlas only after the webfont is loaded (`LABEL_FONT()` switch). Icons go through a
  canvas atlas (`buildAtlas`), anchored at the bottom; overlay layers use `parameters: {depthCompare:'always', depthWriteEnabled:false}`.

## 3. How to verify anything (do this constantly)

```sh
npm run build && (npx vite preview --port 4173 &)      # production build
# headless screenshot (software GL: over-zoomed & blurry — judge structure/colour, NOT sharpness or scale)
chromium --headless=new --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --ignore-gpu-blocklist --window-size=1400,900 --timeout=30000 --screenshot=out.png \
  "http://localhost:4173/?map=customs&view=3d#2.4/-70/10"      # hash = zoom/x/z in game coords
```
Retry a black 3D frame 2–4×; it is a swiftshader flake, not a bug. Road accuracy: `?base=satellite&debug=roads`.
Independent judge: `codex exec --skip-git-repo-check -s read-only -i shot.png < prompt.txt`.
Real-GPU truth comes from the user's browser — ask for a screenshot when it matters.

## 4. How work is done (as of 2026-08-30)

- **One machine**: the Windows game laptop (WSL2) owns everything — site, relay, companion, deploys (the Linux
  laptop died 2026-08-29; `docs/setup/LAN-MOUSE.md` is historical). Deploys: `vercel --prod` (explicit team scope)
  and `fly deploy --ha=false` from `relay/`.
- Big pushes have been done by an orchestrator fanning out builder/reviewer subagents; every substantial change
  goes through an adversarial review (findings verified by independent skeptics before fixing). Solo agents are
  fine for focused fixes — keep the verification habits either way.
- **The founder reviews on a real GPU and sends terse feedback; prioritise exactly what they name.** Visual work
  is judged against the current live site on real hardware, never against a plan or headless captures — nothing
  ships that looks worse than what is live, and every rendering effect must pay for its GPU cost visibly.

## 5. Current state and open work

Shipped to prod 2026-08-30 (merge `36b37d6`): the **UI v2 shell** (edge-to-edge map, floating chips, right
toolbar with dockable panels — manual pin wins; bottom-centre omnibox: no prefix = lookup, `>` = commands,
`?` = AI; DeepSeek assistant card with map actions), 3D default view with an oblique camera that can never go
under the map, marker LOD + spawn clustering, live position with heading marker + state machine, the quest layer
plus **active quests streamed from the player's own game logs** (companion → relay `POST /quests/CODE` → "My
quests" + auto-select + assistant grounding; spec `docs/plans/ACTIVE-QUESTS.md`), exact tarkov.dev map data with
elevation buckets (Woods' 77 m mountain is real), and two looks: **Vector (default, zero render overhead)** and
Real (R1.5: fog/grade/detail, each individually toggleable via `?fx=`). Tests: `npm test` (12 suites),
`npm run e2e` (9-step walkthrough). Headless capture trap: plain `--screenshot` hangs on deck.gl's rAF loop —
use a CDP driver, fresh profile per shot, explicit `&view=` (the view persists in localStorage).

Backlog (highest value first):
1. Real-raid validation of quest streaming (fixtures + simulate only so far) — first raid with the companion running.
2. Visual defects skipped in the last QA (lane-F report): label beams punch through roofs, Woods Mountain Spine
   blown out in Real, missing objective thumbnails, Reserve terrain spur, close-zoom fidelity at `#5`.
3. Realism R2+ (`docs/plans/RENDER-REALISM.md`): terrain splats, instanced glTF vegetation, building materials —
   only with real assets; tint-and-fog realism was tried and rejected by the founder.
4. Woods 3D first paint: ~15 s of synchronous `buildTerrain` on the main thread (founder: performance later).
5. Survey-dependent 3D fidelity (`docs/plans/3D-AUDIT.md` ranks): Reserve bunker network, Customs industrial east,
   road profiles — needs founder raid-hours with the companion's elevation logging.
6. More maps (Shoreline, Interchange, Lighthouse, Streets…) via `docs/MAP-BUILD-PLAYBOOK.md`.

## 6. Ready-to-paste prompt for a fresh session

> You are continuing TarkovZero (https://github.com/writtenonwater99/tarkovzero, live at https://tarkovzero.com). Clone it,
> read `docs/AGENT-ONBOARDING.md`, `README.md`, `CLAUDE.md` (deep log of decisions and gotchas — long, read all of it),
> `docs/MAP-BUILD-PLAYBOOK.md`, `docs/plans/PROGRESS.md` (its last "Fix pass" section is the newest data-pipeline state),
> and `docs/plans/UI-REWORK.md` + `docs/plans/ACTIVE-QUESTS.md` for the current UI and quest architecture. Respect the
> non-negotiables in the onboarding doc. Run `npm install && npm test && npm run build` to confirm your environment
> (12 suites must pass). Then work on: <task>. Verify with tests + the e2e walkthrough + screenshots (CDP driver, not
> bare --screenshot), keep Customs data deterministic, commit with clear messages, and do not deploy unless told.
