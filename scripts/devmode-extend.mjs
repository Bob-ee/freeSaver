#!/usr/bin/env node
// Keep the TV's Developer Mode session alive.
//
//   node scripts/devmode-extend.mjs              extend the session
//   node scripts/devmode-extend.mjs --check      only report remaining time
//   node scripts/devmode-extend.mjs --device tv  pick another ares device name
//   node scripts/devmode-extend.mjs --debug      also print raw (token-free) server replies
//
// How it works: the session token is read from the TV over the dev-mode SSH
// connection, then LG's developer server is asked to check / reset the session.
// The token is never printed, logged or written anywhere.
//
// Exit codes: 0 ok, 2 TV unreachable / off (normal for a scheduled job),
//             1 any other failure.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOVACOM = path.join(root, 'node_modules', '.bin', 'ares-novacom');
const LG = 'https://developer.lge.com/secure';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const debug = args.includes('--debug');
const di = args.indexOf('--device');
const device = di >= 0 && args[di + 1] ? args[di + 1] : 'tv';
if (args.includes('-h') || args.includes('--help')) {
  console.log('usage: devmode-extend.mjs [--check] [--device <name>] [--debug]');
  process.exit(0);
}

class TvOffline extends Error {}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function say(msg) {
  console.log(`[${ts()}] ${msg}`);
}
function fail(code, msg) {
  console.error(`[${ts()}] ${msg}`);
  process.exit(code);
}

function readToken() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(NOVACOM)) {
      return reject(new Error(`ares-novacom not found at ${NOVACOM} (run npm install)`));
    }
    const p = spawn(
      NOVACOM,
      ['--device', device, '--run', 'cat /var/luna/preferences/devmode_enabled'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // ares tools start with "#!/usr/bin/env node"; a scheduled job's PATH
        // usually lacks node, so put the running node's folder on it.
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}` }
      }
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new TvOffline('timed out talking to the TV'));
    }, 15000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const all = out + '\n' + err;
      if (code !== 0) {
        if (/no matched device|unknown device|not registered/i.test(all)) {
          return reject(new Error(`device "${device}" is not set up (run ares-setup-device --list)`));
        }
        if (/env: node|No such file or directory/i.test(all)) {
          return reject(new Error('could not start the LG tools: ' + all.trim().split('\n')[0]));
        }
        return reject(new TvOffline(all.replace(/\[Info\][^\n]*\n?/g, '').trim().split('\n')[0] || `exit ${code}`));
      }
      // The first lines are ares "[Info] ..." chatter; the token is a bare hex-ish string.
      const lines = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('['));
      const token = lines[lines.length - 1];
      if (!token || !/^[A-Za-z0-9._-]{16,}$/.test(token)) {
        return reject(
          new Error('Developer Mode session token not found on the TV (is Developer Mode enabled?)')
        );
      }
      resolve(token);
    });
  });
}

async function lg(kind, token) {
  const url = `${LG}/${kind}.dev?sessionToken=${encodeURIComponent(token)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`could not reach developer.lge.com (${e.cause?.code || e.name})`);
  }
  const text = (await res.text()).trim();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (debug) console.error(`  ${kind}: HTTP ${res.status} ${text.slice(0, 300).split(token).join('<token>')}`);
  return { status: res.status, text, json };
}

// Check reply is JSON like {"result":"success","errorCode":"200","errorMsg":"<remaining>"}
// where the message is the time left. Be liberal in what we parse.
function remainingHours(reply) {
  const j = reply.json;
  if (!j) return null;
  if (String(j.result).toLowerCase() !== 'success') return null;
  const raw = j.errorMsg ?? j.remainingTime ?? j.remain ?? j.data;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  // e.g. "1000:00:00" or "999 hours"
  const m = String(raw).match(/(\d+)(?::(\d+))?/);
  if (!m) return null;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
}

function fmt(h) {
  return h == null ? 'unknown' : `${Math.round(h * 10) / 10}h`;
}

function describeFailure(reply) {
  const j = reply.json;
  if (j && (j.errorMsg || j.result)) return `${j.result || 'error'}: ${j.errorMsg || ''}`.trim();
  return `HTTP ${reply.status}`;
}

async function main() {
  const token = await readToken();
  const before = await lg('CheckDevModeSession', token);
  const hb = remainingHours(before);
  if (hb == null) throw new Error(`session check failed (${describeFailure(before)}); Developer Mode may have expired`);
  if (checkOnly) {
    say(`Developer Mode on "${device}": ${fmt(hb)} remaining`);
    return;
  }
  const reset = await lg('ResetDevModeSession', token);
  const okReset = reset.json && String(reset.json.result).toLowerCase() === 'success';
  if (!okReset) throw new Error(`extend failed (${describeFailure(reset)})`);
  const after = await lg('CheckDevModeSession', token);
  const ha = remainingHours(after);
  say(`Developer Mode on "${device}" extended: ${fmt(hb)} -> ${fmt(ha)} remaining`);
}

main().catch((e) => {
  if (e instanceof TvOffline) {
    fail(2, `TV "${device}" is unreachable (${e.message}); nothing to do. Is it on and on the network?`);
  }
  fail(1, `devmode-extend: ${e.message}`);
});
