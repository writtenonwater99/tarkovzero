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
| terrain | **exact tiles, PROMOTED 2026-09-02** — `public/assets/3d/customs/terrain/`, 8 surfaces, 10.7 MiB | exact local tiles from `.local-game-derived/` (identical bytes) |
| vegetation | **31 authored families, 8,805 placements, PROMOTED 2026-09-02** — `public/assets/3d/customs/authored/vegetation/`, 105 files, 41.0 MiB | the same 31 families from `.local-candidates/` (identical GLB and array bytes); placements read from the raw Unity dump instead of the derived table |
| walls / gates | authored geometry (public props + fences) | same |
| terrain PBR, Fortress | shipped | same |

**The terrain row changed on 2026-09-02.** The founder opened production and said "this is far from
what we worked on. not even the floor ground correct" — production was drawing the heightfield fitted
from SPT spawns and loot points while the reviewed local build drew the exact Unity tiles. He approved
promoting the terrain HEIGHT and CONTROL surfaces, twice. They now ship as ordinary public assets, the
way `public/assets/3d/customs/authored/fortress/` already did:

- `scripts/promote-terrain-surfaces.mjs` (`npm run promote:terrain`) copies the 8 files into
  `public/assets/3d/customs/terrain/`, writes the public `terrain-manifest.json` (`localOnly: false`,
  no vegetation reference), and writes the 8 rows of `asset-promotion-manifest.json`. `--check` fails
  if the three artifacts have drifted apart.
- `loadCustomsPromotedTerrainPackage()` in `src/customs-local-terrain-loader.js` loads them with no
  gate. `loadCustomsLocalTerrainPackage()` is unchanged and still refuses any non-loopback origin.
  Neither loader accepts the other's package: one requires `localOnly: true`, the other `false`.
- **`canLoadLocalGameDerivedAssets()` did not move.** It is still dev + loopback, and still governs
  the raw Unity vegetation dumps, the authored vegetation packs, the bridge corrections and the scalar
  facts. The terrain simply stopped being one of the things it governs.
- The receipt for the terrain rows is WEAK and says so in the manifest: its only provenance document
  is `scripts/extract-customs-terrain-local.py`, an EXTRACTOR, not a factory + catalog pair that
  regenerates the bytes from committed inputs. What authorises the promotion is the founder's ruling
  (`approvedBy`), recorded as such. The receipt proves the extractor is unchanged since approval and
  nothing more.
- `terrain-NNN-vegetation.json` sits in the same directory and is a RAW CAPTURE. It is not nameable
  by the terrain source key, is refused by `classifyLocalPath`, is refused by the promoted loader if a
  manifest ever references it, and its digest is in the committed capture inventory.
- Cost, measured: dist +11,265,697 bytes; over the wire 6.29 MB transferred / 10.74 MiB decoded across
  9 requests; median first frame 4,640 ms vs 4,414 ms without it (+226 ms, +5.1%, SwiftShader, three
  runs each, `gpuFrameMs` still null); terrain triangles 547,438 → 2,884,476.

**The vegetation row changed on 2026-09-02 too, and it is the last delta between production and the
build the founder reviewed.** Production drew 2,348 procedural proxies over public tree positions;
the reviewed local build draws 8,805 authored placements across 31 families. He approved promoting
it. The pack now ships as ordinary public assets under
`public/assets/3d/customs/authored/vegetation/`:

- `scripts/promote-authored-vegetation.mjs` (`npm run promote:vegetation`) copies the 93 GLBs
  (`assets/<family>/<family>-lod{0,1,2}.glb`, 15.4 MB) and the 9 shared texture-array blobs
  (`arrays/veg-l{0,1,2}-{basecolor,orm,normal}.bin`, 26.9 MB), writes the public
  `vegetation-manifest.json` (`localOnly: false`, `distribution: promoted-public`), the regenerated
  public array index `arrays/veg-arrays.json`, the derived `veg-placements.bin`, and the 102 rows of
  `asset-promotion-manifest.json` — all from one read. `--check` fails if any of them has drifted.
