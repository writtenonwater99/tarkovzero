# Terrain elevation data and survey runs

TarkovZero keeps terrain geometry at true game scale. The 5 m surface is fitted from the `ground` view of one shared evidence pipeline: exact tarkov.dev positions, SPT spawns/loose loot, and optional companion surveys. Hand-authored terrain features fill sparse areas only; they do not override dense ground evidence.

## Stored SPT evidence

GitHub still exposes the current `looseLoot.json` files as Git LFS pointers, and the retired SPT Gitea URL redirects away. The full files were recovered from the official SPT 4.1.2 (40743) release archive:

`https://spt-releases.modd.in/SPT-4.1.2-40743-cf04a11.7z`

Only compact positions are checked in:

| Map | Release path | Compact positions |
|---|---|---:|
| Customs | `SPT_Runtime/SPT_Data/database/locations/bigmap/looseLoot.json` | 1,820 |
| Reserve | `SPT_Runtime/SPT_Data/database/locations/rezervbase/looseLoot.json` | 4,148 |
| Woods | `SPT_Runtime/SPT_Data/database/locations/woods/looseLoot.json` | 1,720 |

They live at `scripts/data/<map>/loose-loot-samples.json`. `scripts/ingest-elevation.mjs` preserves every full-precision input point in `points`, then emits a separate compatibility `samples` view that prefers survey over spawn over loot inside the same 2 m cell. It writes `scripts/data/<map>/elevation-samples.json` deterministically.

The terrain builder never discards a finite vertical observation. It assigns every point to `ground`, `rock`, `floor`, `roof`, or `underground`, retaining provider/source ID, exact `(x,y,z)`, and reason codes in `terrain.evidence.buckets`. Only the 2 m-deduped trusted `ground` view feeds the single-valued heightfield. Rock points feed hard-rock geometry; floor/roof/underground points feed `floorSurfaces`. The full route is therefore auditable even when an observation must not deform walkable ground.

## Customs survey run

1. In EFT, bind **Make Screenshot to F11**. The companion reads this binding from the current EFT log.
2. From the repository's `companion` directory, install once with `npm install`, then run:

   ```powershell
   node companion.mjs --map customs --auto 1000
   ```

   `--auto 1000` presses the configured screenshot key once per second. This is local input automation and remains the user's choice. Screenshots are deleted after three seconds by default; use `--keep` only if the images themselves are needed.
3. Stay on ordinary walkable ground. Walk both across and around each hill, including its base and crest; avoid roofs, stairs, jumps, rocks, and underground routes. Prioritise:

   - Powerline Tower and the approaches around x≈497, z≈110;
   - Sniper Hill around x≈110, z≈85;
   - the west rise/Crossroads approaches around x≈-320, z≈-80.

4. Stop with Ctrl+C after the route. Every parsed screenshot has already been appended locally as `{map,x,y,z,t}` to `companion/elevation-customs.jsonl`, even if the relay was disconnected.
5. Back in the repository root, merge and rebuild:

   ```bash
   node scripts/ingest-elevation.mjs customs companion/elevation-customs.jsonl
   node scripts/build-3d.mjs customs
   npm run build
   ```

Pass multiple JSONL files to merge multiple runs. Use `--elevation-log <file>` to choose another log path, or `--elevation-log off` to disable local logging. Reserve and Woods work the same way with their map key and default `elevation-<map>.jsonl` filename.

## Review diagnostics

The builder prints total input, bucket counts, ground-fit cells, and the fitted range. Fix pass 10 routes 3,439 Customs observations into 1,001 ground / 3 rock / 2,159 floor / 80 roof / 196 underground; Reserve routes 6,332 into 857 / 2 / 2,824 / 576 / 2,073; Woods routes 3,302 into 1,935 / 272 / 874 / 168 / 53. The fit uses 598 / 432 / 1,048 deduped ground cells respectively. Woods' separate hard-rock surface restores the reviewed central-mountain tops without contaminating the walkable-ground fit.
