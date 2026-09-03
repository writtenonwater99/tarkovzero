# Continuation handoff — 2026-09-03

You are picking up TarkovZero cold. Read this before touching anything. It **supersedes**
`docs/CONTINUATION-HANDOFF-2026-09-02.md`, which is now historical — its §3 table in particular is
wrong (it says production draws the public heightfield; production draws the exact terrain).

Two things in this document matter more than the status list:

- **§7 — how this project fails.** The same failure mode has now appeared eight times. It will come
  for you too.
- **§4 — the boundary.** It is the only part of this repo where a mistake is a legal problem for the
  founder rather than a rendering bug, and it has known, stated limits.

---

## 1. Where the work lives

| | |
|---|---|
| Live | **https://tarkovzero.com** — public, no password |
| Repo | `writtenonwater99/tarkovzero` |
| Branch that is TRUTH | **`work/customs-2026-09-02`** (pushed) — plus the 2026-09-03 commit on top |
| `main` | **Diverges from `origin/main`** after a force-push during the 2026-09-01 session (237 ours / 206 theirs, mostly identical content under different SHAs). NOT reconciled — the founder's call. Do not force-push it. |
| Git integration | **LIVE.** A push to `main` auto-deploys to production. A push to any other branch builds a Preview. `vercel --prod` deploys the WORKING TREE, not a git ref. |

Customs is the only map the site opens. Reserve and Woods are built but **deliberately locked** (§5).

---

## 2. What this is

A Google-Maps-style interactive Escape from Tarkov map. Personal project, not a revenue lane — the
founder has said so explicitly. It is also *his* project: he plays the game, he owns the install, and
**his eyes and his raids are the only evidence source here that is independent of everything else.**

Two renderers:
- **Three.js** (`src/map3d-three.js`) — **the default for Customs since 2026-09-02.** All realism work
  lives here: authored buildings, bridges, exact terrain, authored vegetation, walls, gates.
- **deck.gl** (`src/map3d.js`) — served production for months. Still one URL away: **`?renderer=deck`**
  (case-insensitive). Reserve and Woods always use it. e2e steps 1–10 walk it so it cannot rot.

Consequence to know: **the map switcher is also a renderer switcher.** Leaving Customs drops you to
deck.gl; returning brings Three back.

---

## 3. What ships vs what stays local

| | production | localhost |
|---|---|---|
| terrain | **exact tiles — PROMOTED**, 8 surfaces, 10.7 MiB | identical bytes from `.local-game-derived/` |
| vegetation | **31 authored families, 8,805 placements — PROMOTED**, 41 MiB | identical |
| buildings / bridges / walls / PBR / Fortress | ships | same |
| the 460 MB scalar facts dump | **never** | local only |
| 65 in-game survey photographs | **never** | local only |

On 2026-09-02 the founder ruled that the local packages contain no extracted game assets — *"we took
measurements and designed"* — and approved promoting the authored outputs. That is what the promotion
road in §4 exists to carry. **Raw captures never move.**

Payload, measured: dist ≈ 111 MB (was 55). Terrain cost **+226 ms** to first frame. Vegetation cost
**nothing measurable** — its mount is `void mountAuthoredVegetation()`, never awaited, so only the
manifest + placement table (480 KB) are on the critical path.

Two reductions available, neither done: gzip on the wire (43 MB → 19.8 MB; Vercel does not compress
`application/octet-stream`), and dropping the offline mip chains (−6.7 MB, no visual change — the
loader uploads level 0 only).

---

## 4. The boundary — read this fully before promoting anything

Four independent layers, documented in `src/renderer-gate.js`'s header. Three questions, kept separate
on purpose and each its own function:

- **(a) may Three run?** — product question. Yes, Customs, now by default.
- **(b) may local game-derived data load?** — `canLoadLocalGameDerivedAssets()`, **dev AND loopback**,
  unchanged all day. Still governs the facts dump, the raw Unity vegetation dumps and the bridge
  corrections.
