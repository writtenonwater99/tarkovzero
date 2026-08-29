#!/usr/bin/env node
// Fetch quest objective recognition screenshots from the EFT Wiki (Fandom) for every
// SPT quest, and write public/data/quest-images.json.
//
// Source: MediaWiki API on escapefromtarkov.fandom.com. We fetch each quest page's
// wikitext, look at the "Guide" section (where walkthrough screenshots live), and
// parse <gallery> blocks / inline [[File:...]] links with captions. File names are
// then resolved to full static.wikia.nocookie.net URLs via the imageinfo API.
//
// Idempotent: raw wikitext + image list per quest is cached under
// scripts/data/wiki-quests/<taskId>.json, and resolved image URLs are cached in
// scripts/data/wiki-quests/_imageinfo-cache.json. Rerunning the script only fetches
// what's missing (use --force to refetch everything, --force-images to only
// re-resolve image URLs).
//
// Usage: node scripts/fetch-quest-images.mjs [--force] [--force-images] [--limit N]

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, 'data', 'wiki-quests');
const QUEST_SOURCE = path.join(__dirname, 'data', 'spt-quests-source.json');
const OUTPUT = path.join(ROOT, 'public', 'data', 'quest-images.json');
const IMAGEINFO_CACHE_FILE = path.join(CACHE_DIR, '_imageinfo-cache.json');

const API = 'https://escapefromtarkov.fandom.com/api.php';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) TarkovZeroBot/1.0 (+https://tarkovzero.com; contact: nobleheavens369@gmail.com)';

const MIN_INTERVAL_MS = 340; // ~3 req/s
const MAX_RETRIES = 5;
const MIN_IMAGE_DIM = 300; // filter out small icons/portraits
// Bump when title-resolution logic changes, so previously-"missing" pages get
// retried once with the improved resolver instead of being skipped forever.
const RESOLVER_VERSION = 2;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const FORCE_IMAGES = args.includes('--force-images') || FORCE;
const limitArg = args.find((a) => a.startsWith('--limit'));
const LIMIT = limitArg ? Number(limitArg.split('=')[1] || args[args.indexOf(limitArg) + 1]) : Infinity;

// ---------------------------------------------------------------------------
// Rate-limited fetch with retry on 429/5xx
// ---------------------------------------------------------------------------
let lastRequestAt = 0;
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rateLimitedFetch(url) {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        if (attempt > MAX_RETRIES) throw new Error(`HTTP ${res.status} after ${attempt} attempts: ${url}`);
        const backoff = Math.min(15000, 500 * 2 ** attempt) + Math.random() * 300;
        await sleep(backoff);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt > MAX_RETRIES) throw err;
      const backoff = Math.min(15000, 500 * 2 ** attempt) + Math.random() * 300;
      await sleep(backoff);
    }
  }
}

async function apiParse(page) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext|images&redirects=1&format=json`;
  return rateLimitedFetch(url);
}

async function apiImageInfo(titles) {
  const url = `${API}?action=query&titles=${titles.map(encodeURIComponent).join('|')}&prop=imageinfo&iiprop=url|size&format=json`;
  return rateLimitedFetch(url);
}

async function apiOpenSearch(query) {
  const url = `${API}?action=opensearch&search=${encodeURIComponent(query)}&limit=8&format=json`;
  return rateLimitedFetch(url);
}

// ---------------------------------------------------------------------------
// Title resolution helpers: the EFT wiki has reorganized many multi-part quest
// lines since the SPT task DB names were captured (e.g. "Farming - Part 1" is
// now just "Farming"; the old numbered "Gunsmith - Part N" chain was replaced
// by per-weapon "Gunsmith - <weapon>" pages). We try progressively fuzzier
// title candidates, but only accept an opensearch match if its part number
// (if any) agrees with the query's, to avoid silently attaching e.g. "Signal -
// Part 1" to the unrelated "Signal - Part 4" page.
// ---------------------------------------------------------------------------
function extractPartNum(title) {
  const m = /\bpart\s*(\d+)\b/i.exec(title);
  return m ? Number(m[1]) : null;
}

function baseWithoutPart(title) {
  return title.replace(/\s*-\s*part\s*\d+\s*$/i, '').trim();
}

function normalizeForMatch(title) {
  return title
    .replace(/['’‘]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .toLowerCase()
    .replace(/\bpart\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveQuestPage(questName) {
  const directAttempts = [questName];
  if (questName.includes(' - ')) directAttempts.push(questName.replace(/ - /g, ' – '));
  const base = baseWithoutPart(questName);
  if (base !== questName) directAttempts.push(base);

  for (const title of directAttempts) {
    try {
      const res = await apiParse(title);
      if (res && res.parse && res.parse.wikitext) {
        return { parsed: res.parse, resolvedTitle: title, fuzzy: title !== questName };
      }
    } catch (err) {
      console.warn(`Fetch error for "${title}": ${err.message}`);
    }
  }

  // Fuzzy fallback via opensearch, verified against part-number agreement.
  try {
    const qPart = extractPartNum(questName);
    const qBaseNorm = normalizeForMatch(base);
    const search = await apiOpenSearch(questName);
    const candidates = (search && search[1]) || [];
    for (const candidate of candidates) {
      const cPart = extractPartNum(candidate);
      if (qPart != null && cPart != null && qPart !== cPart) continue;
      const cBaseNorm = normalizeForMatch(baseWithoutPart(candidate));
      if (cBaseNorm !== qBaseNorm || !cBaseNorm) continue;
      try {
        const res = await apiParse(candidate);
        if (res && res.parse && res.parse.wikitext) {
          return { parsed: res.parse, resolvedTitle: candidate, fuzzy: true };
        }
      } catch (err) {
        console.warn(`Fetch error for fuzzy candidate "${candidate}": ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`opensearch error for "${questName}": ${err.message}`);
  }

  return { parsed: null, resolvedTitle: null, fuzzy: false };
}

