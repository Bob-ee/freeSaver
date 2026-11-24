// Watches the app on the TV over a long session and logs what it sees.
//   node scripts/soak.mjs [hours=10] [intervalMinutes=5]
// Each line of scripts/.cache/soak/soak.jsonl is one sample: which apps the TV
// reports as running, and the app's own view (foreground? animating?
// pictures shown/failed, memory, keep-awake video state).
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => join(root, 'node_modules', '.bin', name);
const APP = 'com.freesaver.app';
const hours = Number(process.argv[2]) || 10;
const every = (Number(process.argv[3]) || 5) * 60000;
const outDir = join(root, 'scripts', '.cache', 'soak');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'soak.jsonl');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (cmd, args, ms = 30000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, encoding: 'utf8' }, (err, stdout, stderr) => resolve((stdout || '') + (stderr || '')));
});

let tunnel = null;
let base = null;
function openTunnel() {
  return new Promise((resolve) => {
    base = null;
    if (tunnel) tunnel.kill();
    tunnel = spawn(bin('ares-inspect'), ['--device', 'tv', '--app', APP], { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = setTimeout(() => resolve(false), 20000);
    tunnel.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/localhost:(\d+)/);
      if (m && !base) { base = `http://localhost:${m[1]}`; clearTimeout(done); resolve(true); }
    });
    tunnel.on('exit', () => { base = null; });
  });
}

const PROBE = `(async () => {
  const frames = await new Promise((res) => { let n = 0; const t0 = performance.now();
    const tick = () => { n++; performance.now() - t0 < 1000 ? requestAnimationFrame(tick) : res(n); };
    requestAnimationFrame(tick); setTimeout(() => res(n), 1500); });
  const v = document.getElementById('keepawake');
  const img = document.querySelector('.slide.visible img');
  let log = []; try { log = JSON.parse(localStorage.getItem('freesaver.log') || '[]'); } catch (e) {}
  return JSON.stringify({ hidden: document.hidden, frames, video: v.paused ? 'paused' : 'playing', videoT: Math.round(v.currentTime),
    pic: img ? img.src.slice(-40) : null, message: document.getElementById('message').textContent,
    mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
    lastBeat: (log.filter((e) => e[1] === 'beat').pop() || [])[2] || null,
    events: log.filter((e) => e[1] !== 'beat').slice(-6) });
})()`;

async function probe() {
  if (!base && !(await openTunnel())) return { error: 'no tunnel' };
  try {
    const pages = await (await fetch(base + '/json', { signal: AbortSignal.timeout(8000) })).json();
    const ws = new WebSocket(pages[0].webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, 'ws://' + base.replace('http://', '')));
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); setTimeout(() => rej(new Error('ws timeout')), 8000); });
    const answer = await new Promise((res, rej) => {
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result); };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: PROBE, awaitPromise: true, returnByValue: true } }));
      setTimeout(() => rej(new Error('probe timeout')), 15000);
    });
    ws.close();
    return JSON.parse(answer.result.value);
  } catch (err) {
    base = null; // reopen the tunnel next time
    return { error: String(err.message || err) };
  }
}

const until = Date.now() + hours * 3600000;
while (Date.now() < until) {
  const running = (await run(bin('ares-launch'), ['--device', 'tv', '--running'])).split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('[') && !/ERR/.test(l));
  const sample = { at: new Date().toISOString(), running, app: running.includes(APP) ? await probe() : { error: 'app not running' } };
  appendFileSync(out, JSON.stringify(sample) + '\n');
  await wait(every);
}
if (tunnel) tunnel.kill();
