# UI rework v2 — direction (2026-08-29, desktop only)

Status: DIRECTION, pre-build. Inputs: current build screenshots (scratchpad `ui/`), Gemini 3.1 Pro visual pass
(`ui/gemini-ui-review.md`), Fable synthesis. Codex red team pending before implementation starts.

## Diagnosis (what's wrong today)

1. **The rail owns 20% of the screen and is opaque.** The map is the product; at 1400 px the map gets 1125 px and the
   3D view is letterboxed inside that. Every feature lives as an equal accordion row in one column, so opening Quests
   scrolls Ask/View/Live off the bottom.
2. **The assistant is filed as a setting.** "Ask · AI quest help · [A]" is a collapsed row between Quests and View. It is
   the feature that can drive the whole map (select quests, fly-to, toggle layers) and it is invisible.
3. **Two search boxes** (Find extract/place, Search quests) plus an Ask input — three text fields for "type a thing".
4. **Marker soup.** Spawn skulls are the same size and weight as extracts; at map-fit zoom there are ~100 equal-weight
   badges on Customs. Extract labels in 3D carry a second line ("REQ. GREEN FLARE") permanently.
5. **Raid status is a text sub-header** ("40 MIN · 10–12 PMC · PARTISAN 30%") and **Live position is the last row**,
   though it is the thing a player looks at during a raid.
6. **View controls are a wall of segmented toggles** (Base / Floors / Relief / Trees / Rocks / Labels) always visible even
   when nobody is changing them.

## Principles

- Map edge-to-edge, always. Chrome is floating, translucent (subtle — Tarkov's own UI is flat and dark, not frosted
  glass), and every module can collapse to a strip or icon.
- One text field. Typing is either a lookup (place/extract/quest, instant results) or a question (natural language →
  assistant). Same box, same hotkey.
- Weight follows raid priority: extracts > live player > quest objectives > everything else. Spawns/loot are context,
  drawn small and desaturated until zoomed in.
