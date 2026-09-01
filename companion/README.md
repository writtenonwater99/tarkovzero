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
- **Active quests** — how many quests you have started / finished / failed, the date the reconstruction
  starts from, and how many quest sets have been sent (the header pill lists the ids on hover);
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
| `--no-quests` | — | don't read the quest log at all (nothing about quests leaves the PC) |
| `--reset-quests` | — | throw away `companion-quests.json` and rebuild it from the logs on this run |
| `--verbose` | — | print each filename and log-detection details |
| `--simulate` | — | no game: walks a fake player around Customs |
| `--port <n>` | `4173` | UI port; if it's busy the next 20 ports are tried |
| `--headless` | — | no UI server, terminal only |
| `--no-open` | — | start the UI but don't open the browser |

Independent accuracy survey flags are deliberately not persisted in `companion.json`:

| flag | meaning |
|---|---|
| `--survey-capture <id>` | load pre-declared metadata from `data/customs-audit-anchors.json` |
| `--survey-plan <file>` | use another schema-v1 Customs capture plan |
| `--survey-log <file>` | append independent evidence as JSONL; default `companion/survey-customs.jsonl` |
| `--game-build <id>` | required EFT build/version recorded with every observation |
| `--confidence <0..1>` | required capture confidence; held-out audit evidence requires at least 0.8 |
| `--feature-id <id>` | stable `customs.*` feature id for a direct/ad-hoc capture |
| `--survey-tag <text>` | human-readable physical target for a direct capture |
| `--point-role <role>` | what is being measured, such as `ground-contact`, `object-corner`, or `floor-contact` |
| `--surface-kind <kind>` | labeled truth: `ground`, `road`, `bridge-deck`, `water`, `rock`, `floor`, `roof`, `underground`, or `object` |
| `--surface-id <id>` | emitted, geometry-bound `customs.surface.*` stable ID; required for floor, roof, and underground captures so the audit never chooses a layer from observed Y or labels |
| `--partition <train\|held-out>` | route partition declared before capture |
| `--route-id <customs.*>` | stable route id; the same route may never cross partitions |
| `--vertical-reference <kind>` | only `player-origin` is valid for EFT screenshots (the default); `surface-contact` belongs to a separate capture source/schema and is rejected here |
| `--surface-offset <metres>` | calibrated player-origin-to-surface offset; without it the observation cannot count toward elevation error |
| `--priority` | mark a priority-compound/control observation |

Works with Windows Node (`node companion.mjs`) or from WSL (`node.exe companion.mjs` / `node companion.mjs`).
The folder is polled every 250 ms rather than `fs.watch`ed (fs.watch is silent on `/mnt/c`).

## How it works

EFT embeds position + rotation in every screenshot filename. The companion watches the folder, parses the
filename, and sends `{x, y, z, yaw, map}` to the relay under your code. If a username is set it rides along in
every position message as `name` (the site reads `m.name` and labels your arrow with it instead of the code).

## Independent Customs accuracy survey

Ordinary position and `elevation-*.jsonl` logs are **not** independent accuracy evidence. Accuracy survey
mode is opt-in, Customs-only, rejects `--simulate`, requires stable feature/route/build/confidence metadata,
and records the original EFT screenshot filename as `screenshotId`. EFT filenames always report the
**player origin**; the companion cannot label them as surface contacts. Without an independently calibrated
`surfaceOffsetM`, they remain useful for horizontal/classification evidence but are excluded from vertical
metrics. Survey mode preserves PNG/JPG files even when the normal delete-after-3-seconds option is enabled.

The committed capture plan contains metadata only—there are intentionally no placeholder measurements. For
example, this captures the pre-declared held-out Dorms east route:

```bash
cd companion
node companion.mjs --map customs \
  --survey-capture dorms-east-ground-held-out \
  --game-build "<exact EFT build>" --confidence 0.95 \
  --surface-offset "<independently calibrated metres>"
```

Every new EFT screenshot appends one JSON object to `survey-customs.jsonl`. Stop/restart with another
`--survey-capture` id when the physical target changes. Never move a route between `train` and `held-out`
after inspecting errors. The raw survey log is git-ignored because it contains first-party raid coordinates;
promote only a reviewed evidence copy into `data/customs-audit-anchors.json`.

