// Crawl tarkov.dev task data (objectives with zones/positions) from the Tarkov Tools mirror while api.tarkov.dev is down.
// Output: scripts/data/tasks/tasks-mirror.json  (array of task objects as served by the tarkov.dev GraphQL schema)
import { writeFile, mkdir } from 'node:fs/promises';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
const idx = await (await fetch('https://tarkov.muedsa.com/tasks', { headers: { 'User-Agent': UA, RSC: '1' } })).text();
const slugs = [...new Set([...idx.matchAll(/\/tasks\/([a-z0-9-]+)/g)].map((m) => m[1]))];
console.log('slugs', slugs.length);
const tasks = []; let done = 0, fail = 0;
function extractTask(text) {
  const s = unesc(text);
  // find the JSON object that has "objectives": [ ... ] and a task id — take the largest balanced object containing "objectives"
  let best = null;
  for (const m of s.matchAll(/"objectives"\s*:\s*\[/g)) {
    // walk back to the enclosing '{'
    let depth = 0, start = -1;
    for (let i = m.index; i >= 0; i--) { const c = s[i]; if (c === '}') depth++; else if (c === '{') { if (depth === 0) { start = i; break; } depth--; } }
    if (start < 0) continue;
    // walk forward to the matching '}'
    depth = 0; let end = -1, inStr = false;
    for (let i = start; i < s.length; i++) { const c = s[i]; if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; } if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { end = i; break; } } }
    if (end < 0) continue;
    try { const o = JSON.parse(s.slice(start, end + 1)); if (o.id && o.name && Array.isArray(o.objectives) && (!best || o.objectives.length >= best.objectives.length)) best = o; } catch {}
  }
  return best;
}
const queue = [...slugs];
async function worker() {
  while (queue.length) {
    const slug = queue.shift();
    try {
      const r = await fetch(`https://tarkov.muedsa.com/tasks/${slug}`, { headers: { 'User-Agent': UA, RSC: '1' } });
      const t = extractTask(await r.text());
      if (t) { t.slug = slug; tasks.push(t); } else fail++;
    } catch { fail++; }
    done++; if (done % 50 === 0) console.log(`${done}/${slugs.length} (${fail} failed)`);
    await new Promise((res) => setTimeout(res, 150));
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
await mkdir('scripts/data/tasks', { recursive: true });
await writeFile('scripts/data/tasks/tasks-mirror.json', JSON.stringify(tasks));
const zones = tasks.flatMap((t) => t.objectives.flatMap((o) => o.zones || []));
console.log(`tasks ${tasks.length}, failed ${fail}, objectives ${tasks.reduce((n, t) => n + t.objectives.length, 0)}, zones ${zones.length}, with position ${zones.filter((z) => z.position).length}`);
