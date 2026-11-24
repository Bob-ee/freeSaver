#!/usr/bin/env node
// freeSaver photo server: serves the pictures in photos/ to the TV over the
// home network, converting each one once to a TV-sized, upright JPEG.
//
//   node scripts/photo-server.mjs [--dir <folder>] [--port 8377] [--cache <folder>] [--quiet]
//
// Endpoints (read-only, CORS open):
//   GET /photos.json   { photos: [{ src, title, ar, mtime }], version }   newest first
//   GET /p/<id>.jpg    the converted picture (immutable, cached for a year)
//   GET /health        { ok: true, name: "freeSaver photos", count }
//
// Needs macOS (uses `sips`). No npm dependencies.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- options ----------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('usage: photo-server.mjs [--dir <folder>] [--port 8377] [--cache <folder>] [--quiet]');
  process.exit(0);
}
const PHOTO_DIR = path.resolve(opt('dir', path.join(root, 'photos')));
const PORT = Number(opt('port', '8377'));
const QUIET = argv.includes('--quiet');
const CACHE_ROOT = path.resolve(opt('cache', path.join(root, 'scripts', '.cache', 'photos')));
// One sub-folder per photo directory so two servers never clean each other's files.
const CACHE_DIR = path.join(CACHE_ROOT, crypto.createHash('sha1').update(PHOTO_DIR).digest('hex').slice(0, 10));
const MAX_DIM = 3840;
const JPEG_QUALITY = 85;
const CONCURRENCY = 2;
const SETTLE_MS = 2000; // ignore files modified this recently (still being copied)
const EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.webp', '.gif', '.bmp']);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('invalid --port');
  process.exit(1);
}
const log = (...a) => {
  if (!QUIET) console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
};

// ---------- sips helpers ----------
function sips(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sips', args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n')[0]));
      resolve(stdout);
    });
  });
}
async function dims(file) {
  const out = await sips(['-g', 'pixelWidth', '-g', 'pixelHeight', file], 30000);
  const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
  if (!w || !h) throw new Error('unreadable image');
  return { w, h };
}

// Read the EXIF orientation of a JPEG. Returns { value, offset, little } or null.
function jpegOrientation(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return null;
    const marker = buf[p + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const len = buf.readUInt16BE(p + 2);
    if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const t = p + 10; // TIFF header
      const little = buf.toString('latin1', t, t + 2) === 'II';
      const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      if (t + 8 > buf.length) return null;
      const ifd = t + u32(t + 4);
      if (ifd + 2 > buf.length) return null;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > buf.length) return null;
        if (u16(e) === 0x0112) return { value: u16(e + 8), offset: e + 8, little };
      }
      return null;
    }
    p += 2 + len;
  }
  return null;
}

// sips argument lists that turn EXIF orientation 2..8 into an upright picture.
// The argument order of the mirrored cases (5, 7) matters to sips; both were
// verified pixel-by-pixel against a four-colour test image.
const FIXES = {
  2: ['-f', 'horizontal'],
  3: ['-r', '180'],
  4: ['-f', 'vertical'],
  5: ['-r', '270', '-f', 'horizontal'],
  6: ['-r', '90'],
  7: ['-f', 'horizontal', '-r', '270'],
  8: ['-r', '270'],
};

// ---------- conversion ----------
async function convert(entry) {
  const out = path.join(CACHE_DIR, entry.id + '.jpg');
  const tmp = path.join(CACHE_DIR, entry.id + '.tmp.jpg');
  try {
    const src = await dims(entry.abs);
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY)];
    if (Math.max(src.w, src.h) > MAX_DIM) args.push('-Z', String(MAX_DIM)); // never enlarge
    await sips([...args, entry.abs, '--out', tmp]);

    // sips keeps the EXIF orientation tag but does not rotate the pixels. Bake it in
    // and reset the tag to 1 so viewers do not rotate a second time.
    const head = fs.readFileSync(tmp).subarray(0, 262144);
    const o = jpegOrientation(head);
    if (o && o.value > 1 && FIXES[o.value]) {
      await sips([...FIXES[o.value], '-s', 'formatOptions', String(JPEG_QUALITY), tmp]);
      const again = jpegOrientation(fs.readFileSync(tmp).subarray(0, 262144));
      if (again && again.value !== 1) {
        const fd = fs.openSync(tmp, 'r+');
        const b = Buffer.alloc(2);
        if (again.little) b.writeUInt16LE(1); else b.writeUInt16BE(1);
        fs.writeSync(fd, b, 0, 2, again.offset);
        fs.closeSync(fd);
      }
    }
    const d = await dims(tmp);
    fs.writeFileSync(path.join(CACHE_DIR, entry.id + '.json'), JSON.stringify({ w: d.w, h: d.h }));
    fs.renameSync(tmp, out);
    return { w: d.w, h: d.h };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- state ----------
// current: id -> { id, abs, rel, title, mtimeMs, size, w?, h?, ready, failed }
let current = new Map();
let version = 'empty';
let lastScan = 0;
let scanning = null;
let rescanAgain = false;
const queue = [];
let running = 0;
let settleTimer = null;

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const entry = queue.shift();
    if (current.get(entry.id) !== entry) continue; // file vanished or changed meanwhile
    running++;
    const t0 = Date.now();
    convert(entry)
      .then((d) => {
        entry.w = d.w;
        entry.h = d.h;
        entry.ready = true;
        log(`converted ${entry.rel} -> ${d.w}x${d.h} (${Date.now() - t0} ms)`);
      })
      .catch((e) => {
        entry.failed = true;
        log(`skipping ${entry.rel}: ${e.message}`);
      })
      .finally(() => {
        running--;
        recomputeVersion();
        pump();
      });
  }
}

