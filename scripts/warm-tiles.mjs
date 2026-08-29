// Pre-download all Customs tiles into the dev-server cache (.cache/) so zooming is instant offline.
import { mkdir, writeFile, access } from 'node:fs/promises';
const base = 'maps/customs_0.16/main';
const jobs = [];
for (let z = 2; z <= 6; z++) for (let x = 0; x < 1 << z; x++) for (let y = 0; y < 1 << z; y++) jobs.push([z, x, y]);
let done = 0, failed = 0;
async function worker() {
  while (jobs.length) {
    const [z, x, y] = jobs.pop();
    const file = `.cache/${base}/${z}/${x}/${y}.png`;
    try { await access(file); done++; continue; } catch {}
    try {
      const r = await fetch(`https://assets.tarkov.dev/${base}/${z}/${x}/${y}.png`);
      if (!r.ok) throw new Error(r.status);
      await mkdir(`.cache/${base}/${z}/${x}`, { recursive: true });
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
      done++;
    } catch { failed++; }
    if ((done + failed) % 500 === 0) console.log(`${done} done, ${failed} failed`);
  }
}
await Promise.all(Array.from({ length: 24 }, worker));
console.log(`finished: ${done} tiles, ${failed} failed`);
