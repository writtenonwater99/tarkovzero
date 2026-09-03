// In dev, assets go through the Vite dev-server cache (vite.config.js); in production straight to the
// tarkov.dev CDN. `?.` because this registry is the map geometry the Node tests read too, and outside
// a bundler `import.meta.env` is undefined — same pattern as src/assistant.js.
const ASSETS = import.meta.env?.DEV ? '/tiles' : 'https://assets.tarkov.dev';

// Availability is decided in ONE place and this registry is not it — see src/map-availability.js.
// `MAPS` below is the RENDER DATA: three maps, all three complete, all three still under test.
// Whether a visitor may reach one is a separate question, asked here only by `selectMap` and
// `resolveMapRequest` at the bottom of the file.
import {
  MAPPED_MAP_KEYS, assertAvailabilityIsBuildable, isAvailableMap, isLockedMap, normalizeMapRequestKey,
} from './map-availability.js';

// Interactive map configs mirrored from tarkov.dev's maps.json (author: Shebuka / the-hideout).
// bounds and svgBounds stay in tarkov.dev's [[x,z],[x,z]] order; crs.js swaps them for Leaflet.
//
// `minZoom` is Leaflet's floor, `minNativeZoom` the lowest zoom tarkov.dev actually ships tiles for.
// They used to be the same number (2) and that made the floor a silent CROP: Leaflet clamps
// `setView` to minZoom without telling anyone, and Woods' 2D first-visit contain fit is 1.69 — so
// the fit asked for the whole map, got zoom 2, and the first thing a visitor saw on the biggest
// shipped map was its north and south rims cut off with an extract badge half under the window edge
// (QA H2). The floor drops to 1; below `minNativeZoom` Leaflet upscales the z2 tiles instead of
// requesting tiles that do not exist.
export const MAPS = {
  customs: {
    key: 'customs', name: 'Customs', raid: { minutes: 40, pmc: '10–12' },
    tileSize: 256, minZoom: 1, minNativeZoom: 2, maxZoom: 6,
    transform: [0.239, 168.65, 0.239, 136.35], coordinateRotation: 180,
    bounds: [[698, -307], [-372, 237]],
    svgPath: `${ASSETS}/maps/svg/Customs.svg`, svgLayer: 'Ground_Level',
    tilePath: `${ASSETS}/maps/customs_0.16/main/{z}/{x}/{y}.png`,
  },
  reserve: {
    key: 'reserve', name: 'Reserve', raid: { minutes: 40, pmc: '9–11' },
    tileSize: 256, minZoom: 1, minNativeZoom: 2, maxZoom: 6,
    transform: [0.395, 122, 0.395, 137.65], coordinateRotation: 180,
    bounds: [[289, -293], [-303, 244]],
    svgBounds: [[289, -274], [-303, 272]],
    svgPath: `${ASSETS}/maps/svg/Reserve.svg`, svgLayer: 'Ground_Level',
    tilePath: `${ASSETS}/maps/reserve/main/{z}/{x}/{y}.png`,
  },
  woods: {
    key: 'woods', name: 'Woods', raid: { minutes: 35, pmc: '10–14' },
    tileSize: 256, minZoom: 1, minNativeZoom: 2, maxZoom: 6,
    transform: [0.1855, 112.95, 0.1855, 167.85], coordinateRotation: 180,
    bounds: [[646, -914], [-761, 442]],
    svgPath: `${ASSETS}/maps/svg/Woods.svg`, svgLayer: 'Ground_Level',
    tilePath: `${ASSETS}/maps/woods/main_0.16/{z}/{x}/{y}.png`,
  },
};

export const CUSTOMS = MAPS.customs;

// An availability list naming a map with no config here would give the picker an entry that opens
// onto nothing. Checked at module load, against the registry's own keys rather than a literal.
assertAvailabilityIsBuildable(Object.keys(MAPS));
if (MAPPED_MAP_KEYS.some((k) => !MAPS[k]) || Object.keys(MAPS).some((k) => !MAPPED_MAP_KEYS.includes(k))) {
  throw new Error(`MAPS ${Object.keys(MAPS).join(',')} and MAPPED_MAP_KEYS ${MAPPED_MAP_KEYS.join(',')} disagree`);
}

/**
 * What a `?map=` value resolves to, and WHY — so the caller can say something instead of silently
 * showing a different map than the one the URL named.
 *
 *   status 'default'    no `?map=` at all
 *   status 'available'  the map opens; `map` is its config
 *   status 'locked'     one of the eleven, not open yet (Reserve and Woods since 2026-09-02);
 *                       `map` is Customs, and `requested` is what was asked for
 *   status 'unknown'    not a map we have ever named; `map` is Customs
 *
 * `?map=woods` is a documented entry point, so it stays a working URL: it lands on Customs rather
 * than 404ing or showing a blank map, and main.js toasts what happened. It does NOT silently
 * pretend Customs is what was asked for.
 */
export function resolveMapRequest(key) {
  const requested = normalizeMapRequestKey(key);
  if (!requested) return { map: CUSTOMS, requested: null, status: 'default' };
  if (isAvailableMap(requested) && MAPS[requested]) return { map: MAPS[requested], requested, status: 'available' };
  return { map: CUSTOMS, requested, status: isLockedMap(requested) ? 'locked' : 'unknown' };
}

/**
 * The map config for a requested key. Availability is the gate, not the registry: `MAPS` still
 * carries Reserve and Woods, and `selectMap('woods')` still returns Customs, because Woods is
 * locked. Every navigation path in the app goes through here or through `resolveMapRequest`, so
 * there is exactly one way to reach a map: it is in `AVAILABLE_MAP_KEYS`.
 */
export const selectMap = (key) => resolveMapRequest(key).map;
