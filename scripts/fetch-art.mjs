// Rebuilds app/art.json from every module in scripts/sources/.
//   npm run art:refresh            all sources
//   npm run art:refresh -- met     just the named ones (others are kept as-is)
// A source that fails keeps whatever it contributed last time.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'app', 'art.json');
const CATEGORIES = new Set([
  'landscapes', 'seascapes', 'cities', 'impressionism', 'still-life', 'portraits',
  'japanese-prints', 'modern-abstract', 'botanical-animals', 'photography', 'space'
]);

const only = process.argv.slice(2);
const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const previousWorks = Array.isArray(previous.works) ? previous.works : [];

const modules = [];
for (const file of readdirSync(join(here, 'sources')).filter((f) => f.endsWith('.mjs')).sort()) {
  modules.push(await import(pathToFileURL(join(here, 'sources', file)).href));
}

function clean(work, sourceId) {
  if (!work || typeof work.title !== 'string') return null;
  const src = (Array.isArray(work.src) ? work.src : []).filter((u) => typeof u === 'string' && u.startsWith('https://'));
  const cats = (Array.isArray(work.cats) ? work.cats : []).filter((c) => CATEGORIES.has(c));
  if (!src.length || !cats.length) return null;
  const out = { src, title: work.title.trim(), sub: String(work.sub || '').trim(), cats: [...new Set(cats)], source: sourceId };
  if (Number.isFinite(work.ar) && work.ar > 0) out.ar = Math.round(work.ar * 100) / 100; // width / height
  if (typeof work.thumb === 'string' && work.thumb.startsWith('https://')) out.thumb = work.thumb;
  out.fresh = true; // fetched in this run, so not yet scored
  return out;
}

const results = await Promise.all(modules.map(async (mod) => {
  const kept = previousWorks.filter((w) => w.source === mod.id);
  if (only.length && !only.includes(mod.id)) return { mod, works: kept, note: 'kept' };
  try {
    const started = Date.now();
    const works = (await mod.default()).map((w) => clean(w, mod.id)).filter(Boolean);
    if (works.length < 20) throw new Error(`only ${works.length} usable works`);
    return { mod, works, note: `${Math.round((Date.now() - started) / 1000)}s` };
  } catch (err) {
    return { mod, works: kept, note: `FAILED (${err.message}); kept ${kept.length} from last time` };
  }
}));

const works = [];
const sources = [];
for (const { mod, works: list, note } of results) {
  console.log(`${mod.label.padEnd(28)} ${String(list.length).padStart(5)}  ${note}`);
  if (!list.length) continue;
  sources.push({ id: mod.id, label: mod.label });
  works.push(...list);
}

const byCat = {};
for (const w of works) for (const c of w.cats) byCat[c] = (byCat[c] || 0) + 1;
console.log(Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', '));

if (!works.length) throw new Error('no works at all; leaving app/art.json untouched');

// ---- Score every picture for brightness and colour, and drop the murky ones.
// Each thumbnail is decoded to 32x32 RGB by ffmpeg. Scores are cached, so
// only new pictures cost anything on later runs.
//
// "Variety" is how much the colour differs across the picture. An overall
// tint does not count: a sepia photograph or a drawing on yellowed paper is
// strongly tinted but has almost no variety, and those are what we leave out.
const MIN_LIGHT = 62;     // mean brightness 0-255: below this the picture is mostly dark
const MIN_VARIETY = 12;   // below this it is monochrome, whatever its tint
const cacheDir = join(here, '.cache');
mkdirSync(cacheDir, { recursive: true });
const cacheFile = join(cacheDir, 'scores.json');
const scores = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Thumbnails are remembered beside the scores (not in the app), both for
// scoring works that were not re-fetched this run and for the review sheets
// made by scripts/contact-sheets.py.
const thumbFile = join(cacheDir, 'thumbs.json');
const thumbs = existsSync(thumbFile) ? JSON.parse(readFileSync(thumbFile, 'utf8')) : {};
for (const w of works) if (w.thumb) thumbs[w.src[0]] = w.thumb;
writeFileSync(thumbFile, JSON.stringify(thumbs));
const thumbOf = (w) => w.thumb || thumbs[w.src[0]] || w.src[w.src.length - 1];

