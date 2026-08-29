// In dev, assets go through the Vite dev-server cache (vite.config.js); in production straight to the tarkov.dev CDN.
const ASSETS = import.meta.env.DEV ? '/tiles' : 'https://assets.tarkov.dev';
// Customs map config, mirrored from tarkov.dev's maps.json (author: Shebuka / the-hideout).
export const CUSTOMS = {
  key: 'customs',
  tileSize: 256,
  minZoom: 2,
  maxZoom: 6,
  transform: [0.239, 168.65, 0.239, 136.35],
  coordinateRotation: 180,
  bounds: [[698, -307], [-372, 237]], // [[x, z], [x, z]] as in tarkov.dev; swapped to [z, x] in crs.js
  svgPath: `${ASSETS}/maps/svg/Customs.svg`,
  svgLayer: 'Ground_Level',
  tilePath: `${ASSETS}/maps/customs_0.16/main/{z}/{x}/{y}.png`,
};
