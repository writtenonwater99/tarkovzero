# Continuation handoff — 2026-09-02

> **START HERE — branch state is not clean, and that is deliberate.**
>
> All of 2026-09-02's work is on **`handoff/2026-09-02`** (tip `076ac86`), pushed and complete. That branch
> is the truth. `work/customs-industrial-truth-2026-09-01` is the same work minus the last two commits.
>
> **`origin/main` was force-pushed to a rewritten history while this session was running** —
> `46263bd…` → `e69f57d…`, same commits by message, different hashes. Local `main` therefore diverges from
> `origin/main` by 237 ours / 206 theirs, almost all of it the same content under different SHAs.
>
> This was NOT resolved, on purpose: rebasing 30 commits or force-pushing unattended, minutes before the
> machine was shut down, is how work gets lost. Nothing is lost — everything is on the remote branch above.
> **The founder should decide how to reconcile `main`.** Do not force-push it for him.
>
> Production is unaffected either way: `vercel --prod` deploys the working tree, not a git ref, and the
> deploy verified green (see §3).

You are picking up TarkovZero cold. Read this before touching anything; it supersedes
`docs/CONTINUATION-HANDOFF-2026-08-31.md`, which is now historical and wrong in several places (noted below).

The single most useful thing in this document is not the status list. It is **§6 — how this project fails**,
because the same failure mode appeared five separate times in one day and it will come for you too.

---

## 1. What this is

A Google-Maps-style interactive Escape from Tarkov map. Live at **tarkovzero.com** (Vercel), repo
`writtenonwater99/tarkovzero`. v1 is Customs, outdoors only. It is a personal project, not a revenue lane —
the founder has said so explicitly. It is also *his* project: he plays the game, he has the install, and
**his eyes and his raids are the only evidence source in this repo that is independent of everything else.**

There are two renderers:

- **deck.gl** (`src/map3d.js`) — the one production served for months. Untouched by the 2026-09 work.
- **Three.js** (`src/map3d-three.js`) — where all realism work lives: authored assets, exact terrain,
  authored vegetation, walls and gates.

Until 2026-09-01 the Three renderer was hard-gated to dev + loopback. It now also runs in production on
`?renderer=three` (Customs only, never the default) — but on a **different data set**. See §3.

---

## 2. The evidence rule that governs everything

Almost every artifact in this repo traces back to **one acquisition layer**:
`extract-customs-unity.py` → `census-customs-assets.py` → every extractor that imports it. The 440 MB
scalar facts dump was produced by it too.

**Therefore: two of this project's "sources" agreeing is not validation. It is one read, reported twice.**
This was discovered the hard way after building a cross-check on exactly that false premise. Do not rebuild
it.

The only genuinely independent evidence ever obtained is **photographs from in-game survey raids** (§5.2).
When something must be *true* rather than *self-consistent*, that is the instrument.

---

## 3. What is live vs what is local-only

| | production (tarkovzero.com) | localhost |
| --- | --- | --- |
| terrain | public heightfield (`public/data/customs-3d.json`, from SPT spawns + loot + survey logs) | exact local tiles from `.local-game-derived/` |
| vegetation | public `data.trees` positions, procedural | 31 authored families, 8,805 exact placements |
| walls / gates | authored geometry (public props + fences) | same |
| terrain PBR, Fortress | shipped | same |

`src/renderer-gate.js` (renamed from `local-renderer-gate.js`) now separates two questions that were
previously conflated:

- **may Three run at all?** → yes in production, Customs, on explicit request
- **may it load local game-derived enhancements?** → dev + loopback ONLY, unchanged

**The boundary is not negotiable and a site password does not relax it.** The founder's local-use approval
"does not authorize shipping, copying, tracing, or redistributing" game-derived payload, and uploading to
Vercel is distribution regardless of who can log in. `npm run verify:build-boundary` runs after every build
across three roots and fails loudly. Do not weaken it; do not move `.local-game-derived/` or
`.local-candidates/` into `public/`.

**The site is behind a password.** `middleware.js` does site-wide HTTP Basic auth against the
`SITE_PASSWORD` env var in the Vercel project, matching `/(.*)` — every path, including assets and
`/api/assistant`. It **fails closed**: unset or empty env var returns 503 rather than serving openly. See
`docs/PASSWORD-PROTECTION.md`. Ask the founder for the credential; it is not in the repo and must never be.

Deployed and verified 2026-09-02: 401 without credentials on `/`, `/data/customs-3d.json`,
`/assets/3d/customs/authored/fortress/fortress-shell-lod2.glb` and `/api/assistant`; 200 with; 401 on a
wrong password; `WWW-Authenticate: Basic realm="tarkovzero"` present.