// ---------------------------------------------------------------------------
// Map name normalization (must match public/data map slugs, see
// scripts/tarkov-dev-maps.json normalizedName values)
// ---------------------------------------------------------------------------
const MAP_KEYWORDS = [
  [/streets of tarkov/i, 'streets-of-tarkov'],
  [/\bstreets\b/i, 'streets-of-tarkov'],
  [/ground zero/i, 'ground-zero'],
  [/\bcustoms\b/i, 'customs'],
  [/night factory/i, 'factory'],
  [/\bfactory\b/i, 'factory'],
  [/\bicebreaker\b/i, 'icebreaker'],
  [/\binterchange\b/i, 'interchange'],
  [/the labyrinth/i, 'the-labyrinth'],
  [/\blabyrinth\b/i, 'the-labyrinth'],
  [/the lab\b/i, 'the-lab'],
  [/\blaboratory\b/i, 'the-lab'],
  [/\blighthouse\b/i, 'lighthouse'],
  [/\breserve\b/i, 'reserve'],
  [/\bshoreline\b/i, 'shoreline'],
  [/\bterminal\b/i, 'terminal'],
  [/\bwoods\b/i, 'woods'],
];

function inferMapFromText(text) {
  if (!text) return null;
  for (const [re, slug] of MAP_KEYWORDS) {
    if (re.test(text)) return slug;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wikitext parsing
// ---------------------------------------------------------------------------

// Skip icons / portraits / trader art / banners that aren't walkthrough screenshots.
const SKIP_FILENAME_RE = /(icon|banner|portrait|questpicture|logo|trader[-_ ]?art|avatar)/i;

function cleanWikiMarkup(str) {
  if (!str) return '';
  let s = str;
  // [[Link|Display]] -> Display, [[Link]] -> Link
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');
  // ''' '' bold/italic markers
  s = s.replace(/'{2,3}/g, '');
  // <br>, <br/>
  s = s.replace(/<br\s*\/?>/gi, ' ');
  // templates {{...}}
  s = s.replace(/\{\{[^{}]*\}\}/g, '');
  // other stray HTML tags
  s = s.replace(/<[^>]+>/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function extractSection(wikitext, headingRe) {
  const m = headingRe.exec(wikitext);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = wikitext.slice(start);
  const nextHeading = /^==[^=\n][^\n]*==\s*$/m.exec(rest);
  const end = nextHeading ? nextHeading.index : rest.length;
  return rest.slice(0, end);
}

const IMAGE_PARAM_RE =
  /^(thumb|thumbnail|left|right|center|centre|none|frame|frameless|framed|border|baseline|middle|sub|super|text-top|top|text-bottom|bottom|upright(=[\d.]+)?|\d+x?\d*\s*px|link=.*|alt=.*|page=.*|class=.*|lang=.*)$/i;

function parseGalleries(sectionText) {
  const results = [];
  const galleryRe = /<gallery[^>]*>([\s\S]*?)<\/gallery>/gi;
  let gm;
  while ((gm = galleryRe.exec(sectionText))) {
    const body = gm[1];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const fileMatch = /^File:([^|]+)/i.exec(line);
      if (!fileMatch) continue;
      const filename = fileMatch[1].trim();
      const rest = line.slice(fileMatch[0].length);
      const caption = rest.startsWith('|') ? cleanWikiMarkup(rest.slice(1)) : '';
      results.push({ filename, caption });
    }
  }
  return results;
}

function parseInlineFileLinks(sectionText) {
  // Strip gallery blocks first so we don't double-count their File: lines.
  const withoutGalleries = sectionText.replace(/<gallery[^>]*>[\s\S]*?<\/gallery>/gi, '');
  const results = [];
  // Match [[File:Name.ext|param|param|...]] (non-greedy up to the matching ]])
  const linkRe = /\[\[File:([^|\]]+)((?:\|[^\]|]*(?:\[\[[^\]]*\]\][^\]|]*)*)*)\]\]/gi;
  let m;
  while ((m = linkRe.exec(withoutGalleries))) {
    const filename = m[1].trim();
    const paramsRaw = m[2] || '';
    const params = paramsRaw.split('|').slice(1); // drop leading empty from split
    let caption = '';
    if (params.length) {
      const last = params[params.length - 1].trim();
      if (last && !IMAGE_PARAM_RE.test(last)) {
        caption = cleanWikiMarkup(last);
      }
    }
    results.push({ filename, caption });
  }
  return results;
}