- **(c) may diagnostic readouts paint?** — `canShowDiagnosticReadouts()`, dev + loopback. Added
  2026-09-03 so the build banners come off the live page. **A source-pinned test refuses any attempt to
  implement one of these by delegating to another.**

### The promotion road
- `asset-promotion-manifest.json` — the allow-list. 110 entries.
- `scripts/lib/asset-promotion.mjs` — closed enum of promotable sources (a capture root is
  *unnameable*, not merely unlisted), `filePattern` + double traversal refusal, receipt roles pinned by
  the registry, three independent hash bindings.
- `capture-digest-inventory.json` — 74 rows, digests and sizes only, **no payloads**. EFT screenshot
  filenames ARE the position and quaternion, so those rows are stored as `redacted-<digest>.png`;
  committing the real names would publish raid coordinates.
- `npm run promote:terrain` / `npm run promote:vegetation`, both with `--check`.

### Two receipt classes, and they are not interchangeable (asserted)
- **Vegetation: GENERATIVE.** Cites the git-tracked `vegetation_factory.py` + `prototype_catalog.json`.
  Re-running the committed factory regenerates the bytes.
- **Terrain: an integrity seal only.** Its provenance document is an *extractor*. It proves the tool is
  unchanged since approval and nothing more. What authorises it is the founder's ruling, recorded as
  `approvedBy`.

### What the verifier does NOT prove — stated, not hoped
Emitted in every report as `coverage.doesNotProve`, and there is a test named
*"HONEST LIMIT … a RE-ENCODED capture is NOT detected"* that **passes when the leak passes**, so the
limit cannot be quietly forgotten:

> **Authorship** — a promotion is the founder's assertion plus a receipt that the cited documents are
> unchanged. It is not evidence of who authored the bytes.
> **A transformed or re-encoded capture** — any re-save, resample or repack changes the digest and
> every hash check goes quiet. No heuristic is attempted, deliberately.

**We ship one of those knowingly.** `veg-placements.bin` (8,805 rows: position, rotation, scale,
colour) is a *derived scalar extract* of `terrain-NNN-vegetation.json`, which is a registered raw
capture. Round-trip verified bit-exact, ~40% of the capture's content dropped. The pipeline is the
control: one documented script, and the public manifest states geometry / textures / placements as
three separate provenance blocks. Anyone touching this must know it is there.

### A hole that was real, and is closed
`verify:build-boundary` used to build its capture index by WALKING the local roots. **Vercel builds
from a clean checkout where those roots are absent**, so on the deployment that matters the index was
empty. Measured at commit `58f7fd8`: a 5.2 MB survey photograph copied byte-identically into `dist/`
gave `"pass": true`, exit 0. The committed inventory closes it; missing or malformed is a build
failure, never a skipped check.

---

## 5. Maps: eleven listed, one open

`src/map-availability.js` is the **single availability source**. `EFT_MAPS` (all eleven),
`AVAILABLE_MAP_KEYS = ['customs']`, `LOCKED_MAP_KEYS` **derived**, and — kept separate on purpose —
`MAPPED_MAP_KEYS` (`customs, reserve, woods`: maps we have render data for, which is *not* an
availability statement).

`src/assistant-contract.js` does `export const SITE_MAPS = AVAILABLE_MAP_KEYS` — the **same frozen
array**, asserted by identity, so a copy that could drift fails the build. The picker, the omnibox
`> map` row and `scripts/build-quests.mjs` all read it too.

**Unlocking a map is one line**: add its key to `AVAILABLE_MAP_KEYS`. No quests.json rebuild.
Reserve and Woods data, labels, tiers and tests are all intact and green.

Locking is enforced end to end: `crossMapFor()` filters through `SITE_MAPS`, so no quest in
quests.json can produce a `switchMap` from Customs (asserted over all 517). The prompt drops the verb
entirely rather than teaching one the server always refuses. `?map=woods` still resolves — it falls
back to Customs and toasts *"Woods is not available yet."*

