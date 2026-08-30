// Active-quest tracking from the EFT push-notification logs.
//
// EFT never writes a "these are my current quests" snapshot, so the active set is reconstructed by
// replaying every quest chat message the game ever logged:
//
//   2026-08-04 21:25:52.179|1.1.0.0.46624|Info|push-notifications|Got notification | ChatMessageReceived
//   {
//     "type": "new_message", "eventId": "…", "dialogId": "…",
//     "message": { "_id": "…", "uid": "…", "type": 10, "dt": 1785903953, "text": "…",
//                  "templateId": "59689fbd86f7740d137ebfc4 description", … }
//   }
//
// message.type 10 = quest started, 11 = failed, 12 = finished (14 seen too — reward mail, ignored).
// message.templateId is "<taskId> <suffix>"; the first token is the tarkov.dev/SPT task id that
// public/data/quests.json is keyed on. Ids that are not in quests.json (trader mail) go to `unknown`.
//
// See docs/plans/ACTIVE-QUESTS.md for the source-of-truth notes this is built from.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const HEADER = 'Got notification | ChatMessageReceived';
export const STARTED = 10, FAILED = 11, FINISHED = 12;
const QUEST_TYPES = new Set([STARTED, FAILED, FINISHED]);
const SEEN_CAP = 4000;      // ids kept for de-duplication (a full wipe's worth is ~100)
const UNKNOWN_CAP = 200;
export const READ_RETRIES = 40;  // ticks a file may fail to read before the replay steps over it (10 s at 250 ms)
export const STATE_VERSION = 2; // v2 added lastDt (per-task ordering across polls); a bump forces one replay

// ---- log-block parsing -------------------------------------------------------------------------

// Reads one pretty-printed JSON object starting at `from`. Returns null when the object is not
// complete yet (the game is still writing it) so the caller can leave the cursor before it.
function readJsonBlock(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;
  const start = i;
  let depth = 0, inStr = false, esc = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      let end = i + 1;
      if (text[end] === '\r') end++;
      if (text[end] === '\n') end++;
      return { json: text.slice(start, i + 1), end };
    }
  }
  return null; // truncated tail
}

export function taskIdOf(templateId) {
  const first = String(templateId || '').trim().split(/\s+/)[0] || '';
  return /^[0-9a-f]{12,32}$/i.test(first) ? first : null;
}

/**
 * Parse a push-notifications log body.
 * @returns {{events: Array, consumed: number, bad: number}} `consumed` is the number of *bytes*
 * fully processed — anything after it is a partial line or an unfinished JSON block.
 */
export function parseNotificationLog(text) {
  const events = [];
  let bad = 0, i = 0, consumedChars = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    if (nl === -1) break;                       // partial last line — leave it for the next read
    const line = text.slice(i, nl);
    let next = nl + 1;
    if (line.includes(HEADER)) {
      const block = readJsonBlock(text, next);
      if (!block) break;                        // block still being written
      next = block.end;
      try {
        const m = JSON.parse(block.json)?.message;
        if (m && m._id) {
          events.push({ id: String(m._id), dt: Number(m.dt) || 0, type: Number(m.type), templateId: String(m.templateId || ''), taskId: taskIdOf(m.templateId) });
        }
      } catch { bad++; }
    }
    i = next;
    consumedChars = next;
  }
  return { events, consumed: Buffer.byteLength(text.slice(0, consumedChars), 'utf8'), bad };
}

// `PrepareSelectedProfileLocally ProfileId:<hex> AccountId:<digits>` (also `CompleteSelectedProfile`)
const ACCOUNT_RE = /(?:PrepareSelectedProfileLocally|CompleteSelectedProfile)\s+ProfileId:([0-9a-f]+)\s+AccountId:(\d+)/gi;
export function extractAccount(text) {
  let last = null;
  for (const m of String(text).matchAll(ACCOUNT_RE)) last = { profileId: m[1], accountId: m[2] };
  return last;
}