**`.vercelignore` is load-bearing and must not be deleted.** The build-boundary verifier inspects `dist/`
and structurally cannot see what the CLI *uploads*. Without that file `vercel --prod` uploads 1.23 GB —
including 456 MB of `.local-game-derived/` and 413 MB of `.local-candidates/` — to Vercel's build machines
before the build runs. The Vercel CLI does **not** read `.gitignore`. Watch the file count on every deploy;
it should be in the hundreds, not thousands.

**Known, unfixed, low severity:** `vercel.json` rewrites `/api/graphql` to `api.tarkov.dev`, and a Vercel
external rewrite forwards request headers — so the browser's `Authorization: Basic …` is probably forwarded
to that third party on graphql calls. Unverified. Rotating `SITE_PASSWORD` is trivial; stripping the header
in the middleware before the rewrite is the real fix.

---

## 4. Standing decisions — do not re-open these

Recorded with full cost in **`docs/DECISIONS-2026-09-01.md`**. Summary:

1. **The bounds reader is PARKED.** `scripts/extract-customs-bounds.py` is built, 86 tests, 36 refusal
   reasons, and has **never been run against a game install**. Three review rounds cleared its mechanism
   and kept failing its evidence. Walls therefore stand on `provisional-unmeasured` dimensions —
   a deliberate state, not a TODO.
2. **The Fortress LOD silhouette defect stays pinned, not fixed** (+15.67 mm LOD1, +40.00 mm LOD2). It is
   an admitted asset; fixing costs new digests and a fresh GPU review. A validator pins the escapes and
   fails if the geometry moves in *either* direction.
3. **Two admitted LODs cannot be rebuilt.** `fortress-shell-lod0/lod1` and `zb013-basement-lod0` produce a
   different sha256 every build from unmodified code (TEXCOORD_0 ~1 ULP, TANGENT ~3e-03). Pre-existing.
   Accepted.
4. **Building heights stay as they are.** The founder judged them accurate by eye on 2026-09-01, which
   removes the last dependency on the parked bounds reader.

---

## 5. Where each lane actually stands

### 5.1 Vegetation — done, and the best-verified thing here
31/31 authored families, 8,805/8,805 placements bind, Khronos-clean, byte-reproducible. One array-texture
material instead of 199 → **31 draw calls at the default orbit** (was 57 on the fallback path, 1,333 for the
naive cell-grid design that was never built). Cold mount ~6 s, down from 71.5 s.

Local only. The 8,805 placements are game-derived; production falls back to public tree positions. **That
fallback is correct behaviour, not a bug.**

Deferred by decision: **Stage B atlases** — deletes opaque foliage blobs, raises pine LOD1 552 → 2,712
triangles. Correct in principle; needs a real-GPU frame first.

### 5.2 Industrial rail stock — family identity SETTLED, count NOT
The 2026-08-31 handoff claimed "three closed freight wagons, two tank wagons, one hopper, two 6 m red
containers". **That claim had no artifact behind it and is wrong.** 65 photographs across three practice
raids settled it:

- **Six rail families exist**, not three: closed-freight, tank, hopper, **gondola**, locomotive,
  sliding-door boxcar — plus colour variants as distinct authored assets.
- **Gondolas were never in the handoff's list at all.**
- Containers **ride on gondolas** — they are not independent placements, and counting them separately
  double-counts the visible object.
- The elevated cluster (y ≈ 6.9–7.4) is **real walkable geometry**, not backdrop. Customs has a two-level
  rail yard.

**Count and placement remain unestablished** and no asset has been authored. Do not rewrite either landmark
mapping literal from roster evidence. The nine-proxy plan in
`scripts/customs-industrial-admission-plan.mjs` and `build_proof.py` is disproven; a parity test now fails
if the two copies diverge.

Photos: `.local-candidates/survey-2026-09-01/` (65 files). Method: EFT writes world position and camera
quaternion into the screenshot filename, so every photo is self-geotagged. **Run the companion with
`--keep` or the photos delete themselves 3 s after upload.**

### 5.3 Walls and gates — geometry fixed, dimensions provisional
Fences were `THREE.Line` at a hardcoded 1.9 m — no thickness, no shadow. Now real draped geometry with
gates as first-class openings. The visibility bug was subtle and worth knowing: **a box filter conserves a
mask's mean while an alpha test reads its coverage**, and the sRGB upload pushed the mean (0.4039) under the
threshold (0.42), so chain-link vanished entirely. Coverage-preserving mips fixed it.

`WALL_CLASSES` is the only dimension table and `resolveWallClasses` the only seam, every value marked
`provisional-unmeasured` and surfaced in the hover label. Measurements can land later without touching
geometry code.