Known gap, pre-existing: `quests.json` references a twelfth key, `icebreaker`, on 20 quests. It has no
label and is not in `EFT_MAPS`.

---

## 6. What Customs actually took — the order that worked

For when Woods and Reserve come off hold. Fuller version in `docs/MAP-BUILD-PLAYBOOK.md`.

1. **Survey raids first.** The exact terrain and the authored vegetation both trace to the founder's own
   captures. Woods and Reserve have none. **This is the bottleneck — no amount of agent hours
   substitutes for him playing the map.**
2. Geometry before signage. Bridges and buildings, then labels and icons.
3. **The promotion road is built once, not per map.** It exists now.
4. Look at the pixels at a low angle, not just at map zoom. A flat top-down view hid a bridge deck
   folded into a 102% grade, and hid a bridge rendered 14 m underwater.
5. Every metric must be able to fail. See §7.

---

## 7. How this project fails — read this twice

**A system reports success while something has silently fallen back.** Eight instances now. Today's:

6. `renderStats().bridges.local.applied: true`, six decks, eleven piers — all green, and the bridge was
   **14 m underwater and invisible.** The metric could not see a drowned deck. Now there is
   `overWater.submerged` and `minClearanceM`.
7. The partition guard that was supposed to prevent double-built buildings was **vacuous** — an agent
   stamped 30 buildings with one index and every count guard passed.
8. `renderStats().buildings` was a snapshot taken once at mount; it reported 67 skirts / 756 triangles
   permanently while the frame drew 66 / 748.

And the shape that keeps recurring: **a count cannot detect facing, presence or visibility.** 30 plinth
skirts were back-face culled and invisible while the triangle count reported them drawn. It took a
side-aware raycast to see it.

The rule: **when you add an assertion, prove it discriminates.** Mutate the code, watch it go red,
restore. When you report a number, ask what would have to be true for it to be wrong, and whether
anything checks that.

---

## 8. Traps that cost real time

- **`/mnt/c` is drvfs.** `@deck.gl/core` imports in ~197 s from Node. `npm test` takes 10+ minutes.
  None of this is a hang.
- **Vite's watcher never fires on `/mnt/c`.** After ANY edit, restart the dev server — HMR serves stale
  code indefinitely. This has wasted more than one founder review.
- **Never `pkill -f vite`** — it self-matches and has killed the founder's server. Kill by PID, on ports
  you started.
- A real `vite dev` server pegs headless Chromium's main thread for >10 min on `/mnt/c` and hangs CDP
  rather than failing. e2e's dev arm builds a dev-mode bundle instead (~16 s).
- `gpuFrameMs` is **null** under SwiftShader. **No frame-time claim in this repo is backed by
  anything.** Production Customs Three: 1,439 draw calls, 531,436 triangles at the default framing.
- Pre-existing and unattributed: a `glDrawArraysInstancedANGLE: primcount < 0` warning in the 3D view,
  confirmed against a clean build at `e3bed80`.

---

## 9. The local reference boundary (unchanged, still binding)

The founder approved **read-only use on this machine only** of his legitimate Steam EFT install, to
derive sanitized scalar facts. It is not an asset-import licence.

```
C:\Program Files (x86)\Steam\steamapps\common\Escape from Tarkov\build\EscapeFromTarkov_Data
```

Read-only. Never alter it, never add it to Git, never put its absolute path in a build artifact.
Logs under `build/Logs/` are read routinely by the companion and are fine to read; assets are not.

---

## 10. Open items

- **`main` reconciliation** — the founder's decision. Git integration is live, so a push to `main`
  deploys.
- **Woods and Reserve** — on hold by decision, not by blocker. §5 says how to unlock; §6 says what it
  costs.
- **Wire size** — 111 MB dist; gzip and mip-chain reductions available (§3).
- Four label tiers the founder flagged for his own eye: Big Red, Dorms 2-Story, Crackhouse, Storage.
  All four draw at the default framing regardless, so this is a look question, not a visibility one.
- The founder has non-map polishing to discuss next session.