function extractLocationMap(wikitext) {
  const m = /\|\s*location\s*=\s*([^\n]*)/i.exec(wikitext);
  if (!m) return null;
  return inferMapFromText(m[1]);
}

// Some quests (e.g. "place N items across several maps") organize the Guide
// section into per-map ====Heading==== blocks whose individual gallery images
// have no per-image caption at all — the map/spot context lives in the
// heading and in a leading '''Bold label''' line instead. Split the section
// on any heading so we can carry that context onto each image.
function splitGuideIntoBlocks(guideText) {
  const headingRe = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;
  const blocks = [];
  let lastIndex = 0;
  let lastHeading = null;
  let m;
  while ((m = headingRe.exec(guideText))) {
    blocks.push({ heading: lastHeading, body: guideText.slice(lastIndex, m.index) });
    lastHeading = cleanWikiMarkup(m[2]);
    lastIndex = headingRe.lastIndex;
  }
  blocks.push({ heading: lastHeading, body: guideText.slice(lastIndex) });
  return blocks;
}

// Within a ====Map heading==== block, individual stash spots are usually
// introduced by their own '''Bold label''' line rather than a further wiki
// heading (see e.g. "Is This a Reference?"). Split on those so each mini
// gallery gets its own label instead of inheriting the block's first one.
function splitBlockByBoldLabels(body) {
  // Non-greedy match up to the next '''  — labels routinely contain a plain
  // apostrophe (e.g. "The burned girl's sickroom"), so we can't exclude ' outright.
  const boldRe = /'''(.+?)'''/g;
  const marks = [];
  let m;
  while ((m = boldRe.exec(body))) {
    marks.push({ index: m.index, label: cleanWikiMarkup(m[1]) });
  }
  if (!marks.length) return [{ label: null, text: body }];
  const segments = [];
  if (marks[0].index > 0) segments.push({ label: null, text: body.slice(0, marks[0].index) });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    segments.push({ label: marks[i].label, text: body.slice(start, end) });
  }
  return segments;
}

