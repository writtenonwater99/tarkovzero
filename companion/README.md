# TarkovZero Companion

Runs on the PC that plays Escape from Tarkov. Streams your in-raid position to tarkovzero.com.

```
cd companion
npm install
node companion.mjs
```

Prints a pairing code (e.g. `K7P-3QX`). On tarkovzero.com → **Live position** → enter the code → Connect.
In a raid press the in-game screenshot key; your arrow appears on the map.

Options (persisted in `companion.json`):

| flag | default | meaning |
|---|---|---|
| `--dir <path>` | auto: `<Documents>\Escape from Tarkov\Screenshots` (OneDrive-redirected Documents handled) | screenshots folder; if it doesn't exist yet the companion waits for EFT to create it |
| `--logs <path>` | auto: `%LOCALAPPDATA%\Battlestate Games\EFT\Logs` or Steam `...\Escape from Tarkov\build\Logs` | EFT log folder, used for map + screenshot-key detection |
| `--map <name>` | auto from logs, fallback `customs` | force the map name sent with each position |
| `--relay <wss url>` | `wss://tarkovzero-relay.fly.dev` | relay server |
| `--code <CODE>` / `--newcode` | random | pairing code |
| `--keep` | delete PNGs after 3 s | keep screenshots |
| `--auto <ms>` | off | auto-press the screenshot key every N ms (input automation; your call). Key is read from the EFT log (`MakeScreenshot` binding, default PrintScreen) |
| `--verbose` | — | print each filename and log-detection details |
| `--simulate` | — | no game: walks a fake player around Customs |

Works with Windows Node (`node companion.mjs`) or from WSL (`node.exe companion.mjs` / `node companion.mjs`).
The folder is polled every 250 ms rather than `fs.watch`ed (fs.watch is silent on `/mnt/c`).

How it works: EFT embeds position + rotation in every screenshot filename. The companion watches the folder,
parses the filename, and sends `{x, y, z, yaw, map}` to the relay under your code. Nothing else leaves your PC.
