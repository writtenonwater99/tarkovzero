# Customs realism checkpoint — 2026-08-31

This is a **localhost-only, no-deployment** checkpoint.  Commit it before any
new feature work.  `main` has not been deployed as part of this pass.

## First read

1. `docs/CUSTOMS-TRUTH-PIPELINE.md` — local-only data boundary and extraction
   contract.
2. `docs/plans/ASSET-MANIFEST-V2.md` — authored asset admission/runtime
   contract.
3. `docs/LOCAL-THREE-POC.md` — local Three renderer and its production gate.
4. `docs/AGENT-ONBOARDING.md` and `CLAUDE.md` — broader product history. Where
   an older document says to use no game-file facts at all, this checkpoint and
   the truth-pipeline document are the current scoped exception below.

## Local-only game reference boundary

The founder explicitly approved **read-only use on this machine only** of their
legitimate Steam EFT install to derive sanitized scalar facts for personal map
understanding. It is not an asset-import license and it does not authorize
shipping, copying, tracing, or redistributing game meshes, textures, materials,
audio, shaders, bundles, scenes, or other creative payloads.

The exact Windows install/data root currently present on this PC is:

```text
C:\Program Files (x86)\Steam\steamapps\common\Escape from Tarkov\build\EscapeFromTarkov_Data
```

Its WSL spelling is:

```text
/mnt/c/Program Files (x86)/Steam/steamapps/common/Escape from Tarkov/build/EscapeFromTarkov_Data
```

Treat that tree as read-only. Never alter it, never add it to Git, and never
put its absolute path in a runtime/build artifact. The only local derived
package is deliberately ignored at:

```text
/mnt/c/Users/zeque/tarkovzero/.local-game-derived/
```

It is served only by the loopback-only Vite route during local development and
is protected by `npm run verify:build-boundary`. Keep it outside `public/`.

## What is verified locally

- Customs terrain: two exact local height tiles, 1,191,000 vertices and
  2,375,828 triangles. The fixed presentation relief is 2x; fog is off.
- Internal terrain/spawn residual: median 0.171257 m, P90 2.232905 m; 251/278
  (90.2878%) reference spawns are within 2.5 m. This is **not** independent
  certification: held-out in-raid survey routes have not been collected.
- Terrain PBR V2.1 and Fortress V2 are promoted under
  `public/assets/3d/customs/`; local browser QA showed WebGL2, fog off, PBR
  active, Fortress loaded with no GLB errors.
- `src/customs-authored-vegetation.js` has a strict offline adapter plus a
  nonthrowing binding probe. It is intentionally not wired into the renderer.
- `scripts/industrial-prop-asset-factory/` has independently verified original
  authored industrial prototypes. Do not admit its legacy nine-proxy plan.

## Important correction: industrial identities

Sanitized Unity transform facts disprove the old proxy labels. Do **not** place
the existing diesel shunter or 40-ft container models into their old proxy
slots.

The truthful first set is three closed freight wagons, two tank wagons, one
hopper wagon, and two 6 m red containers. The existing factory tanker may be
reused after scale/axis/seat verification; the missing original authored
families are closed wagon, hopper wagon, and 6 m container. Preserve exact
identity/placement evidence and use `RAILWAY_TRACK_PROFILE.vehicleWheelBottomLiftM`
for rail stock seating, not Unity root Y.

## Offline candidates — do not promote yet

- Broadleaf alpha-card proof:
  `/tmp/tarkovzero-tree02-alpha-proof-final2.W0B5cN`. Structural, LOD, alpha,
  Khronos, and reproducibility gates pass, but visual/budget/runtime gates do
  not. It remains `revise-offline-proof-only`.
- Crackhouse authoring candidate: inspect the latest `/tmp/tarkovzero-*` output
  and `scripts/building-asset-factory/`. The worker stopped for quota before a
  final handoff. It is not runtime-promoted and is not an exact facade or
  tactical/collision certification.
- The new small extractor work was interrupted with the helper quota; check
  whether `scripts/extract-customs-industrial-roots.py` exists before resuming.
  Do not assume it completed.

## Required next sequence

1. Push/inspect this checkpoint, then run `git diff --check`, focused tests,
   `npm test`, and `npm run build` before changing renderer defaults.
2. Inspect offline candidate contact sheets on a real GPU. Headless captures
   are diagnostics only; visual admission requires the founder's GPU verdict.
3. Build only the three missing industrial family models as original assets;
   validate GLB structure, Khronos, mutation rejection, byte reproducibility,
   axis/pivot, scale, terrain/rail seating, and exact root/cell mapping.
4. Add a pure hybrid vegetation router: authored and procedural placements must
   be complementary, deterministic, and exactly cover the original count.
   Retain procedural rendering until authored loading succeeds atomically.
5. Integrate only admitted authored assets, capture browser network/console/perf
   evidence, then rerun accuracy regressions. Do not deploy without explicit
   approval.

## Helper policy carried forward

The user approved Claude Code, Gemini API, and `claude-ds` for this personal,
free project. Keep Codex as integrator/reviewer. Claude and DeepSeek quota was
exhausted during this pass, so do not treat partial worker output as finished;
validate it independently before use. Gemini is for screenshot-based visual
critique only, after a real screenshot exists.