Run the audit from the repository root:

```bash
npm run audit:customs -- \
  --input data/customs-audit-anchors.json \
  --input companion/survey-customs.jsonl
```

The audit reports held-out horizontal and vertical errors, training-evidence coverage, held-out surface
classification, playable-bounds outliers, and object fidelity. It exits nonzero until all gates pass. Survey
records contain reference truth only: an embedded `model` prediction is forbidden. Centers, corners, surfaces,
yaw, and dimensions are derived from the emitted, hashed `customs-3d.json` artifact. Dangling or duplicate
stable-feature assignments fail the model contract. Layered predictions resolve the predeclared `surfaceId`
against an emitted, geometry-bound `floorSurfaces[].stableId`; `surfaceKind`, `pointRole`, and observed Y only score the result
and never select a floor. Generated terrain residuals are never substituted for held-out truth.
`npm run audit:customs -- --bootstrap` validates the empty-template workflow without claiming a pass.

## Active quests

EFT logs a chat message every time a quest is started (`type: 10`), failed (`11`) or finished (`12`) —
`build\Logs\log_*\* push-notifications_000.log`, a header line followed by pretty-printed JSON. There is no
"current quests" snapshot anywhere, so `quests.mjs` **replays** those messages across every `log_*` session,
oldest first, in `dt` order: started adds, finished/failed removes. The first token of `templateId` is the
task id that `public/data/quests.json` is keyed on; ids that file doesn't know (trader mail) are counted
separately and never published.

The result lives in `companion-quests.json` next to `companion.json` (git-ignored) together with a cursor
(`{file, offset}`), so a restart resumes instead of re-reading, and message `_id`s already applied are
skipped. Your `AccountId` / `ProfileId` come from `application_000.log`
(`PrepareSelectedProfileLocally ProfileId:… AccountId:…`). A different `AccountId` is a different player: the
reconstruction is thrown away and rebuilt from that session only. A different `ProfileId` on the same account
is ambiguous, so it only wipes when no quest events follow it (a fresh character); if the quest log keeps
going the reconstruction is kept and the companion says so. `--reset-quests` wipes by hand.

On every change and on every relay (re)connect the companion sends

```
POST <relay over http>/quests/<CODE>
{"active":[taskId…],"done":[…],"failed":[…],"accountId":"…","ts":1788056390936,"since":"2026-08-04"}
```

and the relay forwards it to the site as `{"type":"quests", …}` (also cached for late joiners, exactly like
the last position). So besides your position, what leaves the PC is: the quest ids you have started/finished/
failed and your numeric EFT account id (it is what tells the site "this is still the same profile"). Nothing
else — no names, no items, no chat text. `--no-quests` switches the whole thing off.

**Caveat:** EFT rotates old log folders away, so quests you started before your oldest kept log are invisible
to the replay. The UI shows the "since" date; add anything missing by hand on the site.

## Local HTTP API

Same-origin, 127.0.0.1 only, token required (`X-TZ-Token` header, or `?t=` for the event stream):

| route | meaning |
|---|---|
| `GET /` | the UI page |
| `GET /api/state` | full state: code, name, folders, map, relay status, `sent`, `lastPos`, `quests` (counts + `since` + active ids), last 100 log lines, version |
| `POST /api/config` | `{ name, dir, map, deleteScreenshots, autoMs, relay }` — any subset; applied immediately and persisted |
| `POST /api/newcode` | new pairing code + relay reconnect |
| `POST /api/quit` | stops the companion |
| `GET /api/events` | Server-Sent Events: every log line, plus `{"state":true}` hints to refetch state |

## Tests

```
npm run test:quests            # from the repo root — node --test, no dependencies
node --test companion/test/survey.test.mjs scripts/audit-map-accuracy.test.mjs
```

Covers the quest-log parser and the state machine against `test/fixtures/` (three synthetic log sessions in
the game's exact format — see `test/fixtures/README.md`): replay order, dedupe, finished-removes-active,
`dt` ordering across separate polls, cursor resume and live tailing, a truncated tail and a read failure in
an old session, the account- and profile-change resets (one branch each), and unknown ids.

`npm run test:relay` runs the relay's own suite (bad bodies, out-of-order quest posts, list caps), and
`npm test` runs both.