function parseQuestImages(wikitext) {
  const guide = extractSection(wikitext, /^==\s*Guide\s*==\s*$/im);
  if (!guide) return [];

  const blocks = splitGuideIntoBlocks(guide);
  const all = [];
  let currentMap = null;
  for (const block of blocks) {
    const headingMap = inferMapFromText(block.heading);
    if (headingMap) currentMap = headingMap;
    for (const segment of splitBlockByBoldLabels(block.body)) {
      const fromGalleries = parseGalleries(segment.text);
      const fromInline = parseInlineFileLinks(segment.text);
      for (const item of [...fromGalleries, ...fromInline]) {
        all.push({ ...item, sectionMap: currentMap, blockLabel: segment.label });
      }
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const item of all) {
    const key = item.filename.replace(/ /g, '_');
    if (seen.has(key)) continue;
    seen.add(key);
    if (SKIP_FILENAME_RE.test(item.filename)) continue;
    deduped.push({
      filename: item.filename,
      caption: item.caption,
      sectionMap: item.sectionMap,
      blockLabel: item.blockLabel,
    });
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

  const questSource = readJson(QUEST_SOURCE, null);
  if (!questSource) {
    console.error(`Could not read quest source at ${QUEST_SOURCE}`);
    process.exit(1);
  }

  const quests = Object.keys(questSource)
    .map((taskId) => ({ taskId, questName: questSource[taskId].QuestName }))
    .filter((q) => q.questName)
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .slice(0, LIMIT);

  console.log(`Loaded ${quests.length} quests from source.`);

  const imageinfoCache = readJson(IMAGEINFO_CACHE_FILE, {});

  let fetchedCount = 0;
  let cachedCount = 0;
  let missingCount = 0;
  const perQuestParsed = {}; // taskId -> { questName, location, images: [{filename, caption}] }

  let fuzzyCount = 0;

  for (const { taskId, questName } of quests) {
    const cacheFile = path.join(CACHE_DIR, `${taskId}.json`);
    let cached = FORCE ? null : readJson(cacheFile, null);
    // Retry previously-missing pages once against the newer resolver (which
    // knows about merged/renamed multi-part quest lines).
    if (cached && cached.missing && cached.resolverVersion !== RESOLVER_VERSION) {
      cached = null;
    }

    if (!cached) {
      const { parsed, resolvedTitle, fuzzy } = await resolveQuestPage(questName);

      cached = {
        taskId,
        questName,
        resolvedTitle,
        fuzzy,
        missing: !parsed,
        resolverVersion: RESOLVER_VERSION,
        wikitext: parsed ? parsed.wikitext['*'] : null,
        images: parsed ? parsed.images || [] : [],
        fetchedAt: new Date().toISOString(),
      };
      writeJsonAtomic(cacheFile, cached);
      fetchedCount++;
      if (cached.missing) missingCount++;
      if (cached.fuzzy) fuzzyCount++;
      if (fetchedCount % 25 === 0) {
        console.log(`  ...fetched ${fetchedCount} pages so far (${missingCount} missing, ${fuzzyCount} fuzzy-matched)`);
      }
    } else {
      cachedCount++;
      if (cached.missing) missingCount++;
      if (cached.fuzzy) fuzzyCount++;
    }

    if (cached.wikitext) {
      const images = parseQuestImages(cached.wikitext);
      const location = extractLocationMap(cached.wikitext);
      if (images.length) {
        perQuestParsed[taskId] = { questName, location, images };
      }
    }
  }

  console.log(
    `Wikitext: ${fetchedCount} fetched this run, ${cachedCount} from cache, ${missingCount} pages missing/not found, ${fuzzyCount} fuzzy/renamed-page matches.`,
  );

  // Collect all distinct filenames needing resolution.
  const allFilenames = new Set();
  for (const q of Object.values(perQuestParsed)) {
    for (const img of q.images) allFilenames.add(img.filename);
  }

  const needResolve = [...allFilenames].filter(
    (f) => FORCE_IMAGES || !imageinfoCache[normalizeFileKey(f)],
  );

  console.log(`${allFilenames.size} distinct images referenced, ${needResolve.length} need URL resolution.`);

  const BATCH = 50;
  for (let i = 0; i < needResolve.length; i += BATCH) {
    const batch = needResolve.slice(i, i + BATCH);
    const titles = batch.map((f) => `File:${f}`);
    try {
      const res = await apiImageInfo(titles);
      const pages = (res.query && res.query.pages) || {};
      const foundByTitle = {};
      for (const page of Object.values(pages)) {
        if (page.imageinfo && page.imageinfo[0]) {
          const title = page.title.replace(/^File:/, '');
          foundByTitle[normalizeFileKey(title)] = {
            url: page.imageinfo[0].url,
            width: page.imageinfo[0].width,
            height: page.imageinfo[0].height,
          };
        }
      }
      for (const f of batch) {
        const key = normalizeFileKey(f);
        imageinfoCache[key] = foundByTitle[key] || null;
      }
    } catch (err) {
      console.warn(`imageinfo batch failed (${i}-${i + batch.length}): ${err.message}`);
      for (const f of batch) {
        const key = normalizeFileKey(f);
        if (!(key in imageinfoCache)) imageinfoCache[key] = null;
      }
    }
    writeJsonAtomic(IMAGEINFO_CACHE_FILE, imageinfoCache);
    if ((i / BATCH) % 4 === 0) {
      console.log(`  ...resolved ${Math.min(i + BATCH, needResolve.length)}/${needResolve.length} images`);
    }
  }

  // Build final output.
  const output = {
    _credit: 'EFT Wiki (Fandom), CC BY-NC-SA',
    _generated: new Date().toISOString(),
  };

  let questsWithImages = 0;
  let totalImages = 0;

  for (const taskId of Object.keys(perQuestParsed).sort()) {
    const q = perQuestParsed[taskId];
    const entries = [];
    for (const img of q.images) {
      const info = imageinfoCache[normalizeFileKey(img.filename)];
      if (!info) continue; // couldn't resolve (deleted/renamed file)
      if (Math.min(info.width || 0, info.height || 0) < MIN_IMAGE_DIM) continue; // filter icons
      const map = inferMapFromText(img.caption) || img.sectionMap || q.location || null;
      const objectiveHint = img.caption || img.blockLabel || null;
      entries.push({
        url: info.url,
        caption: img.caption || null,
        map,
        objectiveHint,
      });
    }
    if (entries.length) {
      output[taskId] = entries;
      questsWithImages++;
      totalImages += entries.length;
    }
  }

  writeJsonAtomic(OUTPUT, output);

  console.log(`\nDone. ${questsWithImages} quests with >=1 image, ${totalImages} total images.`);
  console.log(`Output: ${OUTPUT}`);
}

function normalizeFileKey(filename) {
  return filename.trim().replace(/ /g, '_');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
