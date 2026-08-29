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

async function fetchSnapshot(normalizedName) {
  const res = await fetch(`/data/${normalizedName}.json`);
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error(`no local snapshot for ${normalizedName}`);
  return res.json();
}

// The public API does not carry Wiki panel/floor metadata. Merge the generated
// community levels plus community-only switches and loot containers onto live
// objects by stable human name so production and the offline snapshot render identically.
function mergeCommunityMeta(live, community) {
  const extractMeta = new Map((community.extracts || []).map((e) => [`${e.name}|${e.faction}`, e]));
  const extractByName = new Map((community.extracts || []).map((e) => [e.name, e]));
  const lockMeta = new Map((community.locks || []).map((l) => [l.key?.name, l]));
  return {
    ...live,
    extracts: (live.extracts || []).map((e) => {
      const meta = extractMeta.get(`${e.name}|${e.faction}`) ?? extractByName.get(e.name);
      return meta ? { ...e, level: meta.level, note: meta.note ?? e.note } : { ...e, level: 'surface' };
    }),
    locks: (live.locks || []).map((l) => ({ ...l, level: lockMeta.get(l.key?.name)?.level ?? 'surface' })),
    switches: community.switches ?? live.switches ?? [],
    containers: community.containers ?? live.containers ?? [],
  };
}

/** Live API first, enriched/fallback from the reproducible community snapshot. */
export async function loadMapData(normalizedName) {
  const snapshot = await fetchSnapshot(normalizedName).catch(() => null);
  try {
    const live = await fetchMapData(normalizedName);
    return { data: snapshot ? mergeCommunityMeta(live, snapshot) : live, source: snapshot ? 'live + community levels' : 'live' };
  } catch (e) {
    console.warn('tarkov.dev API failed, using snapshot:', e.message);
    if (!snapshot) throw new Error(`tarkov.dev API unavailable and no local snapshot (run: npm run fetch-data)`);
    return { data: snapshot, source: snapshot.source ?? 'snapshot' };
  }
}