- `loadCustomsPromotedVegetationPackage()` in `src/customs-promoted-vegetation-loader.js` loads them
  with **no origin gate**. `loadCustomsLocalVegetation()` is unchanged and still requires the fixed
  loopback manifest URL and `localOnly: true` tile payloads. Neither accepts the other's package.
  Both feed the SAME `buildCustomsLocalVegetationRenderPlan()`, so the promoted forest is the
  reviewed forest by construction rather than by resemblance.
- **`canLoadLocalGameDerivedAssets()` did not move.** Vegetation simply stopped being one of the
  things it governs, exactly as terrain did.
- **Two receipts, not one, and the manifest keeps them apart.** The GEOMETRY and the TEXTURE ARRAYS
  have the STRONG receipt terrain never had: all 31 families report `geometryEvidence: "original
  approximation from scalar prototype identity and fallback envelope"`, and
  `validation/factory-provenance-report.json` hashes the pack against the git-tracked
  `vegetation_factory.py` + `prototype_catalog.json` (both currently matching, `sha256:0749080c…` /
  `sha256:0fcbca39…`). Re-running the committed factory regenerates those bytes.
  The **PLACEMENTS do not have that receipt.** `pack-index.json`'s placement mirror carries identity
  only; the 8,805 coordinates exist solely in `terrain-{000,001}-vegetation.json`, which is a
  registered RAW CAPTURE and never ships. `veg-placements.bin` is a derived scalar EXTRACT of that
  capture written by the promotion script — position, rotation, the two scale factors, the instance
  colour, the prototype binding, and nothing else (it drops `positionNormalized`, `lightmapColor`,
  every prototype record and the document structure). Its receipt is therefore the TERRAIN class: a
  measurement promoted on the founder's ruling. That is recorded in the public manifest's
  `provenance.placements` block, separately from `provenance.geometry`, so the two cannot be read as
  one chain. This is exactly the "transformed capture" the boundary states it cannot detect — the
  control for it is the closed registry plus review of the pipeline that writes `public/`, which is
  that one script.
- The capture itself is refused four ways: no registry key is rooted at it, `classifyLocalPath`
  still returns `raw-capture` (asserted), the promotion script re-checks that tier before reading
  it, and the promoted loader walks the whole manifest refusing any string shaped like
  `terrain-NNN-vegetation.json` — keys included.
- **The banner tells the truth per subsystem, and a fallback now reads as degraded.** The code
  `authored-unavailable-in-release` is gone; `promoted-vegetation-missing` replaces it. Its state is
  `degraded` in every environment, because the pack ships and its absence is a failed load. See
  `docs/LOCAL-THREE-POC.md` § "What a production frame says about itself".
- Cost, measured (same build, same server, same camera; the WITHOUT arm parks
  `vegetation-manifest.json` so the package is unreachable — `dist/` is on drvfs and will not rename
  a directory the preview server has open):

  | | bytes |
  | --- | --- |
  | 93 GLBs (`assets/`) | 15,396,212 |
  | 9 array blobs (`arrays/`) | 26,950,884 |
  | `arrays/veg-arrays.json` | 186,394 |
  | `vegetation-manifest.json` | 57,522 |
  | `veg-placements.bin` (8,805 rows × 48 B + 48 B header) | 422,688 |
  | **dist delta** | **43,013,700 (105 files, 41.02 MiB)** |

  Over the wire on `vite preview` (which compresses nothing): 105 requests, 42,839,562 transferred /
  43,013,700 decoded. Median first frame **5,615 ms with vs 6,349 ms without** (3 runs each,
  SwiftShader, `gpuFrameMs` still null) — the arm carrying the pack was *faster*, so the difference
  is noise and there is **no measurable first-paint cost**. That is structural, not luck: the mount
  is `void mountAuthoredVegetation()`, never awaited, so only the manifest + placement table
  (480,210 B) are on the critical path and the other 42.53 MB arrives after the map is interactive.
  Cold mount over HTTP: 93/93 GLBs in 9,385 ms, then 31 families / 93 buckets / 31 live buckets /
  **31 draw calls**, `materialMode: shared-array-texture`, 7,104 visible + 4 frustum-rejected =
  7,108 authored placements, `accountedPlacements` 8,805 (the conservation sum balances), 29,983,984
  resident bytes.
