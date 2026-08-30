import L from 'leaflet';
import { pos } from './crs.js';
import { parseQuestsMessage, mergeQuestSets } from './active-quests.js';

// Live player positions from the relay. One subscription per pairing code; each code gets its own
// coloured arrow + trail. Designed for several codes at once (you + friends) even though v1 UI is solo.
// `?relay=` is a DEV-ONLY override, for pointing a local site at a local relay. It must never ship:
// the socket URL is `${RELAY}/sub/${code}`, so a link with someone else's host in it hands them the
// pairing code — the only thing protecting the feed — in the request path, and then lets them write
// whatever `pos` and `quests` messages they like into the player's map.
const relayParam = import.meta.env.DEV ? new URLSearchParams(location.search).get('relay') : null;
const RELAY = relayParam
  || import.meta.env.VITE_RELAY_URL || (import.meta.env.DEV ? 'ws://localhost:8787' : 'wss://tarkovzero-relay.fly.dev');
export const COLORS = ['#ff3d3d', '#3d9bff', '#3dff7a', '#ffd23d', '#d63dff', '#3dfff0'];
const CODE_RE = /^[A-Z0-9]{6}$/;
export const normCode = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Names/status can come from anyone publishing to a code — always escape before rendering as HTML.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// -------------------------------------------------------------------- state machine (red team #11) --
// disconnected (no code) -> connecting (socket opening / no position yet) -> streaming (position within
// the last STALE_MS) -> stale (last position older than that, socket still open) -> back to connecting
// the moment the socket actually drops and a new one is opened.
export const STALE_MS = 10_000;

// ?livestate=connecting|streaming|stale forces every player into that state for QA screenshots without
// a real companion — the toolbar/panel/telemetry chip can be exercised on demand. Dev-only, kept for CI.
const QA_STATE = ['connecting', 'streaming', 'stale'].includes(new URLSearchParams(location.search).get('livestate'))
  ? new URLSearchParams(location.search).get('livestate') : null;
const QA_AGE_MS = { connecting: 0, streaming: 2000, stale: 15000 };
const qaPlayer = () => ({
  code: 'QA0000', name: 'QA test', color: COLORS[0], map: null, status: 'QA',
  last: { x: 12.3, z: -45.6, yaw: 214 }, lastAt: Date.now() - QA_AGE_MS[QA_STATE], ws: { readyState: 1 },
});
// The walk the QA player arrives on. Feeding these through onPos() — the same function a relay
// message lands in — is what makes the override draw an arrow, a drop-line and a trail instead of
// only a panel row and a telemetry chip (QA D11): a synthetic object handed straight to summary()
// never reaches the marker/trail code, so the HUD claimed "Streaming · 1 player" over an empty map.
const QA_TRACK = [
  { x: -78.4, z: -8.2, yaw: 108 }, { x: -44.1, z: -19.6, yaw: 116 }, { x: -12.7, z: -28.9, yaw: 124 },
  { x: 18.6, z: -36.4, yaw: 148 }, { x: 12.3, z: -45.6, yaw: 214 },
];

