// Marker icons: small inline SVG glyphs on a coloured badge. Used on the map and in the sidebar legend.
const GLYPH = {
  // exit: door frame with arrow
  extract: '<path d="M4 3h8v18H4z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12h8m-3-3 3 3-3 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  // transit: double chevron
  transit: '<path d="M5 6l6 6-6 6M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  // spawn: person
  person: '<circle cx="12" cy="7" r="3.5" fill="currentColor"/><path d="M5 21c0-4.5 3-7 7-7s7 2.5 7 7z" fill="currentColor"/>',
  // boss: skull
  skull: '<path d="M12 2a8 8 0 0 0-8 8c0 3 1.5 5 3.5 6.3V20h9v-3.7C18.5 15 20 13 20 10a8 8 0 0 0-8-8z" fill="currentColor"/><circle cx="9" cy="10.5" r="2" fill="#000"/><circle cx="15" cy="10.5" r="2" fill="#000"/><path d="M10 17h1v3h-1zm3 0h1v3h-1z" fill="#000"/>',
  // sniper: crosshair
  crosshair: '<circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  // stationary weapon: gun
  gun: '<path d="M2 9h15l5 2-5 2h-4l-1 3H9l1-3H2z" fill="currentColor"/>',
  // lock: padlock
  lock: '<rect x="5" y="10" width="14" height="11" rx="2" fill="currentColor"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  // switch: lightning bolt
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/>',
  // hazard: warning triangle
  warn: '<path d="M12 3 2 21h20z" fill="currentColor"/><path d="M12 9v6m0 2.5v.5" stroke="#000" stroke-width="2.2" stroke-linecap="round"/>',
};

export const KINDS = {
  'extract-pmc':     { label: 'PMC extracts',       glyph: 'extract',   color: '#4caf50' },
  'extract-scav':    { label: 'Scav extracts',      glyph: 'extract',   color: '#ff9800' },
  'extract-shared':  { label: 'Shared extracts',    glyph: 'extract',   color: '#cddc39' },
  'extract-transit': { label: 'Transits',           glyph: 'transit',   color: '#00bcd4' },
  'spawn-pmc':       { label: 'PMC spawns',         glyph: 'person',    color: '#2196f3' },
  'spawn-scav':      { label: 'Scav spawns',        glyph: 'person',    color: '#ffeb3b' },
  'spawn-sniper':    { label: 'Sniper scav spawns', glyph: 'crosshair', color: '#ff5722' },
  'spawn-boss':      { label: 'Boss spawns',        glyph: 'skull',     color: '#f44336' },
  'hazard':          { label: 'Hazards',            glyph: 'warn',      color: '#9c27b0' },
  'weapon':          { label: 'Stationary weapons', glyph: 'gun',       color: '#8d6e63' },
  'switch':          { label: 'Switches / levers',  glyph: 'bolt',      color: '#ffc107' },
  'lock':            { label: 'Locks',              glyph: 'lock',      color: '#e0e0e0' },
};

export function iconHtml(kind, size = 22) {
  const k = KINDS[kind];
  return `<div class="mk" style="--c:${k.color};width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size * 0.7}" height="${size * 0.7}">${GLYPH[k.glyph]}</svg></div>`;
}