- **The 42.5 MB is still the biggest single asset in the deploy, and there are two cheap, measured
  reductions if it needs to come down.** Neither is done, both are contained:
  1. **Serve it compressed.** `gzip -6` over the whole subtree: 43,013,700 → 19,807,318 (46%); the
     array blobs alone 26,950,884 → 8,028,369 (30%). Vercel does not compress `application/octet-stream`,
     so today the wire cost is the raw cost. Worth ~23 MB for zero asset change.
  2. **Stop shipping mip levels the runtime never uploads.** `veg-arrays.json` declares
     `totalBytes: 26,950,884` against `uploadBytesLevel0: 20,213,760`: the loader uploads level 0
     only and sets `generateMipmaps = true` (three 0.185.1 forces this — see the header of
     `src/customs-vegetation-texture-arrays.js`), so 6,737,124 bytes of offline mip chain are pure
     wire cost today. Worth 6.7 MB of both dist and wire, with no visual change.
  The Stage B atlas / KTX2 work in §5.1 is the larger win and still needs a real-GPU frame first.

**The CI fail-open in the capture check, closed the same day.** `verify:build-boundary` built its
capture index by WALKING `.local-game-derived/` and `.local-candidates/`. Vercel builds from a clean
checkout where both are absent, so on the deployment that matters the index was empty and a raw capture
renamed under `public/assets/` shipped clean — measured against the verifier at 58f7fd8: `"pass": true`,
exit 0. `capture-digest-inventory.json` (74 rows, 21 KB, digests and sizes only, EFT screenshot names
redacted to a digest stem) is committed and loaded on every run; missing, unparseable or malformed is a
build failure, never a skipped check. Regenerate with `npm run build:capture-inventory`.

`src/renderer-gate.js` (renamed from `local-renderer-gate.js`) now separates two questions that were
previously conflated:

- **may Three run at all?** → yes in production, Customs, on explicit request
- **may it load local game-derived enhancements?** → dev + loopback ONLY, unchanged

**The boundary is not negotiable and a site password does not relax it.** The founder's local-use approval
"does not authorize shipping, copying, tracing, or redistributing" game-derived payload, and uploading to
Vercel is distribution regardless of who can log in. `npm run verify:build-boundary` runs after every build
across three roots and fails loudly. Do not weaken it; do not move `.local-game-derived/` or
`.local-candidates/` into `public/`.

**The site is PUBLIC — there is no password.** A site-wide HTTP Basic auth gate (`middleware.js` +
`SITE_PASSWORD`, matching `/(.*)`) shipped earlier on 2026-09-02 and was **removed the same day at the
founder's explicit request**. `middleware.js`, `scripts/middleware-site-auth.test.mjs`, the
`test:site-auth` npm script and `docs/PASSWORD-PROTECTION.md` are all gone; `SITE_PASSWORD` was deleted
from the Vercel project after the un-gated deploy verified green. Do not reinstate it without being asked.

This does **not** touch the game-data boundary above, which never depended on it: the password was never
what kept `.local-game-derived/` off Vercel — `.vercelignore` and `verify:build-boundary` are, and both
still stand. `/api/assistant` keeps its own guards (same-origin check + 20 req/min/IP, `api/assistant.js`),
which are now the only thing in front of the DeepSeek key.

**`.vercelignore` is load-bearing and must not be deleted.** The build-boundary verifier inspects `dist/`
and structurally cannot see what the CLI *uploads*. Without that file `vercel --prod` uploads 1.23 GB —
including 456 MB of `.local-game-derived/` and 413 MB of `.local-candidates/` — to Vercel's build machines
before the build runs. The Vercel CLI does **not** read `.gitignore`. Watch the file count on every deploy;
it should be in the hundreds, not thousands.

**Closed by the gate removal:** the `/api/graphql` → `api.tarkov.dev` rewrite in `vercel.json` forwards
request headers, so the browser's `Authorization: Basic …` was probably being handed to that third party on
every graphql call. With Basic auth gone there is no credential on the wire to leak.

---

## 3b. What the live page offers, and what it says about itself (2026-09-02, late)

Two founder instructions, both about the live page rather than the renderer.

**One map opens; all eleven are listed.** *"on the live page for now on the maps tab put all the maps but lock
them. even the woods/reserve. so rn customs is what avalible."* Reserve and Woods work — that is the point: beside
a finished Customs they would draw as the older map, and he would rather show them as coming.