- Keep the identity: Barlow Condensed for headers/numbers/map labels, **Barlow (regular) for body** (already loaded —
  no Inter/Roboto), dark-green palette, game-icons glyphs (restyled to mono stencil, not replaced — user's art
  decision, Gemini's "trash the icons" declined), amber reserved for quest objectives, green for extracts.

## Layout (chosen: floating HUD, "ATAK" family — Gemini option B, adapted)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [TZ CUSTOMS ▾] [⏱ 40:00 · 10–12 PMC · P 30%]                  [2D|3D] [⚙]    │  top strip (two floating chips)
│                                                                  ┌──┐        │
│                                                                  │◎ │ layers │  right toolbar: icon buttons,
│                                                                  │⚑ │ quests │  hover = tooltip, click = flyout
│                          MAP (100vw × 100vh)                     │▣ │ view   │  panel docked to the toolbar
│                                                                  │◉ │ live   │
│                                                                  ├──┤        │
│                                                                  │+ │        │  zoom / north / fit / floors(3D)
│                                                                  │− │        │
│ [x 123.4  z −45.6 · 100 m ─────]                                 │N │        │  bottom-left telemetry chip
│                                                                  └──┘        │
│            ┌──────────────────────────────────────────────┐                  │
│            │ ▸ Find a place, a quest, or ask anything… ⌘K │                  │  omnibox, bottom-centre
│            └──────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Modules

- **Map chip (top-left):** wordmark + map name (picker on click) and the raid-status chip styled as a read-out, not a
  sentence. Status dot moves here.
- **View chip (top-right):** 2D/3D segmented control + a gear that opens the View flyout (base, relief, trees, rocks,
  labels). Floors (3D) become a vertical stack under the HUD buttons, visible only in 3D.
- **Right toolbar:** four icon buttons — Layers, Quests, View, Live — each opens ONE docked flyout panel (max 360 px,
  translucent, scrolls internally). Only one flyout open at a time; Esc closes. Keyboard: 1–6 still toggle layer rows,
  Q toggles the Quests flyout, L labels, 3 view.
  - *Layers flyout* = today's Filters (groups, All/None, counts).
  - *Quests flyout* = search, selected quests with objective checklist, "My quests" section (auto-populated when the
    companion can read active quests — see research note below). Because this panel gets long it can be pinned
    (stays open as a right dock, map pans under it).
  - *Live flyout* = pairing code, connection state, trails toggle, clear. The toolbar button itself is the GPS-style
    on/off indicator (grey → green pulse when a position is streaming).
- **Omnibox (bottom-centre, ⌘K or /):** replaces Find, quest search and Ask.
  - Instant results dropdown (above the box) as you type: places, extracts, quests, layers ("show scav extracts").
  - Enter on a result = fly-to/select. Enter on free text with no result, a trailing "?", or a phrase the intent
    classifier flags as a question = assistant.
  - Assistant reply = a **transient card above the omnibox** (streaming text, action chips: "Show on map",
    "Select quest", "Fly to"), and the map acts: selected quest lights up in amber, irrelevant layers dim to 40% for
    the duration, camera flies. Conversation history lives in a small "↑ history" flip on the card, not a chat pane.
  - Footer credit "Answers by DeepSeek" inside the card, not in the rail.
- **Telemetry chip (bottom-left):** cursor coords + scale bar; when live is connected it becomes the player read-out
  (x/z, heading, map-detected).
- **Quest card** (photo card on marker click) stays where it is (anchored to marker).
- Help (?) and credits: gear flyout footer.

### Marker/label system

- Zoom LOD: below fit-zoom+1, spawns/loot/containers draw as 6 px desaturated dots; icons appear from that zoom up;
  clustering with counts for spawns (already on the backlog).
- Extracts keep the letter badge, drop the permanent second line; requirement shows on hover/selection and as a small
  corner glyph (flare / key / cash).
- Labels: keep beam pings; Barlow Condensed; density "Key" becomes the default at fit zoom, "All" from +1.
- One icon style pass: mono stencil versions of the game-icons glyphs on a 2-tone badge; colour = category, not glyph.

## Build plan (fleet)

1. Scaffold new shell: `index.html` + `style.css` tokens → floating chips, right toolbar, flyout container, omnibox.
   Old rail markup removed; every existing `id` the JS binds to keeps working (map `#layers`, `#quests`, `#live`,
   `#ask-log` … are mounted inside the flyouts). ~2 fleet-h (opus).
2. Omnibox: merge `find`, `quest-find`, `ask-form` into one controller (`src/omnibox.js`), intent routing,
   result ranking, assistant card. ~3 fleet-h (opus).
3. HUD/telemetry/live indicator/floors stack. ~1.5 fleet-h (sonnet).
4. Marker LOD + extract label change + icon mono pass. ~2 fleet-h (opus; touches icons.js, main.js, map3d.js).
5. Visual QA: real-GPU screenshots from the user, Gemini pass on the result, fix list. ~1 fleet-h.

Not in scope: mobile (explicitly dropped 2026-08-29), 3D data fidelity (separate Codex audit), assistant backend.

## Decisions (2026-08-29, founder + Fable)

- **Toolbar on the right** (founder). Top-left stays reading-first for map name + raid status.
- **Quests flyout auto-pins when a quest is selected** and unpins when the last quest is deselected; the pin is also a
  manual toggle. Rationale: a selected quest is a working session, not a lookup.
- **Omnibox bottom-centre.** Game-HUD convention, keeps the top edge free for status, and the assistant card grows
  upward over the map rather than covering the map chip. Mitigation for the south-edge collision: the card is capped
  at 40vh and the map auto-pans so a fly-to target lands in the upper 60% of the viewport.
- **3D is the default view** (founder, 2026-08-29). With no `?view=` and nothing in localStorage the site opens the
  diorama; 2D is one click (or `3`) away and either choice persists. `index.html` ships with the 3D cell marked and
  `main.js` calls `setView()` for both branches on boot.
- **The 3D camera is oblique and can never go under the map** (founder, 2026-08-29). Load / fit / `N` frame at
  `rotationX 32°`, `rotationOrbit −20°` (`src/camera.js` `CAM`) instead of the old near-top-down 50–62°. Two clamps
  ride every view-state change (`onViewStateChange`, `setView`, and `set3d` in main.js): a hard floor of 9° above the
  ground plane, and — when the eye is close enough that 9° would put it inside the hill under the orbit target — a
  higher floor computed from the OrbitView eye distance and the terrain height there. Because the ground plane
  foreshortens with tilt, the 2D↔3D zoom offset is now a function of it (`zoomOffset()`, still 2.06 at the historical
  62°), so the oblique view still covers the viewport and 2D→3D→2D round-trips keep their scale.
- **Fit means cover, not contain** (step 2, defect from step 1). An explicit fit zooms so the map covers the viewport
  and centres it in the safe rect; opening, closing or pinning a panel never moves the camera.

## Codex red team (2026-08-29, job cxt-20260829-232819-lqr0) — dispositions

Premise corrections accepted: Customs default = 191 raw points (6 extracts, 120 spawns, 65 stashes), extracts/spawns
26 px in 3D, 26/22 in 2D; 3D already hides requirement lines below zoom 0.6; the assistant today can only select a
quest / fly to an objective / switch map (no layer API in `window.tz`); `3` is bound to both "toggle 3D" and layer
row 3 (existing bug); the active-quest item was not implementation-ready (companion, relay `pos|map` only, no
first-run snapshot). Usage premises (raid-time second screen, priority order) are UNMEASURED — stated as design
bets, not facts.

| # | Finding | Disposition |
|---|---|---|
| f | Missing option: HUD + optional persistent planning workspace (Quests + Layers may coexist) | **ADOPTED** — replaces "one flyout at a time" |
| 1 | (a) degrades quest-planning via exclusivity/hidden controls | adapted → see f |
| 2 | 5-user click-prototype falsification test | **DECLINED** — no test users available (solo founder); falsifier = founder real-GPU walkthrough of the chain "find extract → select quest → adjust layer → inspect photo → switch floor" before merge |
| 3 | Single-flyout vs pinning contradiction | accepted — **manual pin wins**; states: one *pinned workspace* (Quests or Layers, or both stacked) + one *transient* panel (View/Live); clicking a transient while a workspace is pinned opens it alongside; Esc closes transient first |
| 4 | Quest search duplicated | accepted — scoped search stays inside the Quests panel; omnibox results *supplement* |
| 5 | Omnibox auto-routing unsafe | accepted — **no prefix = local lookup; `>` = command; `?` = AI**; Enter acts only on a selected/exact result; otherwise an unselected "Ask AI…" row; classifier ranks, never auto-routes |
| 6 | Assistant actions contradictory / streaming | accepted — non-streaming; quest-select + fly-to stay immediate (existing behaviour); map-switch asks; **never dim extracts or live**; "Restore" chip after any focus mode |
| 7 | "Keep every id" insufficient | accepted — all panel DOM is mounted statically (hidden), never lazily; Find/Quest/Ask controllers migrate atomically; add `scripts/dom-contract-check.mjs` smoke test listing the selectors in the finding's table |
| 8 | "Upper 60%" not a collision system | accepted — one safe-viewport rect (insets from chips, pinned dock, omnibox/card) passed to 2D fit/fly, 3D projection, popup + photo-card placement |
| 9 | Duplicate View triggers; shortcut `3` | accepted — single View trigger (toolbar); drop bare 1–6, layer toggles via omnibox `>` commands |
| 10 | Icon-only discovery | accepted — tooltips on hover+focus, aria, persistent labels until first use |
| 11 | Live state conflation | accepted — disconnected/connecting/stale/streaming + last-update age; primary-player selector |
| 12 | LOD by zoom jumps; clustering unbudgeted | accepted — metres-per-pixel thresholds with hysteresis; spawn clustering in the marker task; extracts/live/selected quests exempt |
| 13 | Large-panel blur GPU bet | accepted — panels flat 92% opacity; blur only on small chips |
| 14 | Scope drift (active quests) | accepted — active-quest ingestion moves to its own spec `docs/plans/ACTIVE-QUESTS.md`, not in this commitment |

Build proceeds as (e)/(f). Review units ≤400 changed lines each; branch `ui-v2`.

## Research note — auto quests / gear (2026-08-29, verified against sources)

- **Active quests: YES, locally, no auth.** EFT writes quest state as system chat notifications into
  `*notifications_000.log` (the file the companion already tails): `Got notification | ChatMessageReceived` with
  `message.type` 10 = Started / 11 = Failed / 12 = Finished and `message.templateId` = task id — the same ids
  `quests.json` is keyed on. There is no "current quests" snapshot; the companion replays Started/Finished/Failed
  deltas (persist in `companion.json`) and streams the active set to the site. Verified in TarkovMonitor source
  (`the-hideout/TarkovMonitor`: `GameWatcher.cs`, `LogMessageTypes.cs`). `application_000.log` also yields the BSG
  account id (`SelectProfile ProfileId:… AccountId:…`).
  → "My quests" auto-populates; the assistant grounds on them by default; objectives for the detected map light up
  on raid start. Build item 6 (companion, ~2 fleet-h sonnet; site side inside the Quests flyout).
- **Gear/loadout: NOT automatable.** tarkov.dev's Players page (`player.tarkov.dev`) returns a full per-slot
  loadout by account id but every call needs a solved Cloudflare Turnstile (curl → 401); it has no quest data.
  EFT logs expose gear only for squad-mates (`GroupMatchRaidReady`). TarkovTracker's API needs an opt-in token and
  has no gear field. → Offer "import your tarkov.dev profile JSON" as a manual step later; not in this rework.
- Full report: scratchpad `eft-profile-research.md`. Unverified: raw `player.tarkov.dev` response body, whether
  `GroupMatchRaidReady` fires solo.
