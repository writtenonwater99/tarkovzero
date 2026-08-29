export const API_URL = 'https://api.tarkov.dev/graphql';

export const QUERY = `{
  maps(lang: en) {
    name normalizedName
    extracts { id name faction position { x y z } }
    spawns { position { x y z } sides categories zoneName }
    bosses { name spawnChance spawnLocations { name chance } }
    hazards { name position { x y z } }
    stationaryWeapons { stationaryWeapon { name } position { x y z } }
    locks { lockType key { name } position { x y z } }
  }
}`;

export async function fetchMapData(normalizedName) {
  const res = await fetch('/api/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY }),
  });
  const json = await res.json();
  if (!json.data) throw new Error(json.errors?.[0]?.message ?? json.errors?.[0] ?? 'API error');
  const map = json.data.maps.find((m) => m.normalizedName === normalizedName);
  if (!map) throw new Error(`map ${normalizedName} not in API response`);
  return map;
}

/** Live API first, falls back to the snapshot in public/data (see scripts/fetch-data.mjs). */
export async function loadMapData(normalizedName) {
  try {
    return { data: await fetchMapData(normalizedName), source: 'live' };
  } catch (e) {
    console.warn('tarkov.dev API failed, using snapshot:', e.message);
    const res = await fetch(`/data/${normalizedName}.json`);
    if (!res.ok || !res.headers.get('content-type')?.includes('json'))
      throw new Error(`tarkov.dev API unavailable and no local snapshot (run: npm run fetch-data)`);
    const data = await res.json();
    return { data, source: data.source ?? 'snapshot' };
  }
}
