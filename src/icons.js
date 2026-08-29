// Marker icons: white stroke glyphs on a coloured badge. Badge shape encodes the category —
// extracts = rounded square, spawns = circle, utilities (weapons/switches/locks/hazards) = diamond.
const S = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const GLYPH = {
  exit: `<path d='M4 3h9v4h-3V6H7v12h3v-1h3v4H4z' fill='#fff'/><path d='M13 12h6.5m0 0-3-3m3 3-3 3' stroke='#fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' fill='none'/>`,
  exitScav: `<path d='M4 3h9v4h-3V6H7v12h3v-1h3v4H4z' fill='#fff'/><path d='M13 12h6.5m0 0-3-3m3 3-3 3' stroke='#fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' fill='none'/><path d='M6 2.2q3-2 6 0' stroke='#fff' stroke-width='1.6' fill='none'/>`,
  transit: `<path d='M5 6v12M19 6v12' stroke='#fff' stroke-width='2.2' stroke-linecap='round'/><path d='M3 12h15m0 0-3.5-3.5M18 12l-3.5 3.5' stroke='#fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' fill='none'/>`,
  soldier: `<path d='M7.5 10a4.5 4.5 0 0 1 9 0v1h-9z' fill='#fff'/><circle cx='12' cy='12' r='2.6' fill='#fff'/><path d='M5 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5z' fill='#fff'/><path d='M16.5 13.5 21 9' stroke='#fff' stroke-width='2' stroke-linecap='round'/>`,
  hood: `<path d='M12 3 6.5 13h11z' fill='#fff'/><circle cx='12' cy='11.5' r='2' fill='#2a2a2a'/><path d='M5 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5z' fill='#fff'/>`,
  crosshair: `<circle cx='12' cy='12' r='6' stroke='#fff' stroke-width='2.2' fill='none'/><path d='M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5' stroke='#fff' stroke-width='2.2' stroke-linecap='round'/><circle cx='12' cy='12' r='1.6' fill='#fff'/>`,
  skull: `<path d='M5 8l2.5 2 2-3 2.5 3 2.5-3 2 3L19 8v2H5z' fill='#fff'/><path d='M12 9.5a6 6 0 0 0-6 6c0 2 1 3.4 2.4 4.3V22h7.2v-2.2C17 18.9 18 17.5 18 15.5a6 6 0 0 0-6-6z' fill='#fff'/><circle cx='9.8' cy='15.5' r='1.3' fill='#b91c1c'/><circle cx='14.2' cy='15.5' r='1.3' fill='#b91c1c'/>`,
  trefoil: `<circle cx='12' cy='12' r='2' fill='#fff'/><path d='M12 12 8.5 5.9a7 7 0 0 1 7 0zM12 12l6.5 3.3a7 7 0 0 1-3.5 6.2zM12 12l-6.5 3.3a7 7 0 0 0 3.5 6.2z' fill='#fff'/>`,
  turret: `<path d='M3 9h12l5 2-5 2H9' fill='#fff'/><circle cx='7' cy='11' r='2.6' fill='#fff'/><path d='M7 13.5 4 21M7 13.5l3 7.5' stroke='#fff' stroke-width='2' stroke-linecap='round'/>`,
  lever: `<path d='M4 19h16' stroke='#fff' stroke-width='2.4' stroke-linecap='round'/><path d='M8 19 15 6' stroke='#fff' stroke-width='2.6' stroke-linecap='round'/><circle cx='15.5' cy='5.5' r='2.4' fill='#fff'/><circle cx='8' cy='19' r='2.2' fill='#fff'/>`,
  lock: `<rect x='5' y='11' width='14' height='9' rx='2' fill='#fff'/><path d='M8 11V8a4 4 0 0 1 8 0v3' stroke='#fff' stroke-width='2.4' fill='none'/><circle cx='12' cy='15.5' r='1.3' fill='#111'/>`,
};

