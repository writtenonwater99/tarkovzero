// node --test companion/test/quests.test.mjs   (or: npm run test:quests)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuestTracker, parseNotificationLog, extractAccount, taskIdOf, loadTaskIds, defaultQuestsFile, sessionDate, pushLogFiles } from '../quests.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'logs');
const SESSION = {
  a: 'log_2026.08.04_21-12-00_1.1.0.0.46624',
  b: 'log_2026.08.05_20-20-49_1.1.0.0.46657',
  c: 'log_2026.08.09_16-09-59_1.1.0.0.46657',
};
// real ids from public/data/quests.json
const SHOOTER = '5c0bde0986f77479cf22c2f8';   // A Shooter Born in Heaven
const BACKGROUND = '5936da9e86f7742d65037edf'; // Background Check
const BADREP = '5967530a86f77462ba22226b';     // Bad Rep Evidence
const AQUARIUS = '59689fbd86f7740d137ebfc4';   // Operation Aquarius - Part 1
const FIRSTINLINE = '657315ddab5a49b71f098853';
const SUPPLYPLANS = '596a0e1686f7741ddf17dbee';
const UNKNOWN_ID = '616041eb031af660100c9967'; // seen in the real logs, absent from quests.json

const tmps = [];
function stage(keys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-quests-'));
  tmps.push(dir);
  addSessions(dir, keys);
  return dir;
}
function addSessions(dir, keys) {
  for (const k of keys) fs.cpSync(path.join(FIX, SESSION[k]), path.join(dir, SESSION[k]), { recursive: true });
}
function pushLog(dir, key) {
  const d = path.join(dir, SESSION[key]);
  return path.join(d, fs.readdirSync(d).find((f) => f.includes('push-notifications')));
}
function tracker(dir, log) {
  return new QuestTracker({ logsDir: dir, statePath: path.join(dir, 'companion-quests.json'), questsFile: defaultQuestsFile(), log });
}
const HEAD = '2026-08-04 21:40:00.000|1.1.0.0.46624|Info|push-notifications|Got notification | ChatMessageReceived\n';
function block(id, type, dt, taskId) { // one complete ChatMessageReceived block in the game's shape
  return HEAD + `{\n  "type": "new_message",\n  "message": {\n    "_id": "${id}",\n    "type": ${type},\n`
    + `    "dt": ${dt},\n    "templateId": "${taskId} description"\n  }\n}\n`;
}
const HALF_BLOCK = HEAD + '{\n  "type": "new_message",\n  "message": {\n    "_id": "cut";'; // killed mid-write
const sorted = (a) => [...a].sort();
test.after(() => { for (const d of tmps) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

// ---- pure parsing --------------------------------------------------------------------------------

test('parseNotificationLog reads every ChatMessageReceived block, including nested reward items', () => {
  const text = fs.readFileSync(pushLog(stage(['a']), 'a'), 'utf8');
  const { events, bad } = parseNotificationLog(text);
  assert.equal(bad, 0);
  assert.deepEqual(events.map((e) => [e.type, e.taskId]), [
    [10, SHOOTER], [10, BACKGROUND], [10, BADREP], [10, UNKNOWN_ID], [14, '5fd4c8d49e4b2a58b34bbd29'],
  ]);
  assert.equal(events[0].id, '6a72bb512569f1c84b0391a9');
  assert.equal(events[0].dt, 1785903953);
});

test('parseNotificationLog leaves a half-written block for the next read', () => {
  const complete = '2026-08-04 21:25:52.179|1.1.0.0.46624|Info|push-notifications|Got notification | ChatMessageReceived\n'
    + '{\n  "type": "new_message",\n  "message": {\n    "_id": "abc",\n    "type": 10,\n    "dt": 1,\n'
    + '    "templateId": "' + SHOOTER + ' description"\n  }\n}\n';
  const partial = '2026-08-04 21:25:53.000|1.1.0.0.46624|Info|push-notifications|Got notification | ChatMessageReceived\n'
    + '{\n  "type": "new_message",\n  "message": {\n    "_id": "def",\n';
  const r = parseNotificationLog(complete + partial);
  assert.equal(r.events.length, 1);
  assert.equal(r.consumed, Buffer.byteLength(complete)); // cursor stops before the unfinished block
  const r2 = parseNotificationLog(complete + partial + '    "type": 10,\n    "dt": 2,\n    "templateId": "' + BACKGROUND + ' description"\n  }\n}\n');
  assert.deepEqual(r2.events.map((e) => e.id), ['abc', 'def']);
});

test('taskIdOf takes the first token, and only when it looks like an id', () => {
  assert.equal(taskIdOf('59689fbd86f7740d137ebfc4 description'), '59689fbd86f7740d137ebfc4');
  assert.equal(taskIdOf('616041eb031af660100c9967 successMessageText 58330581ace78e27b8b10cee 0'), '616041eb031af660100c9967');
  assert.equal(taskIdOf('hello world'), null);
  assert.equal(taskIdOf(''), null);
});

test('extractAccount takes the last ProfileId/AccountId pair', () => {
  const dir = stage(['a']);
  const app = path.join(dir, SESSION.a, fs.readdirSync(path.join(dir, SESSION.a)).find((f) => f.includes('application')));
  assert.deepEqual(extractAccount(fs.readFileSync(app, 'utf8')), { profileId: 'aaaa1111bbbb2222cccc3333', accountId: '10000001' });
  assert.equal(extractAccount('nothing here'), null);
});

test('sessionDate / pushLogFiles order sessions oldest first', () => {
  const dir = stage(['c', 'a', 'b']);
  assert.deepEqual(pushLogFiles(dir).map((f) => f.dir), [SESSION.a, SESSION.b, SESSION.c]);
  assert.equal(sessionDate(SESSION.a), '2026-08-04');
});

test('quests.json gives us the task-id filter', () => {
  const ids = loadTaskIds(defaultQuestsFile());
  assert.ok(ids.size > 400);
  for (const id of [SHOOTER, BACKGROUND, BADREP, AQUARIUS, FIRSTINLINE, SUPPLYPLANS]) assert.ok(ids.has(id), id);
  assert.equal(ids.has(UNKNOWN_ID), false);
});

// ---- state reconstruction -------------------------------------------------------------------------

test('replay walks every session oldest->newest and applies events in dt order', () => {
  const t = tracker(stage(['a', 'b']));
  const r = t.sync({ rescan: true });
  assert.equal(r.changed, true);
  // 59689fbd is logged finished BEFORE its own started block; dt ordering still lands it in done
  assert.deepEqual(sorted(t.state.active), [SHOOTER]);
  assert.deepEqual(sorted(t.state.done), sorted([BACKGROUND, AQUARIUS]));
  assert.deepEqual(sorted(t.state.failed), [BADREP]);
  assert.equal(t.state.since, '2026-08-04');
  assert.equal(t.state.accountId, '10000001');
});

test('finished removes a quest from active', () => {
  const t = tracker(stage(['a']));
  t.sync({ rescan: true });
  assert.ok(t.state.active.includes(BACKGROUND));
  addSessions(t.logsDir, ['b']);
  t.sync({ rescan: true });
  assert.equal(t.state.active.includes(BACKGROUND), false);
  assert.ok(t.state.done.includes(BACKGROUND));
});

test('unknown ids are kept aside, never published as active', () => {
  const t = tracker(stage(['a']));
  t.sync({ rescan: true });
  assert.deepEqual(t.state.unknown, [UNKNOWN_ID]);
  for (const set of ['active', 'done', 'failed']) assert.equal(t.state[set].includes(UNKNOWN_ID), false);
  assert.equal(t.snapshot().active.includes(UNKNOWN_ID), false);
});

test('duplicate message _ids are applied once, and a second sync is a no-op', () => {
  const t = tracker(stage(['a', 'b']));
  const first = t.sync({ rescan: true });
  assert.equal(first.applied, 7); // 3 known in A + 4 in B; the duplicated start is not one of them
  const dupId = '6a72bb512569f1c84b0391a9';
  assert.equal(t.state.seen.filter((id) => id === dupId).length, 1);
  const again = t.sync({ rescan: true });
  assert.equal(again.applied, 0);
  assert.equal(again.changed, false);
  assert.deepEqual(again.snapshot, first.snapshot);
});

test('cursor is persisted and a restart resumes instead of re-reading', () => {
  const dir = stage(['a']);
  const statePath = path.join(dir, 'companion-quests.json');
  const t = tracker(dir);
  t.sync({ rescan: true });
  const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(onDisk.cursor.file, `${SESSION.a}/${path.basename(pushLog(dir, 'a'))}`);
  assert.equal(onDisk.cursor.offset, fs.statSync(pushLog(dir, 'a')).size);

  // a fresh tracker (new process) picks the state back up and does not re-apply anything
  addSessions(dir, ['b']);
  const t2 = new QuestTracker({ logsDir: dir, statePath, questsFile: defaultQuestsFile() });
  assert.deepEqual(sorted(t2.state.active), sorted([SHOOTER, BACKGROUND, BADREP]));
  const r = t2.sync({ rescan: true });
  assert.equal(r.applied, 4); // only session B's four known events (the repeated start is deduped)
  assert.deepEqual(sorted(t2.state.active), [SHOOTER]);
});

test('tailing the live file picks up an appended block without a rescan', () => {
  const dir = stage(['a']);
  const t = tracker(dir);
  t.sync({ rescan: true });
  const before = t.state.cursor.offset;
  fs.appendFileSync(pushLog(dir, 'a'),
    '2026-08-04 21:40:00.000|1.1.0.0.46624|Info|push-notifications|Got notification | ChatMessageReceived\r\n'
    + '{\r\n  "type": "new_message",\r\n  "eventId": "6a72c0000000000000000001",\r\n  "dialogId": "54cb57776803fa99248b456e",\r\n'
    + '  "message": {\r\n    "_id": "6a72c0000000000000000002",\r\n    "type": 10,\r\n    "dt": 1785905000,\r\n'
    + `    "templateId": "${FIRSTINLINE} description",\r\n    "hasRewards": false\r\n  }\r\n}\r\n`);
  const r = t.sync(); // no rescan: only the file the cursor sits on is read
  assert.equal(r.changed, true);
  assert.equal(r.applied, 1);
  assert.ok(t.state.active.includes(FIRSTINLINE));
  assert.ok(t.state.cursor.offset > before);
});

// ---- damaged / unreadable logs ---------------------------------------------------------------------

test('a truncated tail in a closed session is stepped over, not parked on forever', () => {
  const dir = stage(['a', 'b']);
  fs.appendFileSync(pushLog(dir, 'a'), HALF_BLOCK);   // EFT killed mid-write; this file never grows again
  const lines = [];
  const t = tracker(dir, (l) => lines.push(l));
  for (let i = 0; i < 3; i++) t.sync({ rescan: true });
  assert.deepEqual(sorted(t.state.done), sorted([BACKGROUND, AQUARIUS]));  // session B was still read
  assert.deepEqual(sorted(t.state.active), [SHOOTER]);
  assert.ok(t.state.cursor.file.startsWith(SESSION.b), t.state.cursor.file);
  assert.equal(lines.filter((l) => l.includes('truncated tail')).length, 1); // said once, not per tick
});

test('a half-written block in the newest file is left for the next read', () => {
  const dir = stage(['a']);
  const t = tracker(dir);
  t.sync({ rescan: true });
  const at = t.state.cursor.offset;
  const half = block('6a72c0000000000000000002', 10, 1785905000, FIRSTINLINE).slice(0, -20);
  fs.appendFileSync(pushLog(dir, 'a'), half);
  assert.equal(t.sync().applied, 0);
  assert.equal(t.state.cursor.offset, at);            // the live file's tail is never skipped
  assert.equal(t.state.active.includes(FIRSTINLINE), false);
  fs.appendFileSync(pushLog(dir, 'a'), block('6a72c0000000000000000002', 10, 1785905000, FIRSTINLINE).slice(-20));
  assert.equal(t.sync().applied, 1);
  assert.ok(t.state.active.includes(FIRSTINLINE));
});

test('a read failure pins the cursor instead of losing that session', () => {
  const dir = stage(['a', 'b', 'c']);
  const clean = tracker(stage(['a', 'b', 'c']));
  clean.sync({ rescan: true });

  const lines = [];
  const t = tracker(dir, (l) => lines.push(l));
  const broken = pushLog(dir, 'b');
  const saved = fs.readFileSync(broken);
  fs.rmSync(broken); fs.mkdirSync(broken);            // statSync works, reading throws — an EIO blip
  for (let i = 0; i < 5; i++) t.sync({ rescan: true });
  assert.ok(t.state.cursor.file.startsWith(SESSION.a), t.state.cursor.file); // never jumped to C
  assert.equal(lines.filter((l) => l.includes('could not read')).length, 1);

  fs.rmSync(broken, { recursive: true }); fs.writeFileSync(broken, saved);
  t.sync({ rescan: true });
  assert.deepEqual(sorted(t.snapshot().active), sorted(clean.snapshot().active)); // session B recovered
  assert.deepEqual(sorted(t.snapshot().done), sorted(clean.snapshot().done));
  assert.deepEqual(sorted(t.snapshot().failed), sorted(clean.snapshot().failed));
  assert.equal(lines.filter((l) => l.includes('readable again')).length, 1);
});

test('a different AccountId wipes the state and replays only the new session', () => {
  const dir = stage(['a', 'b']);
  const t = tracker(dir);
  t.sync({ rescan: true });
  assert.equal(t.state.accountId, '10000001');

  addSessions(dir, ['c']);
  const r = t.sync({ rescan: true });
  assert.equal(r.changed, true);
  assert.equal(t.state.accountId, '20000002');
  assert.equal(t.state.profileId, 'dddd4444eeee5555ffff6666');
  assert.deepEqual(sorted(t.state.active), sorted([FIRSTINLINE, SUPPLYPLANS]));
  assert.deepEqual(t.state.done, []);
  assert.deepEqual(t.state.failed, []);
  assert.equal(t.state.since, '2026-08-09'); // "since" moves to the wipe, not the oldest log
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'companion-quests.json'), 'utf8')).accountId, '20000002');
});

