# Fixture logs

Synthetic EFT log sessions in the exact on-disk shape of
`…\Escape from Tarkov\build\Logs\log_<date>_<ver>\<ver> {application,push-notifications}_000.log`
(header line + pretty-printed JSON block, see `docs/plans/ACTIVE-QUESTS.md`).

They are hand-written, not copies of a real profile: `text` and `uid` are stripped, `_id`/`eventId`/`dialogId`
are made up, and every task id is either a real id from `public/data/quests.json` or
`616041eb031af660100c9967` — an id the real logs do contain and which is deliberately **not** in quests.json,
so the "drop ids we don't know" path is covered.

Session A is CRLF (what the game writes); B and C are LF, so the parser is exercised on both.

| session | account | contents |
|---|---|---|
| `log_2026.08.04_21-12-00_…46624` | `10000001` | started ×3 (`5c0bde09…`, `5936da9e…`, `5967530a…`), started ×1 unknown id, one `type: 14` reward mail |
| `log_2026.08.05_20-20-49_…46657` | `10000001` | `5936da9e…` finished, a verbatim duplicate of the first started block (dedupe), `5967530a…` failed, `59689fbd…` finished **before** its own started block in file order (dt ordering) |
| `log_2026.08.09_16-09-59_…46657` | `20000002` | different AccountId (wipe): `657315dd…` and `596a0e16…` started |