export function createLive(map, mapData, ui, hooks = {}) {
  const players = new Map();
  const opts = { follow: true, trail: true, primary: null };
  const pane = 'live';
  map.createPane(pane); map.getPane(pane).style.zIndex = 650;

  const arrowIcon = (color) => L.divIcon({
    className: '',
    html: `<div class="player-arrow" style="--c:${color}"><svg viewBox="0 0 120 120" width="120" height="120"><defs><radialGradient id="pg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${color}" stop-opacity=".55"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs><path d="M60 60 L26 6 A62 62 0 0 1 94 6 Z" fill="url(#pg)"/><path d="M60 60 L26 6 A62 62 0 0 1 94 6" fill="none" stroke="${color}" stroke-opacity=".7" stroke-width="1.2"/><circle cx="60" cy="60" r="7" fill="${color}" stroke="#0a0e0c" stroke-width="2"/><circle cx="60" cy="60" r="11" fill="none" stroke="${color}" stroke-opacity=".8" stroke-width="1.5"/></svg></div>`,
    iconSize: [120, 120], iconAnchor: [60, 60],
  });

  function setHeading(p, yaw) {
    const el = p.marker.getElement()?.querySelector('.player-arrow');
    // Game yaw 0 = +Z, which points down on this map (coordinateRotation 180): screen angle = yaw + 180.
    if (el) el.style.transform = `rotate(${(yaw ?? 0) + (mapData.coordinateRotation ?? 0)}deg)`;
  }

  /** One player's state — QA_STATE overrides everything so the HUD can be screenshotted on demand. */
  function playerState(p) {
    if (QA_STATE) return QA_STATE;
    if (!p.ws || p.ws.readyState !== 1) return 'connecting';
    if (!p.lastAt) return 'connecting';
    return (Date.now() - p.lastAt) < STALE_MS ? 'streaming' : 'stale';
  }
  /** The real roster, or a single synthetic QA player when forced and nothing real is connected. */
  function allPlayers() {
    const list = [...players.values()];
    return (QA_STATE && !list.length) ? [qaPlayer()] : list;
  }
  /** Enriched per-player rows for the panel / telemetry chip / window.tz.live.state(). */
  function summary() {
    return allPlayers().map((p) => {
      const state = playerState(p);
      const lastAt = p.lastAt ?? null;
      return { code: p.code, name: p.name, map: p.map, color: p.color, status: p.status, last: p.last, state, lastAt, ageMs: lastAt != null ? Date.now() - lastAt : null };
    });
  }
  /** The player everything else (follow, telemetry chip, raid-switch toast) is grounded on: a manual
   *  pick if it still exists, else the first streaming player, else the first player of any state. */
  function primary() {
    const list = summary();
    if (!list.length) return null;
    if (opts.primary) { const m = list.find((s) => s.code === opts.primary); if (m) return m; }
    return list.find((s) => s.state === 'streaming') ?? list[0];
  }
  function setPrimary(code) {
    const c = normCode(code);
    opts.primary = players.has(c) ? c : null;
    persist(); ui.render();
  }
  /** window.tz.live.state() — one summary number for "is live position usable right now". */
  function state() {
    const list = summary();
    if (!list.length) return { state: 'disconnected', lastAt: null, ageMs: null, players: [] };
    const rank = { streaming: 3, stale: 2, connecting: 1 };
    let best = list[0];
    for (const s of list) if ((rank[s.state] ?? 0) > (rank[best.state] ?? 0)) best = s;
    return {
      state: best.state, lastAt: best.lastAt, ageMs: best.ageMs,
      players: list.map(({ code, name, map, lastAt }) => ({ code, name, map, lastAt })),
    };
  }

  /* ------------------------------------------------------------- quest sets -- */
  // The companion also streams the player's quest log — one `{t:'quests', active, done, failed,
  // accountId, ts, since}` per pairing code, on connect and on every change (docs/plans/
  // ACTIVE-QUESTS.md). This module only keeps and merges them; src/quests.js decides what to draw.
  const questSets = new Map();   // code -> normalised set (see active-quests.js)

  function onQuests(code, m) {
    const set = parseQuestsMessage(m);
    if (!set) return false;
    questSets.set(code, set);
    hooks.onQuests?.(quests());
    return true;
  }
  /**
   * window.tz.live.quests() — the merged sets across every connected code, primary player first.
   * `{ active:[taskId], done:[…], failed:[…], accountId, ts, since, codes:[…] }`.
   */
  function quests() {
    const pc = primary()?.code;
    const order = [];
    if (pc && questSets.has(pc)) order.push(questSets.get(pc));
    for (const [c, set] of questSets) if (c !== pc) order.push(set);
    return { ...mergeQuestSets(order), codes: [...questSets.keys()] };
  }

  // QA without a game PC: `?quests=<taskId,taskId>` (plus optional `quests-done`, `quests-failed`,
  // `quests-since`) is fed through the exact same parser as a relay message, so a screenshot or a
  // bug report made this way exercises the real path and not a second one.
  function applyQaQuests() {
    const qs = new URLSearchParams(location.search);
    if (!qs.has('quests')) return;
    const ids = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
    setTimeout(() => onQuests('QA0000', {
      t: 'quests',
      active: ids(qs.get('quests')),
      done: ids(qs.get('quests-done')),
      failed: ids(qs.get('quests-failed')),
      since: qs.get('quests-since') || null,
      accountId: 'qa',
      ts: Date.now(),
    }), 0);
  }

  /**
   * `?livestate=…` without a game PC: put ONE player in the real roster and walk it through onPos(),
   * exactly as a relay `pos` message would. Everything downstream — marker, heading, drop-line,
   * trail, follow, telemetry, the 3D player layers, `window.tz.live.state()` — is then the shipping
   * code path and not a QA-only imitation of it. No socket and no persist(): the fake code must
   * never survive into localStorage and come back on a real session.
   */
  function applyQaLive() {
    if (!QA_STATE || players.size) return;
    const p = {
      code: 'QA0000', name: 'QA test', nameOverride: false, color: COLORS[0],
      status: '', last: null, lastAt: null, map: null, resume: true, ws: { readyState: 1 },
    };
    players.set(p.code, p);
    setTimeout(() => {
      for (const q of QA_TRACK) onPos(p, { type: 'pos', x: q.x, z: q.z, yaw: q.yaw, map: mapData.key });
      // playerState() is forced by QA_STATE anyway; back-date lastAt so the "…s ago" read-outs
      // still match the state being screenshotted.
      p.lastAt = Date.now() - QA_AGE_MS[QA_STATE];
      ui.render?.();
    }, 0);
  }

  const TELEPORT_UNITS = 300; // a trail jump longer than this (game units) is a teleport / stale replay, not movement

  function onPos(p, m) {
    // Username sent by the companion wins over the code; a name typed on the site is a fallback/override.
    if (typeof m.name === 'string' && m.name.trim() && m.name.trim() !== p.name && (!p.nameOverride || p.name === p.code)) {
      p.name = m.name.trim().slice(0, 24);
      p.marker?.setTooltipContent(esc(p.name));
      persist();
    }
    // A position (matched map or not) is high-frequency — every screenshot the companion takes — so it
    // always goes through the cheap tick path, never the full panel rebuild: rebuilding the add-code /
    // add-name inputs on every incoming position would blow away whatever the player is mid-typing.
    if (m.map && m.map !== mapData.key) { p.map = m.map; p.status = `on ${String(m.map).slice(0, 32)} (not ${mapData.key})`; (ui.tick ?? ui.render)?.(); return; }
    p.map = m.map ?? mapData.key;
    p.lastAt = Date.now(); // this is a usable position for THIS map — mark it fresh before anything below reads state
    const ll = pos(m);
    if (!p.marker) {
      p.marker = L.marker(ll, { icon: arrowIcon(p.color), pane, interactive: true }).addTo(map).bindTooltip(esc(p.name), { permanent: true, direction: 'right', offset: [14, 0], className: 'player-tip' });
      p.trail = L.polyline([], { color: p.color, weight: 3, opacity: 0.8, pane }).addTo(map);
    } else p.marker.setLatLng(ll);
    setHeading(p, m.yaw);
    // First message after (re)connect is the relay's replay of the last known point: place the marker, don't
    // extend the trail from it. Likewise skip a segment that jumps further than a player can move.
    const prev = p.last;
    const jumped = prev && Math.hypot(m.x - prev.x, m.z - prev.z) > TELEPORT_UNITS;
    if (!opts.trail) p.trail.setLatLngs([]);
    else if (p.resume || jumped) p.trail.setLatLngs([ll]);
    else p.trail.addLatLng(ll);
    p.resume = false;
    p.last = m;
    if (opts.follow && primary()?.code === p.code) {
      map.panTo(ll, { animate: true, duration: 0.4 });
      hooks.onFollow?.(m.x, m.z);
    }
    p.status = `x ${m.x.toFixed(0)} z ${m.z.toFixed(0)}`;
    (ui.tick ?? ui.render)?.();
  }

  function connect(p) {
    const ws = new WebSocket(`${RELAY}/sub/${p.code}`);
    p.ws = ws; p.status = 'connecting…'; p.resume = true; ui.render();
    ws.onopen = () => { p.status = 'waiting for companion'; ui.render(); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'pos') onPos(p, m);
      // The quest set carries `t`, not `type` — accept either so a relay that normalises the
      // envelope, and one that forwards the companion's message verbatim, both work.
      else if ((m.t ?? m.type) === 'quests') onQuests(p.code, m);
      else if (m.type === 'status' || m.type === 'hello') { p.online = m.publishers > 0; if (!p.last) p.status = p.online ? 'companion online' : 'waiting for companion'; ui.render(); }
    };
    ws.onclose = () => { if (players.has(p.code)) { p.status = 'reconnecting…'; ui.render(); setTimeout(() => connect(p), 2000); } };
  }

  function add(codeRaw, name, { override = false } = {}) {
    const code = normCode(codeRaw);
    if (!CODE_RE.test(code)) throw new Error('Code must be 6 letters/numbers, e.g. K7P3QX');
    if (players.has(code)) return;
    const p = { code, name: (name || '').trim().slice(0, 24) || code, nameOverride: override && !!name, color: COLORS[players.size % COLORS.length], status: '', last: null, lastAt: null, map: null };
    players.set(code, p); connect(p); persist();
  }
  function rename(code, name) {
    const p = players.get(code); if (!p) return;
    p.name = (name || '').trim().slice(0, 24) || p.code; p.nameOverride = !!name.trim();
    p.marker?.setTooltipContent(esc(p.name)); persist(); ui.render();
  }
  function remove(code) {
    const p = players.get(code); if (!p) return;
    players.delete(code); p.ws?.close(); p.marker?.remove(); p.trail?.remove();
    if (opts.primary === code) opts.primary = null;
    // Their quest set goes with them — "My quests" must never outlive the code that fed it.
    if (questSets.delete(code)) hooks.onQuests?.(quests());
    persist(); ui.render();
  }
  function persist() {
    try { localStorage.setItem('tarkovzero:live', JSON.stringify({ players: [...players.values()].map((p) => ({ code: p.code, name: p.name, override: p.nameOverride })), primary: opts.primary })); }
    catch {}
  }
  function restore() {
    try {
      const raw = JSON.parse(localStorage.getItem('tarkovzero:live') || '[]');
      const list = Array.isArray(raw) ? raw : (raw.players ?? []); // migrate from the old bare-array format
      for (const e of list) { if (typeof e === 'string') add(e); else add(e.code, e.name !== e.code ? e.name : '', { override: !!e.override }); }
      if (!Array.isArray(raw) && raw.primary && players.has(raw.primary)) opts.primary = raw.primary;
    } catch {}
  }
  function clearTrails() { for (const p of players.values()) p.trail?.setLatLngs([]); }

  // 1 Hz ticker: nothing new has to arrive for "3s ago" to become "4s ago", or for streaming to tip
  // over into stale after STALE_MS of silence. ui.tick, when the caller provides it, is the *cheap*
  // path (text/attribute updates only) — ui.render stays reserved for real structural events.
  setInterval(() => {
    // The QA player is a still life: hold its age at the one the forced state describes, or a
    // screenshot taken 20 s into a settle reads "streaming · 20s ago" past STALE_MS.
    if (QA_STATE) { const p = players.get('QA0000'); if (p?.lastAt) p.lastAt = Date.now() - QA_AGE_MS[QA_STATE]; }
    if (players.size || QA_STATE) (ui.tick ?? ui.render)?.();
  }, 1000);
  applyQaQuests();
  applyQaLive();

  return { players, opts, add, remove, rename, restore, clearTrails, relay: RELAY, summary, primary, setPrimary, state, quests };
}