// ---- quests.json task ids ----------------------------------------------------------------------

export function defaultQuestsFile() { return path.join(here, '..', 'public', 'data', 'quests.json'); }

export function loadTaskIds(file = defaultQuestsFile()) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.quests || raw.tasks || []);
  return new Set(list.map((q) => q && q.id).filter(Boolean));
}

// ---- log discovery -----------------------------------------------------------------------------

// log_2026.08.04_21-12-00_1.1.0.0.46624 -> 2026-08-04 (dir names sort chronologically)
export function sessionDate(dirName) {
  const m = /^log_(\d{4})\.(\d{2})\.(\d{2})/.exec(dirName);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * One pass over the Logs folder (a readdir per session dir, ~70 ms on /mnt/c — worth doing once):
 * every push-notifications and application log, oldest session first.
 * @returns {{push: Array<{rel:string,dir:string,full:string}>, app: string[]}}
 */
export function listLogFiles(logsDir) {
  let dirs;
  try { dirs = fs.readdirSync(logsDir).filter((d) => d.startsWith('log_')).sort(); } catch { return { push: [], app: [] }; }
  const push = [], app = [];
  for (const d of dirs) {
    let files;
    try { files = fs.readdirSync(path.join(logsDir, d)).sort(); } catch { continue; }
    for (const f of files) {
      if (/push-notifications_\d+\.log$/i.test(f)) push.push({ rel: `${d}/${f}`, dir: d, full: path.join(logsDir, d, f) });
      else if (/application_\d+\.log$/i.test(f)) app.push(path.join(logsDir, d, f));
    }
  }
  return { push, app };
}

/** Every push-notifications log under `logsDir`, oldest session first. */
export function pushLogFiles(logsDir) { return listLogFiles(logsDir).push; }

function readHead(file, bytes) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(bytes, st.size);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

function readFrom(file, offset) {
  const st = fs.statSync(file);
  const start = st.size < offset ? 0 : offset;      // file replaced/truncated -> start over
  const len = st.size - start;
  if (len <= 0) return { text: '', start, size: st.size };
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, start);
  fs.closeSync(fd);
  return { text: buf.toString('utf8'), start, size: st.size };
}

// ---- state -------------------------------------------------------------------------------------

export function emptyState() {
  return { version: STATE_VERSION, accountId: null, profileId: null, cursor: { file: null, offset: 0 }, active: [], done: [], failed: [], unknown: [], seen: [], lastDt: {}, since: null, ts: 0 };
}

function normalizeState(s) {
  const e = emptyState();
  if (!s || typeof s !== 'object' || s.version !== STATE_VERSION) return e;
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const dts = (v) => {
    const o = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, n] of Object.entries(v)) if (Number.isFinite(Number(n))) o[k] = Number(n);
    return o;
  };
  return {
    version: STATE_VERSION,
    accountId: s.accountId ? String(s.accountId) : null,
    profileId: s.profileId ? String(s.profileId) : null,
    cursor: { file: s.cursor?.file ? String(s.cursor.file) : null, offset: Number(s.cursor?.offset) || 0 },
    active: arr(s.active), done: arr(s.done), failed: arr(s.failed), unknown: arr(s.unknown), seen: arr(s.seen), lastDt: dts(s.lastDt),
    since: s.since ? String(s.since) : null,
    ts: Number(s.ts) || 0,
  };
}

const capTail = (set, cap) => (set.size <= cap ? [...set] : [...set].slice(set.size - cap));

/**
 * Apply quest events to `state` (mutates). Events are sorted by `dt` (file order breaks ties) so a
 * log that records a finish before the matching start still reconstructs correctly. The sort alone
 * only covers a pair that lands in the same read; the live file is tailed every 250 ms and the pair
 * routinely straddles two polls, so `state.lastDt` remembers the newest `dt` applied per task and an
 * event older than it is ignored. Without that, the same bytes on disk give a different published set
 * depending on poll timing — and a quest just handed in gets republished as active.
 * @returns {{applied:number, skipped:number, unknown:number, setsChanged:boolean}}
 */