### 5.4 Buildings — planned, not started
`docs/plans/BUILDING-MASSING.md` is the plan. The headline finding: of 71 buildings, **one** has a height
that measures anything. 55 are per-group constants. Founder judged them acceptable, so the lane proceeds on
current heights with authored detail.

**Blocker before authoring anything:** `derive_transform()` refuses anything but a quad footprint, which
alone rejects 16 of 71 buildings including 8 of the 12 largest; `CANONICAL` is evaluated at module import;
`load_facts()` asserts `place == 'Crackhouse'`. The factory is still crackhouse-shaped where it counts.

Three factories were consolidated onto `scripts/lib` with **zero output bytes changed** (17/24 byte-identical,
the rest accounted). Five diverged helpers are preserved as **named variants with no default** — do not
"tidy" them into agreement; that is a re-baseline, not a refactor, and tests will fail loudly.

---

## 6. How this project fails — read this twice

**Five times in one day, a system reported success while something had silently fallen back.** Every one was
found by attacking the *evidence*, never the mechanism.

1. A dev route that didn't exist returned **HTTP 200 with `index.html`** (Vite's SPA fallback), so
   `if (!response.ok)` never fired and the app silently used per-primitive materials.
2. `warnings: []` while the **entire** vegetation pack had failed to mount — the function only covered two
   of eleven degraded states.
3. The CUSTOMS TRUTH strip claimed `7,108 AUTHORED VEGETATION` on a run where 0 mounted — plus three more
   lies in the same strip, one of which changed *dynamically* when you flipped to vector.
4. `payloadBytesRead` in the bounds reader summed a set no logged read could ever enter. **Identically zero
   by construction.** It would have been quoted as proof of safety.
5. The founder reviewed the vegetation and reported "no issues" — **on the procedural forest**, because the
   authored mount took 71.5 s and nothing on screen said so.

The rule that falls out: **a metric that cannot fail is worse than no metric.** When you add an assertion,
prove it discriminates — mutate the code, watch the test go red. When you report a number, ask what would
have to be true for it to be wrong, and whether anything checks that.

---

## 7. Traps that cost real time

- **`/mnt/c` is drvfs.** `@deck.gl/core` imports in **197 s** from Node (vs `three` at 0.36 s); any suite
  importing `src/terrain.js` costs 3–4 minutes of pure I/O wait and flakes under load with
  `'Promise resolution is still pending'`. Vite dev startup is ~56 s. **None of this is a hang.** See
  `wsl-mntc-esm-import-cost-gotcha` in the vault.
- **Vite's watcher never fires on `/mnt/c`.** After ANY edit, restart the dev server — HMR will serve stale
  code indefinitely. This wasted a founder review: he was looking at a server started before the wall work
  and saw no walls.
- **Never `pkill -f vite`** — it self-matches your own shell, and one agent killed the founder's server that
  way. Scope kills to PIDs you started.
- `npm test` takes 10+ minutes. Budget for it; do not assume it hung.

---

## 8. What to do next

In order of value:

1. **The founder's GPU review** — `docs/GPU-SITTING.md`. Authored vegetation, Fortress, terrain PBR and the
   crackhouse contact sheets, batched into one sitting. Four questions only a real GPU can answer, and
   `gpuFrameMs` is `null` under SwiftShader so **no frame-time claim in this repo is backed by anything.**
2. **Parameterise the building factory** (§5.4 blocker), then author the twelve-building shortlist.
3. **Fence/gate look on a real GPU** — the geometry is fixed but has never been seen on real hardware.
4. Optional: one more survey raid closes targets #4 and #7, both redundant instances of confirmed families.
   Low value; the family question is closed.

**Do not** run the bounds reader, re-open the decisions in §4, rebuild the cross-source check that §2
invalidates, or author industrial rail stock against an unverified count.

---

## 9. Local reference boundary (unchanged, still binding)

The founder approved **read-only use on this machine only** of his legitimate Steam EFT install, to derive
sanitized scalar facts. It is not an asset-import licence.

```
C:\Program Files (x86)\Steam\steamapps\common\Escape from Tarkov\build\EscapeFromTarkov_Data
/mnt/c/Program Files (x86)/Steam/steamapps/common/Escape from Tarkov/build/EscapeFromTarkov_Data
```

Read-only. Never alter it, never add it to Git, never put its absolute path in a build artifact.
Derived packages live in `.local-game-derived/` and `.local-candidates/`, both git-ignored, both scanned by
`verify:build-boundary`. Logs under `build/Logs/` are read routinely by the companion and are fine to read;
assets are not.