// Palette: greens = your way out, blues/ambers = people, reds = danger, neutrals = utilities.
export const KINDS = {
  'extract-pmc':     { label: 'PMC extracts',       glyph: 'exit',      color: '#228b48', shape: 'sq'  },
  'extract-scav':    { label: 'Scav extracts',      glyph: 'exitScav',  color: '#d27818', shape: 'sq'  },
  'extract-shared':  { label: 'Shared extracts',    glyph: 'exit',      color: '#228b48', color2: '#d27818', shape: 'sq' },
  'extract-transit': { label: 'Transits',           glyph: 'transit',   color: '#187896', shape: 'sq'  },
  'spawn-pmc':       { label: 'PMC spawns',         glyph: 'soldier',   color: '#326fa8', shape: 'ci'  },
  'spawn-scav':      { label: 'Scav spawns',        glyph: 'hood',      color: '#c4a028', shape: 'ci'  },
  'spawn-sniper':    { label: 'Sniper scav spawns', glyph: 'crosshair', color: '#dc5a1e', shape: 'ci'  },
  'spawn-boss':      { label: 'Boss spawns',        glyph: 'skull',     color: '#be282c', shape: 'ci', ring: true },
  'hazard':          { label: 'Hazards',            glyph: 'trefoil',   color: '#9646be', shape: 'dia' },
  'weapon':          { label: 'Stationary weapons', glyph: 'turret',    color: '#6e6860', shape: 'dia' },
  'switch':          { label: 'Switches / levers',  glyph: 'lever',     color: '#dcb41e', shape: 'dia' },
  'lock':            { label: 'Locks',              glyph: 'lock',      color: '#828c96', shape: 'dia' },
};
// Letter codes for extracts (re3mr-style badges); null -> draw the glyph
export const EXTRACT_LETTER = { 'Dorms V-Ex': 'D', 'Crossroads': 'C', 'Trailer Park': 'TP', 'Old Gas Station': 'OG', 'RUAF Roadblock': 'R', "Smugglers' Boat": 'SB', 'ZB-1011': '11', 'Smugglers\' Bunker (ZB-1012)': '12', 'ZB-013': '13', 'Railroad to Tarkov': 'R2', 'Railroad to Port': 'R1', 'Railroad to Military Base': 'R3', 'Sniper Roadblock': 'N', 'Old Road Gate': 'O', 'Passage Between Rocks': 'P', 'Military Base CP': 'M', 'Scav Checkpoint': 'S', 'Administration Gate': 'A', 'Factory Far Corner': 'F', 'Warehouse 4': '4', 'Factory Shacks': 'Y', 'Old Gas Station Gate': 'L', 'Warehouse 17': '17', "Trailer Park Workers' Shack": 'I', 'Boiler Room Basement (Co-op)': 'Z', 'Railroad Passage (Flare)': 'W', 'Transit to Factory': 'H', 'Transit to Reserve': 'V', 'Transit to Interchange': 'G', 'Transit to Shoreline': 'E' };
export const extractLetter = (name) => EXTRACT_LETTER[(name || '').trim()] ?? null;

const KEY = '#0a0e0c', CREAM = '#f5f2e8';
function badgeSvg(k, letter) {
  const shape = k.shape === 'ci' ? `<circle cx='12' cy='12' r='10.4' fill='${k.color}'/>`
    : k.shape === 'sq' ? `<rect x='1.8' y='1.8' width='20.4' height='20.4' rx='5' fill='${k.color}'/>`
    : `<rect x='4' y='4' width='16' height='16' rx='3' transform='rotate(45 12 12)' fill='${k.color}'/>`;
  const split = k.color2 ? `<clipPath id='c'><rect x='1.8' y='1.8' width='20.4' height='20.4' rx='5'/></clipPath><path d='M1.8 22.2 22.2 1.8v20.4z' fill='${k.color2}' clip-path='url(#c)'/>` : '';
  const key = k.shape === 'ci' ? `<circle cx='12' cy='12' r='10.4' fill='none' stroke='${KEY}' stroke-width='1.6'/><circle cx='12' cy='12' r='9.5' fill='none' stroke='${CREAM}' stroke-width='1'/>`
    : k.shape === 'sq' ? `<rect x='1.8' y='1.8' width='20.4' height='20.4' rx='5' fill='none' stroke='${KEY}' stroke-width='1.6'/><rect x='2.8' y='2.8' width='18.4' height='18.4' rx='4.2' fill='none' stroke='${CREAM}' stroke-width='1'/>`
    : `<rect x='4' y='4' width='16' height='16' rx='3' transform='rotate(45 12 12)' fill='none' stroke='${KEY}' stroke-width='1.6'/>`;
  const ring = k.ring ? `<circle cx='12' cy='12' r='11.6' fill='none' stroke='${CREAM}' stroke-width='0.8'/>` : '';
  const inner = letter ? `<text x='12' y='16.6' text-anchor='middle' font-family='Barlow Condensed, Arial Narrow, sans-serif' font-weight='700' font-size='${letter.length > 2 ? 9 : letter.length > 1 ? 11 : 13}' fill='${CREAM}'>${letter}</text>` : `<g transform='translate(4.6 4.6) scale(.62)'>${GLYPH[k.glyph]}</g>`;
  return `${shape}${split}${key}${ring}${inner}`;
}
export function iconHtml(kind, size = 24, letter = null) {
  const k = KINDS[kind];
  return `<div class="mk ${k.shape}" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size}" height="${size}">${badgeSvg(k, letter)}</svg></div>`;
}
export function iconDataUrl(kind, size = 48, letter = null) {
  const k = KINDS[kind];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${badgeSvg(k, letter)}</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
export const arrowDataUrl = (color, size = 64) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2 20 21l-8-4-8 4z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`);
