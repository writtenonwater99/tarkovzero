// Snapshot tarkov.dev API data into public/data/<map>.json so the app works when the API is down.
import { writeFile, mkdir } from 'node:fs/promises';
import { QUERY, API_URL } from '../src/api.js';

const maps = process.argv.slice(2).length ? process.argv.slice(2) : ['customs'];
const res = await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: QUERY }),
});
const json = await res.json();
if (!json.data) { console.error('API error:', json.errors); process.exit(1); }
await mkdir('public/data', { recursive: true });
for (const name of maps) {
  const m = json.data.maps.find((x) => x.normalizedName === name);
  if (!m) { console.error(`no map ${name}`); continue; }
  await writeFile(`public/data/${name}.json`, JSON.stringify(m, null, 1));
  console.log(`wrote public/data/${name}.json: ${m.extracts.length} extracts, ${m.spawns.length} spawns, ${m.locks.length} locks`);
}
