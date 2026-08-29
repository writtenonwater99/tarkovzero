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
| `--dir <path>` | `Documents\Escape from Tarkov\Screenshots` | screenshots folder |
| `--relay <wss url>` | `wss://tarkovzero-relay.fly.dev` | relay server |
| `--code <CODE>` / `--newcode` | random | pairing code |
| `--keep` | delete PNGs after 3 s | keep screenshots |
| `--auto <ms>` | off | auto-press the screenshot key every N ms (input automation; your call) |
| `--simulate` | — | no game: walks a fake player around Customs |

How it works: EFT embeds position + rotation in every screenshot filename. The companion watches the folder,
parses the filename, and sends `{x, y, z, yaw, map}` to the relay under your code. Nothing else leaves your PC.
