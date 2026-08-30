/**
 * Active quests — the pure half (no DOM, no Leaflet, no deck).
 *
 * The companion replays Escape from Tarkov's own `push-notifications` log (message type 10 =
 * started, 12 = finished, 11 = failed) and posts the resulting sets to the relay, which forwards
 * them to every subscriber of a pairing code as ONE message shape:
 *
 *   { t:'quests', active:[taskId], done:[taskId], failed:[taskId], accountId, ts, since }
 *
 * `taskId` is the tarkov.dev / SPT task id — the `id` field of a row in public/data/quests.json.
 * `since` is the oldest game log the companion could read: EFT rotates logs, so a quest started
 * before that date may be missing from `active` and the UI has to say so.
 *
 * Everything in this file is a pure function of (message | quest list | current map), which is what
 * scripts/active-quests-test.mjs exercises. See docs/plans/ACTIVE-QUESTS.md for the full spec.
 */

/** A quest set from a stranger's relay room is untrusted input: cap what we will look at. */
export const MAX_IDS = 500;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Trim, drop anything that isn't an id-shaped string, dedupe, keep the incoming order. */
export function normalizeIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

const str = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, n) : null);

/**
 * Normalise one `{t:'quests'}` message. Returns null when the message is something else, so the
 * socket handler can use it as its own type test.
 *
 * A finished or failed quest never stays in `active`: the companion should already have removed it,
 * but the site is the last line and two lists disagreeing would show a quest twice.
 */
export function parseQuestsMessage(m) {
  if (!m || typeof m !== 'object') return null;
  if ((m.t ?? m.type) !== 'quests') return null;
  const done = normalizeIds(m.done);
  const failed = normalizeIds(m.failed);
  const closed = new Set([...done, ...failed]);
  return {
    active: normalizeIds(m.active).filter((id) => !closed.has(id)),
    done,
    failed,
    accountId: str(m.accountId, 64),
    ts: Number.isFinite(m.ts) ? m.ts : Date.now(),
    since: str(m.since, 40),
  };
}

/**
 * Merge the sets of several pairing codes (you + a friend running their own companion), best
 * source first. Active anywhere wins: a quest one player has finished is still worth drawing while
 * another player is on it.
 */
export function mergeQuestSets(sets) {
  const list = (sets ?? []).filter(Boolean);
  const active = normalizeIds(list.flatMap((s) => s.active ?? []));
  const inActive = new Set(active);
  const done = normalizeIds(list.flatMap((s) => s.done ?? [])).filter((id) => !inActive.has(id));
  const closed = new Set([...inActive, ...done]);
  return {
    active,
    done,
    failed: normalizeIds(list.flatMap((s) => s.failed ?? [])).filter((id) => !closed.has(id)),
    accountId: list.find((s) => s.accountId)?.accountId ?? null,
    since: list.find((s) => s.since)?.since ?? null,
    ts: list.reduce((t, s) => Math.max(t, s.ts ?? 0), 0) || null,
  };
}

/** One panel row. `here` = this quest has drawable objectives on the map that is open. */
function rowFor(id, q, mapKey) {
  return {
    id,
    slug: q.slug,
    name: q.name,
    trader: q.trader ?? '',
    here: !!q.siteMaps?.includes(mapKey),
    maps: [...new Set([...(q.siteMaps ?? []), ...(q.maps ?? [])])],
  };
}

/**
 * Active ids ∩ quests.json, split into this map and everywhere else.
 *
 * Order is the order the ids arrived in — the companion replays the log in `dt` order, so that is
 * "most recently accepted last", which is a fact about the player's game and not ours to re-sort.
 * Ids with no row in quests.json (trader chatter carries the same message shape) are reported
 * separately and never rendered as quests.
 */
export function activeRows(all, activeIds, mapKey) {
  const byId = new Map((all ?? []).map((q) => [q.id, q]));
  const here = [];
  const elsewhere = [];
  const unknown = [];
  for (const id of normalizeIds(activeIds)) {
    const q = byId.get(id);
    if (!q) { unknown.push(id); continue; }
    const row = rowFor(id, q, mapKey);
    (row.here ? here : elsewhere).push(row);
  }
  return { here, elsewhere, unknown };
}

/** The same intersection for the finished ids — one flat list, incoming order. */
export function doneRows(all, doneIds, mapKey) {
  const byId = new Map((all ?? []).map((q) => [q.id, q]));
  const rows = [];
  for (const id of normalizeIds(doneIds)) {
    const q = byId.get(id);
    if (q) rows.push(rowFor(id, q, mapKey));
  }
  return rows;
}

/**
 * Which quests auto-select should ADD right now. It only ever adds:
 *
 *  - off when the toggle is off;
 *  - only active quests with objectives on the map that is open;
 *  - never something already selected — a manual selection is never touched, and never removed;
 *  - never a slug that was auto-selected once already (`applied`), so a player who takes one off
 *    the map keeps it off until the game says the quest changed.
 */
export function autoSelectSlugs({ all, activeIds, mapKey, selected = [], applied = new Set(), auto = true } = {}) {
  if (!auto) return [];
  const already = new Set(selected);
  const out = [];
  for (const row of activeRows(all, activeIds, mapKey).here) {
    if (already.has(row.slug) || applied.has(row.slug) || out.includes(row.slug)) continue;
    out.push(row.slug);
  }
  return out;
}

/** `since` as a date, whether it arrives as an ISO string, a seconds epoch or a ms epoch. */
export function sinceLabel(since) {
  if (since == null || since === '') return '';
  const raw = String(since).trim();
  const n = Number(raw);
  const d = /^\d{13}$/.test(raw) ? new Date(n)
    : /^\d{10}$/.test(raw) ? new Date(n * 1000)
    : new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : raw.slice(0, 40);
}

/**
 * The caveat line. EFT deletes old logs, so the companion's replay can only reach back so far —
 * an empty "My quests" is not proof the player has no quests, and the panel must say which.
 */
export function sinceCaveat(since) {
  const label = sinceLabel(since);
  return label ? `Read from game logs since ${label} — quests started before then may be missing.` : '';
}