async function measure(url) {
  // Downloaded with curl over HTTP/2: some image servers (Wikimedia) refuse
  // HTTP/1.1 clients such as Node's fetch, and others refuse ffmpeg's own.
  const bytes = await new Promise((resolve) => {
    execFile('curl', ['-sfL', '--http2', '-m', '40', '-A', UA, url],
      { encoding: 'buffer', maxBuffer: 40 << 20 }, (err, out) => resolve(err || !out || !out.length ? null : out));
  });
  if (!bytes) return null;
  return new Promise((resolve) => {
    const child = execFile('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', 'scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', timeout: 60000, maxBuffer: 1 << 20 }, (err, px) => {
      if (err || !px || px.length < 32 * 32 * 3) return resolve(null);
      const n = 32 * 32;
      let light = 0, rg = 0, yb = 0, rg2 = 0, yb2 = 0;
      for (let i = 0; i < n; i++) {
        const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
        light += 0.299 * r + 0.587 * g + 0.114 * b;
        const a = r - g, c = 0.5 * (r + g) - b;
        rg += a; yb += c; rg2 += a * a; yb2 += c * c;
      }
      const mrg = rg / n, myb = yb / n;
      const variety = Math.sqrt(Math.max(0, rg2 / n - mrg * mrg) + Math.max(0, yb2 / n - myb * myb));
      resolve({ l: Math.round(light / n), s: Math.round(variety * 10) / 10 });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

const todo = works.filter((w) => { const s = scores[thumbOf(w)]; return !s || s.s === undefined; });
if (todo.length) console.log(`scoring ${todo.length} pictures...`);
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < todo.length) {
    const w = todo[next++];
    const s = await measure(thumbOf(w));
    if (s) scores[thumbOf(w)] = s;
  }
}));
writeFileSync(cacheFile, JSON.stringify(scores));

// Review by eye: scripts/review.json maps a work's first image URL to a
// verdict, "<code>: reason". Nothing is thrown away: works are labelled, so
// the app can offer a curated selection by default and everything on request.
//   U              unsuitable for a family room   -> "mature" (m), its own switch
//   any other code (N not really a picture, R poor reproduction, S space junk,
//                   C bad 16:9 crop, D dull as wall art) -> second tier (t: 2)
const reviewFile = join(here, 'review.json');
const review = existsSync(reviewFile) ? JSON.parse(readFileSync(reviewFile, 'utf8')) : {};
const tally = { mature: 0, secondByEye: 0, secondByScore: 0 };

const kept = [];
for (const w of works) {
  const s = scores[thumbOf(w)];
  delete w.thumb; // build-time only; keeps the bundled file small
  delete w.fresh;
  delete w.t; delete w.m;
  const code = String(review[w.src[0]] || '').trim().charAt(0).toUpperCase();
  if (code === 'U') { w.m = 1; tally.mature++; }
  else if (code) { w.t = 2; tally.secondByEye++; }
  // Dark or monochrome works go to the second tier too. Space is meant to be
  // dark and is often one colour, so NASA is exempt.
  if (!w.t && s && w.source !== 'nasa' && (s.l < MIN_LIGHT || s.s < MIN_VARIETY)) { w.t = 2; tally.secondByScore++; }
  if (s) w.v = Math.round(s.s); // colour variety, used by the "Vivid only" switch
  kept.push(w);
}
const curated = kept.filter((w) => !w.t && !w.m).length;
console.log(`unscored (thumbnail unavailable): ${kept.filter((w) => w.v == null).length}`);
console.log(`curated: ${curated};  second tier: ${tally.secondByEye} by eye + ${tally.secondByScore} dark or monochrome;  mature: ${tally.mature}`);

const liveSources = sources.filter((s) => kept.some((w) => w.source === s.id));
writeFileSync(out, JSON.stringify({ sources: liveSources, works: kept }));
console.log(`${kept.length} works from ${liveSources.length} source(s) written to app/art.json`);
