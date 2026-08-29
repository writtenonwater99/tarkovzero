// Marker icons: white stroke glyphs on a coloured badge. Badge shape encodes the category —
// extracts = rounded square, spawns = circle, utilities (weapons/switches/locks/hazards) = diamond.
const S = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const GLYPH = {
  // door frame with arrow leaving it
  extract: `<g ${S}><path d="M10 4H5v16h5"/><path d="M12 12h9"/><path d="M17 8l4 4-4 4"/></g>`,
  // route between two points
  transit: `<g ${S}><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M7.5 16.5 16.5 7.5"/><path d="M13 7.5h3.5V11"/></g>`,
  // person: head + shoulders
  person: `<g ${S}><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-6 7-6s7 2.1 7 6"/></g>`,
  // crosshair
  crosshair: `<g ${S}><circle cx="12" cy="12" r="5.5"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="1" fill="currentColor"/></g>`,
  // skull
  skull: `<g ${S}><path d="M12 3a7.5 7.5 0 0 0-7.5 7.5c0 2.6 1.3 4.6 3.2 5.8V20h8.6v-3.7c1.9-1.2 3.2-3.2 3.2-5.8A7.5 7.5 0 0 0 12 3z"/><circle cx="9.3" cy="11" r="1.4" fill="currentColor" stroke="none"/><circle cx="14.7" cy="11" r="1.4" fill="currentColor" stroke="none"/><path d="M10.5 20v-2.5M13.5 20v-2.5"/></g>`,
  // mounted gun: barrel + mount
  gun: `<g ${S}><path d="M3 10h13l4 2-4 2H9"/><path d="M9 14l-2 6M12 14l-1 3"/><circle cx="7" cy="12" r="2.2"/></g>`,
  // padlock
  lock: `<g ${S}><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1" fill="currentColor" stroke="none"/></g>`,
  // lightning bolt
  bolt: `<g ${S}><path d="M13 3 5 14h6l-1 7 8-11h-6z"/></g>`,
  // warning triangle
  warn: `<g ${S}><path d="M12 4 21 20H3z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></g>`,
};

// Palette: greens = your way out, blues/ambers = people, reds = danger, neutrals = utilities.
export const KINDS = {
  'extract-pmc':     { label: 'PMC extracts',       glyph: 'extract',   color: '#22c55e', shape: 'sq'  },
  'extract-scav':    { label: 'Scav extracts',      glyph: 'extract',   color: '#f59e0b', shape: 'sq'  },
  'extract-shared':  { label: 'Shared extracts',    glyph: 'extract',   color: '#84cc16', shape: 'sq'  },
  'extract-transit': { label: 'Transits',           glyph: 'transit',   color: '#06b6d4', shape: 'sq'  },
  'spawn-pmc':       { label: 'PMC spawns',         glyph: 'person',    color: '#3b82f6', shape: 'ci'  },
  'spawn-scav':      { label: 'Scav spawns',        glyph: 'person',    color: '#eab308', shape: 'ci'  },
  'spawn-sniper':    { label: 'Sniper scav spawns', glyph: 'crosshair', color: '#f97316', shape: 'ci'  },
  'spawn-boss':      { label: 'Boss spawns',        glyph: 'skull',     color: '#ef4444', shape: 'ci'  },
  'hazard':          { label: 'Hazards',            glyph: 'warn',      color: '#a855f7', shape: 'dia' },
  'weapon':          { label: 'Stationary weapons', glyph: 'gun',       color: '#78716c', shape: 'dia' },
  'switch':          { label: 'Switches / levers',  glyph: 'bolt',      color: '#facc15', shape: 'dia' },
  'lock':            { label: 'Locks',              glyph: 'lock',      color: '#94a3b8', shape: 'dia' },
};

export function iconHtml(kind, size = 24) {
  const k = KINDS[kind];
  return `<div class="mk ${k.shape}" style="--c:${k.color};width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size * 0.66}" height="${size * 0.66}">${GLYPH[k.glyph]}</svg></div>`;
}
