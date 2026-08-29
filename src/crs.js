import L from 'leaflet';

// Game coords -> map pixels, same approach as tarkov.dev.
// Leaflet "lat" = game z, "lng" = game x.
function applyRotation(latLng, rotation) {
  if (!latLng.lng && !latLng.lat) return L.latLng(0, 0);
  if (!rotation) return latLng;
  const a = (rotation * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const { lng: x, lat: y } = latLng;
  return L.latLng(x * sin + y * cos, x * cos - y * sin);
}

export function getCRS(mapData) {
  const [sx, mx, sy, my] = mapData.transform;
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(sx, mx, -sy, my),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (latLng) =>
        L.Projection.LonLat.project(applyRotation(latLng, mapData.coordinateRotation)),
      unproject: (point) =>
        applyRotation(L.Projection.LonLat.unproject(point), -mapData.coordinateRotation),
    }),
  });
}

/** {x,y,z} game position -> Leaflet latLng array */
export const pos = (p) => [p.z, p.x];

/** tarkov.dev bounds ([[x,z],[x,z]]) -> Leaflet LatLngBounds ([z,x]) */
export const toLatLngBounds = (b) => L.latLngBounds([b[0][1], b[0][0]], [b[1][1], b[1][0]]);
