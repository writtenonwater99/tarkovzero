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

## 4. How work is split (as of 2026-08-29)

- **Site features** (UI, layers, live position, quest layer, assistant): Claude (Fable) orchestrating, Opus/Sonnet subagents implementing.
- **Map data & 3D world for each map** (terrain, buildings, roads, water, props, limits, per-map fixes): **Codex (GPT-5.6-Sol)**
  in the worktree `../tarkovzero-codex` on branch `codex/maps`, one "fix pass" at a time; the orchestrator commits on its behalf
  (its sandbox cannot write worktree metadata), merges to `main`, deploys. Briefs and outcomes: `docs/plans/PROGRESS.md`.
- **Game PC** (companion app, real-raid testing): a separate Claude session on the Windows laptop (`docs/GAME-LAPTOP-PROMPT.md`).
- The user reviews on a real GPU and sends terse feedback; prioritise exactly what they name.

## 5. Current state and open work

Done: multi-map 2D/3D; real terrain from SPT spawns + loose-loot + survey logs; 3× relief default; baked roads; trees/rocks
toggles; buildings with detail recipes; props; extracts with `level` (underground) tags and letter badges; loot/stashes;
labels with beam pings; game-icons art; live vision-cone marker; new UI rail (Find, filters, view controls, mobile sheet).

In flight / backlog (highest value first):
1. Flat water with carved riverbeds at any relief (Codex pass 8).
2. Playable-limit expansion so every marker (e.g. Customs Dorms V-Ex) sits on terrain; smooth boundary edge (Codex pass 9 brief in scratch).
3. Quest layer: `scripts/build-quests.mjs` → `public/data/quests.json`; Quests panel; numbered objective markers + zone outlines;
   photo card from `public/data/quest-images.json` (wiki); `?quest=`; `window.tz.quests` API.
4. DeepSeek assistant: Vercel function grounded on `quests.json` + wiki text, returning map actions (needs a key in Vercel env).
5. Spawn clustering with counts; 2D label collision; Reserve wiki-panel locks (detached underground panels).
6. More maps (Shoreline, Interchange, Lighthouse, Streets…) via the playbook; each needs playtest facts (real crossings, dirt vs paved).

## 6. Ready-to-paste prompt for a fresh session

> You are continuing TarkovZero (https://github.com/writtenonwater99/tarkovzero, live at https://tarkovzero.com). Clone it,
> read `docs/AGENT-ONBOARDING.md`, `README.md`, `CLAUDE.md`, `docs/MAP-BUILD-PLAYBOOK.md`, and `docs/plans/PROGRESS.md` (its
> last "Fix pass" section is the newest state). Respect the non-negotiables in the onboarding doc. Run `npm install && npm run
> build` and take a headless screenshot as described to confirm your environment. Then work on: <task>. Verify with build +
> screenshots, keep Customs data deterministic, commit with clear messages, and do not deploy unless told.