export function applyEvents(state, events, taskIds, log) {
  const seen = new Set(state.seen);
  const active = new Set(state.active), done = new Set(state.done), failed = new Set(state.failed);
  const unknown = new Set(state.unknown);
  const lastDt = { ...(state.lastDt || {}) };
  let applied = 0, skipped = 0, unknownCount = 0, setsChanged = false;
  const ordered = events.map((e, i) => [e, i]).sort((a, b) => (a[0].dt - b[0].dt) || (a[1] - b[1])).map((x) => x[0]);
  for (const ev of ordered) {
    if (seen.has(ev.id)) { skipped++; continue; }
    seen.add(ev.id);
    if (!QUEST_TYPES.has(ev.type)) { if (log) log(`quest log: ignoring message type ${ev.type} (${ev.templateId})`); continue; }
    const id = ev.taskId;
    if (!id) continue;
    if (taskIds && !taskIds.has(id)) {
      if (!unknown.has(id)) { unknown.add(id); unknownCount++; }
      continue;
    }
    const prev = lastDt[id];
    if (prev !== undefined && ev.dt < prev) { skipped++; continue; }   // a stale transition from an earlier poll
    lastDt[id] = ev.dt;
    const before = `${active.has(id)}${done.has(id)}${failed.has(id)}`;
    if (ev.type === STARTED) { active.add(id); done.delete(id); failed.delete(id); }
    else if (ev.type === FINISHED) { active.delete(id); done.add(id); failed.delete(id); }
    else { active.delete(id); failed.add(id); done.delete(id); }
    if (before !== `${active.has(id)}${done.has(id)}${failed.has(id)}`) setsChanged = true;
    applied++;
  }
  state.seen = capTail(seen, SEEN_CAP);
  state.active = [...active]; state.done = [...done]; state.failed = [...failed];
  state.unknown = capTail(unknown, UNKNOWN_CAP);
  const tracked = Object.keys(lastDt);
  for (const k of tracked.slice(0, Math.max(0, tracked.length - SEEN_CAP))) delete lastDt[k];
  state.lastDt = lastDt;
  return { applied, skipped, unknown: unknownCount, setsChanged };
}

// ---- tracker -----------------------------------------------------------------------------------

export class QuestTracker {
  /**
   * @param {object} o
   * @param {string|null} o.logsDir   EFT Logs folder (the one holding log_* session dirs)
   * @param {string} o.statePath      where companion-quests.json lives
   * @param {string|null} o.questsFile public/data/quests.json (null = accept every id)
   * @param {(line:string)=>void} o.log
   */
  constructor({ logsDir, statePath, questsFile = defaultQuestsFile(), log = () => {} } = {}) {
    this.logsDir = logsDir || null;
    this.statePath = statePath;
    this.log = log;
    this.files = null;       // push-notification logs, oldest first (null = not listed yet)
    this.appFiles = [];      // application logs from the same listing pass
    this.taskIds = null;
    this.readError = null; this.readFails = 0;   // file we last failed to read (logged once, not per tick)
    this.acctKey = null; this.acct = null;   // detectAccount() cache, keyed on the newest application log
    this.questsFile = questsFile;
    if (questsFile) {
      try { this.taskIds = loadTaskIds(questsFile); }
      catch (e) { this.log(`quests: could not read ${questsFile} (${e.message}) — task-id filter off`); }
    }
    this.state = normalizeState(this.readState());
  }

