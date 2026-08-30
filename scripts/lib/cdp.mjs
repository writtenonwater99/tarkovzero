/**
 * A very small Chrome DevTools Protocol client — enough to drive the real app in headless
 * Chromium without adding playwright to the dependency tree.
 *
 * Why raw CDP and not `chromium --screenshot`: this app runs a permanent deck.gl
 * requestAnimationFrame loop, and headless Chromium's screenshot path waits for the virtual-time
 * budget to settle, which never happens — the browser just hangs. Driving a live target over the
 * protocol sidesteps that entirely (same recipe as the scratchpad `shoot.mjs` driver).
 *
 * Everything here is stdlib: node's global WebSocket (node ≥ 22) and child_process.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SwiftShader flags: this machine has no GPU, and deck.gl needs a real WebGL2 context. */
export const CHROMIUM_FLAGS = [
  '--headless=new', '--no-sandbox', '--hide-scrollbars', '--disable-gpu-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--force-device-scale-factor=1',
  '--disable-features=Translate,BackForwardCache', '--no-first-run', '--no-default-browser-check',
];

/** Key descriptors CDP needs; anything not listed is treated as a printable character. */
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ']': { code: 'BracketRight', keyCode: 221, text: ']' },
  '[': { code: 'BracketLeft', keyCode: 219, text: '[' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
};
function keyDesc(key) {
  if (KEYS[key]) return { key, ...KEYS[key] };
  const upper = key.toUpperCase();
  const code = /[a-z]/i.test(key) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : '';
  return { key, code, keyCode: upper.charCodeAt(0), text: key };
}

class CdpError extends Error {}

/**
 * Launch Chromium and attach to one page target.
 *
 * @param {object} [opts]
 * @param {number} [opts.width] @param {number} [opts.height]
 * @param {string} [opts.executablePath]
 * @param {(entry:{type:string,text:string})=>void} [opts.onConsole]
 */
export async function launch({
  width = 1400, height = 985, executablePath = '/usr/bin/chromium', onConsole,
} = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'tz-e2e-'));
  const port = 9500 + Math.floor(Math.random() * 400);
  const proc = spawn(executablePath, [
    ...CHROMIUM_FLAGS,
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); }
    catch { await sleep(500); }
  }
  if (!version) { proc.kill('SIGKILL'); throw new CdpError('chromium never opened its debugging port'); }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new CdpError('CDP websocket refused')); });

  let id = 0;
  const waiting = new Map();
  const events = [];      // {method, params} — kept so callers can drain console/exception logs
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (!m.method) return;
    events.push(m);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      onConsole?.({ type: m.params.type, text });
    } else if (m.method === 'Runtime.exceptionThrown') {
      onConsole?.({ type: 'exception', text: m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'exception' });
    }
  };

  let sessionId = null;
  const send = (method, params = {}, useSession = true) => new Promise((res, rej) => {
    const n = ++id;
    waiting.set(n, (m) => (m.error ? rej(new CdpError(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params, ...(useSession && sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true, width, height }, false);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  /* ------------------------------------------------------------------ page API -- */
  async function evaluate(expression, { awaitPromise = false } = {}) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new CdpError(`page threw: ${d.exception?.description ?? d.text}`);
    }
    return r.result?.value;
  }

  /** Poll `expression` (must return truthy) until it holds or `timeout` runs out. */
  async function waitFor(expression, { timeout = 20_000, interval = 120, label = expression } = {}) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) {
      try { const v = await evaluate(`(() => { try { return (${expression}); } catch (e) { return '__throw:' + e.message; } })()`); if (typeof v === 'string' && v.startsWith('__throw:')) last = v; else if (v) return v; else last = v; }
      catch (e) { last = e.message; }
      await sleep(interval);
    }
    throw new CdpError(`timed out after ${timeout} ms waiting for ${label} (last value: ${JSON.stringify(last)})`);
  }

  async function navigate(url, { waitUntilLoad = true } = {}) {
    await send('Page.navigate', { url });
    if (!waitUntilLoad) return;
    await waitFor('document.readyState === "complete"', { timeout: 30_000, label: 'document load' });
  }

  async function key(k, { modifiers = 0 } = {}) {
    const d = keyDesc(k);
    const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, modifiers };
    await send('Input.dispatchKeyEvent', { type: d.text ? 'keyDown' : 'rawKeyDown', ...base, text: d.text ?? '', unmodifiedText: d.text ?? '' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(12);
  }

  /** Type into whatever has focus, one real key event per character. */
  async function type(text, { delay = 22 } = {}) {
    for (const ch of text) { await key(ch); await sleep(delay); }
  }

  async function click(x, y, { button = 'left', delay = 40 } = {}) {
    const p = { x: Math.round(x), y: Math.round(y), button, buttons: 1, clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, buttons: 0 });
    await sleep(delay);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p });
    await sleep(delay);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p });
    await sleep(delay);
  }

  /** Raw PNG bytes of the current frame. */
  async function screenshot() {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(shot.data, 'base64');
  }

  async function close() {
    try { ws.close(); } catch {}
    proc.kill('SIGKILL');
    await sleep(120);
    rmSync(profile, { recursive: true, force: true });
  }

  return { send, evaluate, waitFor, navigate, key, type, click, screenshot, close, events, viewport: { width, height } };
}
