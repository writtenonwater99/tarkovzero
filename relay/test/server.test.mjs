// node --test relay/test/server.test.mjs   (or: npm run test:relay)
// Spawns the real relay on an ephemeral port (PORT=0) and talks to it over HTTP + ws.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'server.mjs');
const CODE = 'TESTQ1';
const id = (n) => n.toString(16).padStart(24, '0');

let child = null, base = null;

test.before(async () => {
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 10_000);
    child.stdout.on('data', (d) => {
      const m = /listening on :(\d+)/.exec(String(d));
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('relay exited early with ' + c)); });
  });
  base = `http://127.0.0.1:${port}`;
});
test.after(() => { try { child?.kill(); } catch {} });

const post = (code, body) => fetch(`${base}/quests/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const health = async () => (await fetch(`${base}/health`)).json();
function subscribe(code) { // resolves with the first {type:'quests'} message a late joiner receives
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/sub/${code}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no quests message')); }, 5000);
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type !== 'quests') return;
      clearTimeout(timer); ws.close(); resolve(m);
    });
    ws.on('error', reject);
  });
}

test('a JSON body that is not an object is rejected without killing the relay', async () => {
  for (const body of ['null', '[]', '"nope"', '5', 'true', 'not json at all']) {
    const res = await post(CODE, body);
    assert.equal(res.status, 400, body);
    assert.equal(await res.text(), 'bad json');
    assert.equal((await health()).ok, true, `relay died on body ${body}`); // the process must still be up
  }
});

test('missing quest arrays are treated as empty, not as a crash', async () => {
  const res = await post('TESTQ2', JSON.stringify({ ts: 1 }));
  assert.equal(res.status, 200);
  const msg = await subscribe('TESTQ2');
  assert.deepEqual([msg.active, msg.done, msg.failed], [[], [], []]);
});

test('a done list longer than the old 500 cap survives the round trip', async () => {
  const done = Array.from({ length: 600 }, (_, i) => id(i + 1));
  assert.equal((await post('TESTQ3', JSON.stringify({ active: [], done, failed: [], ts: 10 }))).status, 200);
  const msg = await subscribe('TESTQ3');
  assert.equal(msg.done.length, 600);
  assert.deepEqual(msg.done, done);
});

test('a quest set with an older ts never replaces a newer one', async () => {
  const newer = { active: [], done: [id(7)], failed: [], ts: 2000 };
  const older = { active: [id(9)], done: [], failed: [], ts: 1000 };
  assert.equal(await (await post('TESTQ4', JSON.stringify(newer))).text(), 'ok');
  assert.equal(await (await post('TESTQ4', JSON.stringify(older))).text(), 'stale');
  const msg = await subscribe('TESTQ4');
  assert.equal(msg.ts, 2000);
  assert.deepEqual(msg.done, [id(7)]);
  assert.deepEqual(msg.active, []);
  // the same ts is still accepted (a reconnect re-posts the current set verbatim)
  assert.equal(await (await post('TESTQ4', JSON.stringify({ ...newer, active: [id(9)] }))).text(), 'ok');
  assert.deepEqual((await subscribe('TESTQ4')).active, [id(9)]);
});
