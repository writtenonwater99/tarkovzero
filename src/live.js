import L from 'leaflet';
import { pos } from './crs.js';

// Live player positions from the relay. One subscription per pairing code; each code gets its own
// coloured arrow + trail. Designed for several codes at once (you + friends) even though v1 UI is solo.
const RELAY = import.meta.env.VITE_RELAY_URL || (import.meta.env.DEV ? 'ws://localhost:8787' : 'wss://tarkovzero-relay.fly.dev');
const COLORS = ['#ff3d3d', '#3d9bff', '#3dff7a', '#ffd23d', '#d63dff', '#3dfff0'];
const CODE_RE = /^[A-Z0-9]{6}$/;
export const normCode = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function createLive(map, mapData, ui) {
  const players = new Map();
  const opts = { follow: true, trail: true };
  const pane = 'live';
  map.createPane(pane); map.getPane(pane).style.zIndex = 650;

  const arrowIcon = (color) => L.divIcon({
    className: '',
    html: `<div class="player-arrow" style="--c:${color}"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 2 20 21l-8-4-8 4z"/></svg></div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });

  function setHeading(p, yaw) {
    const el = p.marker.getElement()?.querySelector('.player-arrow');
    // Game yaw 0 = +Z, which points down on this map (coordinateRotation 180): screen angle = yaw + 180.
    if (el) el.style.transform = `rotate(${(yaw ?? 0) + (mapData.coordinateRotation ?? 0)}deg)`;
  }

  function onPos(p, m) {
    if (m.map && m.map !== mapData.key) { p.status = `on ${m.map}`; ui.render(); return; }
    const ll = pos(m);
    p.last = m;
    if (!p.marker) {
      p.marker = L.marker(ll, { icon: arrowIcon(p.color), pane, interactive: true }).addTo(map).bindTooltip(p.name, { permanent: true, direction: 'right', offset: [14, 0], className: 'player-tip' });
      p.trail = L.polyline([], { color: p.color, weight: 3, opacity: 0.8, pane }).addTo(map);
    } else p.marker.setLatLng(ll);
    setHeading(p, m.yaw);
    if (opts.trail) p.trail.addLatLng(ll); else p.trail.setLatLngs([]);
    if (opts.follow && [...players.values()].indexOf(p) === 0) map.panTo(ll, { animate: true, duration: 0.4 });
    p.status = `x ${m.x.toFixed(0)} z ${m.z.toFixed(0)}`;
    ui.render();
  }

  function connect(p) {
    const ws = new WebSocket(`${RELAY}/sub/${p.code}`);
    p.ws = ws; p.status = 'connecting…'; ui.render();
    ws.onopen = () => { p.status = 'waiting for companion'; ui.render(); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'pos') onPos(p, m);
      else if (m.type === 'status' || m.type === 'hello') { p.online = m.publishers > 0; if (!p.last) p.status = p.online ? 'companion online' : 'waiting for companion'; ui.render(); }
    };
    ws.onclose = () => { if (players.has(p.code)) { p.status = 'reconnecting…'; ui.render(); setTimeout(() => connect(p), 2000); } };
  }

  function add(codeRaw, name) {
    const code = normCode(codeRaw);
    if (!CODE_RE.test(code)) throw new Error('Code must be 6 letters/numbers, e.g. K7P3QX');
    if (players.has(code)) return;
    const p = { code, name: name || code, color: COLORS[players.size % COLORS.length], status: '', last: null };
    players.set(code, p); connect(p); persist();
  }
  function remove(code) {
    const p = players.get(code); if (!p) return;
    players.delete(code); p.ws?.close(); p.marker?.remove(); p.trail?.remove(); persist(); ui.render();
  }
  function persist() { try { localStorage.setItem('tarkovzero:live', JSON.stringify([...players.keys()])); } catch {} }
  function restore() { try { for (const c of JSON.parse(localStorage.getItem('tarkovzero:live') || '[]')) add(c); } catch {} }
  function clearTrails() { for (const p of players.values()) p.trail?.setLatLngs([]); }

  return { players, opts, add, remove, restore, clearTrails, relay: RELAY };
}
