// Screenshots of the demo (tools/demo/up.sh) through headless Chrome over the DevTools protocol:
// set the theme, open each path, save a PNG at twice the size.
//   node tools/demo/shot.mjs <outdir> <theme:light|dark> <width> <name=path...>
//   node tools/demo/shot.mjs docs/screenshots light 1440 overview=/ containers=/containers
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.DEMO_URL ?? 'http://127.0.0.1:8899';
const [out, theme, widthArg, ...shots] = process.argv.slice(2);
const width = Number(widthArg) || 1440;
const viewport = width < 700 ? 860 : 900;
mkdirSync(out, { recursive: true });

const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn(
  'google-chrome',
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shot-'))}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--lang=en-GB', 'about:blank'],
  { stdio: 'ignore' },
);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50 && !ws; i++) {
  try {
    ws = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {
    await wait(200);
  }
}
if (!ws) throw new Error('chrome did not come up');
const sock = new WebSocket(ws);
await new Promise((r) => (sock.onopen = r));
let id = 0;
const pending = new Map();
sock.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    sock.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Emulation.setLocaleOverride', { locale: 'en-GB' }, sessionId);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, sessionId);
for (const shot of shots) {
  const name = shot.slice(0, shot.indexOf('='));
  const path = shot.slice(name.length + 1);
  await send('Emulation.setDeviceMetricsOverride', { width, height: viewport, deviceScaleFactor: 2, mobile: width < 700 }, sessionId);
  await send('Page.navigate', { url: base + path }, sessionId);
  // the live charts need a few samples before they are worth a picture
  await wait(9000);
  const { result } = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true }, sessionId);
  const height = Math.min(Math.max(viewport, result.value), Number(process.env.SHOT_MAX_HEIGHT) || 1500);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 700 }, sessionId);
  await wait(500);
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = join(out, `${name}-${theme}${width < 700 ? '-phone' : ''}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(file);
}
sock.close();
chrome.kill();
