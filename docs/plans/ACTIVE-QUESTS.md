# Active quests from the game — spec (2026-08-29, separate from the UI rework)

Goal: the site's Quests panel shows the player's currently active quests ("My quests") with no manual input, and the
objectives for the detected map light up when a raid starts. Gear is out of scope (not automatable — see
UI-REWORK.md research note).

## Source of truth (verified on this machine's logs, EFT 1.1.0.x Steam build)

`build\Logs\log_<date>_<ver>\<ver> push-notifications_000.log` — pretty-printed JSON after a header line:

```
2026-08-04 21:25:52.179|1.1.0.0.46624|Info|push-notifications|Got notification | ChatMessageReceived
{
  "type": "new_message",
  "eventId": "…", "dialogId": "…",
  "message": { "_id": "…", "uid": "…", "type": 10, "dt": 1785903953, "text": "…",
               "templateId": "59689fbd86f7740d137ebfc4 description", "hasRewards": false, … }
}
```

- `message.type`: **10 = quest started, 11 = failed, 12 = finished**; 14 observed (unclassified — log and ignore).
- `message.templateId` = `<taskId> <suffix>` — take the first token; it is the tarkov.dev/SPT task id that
  `public/data/quests.json` is keyed on. Some rows may carry non-task ids (trader messages) — drop ids not in quests.json.
- Counts seen 08-04 → 08-28: 27 started, 9 finished, 0 failed.
- Player identity: `application_000.log` line `PrepareSelectedProfileLocally ProfileId:<hex> AccountId:<digits>`
  (also `CompleteSelectedProfile`). Nickname is NOT in the logs for the local player (only party members in
  `GroupMatchRaidReady`) — keep the companion's manual name field.

## State reconstruction

There is no "current quests" snapshot. Active set = replay of all events across ALL log sessions (not only the
newest — today the companion scans only the latest folder):

1. First run: walk every `log_*` dir oldest → newest, parse every `ChatMessageReceived`, apply in `dt` order:
   10 → add to active; 12 → remove from active, add to done; 11 → remove, add to failed. Dedupe on `message._id`.
2. Persist `{accountId, cursor: {file, offset}, active[], done[], failed[], seenIds[]}` in `companion-quests.json`
   (git-ignored, next to `companion.json`). Subsequent runs resume from the cursor; tail the live file at the same
   250 ms poll as screenshots.
3. **Wipe / new profile:** if `AccountId` changes or a `ProfileId` change is seen with an empty event stream after
   it, reset state. Offer `--reset-quests`.
4. Logs older than the companion's install may already be rotated by EFT → the initial active set can be
   incomplete. UI must say "since <oldest log date>" and allow manual add/remove (existing quest selection).

## Transport

- Companion → relay: `POST /quests/CODE` `{active:[ids], done:[ids], accountId, ts}` on change and on connect.
- Relay: keep last quest set per code (same cache as last position); forward to `/sub/CODE` as `{t:'quests', …}`
  alongside `pos|map`. Retention identical to positions.
  **As built (2026-08-29):** the discriminator is `type:'quests'`, not `t:'quests'` — `t` is already the
  timestamp the relay stamps on every message. Payload as shipped:
  `{type:'quests', active[], done[], failed[], accountId, since, ts, code, t}`.
- Site (`src/live.js` → `src/quests.js`): on `quests` message, populate "My quests" (ids ∩ quests.json for the
  current map first, others collapsed); on `map` message, auto-select the active quests that have objectives on
  that map (respect a "auto-select" toggle, default on). Manual selections are never overwritten.

## Estimate

Companion parser + state + tests on fixture logs: 1.5 fleet-h (sonnet). Relay: 0.5. Site: 1 (inside the v2 Quests
panel). Fixture: copy 2–3 real `push-notifications_000.log` files with ids intact (no PII beyond task ids; strip
`text`, `uid`) into `companion/test/fixtures/`.

## Open

- `type` 14 meaning; whether started events fire for quests auto-accepted at profile creation (first-run gap).
- Whether Arena/prestige resets emit anything distinguishable.