- `src/map-availability.js` is THE list. `EFT_MAPS` (eleven rows, the picker), `AVAILABLE_MAP_KEYS` (`['customs']`),
  `LOCKED_MAP_KEYS` (derived), `MAPPED_MAP_KEYS` (the three with render data — **data coverage, not availability**).
- `assistant-contract.js`'s `SITE_MAPS` **is** that array (identity, not a copy — asserted), and `OTHER_MAP_LABELS`
  is built from `LOCKED_MAP_KEYS`. Locking a map therefore moves it, in one edit, out of the switchMap vocabulary
  and into the "TarkovZero cannot open that map yet" vocabulary. `crossMapFor()` can no longer mint a handoff for
  ANY of the 517 quests, proven through the real handler, not just the client.
- Reserve and Woods keep everything else: `MAPS` configs, `LABELS`, `<map>-3d.json`, quest zones, `siteMaps` rows in
  quests.json (filtered on READ, so unlocking needs no rebuild), and every test that covers them.
- A locked row carries a `SOON` badge, `aria-disabled`, and the accessible name "<Map> — not available yet".
  Clicking it toasts instead of navigating. `?map=woods` resolves to Customs with `status:'locked'` and toasts
  which map it wanted; `> map woods` refuses by name rather than "no map called woods".
- **There is no saved map preference and never was** — asserted in `scripts/map-availability.test.mjs`. The URL is
  the whole memory. The one place a map is written down is the assistant's `tz:askPending` sessionStorage handoff,
  which compares its `map` to the tab's on arrival and drops itself when they differ (and clears either way).
- To unlock: add the key to `AVAILABLE_MAP_KEYS`. `npm run test:map-availability`, e2e step 13.

**The build notices are off the live page.** *"also remove the notification boxes in the middle about the build."*
The CUSTOMS TRUTH strip and the vegetation notice are instruments — the orange box is exactly what would have told
the founder the exact terrain silently failed and he was back on the fitted heightfield (§6.3). A visitor cannot
act on either.

- They are **hidden in a release build, drawn on dev + loopback**: question (c) of `src/renderer-gate.js`,
  `canShowDiagnosticReadouts({dev, hostname})`, published as `gate.diagnosticReadouts`. It is a SEPARATE predicate
  from the boundary (b) even though they agree today — one is licensing, one is presentation, and fusing them is
  how a UI decision silently widens the thing that keeps game-derived assets off Vercel.
- **Hiding is not deleting.** Both nodes are still built and repainted on the same 400 ms tick everywhere, and
  `renderStats().truth` / `diagnostics().truth` publish the last painted `customsTruthStripCopy()` plus `shown`.
  A degraded production load is still detectable: `truth.title` becomes `CUSTOMS PUBLIC DATA` and `truth.state`
  becomes `degraded`. No e2e assertion ever read the DOM banner, so none had to move — the new ones read `truth`.
- e2e step 12 asserts absent-in-release with the state intact; **step 14 starts a real `vite dev`** and asserts the
  strip is on screen and its title/detail/state equal `renderStats().truth` field for field. That arm exists
  because a rule that hid the banner *everywhere* would pass step 12 and quietly take the instrument away.
  `npm run e2e -- --skip-dev-arm` skips it; Vite dev startup on /mnt/c is ~60 s (§7).
- The hover label (`.tz-three-hover`) is not a build notice and stays mounted unconditionally.

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

### 5.1 Vegetation — done, promoted, and the best-verified thing here
31/31 authored families, 8,805/8,805 placements bind, Khronos-clean, byte-reproducible. One array-texture
material instead of 199 → **31 draw calls at the default orbit** (was 57 on the fallback path, 1,333 for the
naive cell-grid design that was never built). Cold mount ~6 s, down from 71.5 s.

**PROMOTED 2026-09-02** — see §3. Production loads the same 93 GLBs and the same 9 array blobs from
`public/assets/3d/customs/authored/vegetation/`, and the same 8,805 placements from a derived scalar
table beside them. The old sentence here — "production falls back to public tree positions, and that
fallback is correct behaviour" — is **no longer true**: that fallback is now a defect, and the
banner says so.

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
