# Prompt for Claude on the Windows game laptop

Copy everything below the line into Claude Code on the game laptop (run it inside the cloned repo).

---

You are working on **TarkovZero** (https://tarkovzero.com), an interactive Escape from Tarkov map. Read `CLAUDE.md`
in this repo first — it explains the project and, importantly, the split between two machines:

- The **Linux dev laptop** owns site development and deploys (Vercel site, Fly relay). Do not develop the site here.
- **This Windows laptop** has Tarkov installed. Your job is the **companion app** (`companion/`) and real-game testing.

Goal for this session: get live player position working with the real game, end to end.

Steps:
1. `git pull`, then `cd companion && npm install && node companion.mjs`. Note the pairing code it prints.
2. Confirm the screenshots folder it picked exists (`Documents\Escape from Tarkov\Screenshots`; OneDrive-redirected
   Documents is a common gotcha — use `--dir` if needed and make auto-detection handle it).
3. Have the user start a raid (offline/practice is fine), open tarkovzero.com on any device, enter the code under
   **Live position**, and press the in-game screenshot key a few times while moving.
4. Verify:
   - a position is parsed from every screenshot (if not, capture a real filename and fix the regex in
     `parseScreenshot`; record the real format in `CLAUDE.md`),
   - the arrow lands where the player actually is on Customs,
   - the arrow **points the way the player is facing**. If it's off (backwards / mirrored / ±90°), the fix is in
     `src/live.js` `setHeading` (screen angle = yaw + coordinateRotation) or in the quaternion→yaw math in
     `companion.mjs`. Prefer fixing it in the companion (send the corrected yaw) so the site stays untouched; if the
     site must change, keep it to that one line and say so in the commit message.
   - screenshots are deleted after ~3 s (unless `--keep`),
   - `--auto 2000` works if the user wants it (sends the screenshot key via PowerShell SendKeys; the key defaults
     to PrintScreen — check what the user's in-game binding is).
5. Nice-to-have if time allows: detect the current map from the EFT log
   (`%LOCALAPPDATA%\Battlestate Games\EFT\Logs\...\application.log`) and send it as `map` (normalized names like
   `customs`) so the site can auto-switch later.
6. Commit companion fixes with clear messages and `git push` to `main`. Do not commit `companion.json`.
7. Report back: real filename format, whether heading needed a fix and what it was, any folder/permission issues,
   and measured delay from keypress to arrow move.

Don't touch `src/`, `relay/`, `scripts/`, or deploy anything unless it's the one-line heading fix described above.
