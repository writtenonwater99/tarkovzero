# TarkovZero Companion

Runs on the PC that plays Escape from Tarkov. Streams your in-raid position to tarkovzero.com.

```
cd companion
npm install
node companion.mjs
```

On Windows you can also double-click **`TarkovZero Companion.vbs`** (starts it hidden, no console window) or
**`start-companion.cmd`** (same thing with a visible console — use it if something looks broken; it passes any
extra arguments through, e.g. `start-companion.cmd --verbose`).

It prints a pairing code (e.g. `K7P-3QX`) and opens the UI in your browser. On tarkovzero.com →
**Live position** → enter the code → Connect. In a raid press the in-game screenshot key; your arrow appears
on the map.

## The UI

A small local page on **http://127.0.0.1:4173** (opened automatically at startup). It shows:

- relay status (Connected / Reconnecting…), game-log status, and the current map;
- the pairing code, big, with **Copy** and **New code**;
- settings you can change while it runs — username, screenshots folder, map override, delete-after-3 s,
  auto-screenshot interval — applied and saved to `companion.json` on **Save**;
- the last position (x / y / z / yaw / map / seconds ago), live;
- a live log of everything the companion prints;
- a **Quit** button.

The page is served on 127.0.0.1 only, and the printed UI URL carries a **per-run token**
(`http://127.0.0.1:4173/#t=…`) that the API requires — open the UI from that link (the browser is opened on it
for you). Opening the bare address shows a short "open this page from the companion" note. This keeps other
websites in the same browser from talking to the companion.

Use `--headless` if you only want the terminal.

## Options

Options (persisted in `companion.json`):

| flag | default | meaning |
|---|---|---|
| `--name <text>` | none | username shown on the map instead of the pairing code (max 24 chars) |
| `--dir <path>` | auto: `<Documents>\Escape from Tarkov\Screenshots` (OneDrive-redirected Documents handled) | screenshots folder; if it doesn't exist yet the companion waits for EFT to create it |
| `--logs <path>` | auto: `%LOCALAPPDATA%\Battlestate Games\EFT\Logs` or Steam `...\Escape from Tarkov\build\Logs` | EFT log folder, used for map + screenshot-key detection |
| `--map <name>` | auto from logs, fallback `customs` | force the map name sent with each position |
| `--relay <wss url>` | `wss://tarkovzero-relay.fly.dev` | relay server |
| `--code <CODE>` / `--newcode` | random | pairing code |
| `--keep` | delete PNGs after 3 s | keep screenshots |
| `--auto <ms>` | off | auto-press the screenshot key every N ms (input automation; your call). Key is read from the EFT log (`MakeScreenshot` binding, default PrintScreen) |
| `--verbose` | — | print each filename and log-detection details |
| `--simulate` | — | no game: walks a fake player around Customs |
| `--port <n>` | `4173` | UI port; if it's busy the next 20 ports are tried |
| `--headless` | — | no UI server, terminal only |
| `--no-open` | — | start the UI but don't open the browser |

Works with Windows Node (`node companion.mjs`) or from WSL (`node.exe companion.mjs` / `node companion.mjs`).
The folder is polled every 250 ms rather than `fs.watch`ed (fs.watch is silent on `/mnt/c`).

## How it works

EFT embeds position + rotation in every screenshot filename. The companion watches the folder, parses the
filename, and sends `{x, y, z, yaw, map}` to the relay under your code. If a username is set it rides along in
every position message as `name` (the site reads `m.name` and labels your arrow with it instead of the code).
Nothing else leaves your PC.

## Local HTTP API

Same-origin, 127.0.0.1 only, token required (`X-TZ-Token` header, or `?t=` for the event stream):

| route | meaning |
|---|---|
| `GET /` | the UI page |
| `GET /api/state` | full state: code, name, folders, map, relay status, `sent`, `lastPos`, last 100 log lines, version |
| `POST /api/config` | `{ name, dir, map, deleteScreenshots, autoMs, relay }` — any subset; applied immediately and persisted |
| `POST /api/newcode` | new pairing code + relay reconnect |
| `POST /api/quit` | stops the companion |
| `GET /api/events` | Server-Sent Events: every log line, plus `{"state":true}` hints to refetch state |