  readState() { try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { return null; } }
  save() { try { fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2)); } catch (e) { this.log(`quests: could not write ${this.statePath}: ${e.message}`); } }

  /**
   * Drop every reconstructed quest. `from` (a file from pushLogFiles) makes the next replay start
   * there instead of at the oldest session — used on a wipe/profile change so the previous
   * profile's events are not replayed back in.
   */
  reset(reason, from = null) {
    const keep = { accountId: this.state.accountId, profileId: this.state.profileId };
    this.state = { ...emptyState(), ...keep, ts: Date.now() };
    if (from) { this.state.cursor = { file: from.rel, offset: 0 }; this.state.since = sessionDate(from.dir); }
    if (reason) this.log(`quests: state reset (${reason})`);
    this.save();
  }

  setLogsDir(dir) { if (dir !== this.logsDir) { this.logsDir = dir || null; this.files = null; this.acctKey = null; this.acct = null; } }

  snapshot() {
    const s = this.state;
    return { active: [...s.active], done: [...s.done], failed: [...s.failed], accountId: s.accountId, ts: s.ts, since: s.since };
  }
  counts() {
    const s = this.state;
    return { active: s.active.length, done: s.done.length, failed: s.failed.length, unknown: s.unknown.length, since: s.since, accountId: s.accountId, ts: s.ts };
  }

  /** Player identity from the newest application log. Cached until that file changes: the walk plus the
   *  4 MB head read costs ~150 ms on /mnt/c, and the answer only moves when the game writes a new session. */
  detectAccount(logs = listLogFiles(this.logsDir).app) {
    if (!logs.length) return null;
    const newest = logs[logs.length - 1];
    let key = null;
    try { const st = fs.statSync(newest); key = `${logs.length}|${newest}|${st.size}|${st.mtimeMs}`; } catch {}
    if (key && key === this.acctKey) return this.acct;
    let hit = null;
    for (let i = logs.length - 1; i >= 0; i--) {   // newest session first; profile select is early in the file
      hit = extractAccount(readHead(logs[i], 4 * 1024 * 1024));
      if (hit) break;
      if (this.state.accountId) break;             // known account: only ever look at the newest session
    }
    if (key) { this.acctKey = key; this.acct = hit; }
    return hit;
  }

  /**
   * Read whatever is new and fold it into the state.
   * @param {{rescan?:boolean}} o rescan=true re-lists the log folders and re-checks the player identity
   *   (do this every few seconds, not on every 250 ms tick); otherwise only the file the cursor sits on
   *   is tailed, which is the cheap path the live tick needs.
   * @returns {{changed:boolean, applied:number, snapshot:object}} changed = the published set moved
   */
  sync({ rescan = false } = {}) {
    if (!this.logsDir) return { changed: false, applied: 0, snapshot: this.snapshot() };
    let dirty = false, changed = false;
    const relisted = rescan || !this.files;
    if (relisted) { const all = listLogFiles(this.logsDir); this.files = all.push; this.appFiles = all.app; }
    const newest = this.files.length ? this.files[this.files.length - 1] : null;

    const s = this.state;
    // Identity detection re-reads the log folders; that belongs to the rescan tick (5 s), never to the
    // 250 ms tail tick, which shares its event loop with the screenshot scan and the relay socket.
    const acct = relisted ? this.detectAccount(this.appFiles) : null;
    let profileChange = null;
    if (acct) {
      if (s.accountId && acct.accountId !== s.accountId) { this.reset(`AccountId ${s.accountId} → ${acct.accountId}`, newest); changed = true; }
      // A ProfileId change on the same account is ambiguous, so the spec (docs/plans/ACTIVE-QUESTS.md §3)
      // only wipes when the event stream after it is empty — a fresh character with no quest history.
      // If events keep coming the reconstruction is kept: throwing away every earlier session and jumping
      // the cursor forward is unrecoverable, and `--reset-quests` is there for the rest.
      else if (s.profileId && acct.profileId !== s.profileId) profileChange = { reason: `ProfileId ${s.profileId} → ${acct.profileId}`, from: newest };
      const cur = this.state;
      if (cur.accountId !== acct.accountId || cur.profileId !== acct.profileId) { cur.accountId = acct.accountId; cur.profileId = acct.profileId; dirty = true; changed = true; }
    }
    const st = this.state;
    if (this.files.length && !st.since) { st.since = sessionDate(this.files[0].dir); dirty = true; changed = true; }

    const events = [];
    let cursor = { ...st.cursor }, sinceProfileChange = 0;
    for (const f of this.files) {
      if (st.cursor.file && f.rel < st.cursor.file) continue;
      const from = f.rel === st.cursor.file ? st.cursor.offset : 0;
      let read;
      try { read = readFrom(f.full, from); }
      catch (e) {
        // A transient read failure (a drvfs blip on /mnt/c) must not let a newer file move the cursor
        // past this one — that would drop the whole session's events for good, silently. Stop here and
        // retry on the next tick instead, and say so once.
        if (this.readError !== f.rel) { this.readError = f.rel; this.readFails = 0; this.log(`quests: could not read ${f.rel} (${e.message}) — leaving the cursor here and retrying`); }
        if (++this.readFails < READ_RETRIES) break;
        // permanently unreadable (gone, a permission change): pinning the cursor forever would be its own
        // silent stall, so step over it — loudly, and only after the blip has had ten seconds to clear
        this.log(`quests: giving up on ${f.rel} after ${this.readFails} failed reads — that session's quest events are lost`);
        this.readError = null;
        continue;
      }
      if (this.readError === f.rel) { this.readError = null; this.log(`quests: ${f.rel} is readable again`); }
      if (read.start === 0 && from > 0) this.log(`quests: ${f.rel} shrank — re-reading from the start`);
      const parsed = parseNotificationLog(read.text);
      if (parsed.bad) this.log(`quests: ${parsed.bad} unparsable notification block(s) in ${f.rel}`);
      events.push(...parsed.events);
      if (profileChange && (!profileChange.from || f.rel >= profileChange.from.rel)) sinceProfileChange += parsed.events.length;
      const size = Buffer.byteLength(read.text, 'utf8');
      if (parsed.consumed < size) {
        // An unfinished line or JSON block. On the newest file that just means the game is mid-write:
        // stop so the cursor never jumps past bytes we have not parsed. On an older session it is a
        // permanently truncated tail (EFT killed/crashed mid-write) that will never be completed — the
        // cursor has to step over it, or it parks there and every newer session is never read again.
        if (newest && f.rel === newest.rel) { cursor = { file: f.rel, offset: read.start + parsed.consumed }; break; }
        this.log(`quests: ${f.rel} ends mid-block (${size - parsed.consumed} unparsable byte(s) in a closed session) — skipping the truncated tail`);
        cursor = { file: f.rel, offset: read.start + size };
        continue;
      }
      cursor = { file: f.rel, offset: read.start + parsed.consumed };
    }
    if (profileChange) {
      if (!sinceProfileChange) { this.reset(profileChange.reason, profileChange.from); return { changed: true, applied: 0, snapshot: this.snapshot() }; }
      this.log(`quests: ${profileChange.reason} but the quest log keeps going — keeping the reconstruction (--reset-quests starts over)`);
    }
    if (cursor.file !== st.cursor.file || cursor.offset !== st.cursor.offset) { st.cursor = cursor; dirty = true; }

    let applied = 0;
    if (events.length) {
      const r = applyEvents(st, events, this.taskIds, this.log);
      applied = r.applied;
      if (r.applied || r.skipped || r.unknown) dirty = true;
      if (r.setsChanged || r.unknown) changed = true;
      if (r.unknown) this.log(`quests: ${r.unknown} id(s) not in quests.json (kept as unknown)`);
    }
    if (changed) st.ts = Date.now();
    if (dirty || changed) this.save();
    return { changed, applied, snapshot: this.snapshot() };
  }
}
