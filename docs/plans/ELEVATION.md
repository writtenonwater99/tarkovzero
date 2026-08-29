# Terrain elevation data and survey runs

TarkovZero keeps terrain geometry at true game scale. The 5 m surface is fitted from three evidence classes, in priority order: companion survey positions, SPT ground spawns, and SPT loose-loot positions. Hand-authored terrain features fill sparse areas only; they do not override dense evidence.

## Stored SPT evidence

GitHub still exposes the current `looseLoot.json` files as Git LFS pointers, and the retired SPT Gitea URL redirects away. The full files were recovered from the official SPT 4.1.2 (40743) release archive:

`https://spt-releases.modd.in/SPT-4.1.2-40743-cf04a11.7z`

Only compact positions are checked in:

| Map | Release path | Compact positions |
|---|---|---:|
| Customs | `SPT_Runtime/SPT_Data/database/locations/bigmap/looseLoot.json` | 1,820 |
| Reserve | `SPT_Runtime/SPT_Data/database/locations/rezervbase/looseLoot.json` | 4,148 |
| Woods | `SPT_Runtime/SPT_Data/database/locations/woods/looseLoot.json` | 1,720 |

They live at `scripts/data/<map>/loose-loot-samples.json`. `scripts/ingest-elevation.mjs` combines them with each map's SPT `SpawnPointParams` and any survey logs, prefers survey over spawn over loot inside the same 2 m cell, and writes `scripts/data/<map>/elevation-samples.json` deterministically.

The terrain builder discards loose loot inside mapped buildings, rocks, and underground shapes, then rejects samples more than 2.5 m above or below their local robust median. This removes rooftops, shelves, rock tops, and underground clusters before the multi-scale fit.

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

The builder prints input/accepted/rejection counts and the fitted range. For Customs without a user survey it currently retains 470 of 1,227 deduped evidence cells; dense loose-loot evidence raises the Powerline Tower pylon base from the old synthetic 4.45 m surface to 15.25 m. Sniper Hill remains supported by the authored sparse-area fallback until a survey crosses it.
