# TarkovZero

https://tarkovzero.com — Customs prototype

Interactive (Google-Maps-style) Customs map built on Leaflet, using tarkov.dev tiles, SVG map and API.

```sh
npm install
npm run fetch-data            # snapshot tarkov.dev API -> public/data/customs.json (when the API is up)
npm run build-community-data  # same file from SPT database + EFT Wiki (works while the API is down)
npm run warm-tiles            # pre-download all Customs tiles into .cache/
npm run dev
```

- `src/mapdata.js` — Customs config (tile URL, bounds, game-coord transform) mirrored from tarkov.dev's maps.json
- `src/crs.js` — Leaflet CRS mapping game `{x,z}` -> map pixels (same math as tarkov.dev)
- `src/api.js` — GraphQL query + live/snapshot loader
- `src/main.js` — map, base layers (satellite tiles / abstract SVG, ground level only), toggleable overlays

Credits: map tiles and SVG by Shebuka / the-hideout (https://github.com/the-hideout/tarkov-dev-svg-maps), data from https://tarkov.dev.

## Marker data sources

At runtime the app tries the tarkov.dev API first and falls back to `public/data/customs.json`.
That file can be produced two ways:

- `npm run fetch-data` — tarkov.dev API (exact game data).
- `npm run build-community-data` — SPT server database (spawns, bosses; exact game coords) + EFT Wiki
  interactive map (extracts, transits, locks, guns, levers; wiki pixels converted to game coords with a
  4-point calibration, ~2–7 m error). Calibration pairs live in `scripts/build-community-data.mjs`.
