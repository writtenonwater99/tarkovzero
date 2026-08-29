// Marker icons: white stroke glyphs on a coloured badge. Badge shape encodes the category —
// extracts = rounded square, spawns = circle, utilities (weapons/switches/locks/hazards) = diamond.
const S = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
import { ART } from './icon-art.js';
const A = (k) => `<g transform='scale(0.046875)'><path d='${ART[k]}'/></g>`; // 512 -> 24
const GLYPH = {
  gi_exit: A('exit'), gi_transit: A('transit'), gi_gasmask: A('gasmask'), gi_hood: A('hood'), gi_crosshair: A('crosshair'), gi_crownskull: A('crownskull'), gi_radioactive: A('radioactive'), gi_sentry: A('sentry'), gi_lever: A('lever'), gi_padlock: A('padlock'), gi_stairs: A('stairs'),
  // toy-soldier silhouettes (one colour, no badge). 24x24, feet at y=23.
  armyman: `<path d='M12 1.5a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zM9.2 6.6h5.6l1.4 1.2 3.9-1.6.7 1.6-4 2.3-.8 5.4h-1.1l.3 7.5h-2.2l-.6-6h-.8l-.6 6H9.8l.3-7.5H9l-.8-5.2-3.3-1 .4-1.7 3.2.6z'/><path d='M4 23h16v.8H4z' opacity='.9'/>`,
  hoodman: `<path d='M12 1.2c-2.2 0-3.3 1.8-3.3 3.6v1.7h6.6V4.8c0-1.8-1.1-3.6-3.3-3.6zM9.3 7.1h5.4l1.1 1 3.5 3.6-1.2 1.2-2.4-2.1-.3 5h-1l.4 7.5h-2.1l-.5-6h-.8l-.5 6H9.1l.4-7.5h-1l-.3-5-2.4 2.1-1.2-1.2 3.5-3.6z'/><path d='M4 23h16v.8H4z' opacity='.9'/>`,
  prone: `<path d='M20.5 12.2a1.9 1.9 0 1 1-3.8 0 1.9 1.9 0 0 1 3.8 0zM2.5 17.6l14.2-.4 1.1-2.9h2.6l1 .9-2.2 4.5-1.6.3-.3 2.4h-1.6l-.2-2.3-6.1.2-1.7 2.1H6.2l1.1-2.1H2.5z'/><path d='M12.6 9.4l7.9-4.2.6 1.1-7.7 4.5z'/><path d='M2 23h20v.8H2z' opacity='.9'/>`,
  bossman: `<path d='M12 .8a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM8.6 6.9h6.8l1.9 1.4 4 .9-.4 1.8-3.6-.4-.9 5.6h-1.2l.4 7.8h-2.4l-.7-6.3h-1l-.7 6.3H8.4l.4-7.8H7.6l-.9-5.6-3.6.4-.4-1.8 4-.9z'/><path d='M9.4 1.2h5.2l-.6 1.6h-4z'/><path d='M4 23h16v.8H4z' opacity='.9'/>`,
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

// Palette (TRACK C accents): greens = your way out, blues/ambers = people, reds = danger,
// neutrals = utilities. The four extract hues are re-used by the 3D name chips' borders and by
// the sidebar rows, so toggling 'Scav extracts' visibly removes exactly the orange-bordered chips.
export const KINDS = {
  'extract-pmc':     { label: 'PMC extracts',       glyph: 'gi_exit',      color: '#2DBE6C', shape: 'sq'  },
  'extract-scav':    { label: 'Scav extracts',      glyph: 'gi_exit',  color: '#E0872B', shape: 'sq'  },
  'extract-shared':  { label: 'Shared extracts',    glyph: 'gi_exit',      color: '#2DBE6C', color2: '#E0872B', shape: 'sq' },
  'extract-transit': { label: 'Transits',           glyph: 'gi_transit',   color: '#3A96BA', shape: 'sq'  },
  'spawn-pmc':       { label: 'PMC spawns',         glyph: 'gi_gasmask',   color: '#7fa0b4', shape: 'fig' },
  'spawn-scav':      { label: 'Scav spawns',        glyph: 'gi_hood',   color: '#c9a463', shape: 'fig' },
  'spawn-sniper':    { label: 'Sniper scav spawns', glyph: 'gi_crosshair',     color: '#e2793f', shape: 'fig' },
  'spawn-boss':      { label: 'Boss spawns',        glyph: 'gi_crownskull',   color: '#d24a4a', shape: 'fig' },
  'hazard':          { label: 'Hazards',            glyph: 'gi_radioactive',   color: '#8258A6', shape: 'dia' },
  'weapon':          { label: 'Stationary weapons', glyph: 'gi_sentry',    color: '#6E6860', shape: 'dia' },
  'switch':          { label: 'Switches / levers',  glyph: 'gi_lever',     color: '#D6B236', shape: 'dia' },
  'lock':            { label: 'Locks',              glyph: 'gi_padlock',      color: '#808682', shape: 'dia' },
};
// Letter codes for extracts (re3mr-style badges); null -> draw the glyph
export const EXTRACT_LETTER = { 'Dorms V-Ex': 'D', 'Crossroads': 'C', 'Trailer Park': 'TP', 'Old Gas Station': 'OG', 'RUAF Roadblock': 'R', "Smugglers' Boat": 'SB', 'ZB-1011': '11', 'Smugglers\' Bunker (ZB-1012)': '12', 'ZB-013': '13', 'Railroad to Tarkov': 'R2', 'Railroad to Port': 'R1', 'Railroad to Military Base': 'R3', 'Sniper Roadblock': 'N', 'Old Road Gate': 'O', 'Passage Between Rocks': 'P', 'Military Base CP': 'M', 'Scav Checkpoint': 'S', 'Administration Gate': 'A', 'Factory Far Corner': 'F', 'Warehouse 4': '4', 'Factory Shacks': 'Y', 'Old Gas Station Gate': 'L', 'Warehouse 17': '17', "Trailer Park Workers' Shack": 'I', 'Boiler Room Basement (Co-op)': 'Z', 'Railroad Passage (Flare)': 'W', 'Transit to Factory': 'H', 'Transit to Reserve': 'V', 'Transit to Interchange': 'G', 'Transit to Shoreline': 'E' };
export const extractLetter = (name) => EXTRACT_LETTER[(name || '').trim()] ?? null;

// badge key line + cream inner rule; both come straight from the TRACK C palette (ink / cream)
const KEY = '#0E1211', CREAM = '#E6E3D7';
function badgeSvg(k, letter, level = 'surface') {
  if (k.shape === 'fig') return `<circle cx='12' cy='12' r='11' fill='#0a0e0c' fill-opacity='.45'/><g fill='${k.color}' transform='translate(2.6 2.6) scale(.78)'>${GLYPH[k.glyph]}</g>`; // one-colour art glyph on a faint disc
  const shape = k.shape === 'ci' ? `<circle cx='12' cy='12' r='10.4' fill='${k.color}'/>`
    : k.shape === 'sq' ? `<rect x='1.8' y='1.8' width='20.4' height='20.4' rx='5' fill='${k.color}'/>`
    : `<rect x='4' y='4' width='16' height='16' rx='3' transform='rotate(45 12 12)' fill='${k.color}'/>`;
  const split = k.color2 ? `<clipPath id='c'><rect x='1.8' y='1.8' width='20.4' height='20.4' rx='5'/></clipPath><path d='M1.8 22.2 22.2 1.8v20.4z' fill='${k.color2}' clip-path='url(#c)'/>` : '';
  const key = k.shape === 'ci' ? `<circle cx='12' cy='12' r='10.4' fill='none' stroke='${KEY}' stroke-width='1.6'/><circle cx='12' cy='12' r='9.5' fill='none' stroke='${CREAM}' stroke-width='1'/>`
    : k.shape === 'sq' ? `<rect x='1.8' y='1.8' width='20.4' height='20.4' rx='5' fill='none' stroke='${KEY}' stroke-width='1.6'/><rect x='2.8' y='2.8' width='18.4' height='18.4' rx='4.2' fill='none' stroke='${CREAM}' stroke-width='1'/>`
    : `<rect x='4' y='4' width='16' height='16' rx='3' transform='rotate(45 12 12)' fill='none' stroke='${KEY}' stroke-width='1.6'/>`;
  const ring = k.ring ? `<circle cx='12' cy='12' r='11.6' fill='none' stroke='${CREAM}' stroke-width='0.8'/>` : '';
  const inner = letter ? `<text x='12' y='16.6' text-anchor='middle' font-family='Barlow Condensed, Arial Narrow, sans-serif' font-weight='700' font-size='${letter.length > 2 ? 9 : letter.length > 1 ? 11 : 13}' fill='${CREAM}'>${letter}</text>` : `<g fill='#fff' transform='translate(4.6 4.6) scale(.62)'>${GLYPH[k.glyph]}</g>`;
  // An underground badge must remain recognisable even when its colour is muted by
  // the marker-opacity setting: dashed extract outline + a universal down/stairs cue.
  const underground = level === 'underground'
    ? `${k.shape === 'sq' ? `<rect x='2.8' y='2.8' width='18.4' height='18.4' rx='4.2' fill='none' stroke='#FFD28A' stroke-width='1.2' stroke-dasharray='2.3 1.7'/>` : ''}<g><rect x='14.1' y='14.1' width='8.2' height='8.2' rx='2' fill='${KEY}' stroke='#FFD28A' stroke-width='.7'/><path d='M18.2 15.8v4.5m-1.7-1.7 1.7 1.7 1.7-1.7' fill='none' stroke='#FFD28A' stroke-width='1.25' stroke-linecap='round' stroke-linejoin='round'/></g>`
    : '';
  return `${shape}${split}${key}${ring}${inner}${underground}`;
}
export function iconHtml(kind, size = 24, letter = null, level = 'surface') {
  const k = KINDS[kind];
  return `<div class="mk ${k.shape} level-${level}" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size}" height="${size}">${badgeSvg(k, letter, level)}</svg></div>`;
}
export function iconDataUrl(kind, size = 48, letter = null, level = 'surface') {
  const k = KINDS[kind];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${badgeSvg(k, letter, level)}</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
export const soldierDataUrl = (color, size = 64) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11.5" fill="#0a0e0c" fill-opacity=".55"/><g fill="${color}" transform="translate(2.6 2.6) scale(.78)">${GLYPH.gi_gasmask}</g></svg>`);
export const arrowDataUrl = (color, size = 64) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2 20 21l-8-4-8 4z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`);