test('reset() throws the reconstruction away and a later sync rebuilds it', () => {
  const dir = stage(['a', 'b']);
  const t = tracker(dir);
  t.sync({ rescan: true });
  const before = t.snapshot();
  t.reset('--reset-quests');
  assert.deepEqual(t.state.active, []);
  assert.deepEqual(t.state.seen, []);
  assert.equal(t.state.cursor.file, null);
  t.sync({ rescan: true });
  assert.deepEqual(sorted(t.snapshot().active), sorted(before.active));
  assert.deepEqual(sorted(t.snapshot().done), sorted(before.done));
});

test('snapshot is exactly what goes on the wire', () => {
  const t = tracker(stage(['a', 'b']));
  t.sync({ rescan: true });
  const snap = t.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ['accountId', 'active', 'done', 'failed', 'since', 'ts']);
  assert.equal(typeof snap.ts, 'number');
  assert.ok(snap.ts > 0);
  assert.equal(snap.since, '2026-08-04');
});

test('no logs folder is not an error', () => {
  const t = new QuestTracker({ logsDir: null, statePath: path.join(stage([]), 'companion-quests.json'), questsFile: defaultQuestsFile() });
  const r = t.sync({ rescan: true });
  assert.equal(r.changed, false);
  assert.deepEqual(r.snapshot.active, []);
});
