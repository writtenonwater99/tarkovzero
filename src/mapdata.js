// In dev, assets go through the Vite dev-server cache (vite.config.js); in production straight to the
// tarkov.dev CDN. `?.` because this registry is the map geometry the Node tests read too, and outside
// a bundler `import.meta.env` is undefined — same pattern as src/assistant.js.
const ASSETS = import.meta.env?.DEV ? '/tiles' : 'https://assets.tarkov.dev';

// Interactive map configs mirrored from tarkov.dev's maps.json (author: Shebuka / the-hideout).
// bounds and svgBounds stay in tarkov.dev's [[x,z],[x,z]] order; crs.js swaps them for Leaflet.
export const MAPS = {
  customs: {
    key: 'customs', name: 'Customs', raid: { minutes: 40, pmc: '10–12' },
    tileSize: 256, minZoom: 2, maxZoom: 6,
    transform: [0.239, 168.65, 0.239, 136.35], coordinateRotation: 180,
    bounds: [[698, -307], [-372, 237]],
    svgPath: `${ASSETS}/maps/svg/Customs.svg`, svgLayer: 'Ground_Level',
    tilePath: `${ASSETS}/maps/customs_0.16/main/{z}/{x}/{y}.png`,
    floors: ['all', 0, 1, 2, 3, 'U'],
  },
  reserve: {
    key: 'reserve', name: 'Reserve', raid: { minutes: 40, pmc: '9–11' },
    tileSize: 256, minZoom: 2, maxZoom: 6,
    transform: [0.395, 122, 0.395, 137.65], coordinateRotation: 180,
    bounds: [[289, -293], [-303, 244]],
    svgBounds: [[289, -274], [-303, 272]],
    svgPath: `${ASSETS}/maps/svg/Reserve.svg`, svgLayer: 'Ground_Level',
    tilePath: `${ASSETS}/maps/reserve/main/{z}/{x}/{y}.png`,
    floors: ['all', 0, 1, 2, 3, 4, 'U'],
  },
  woods: {
    key: 'woods', name: 'Woods', raid: { minutes: 35, pmc: '10–14' },
    tileSize: 256, minZoom: 2, maxZoom: 6,
    transform: [0.1855, 112.95, 0.1855, 167.85], coordinateRotation: 180,
    bounds: [[646, -914], [-761, 442]],
    svgPath: `${ASSETS}/maps/svg/Woods.svg`, svgLayer: 'Ground_Level',
    tilePath: `${ASSETS}/maps/woods/main_0.16/{z}/{x}/{y}.png`,
    floors: ['all', 0],
  },
};

export const CUSTOMS = MAPS.customs;
export const selectMap = (key) => MAPS[String(key || '').toLowerCase()] ?? CUSTOMS;
