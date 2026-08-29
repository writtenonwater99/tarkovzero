import L from 'leaflet';
import { pos } from './crs.js';

// Live player positions from the relay. One subscription per pairing code; each code gets its own
// coloured arrow + trail. Designed for several codes at once (you + friends) even though v1 UI is solo.
const RELAY = import.meta.env.VITE_RELAY_URL || (import.meta.env.DEV ? 'ws://localhost:8787' : 'wss://tarkovzero-relay.fly.dev');
export const COLORS = ['#ff3d3d', '#3d9bff', '#3dff7a', '#ffd23d', '#d63dff', '#3dfff0'];
const CODE_RE = /^[A-Z0-9]{6}$/;
export const normCode = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Names/status can come from anyone publishing to a code — always escape before rendering as HTML.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createLive(map, mapData, ui) {
  const players = new Map();
  const opts = { follow: true, trail: true };
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

  const TELEPORT_UNITS = 300; // a trail jump longer than this (game units) is a teleport / stale replay, not movement

  function onPos(p, m) {
    // Username sent by the companion wins over the code; a name typed on the site is a fallback/override.
    if (typeof m.name === 'string' && m.name.trim() && m.name.trim() !== p.name && (!p.nameOverride || p.name === p.code)) {
      p.name = m.name.trim().slice(0, 24);
      p.marker?.setTooltipContent(esc(p.name));
      persist();
    }
    if (m.map && m.map !== mapData.key) { p.map = m.map; p.status = `on ${String(m.map).slice(0, 32)} (not ${mapData.key})`; ui.render(); return; }
    p.map = m.map ?? mapData.key;
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
    if (opts.follow && [...players.values()].indexOf(p) === 0) map.panTo(ll, { animate: true, duration: 0.4 });
    p.status = `x ${m.x.toFixed(0)} z ${m.z.toFixed(0)}`;
    ui.render();
  }

  function connect(p) {
    const ws = new WebSocket(`${RELAY}/sub/${p.code}`);
    p.ws = ws; p.status = 'connecting…'; p.resume = true; ui.render();
    ws.onopen = () => { p.status = 'waiting for companion'; ui.render(); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'pos') onPos(p, m);
      else if (m.type === 'status' || m.type === 'hello') { p.online = m.publishers > 0; if (!p.last) p.status = p.online ? 'companion online' : 'waiting for companion'; ui.render(); }
    };
    ws.onclose = () => { if (players.has(p.code)) { p.status = 'reconnecting…'; ui.render(); setTimeout(() => connect(p), 2000); } };
  }

  function add(codeRaw, name, { override = false } = {}) {
    const code = normCode(codeRaw);
    if (!CODE_RE.test(code)) throw new Error('Code must be 6 letters/numbers, e.g. K7P3QX');
    if (players.has(code)) return;
    const p = { code, name: (name || '').trim().slice(0, 24) || code, nameOverride: override && !!name, color: COLORS[players.size % COLORS.length], status: '', last: null, map: null };
    players.set(code, p); connect(p); persist();
  }
  function rename(code, name) {
    const p = players.get(code); if (!p) return;
    p.name = (name || '').trim().slice(0, 24) || p.code; p.nameOverride = !!name.trim();
    p.marker?.setTooltipContent(esc(p.name)); persist(); ui.render();
  }
  function remove(code) {
    const p = players.get(code); if (!p) return;
    players.delete(code); p.ws?.close(); p.marker?.remove(); p.trail?.remove(); persist(); ui.render();
  }
  function persist() { try { localStorage.setItem('tarkovzero:live', JSON.stringify([...players.values()].map((p) => ({ code: p.code, name: p.name, override: p.nameOverride })))); } catch {} }
  function restore() {
    try {
      for (const e of JSON.parse(localStorage.getItem('tarkovzero:live') || '[]')) {
        if (typeof e === 'string') add(e); else add(e.code, e.name !== e.code ? e.name : '', { override: !!e.override });
      }
    } catch {}
  }
  function clearTrails() { for (const p of players.values()) p.trail?.setLatLngs([]); }

  return { players, opts, add, remove, rename, restore, clearTrails, relay: RELAY };
}