function recomputeVersion() {
  const h = crypto.createHash('sha1');
  for (const e of [...current.values()].filter((e) => e.ready).sort((a, b) => a.id.localeCompare(b.id))) h.update(e.id + ';');
  version = h.digest('hex').slice(0, 12);
}

async function walk(dir, rel, out) {
  let items;
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const abs = path.join(dir, it.name);
    if (it.isDirectory()) await walk(abs, rel + it.name + '/', out);
    else if (it.isFile() && EXTS.has(path.extname(it.name).toLowerCase())) out.push({ abs, rel: rel + it.name, name: it.name });
    // symlinks are deliberately ignored
  }
}

async function doScan() {
  const files = [];
  await walk(PHOTO_DIR, '', files);
  const next = new Map();
  let unsettled = false;
  for (const f of files) {
    let st;
    try {
      st = await fs.promises.stat(f.abs);
    } catch {
      continue;
    }
    if (Date.now() - st.mtimeMs < SETTLE_MS) {
      unsettled = true;
      continue;
    }
    const id = crypto.createHash('sha1').update(`${f.rel}\0${st.size}\0${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 16);
    const prev = current.get(id);
    if (prev) {
      next.set(id, prev);
      continue;
    }
    const entry = {
      id,
      abs: f.abs,
      rel: f.rel,
      title: f.name.slice(0, f.name.length - path.extname(f.name).length),
      mtimeMs: Math.round(st.mtimeMs),
      size: st.size,
      ready: false,
      failed: false,
    };
    // Already converted earlier (e.g. before a restart)?
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, id + '.json'), 'utf8'));
      if (fs.existsSync(path.join(CACHE_DIR, id + '.jpg')) && meta.w && meta.h) {
        entry.w = meta.w;
        entry.h = meta.h;
        entry.ready = true;
      }
    } catch {}
    next.set(id, entry);
    if (!entry.ready) queue.push(entry);
  }
  const added = [...next.keys()].filter((k) => !current.has(k)).length;
  const removed = [...current.keys()].filter((k) => !next.has(k)).length;
  current = next;
  if (added || removed) log(`scan: ${next.size} picture(s), +${added} -${removed}`);

  // Drop cache files that no longer belong to any picture.
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      const m = /^([0-9a-f]{16})\.(jpg|json)$/.exec(name);
      if (!m || !next.has(m[1])) fs.rmSync(path.join(CACHE_DIR, name), { force: true });
    }
  } catch {}

  recomputeVersion();
  pump();
  lastScan = Date.now();
  if (unsettled && !settleTimer) {
    settleTimer = setTimeout(() => {
      settleTimer = null;
      scan();
    }, SETTLE_MS + 500);
  }
}

function scan() {
  if (scanning) {
    rescanAgain = true;
    return scanning;
  }
  scanning = doScan()
    .catch((e) => log('scan error:', e.message))
    .finally(() => {
      scanning = null;
      if (rescanAgain) {
        rescanAgain = false;
        scan();
      }
    });
  return scanning;
}

let debounce = null;
function scheduleScan() {
  clearTimeout(debounce);
  debounce = setTimeout(scan, 400);
}

// ---------- HTTP ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function sendJson(req, res, code, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    ...extra,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function readyList() {
  return [...current.values()].filter((e) => e.ready).sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, OPTIONS' });
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      return sendJson(req, res, 400, { error: 'bad request' });
    }

    if (pathname === '/health') {
      return sendJson(req, res, 200, { ok: true, name: 'freeSaver photos', count: readyList().length });
    }
    if (pathname === '/photos.json') {
      if (Date.now() - lastScan > 3000) await scan();
      const photos = readyList().map((e) => ({
        src: `/p/${e.id}.jpg`,
        title: e.title,
        ar: Math.round((e.w / e.h) * 100) / 100,
        mtime: e.mtimeMs,
      }));
      return sendJson(req, res, 200, { photos, version });
    }
    const m = /^\/p\/([0-9a-f]{16})\.jpg$/.exec(pathname);
    if (m) {
      const entry = current.get(m[1]);
      if (!entry || !entry.ready) return sendJson(req, res, 404, { error: 'not found' });
      const file = path.join(CACHE_DIR, entry.id + '.jpg');
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        return sendJson(req, res, 404, { error: 'not found' });
      }
      const etag = `"${entry.id}"`;
      const headers = {
        ...CORS,
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
        'Last-Modified': new Date(entry.mtimeMs).toUTCString(),
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      return stream.pipe(res);
    }
    return sendJson(req, res, 404, { error: 'not found' });
  } catch (e) {
    log('request error:', e.message);
    if (!res.headersSent) sendJson(req, res, 500, { error: 'server error' });
    else res.destroy();
  }
});

// ---------- start ----------
function localUrls() {
  const urls = [];
  try {
    const n = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (n) urls.push(`http://${n}.local:${PORT}`);
  } catch {}
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
  }
  return urls;
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : `server error: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, '::', async () => {
  console.log(`freeSaver photo server: ${PHOTO_DIR}${fs.existsSync(PHOTO_DIR) ? '' : ' (folder does not exist yet)'}`);
  console.log('Reachable from the TV at:');
  for (const u of localUrls()) console.log('  ' + u);
  await scan();
  console.log(`${current.size} picture(s) found; converting in the background.`);
  try {
    fs.watch(PHOTO_DIR, { recursive: true }, scheduleScan).on('error', () => {});
  } catch {} // folder missing: the periodic rescan below picks it up later
  setInterval(scan, 30000).unref?.();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
