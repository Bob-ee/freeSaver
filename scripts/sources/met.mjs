// The Metropolitan Museum of Art Open Access (https://metmuseum.github.io/).
// No API key. Public-domain works with a primary image, landscape orientation.
//
// How it works
// 1. Streams the Met's Open Access dataset (MetObjects.csv, ~340 MB, refreshed
//    daily, the bulk source the API docs point to) and picks candidates from the
//    museum's own metadata: public domain, a flat artwork (painting, print,
//    drawing, photograph), a category from department / classification /
//    culture / artist / tags, and a landscape shape from the recorded
//    physical dimensions. Nothing is written to disk.
// 2. Ranks the candidates of each category (highlights, works on view and
//    well-known artists first, then shapes closest to 16:9) and asks the
//    object API for the best ones only, because the CSV has no image URLs.
// 3. Reads the first bytes of each full-size JPEG with a ranged request to get
//    its real pixel size and byte length, and keeps the ones a TV can show.
//
// Why not just search the API: it is far slower than documented. The docs say
// "80 requests per second", but the bot filter in front of the API (Imperva)
// measurably answers 403 after ~80 requests inside about a minute (80 ok then
// 403 at 2 requests/second, twice; 170 ok in a row at ~70 requests/minute).
// The API is therefore paced at ~70 requests/minute, so every record fetched
// has to count; search hits were mostly upright or not public domain (the
// search has no public-domain filter) and wasted four requests in five.
//
// Set MET_OPENACCESS_CSV to a local copy of MetObjects.csv to skip the download.

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export const id = 'met';
export const label = 'The Met';

const CSV_URL = 'https://media.githubusercontent.com/media/metmuseum/openaccess/master/MetObjects.csv';
const API = 'https://collectionapi.metmuseum.org/public/collection/v1';
const API_HOST = new URL(API).host;
const UA = 'art-frame-catalogue-builder/1.0 (node fetch)';

const CONCURRENCY = 3;
const API_GAP_MS = 860;           // ~70 request starts per minute
const IMAGE_GAP_MS = 150;
const BLOCK_PAUSES_MS = [30000, 60000, 120000]; // waits after a 403 from the API before giving up
const TIMEOUT_MS = 25000;
const RETRIES = 4;

// The TV is 16:9 and pictures are cropped to fill it; outside this window
// more than a quarter of the picture would be lost.
const MIN_RATIO = 1.33;
const MAX_RATIO = 2.37;
const IDEAL_RATIO = 16 / 9;
const MIN_WIDTH = 1920;
const MAX_WIDTH = 6000;
const MAX_BYTES = 8.5 * 1024 * 1024;
const MAX_PER_ARTIST = 16;
const MAX_UNNAMED = 40;           // "Unidentified artist", anonymous, no artist at all
const MAX_TOTAL = 700;

// How many works we want in each category. A work counts toward every
// category it belongs to, so the number of distinct works is lower than the sum.
// Rarest first: this is also the order the categories are filled in.
const TARGET = {
  space: 12,
  'modern-abstract': 35,
  'still-life': 40,
  portraits: 40,
  cities: 55,
  seascapes: 55,
  'botanical-animals': 55,
  'japanese-prints': 85,
  photography: 85,
  impressionism: 75,
  landscapes: 110
};
// Records requested per wanted work before giving up on a category (each one
// is a paced API request).
const TRIES_PER_WORK = 2.2;

// Artists whose paintings/pastels/drawings count as "impressionism"
// (Impressionists, their circle, Post-Impressionists, American Impressionists).
const IMPRESSIONISTS = [
  'Claude Monet', 'Auguste Renoir', 'Camille Pissarro', 'Alfred Sisley', 'Edgar Degas',
  'Berthe Morisot', 'Mary Cassatt', 'Edouard Manet', 'Gustave Caillebotte', 'Paul Cezanne',
  'Vincent van Gogh', 'Georges Seurat', 'Paul Signac', 'Paul Gauguin', 'Eugene Boudin',
  'Johan Barthold Jongkind', 'Armand Guillaumin', 'Henri-Edmond Cross', 'Frederic Bazille',
  'Childe Hassam', 'John Henry Twachtman', 'William Merritt Chase', 'Theodore Robinson',
  'Julian Alden Weir', 'John Singer Sargent', 'Maurice Brazil Prendergast', 'Willard Leroy Metcalf'
];

// Well-known names get a ranking boost so the mix leans towards familiar work.
const FAMOUS = [
  ...IMPRESSIONISTS,
  'Thomas Cole', 'Frederic Edwin Church', 'Albert Bierstadt', 'Joseph Mallord William Turner', 'John Constable',
  'Camille Corot', 'Jacob van Ruisdael', 'Jasper Francis Cropsey', 'John Frederick Kensett', 'Martin Johnson Heade',
  'George Inness', 'Asher Brown Durand', 'Sanford Robinson Gifford', 'Theodore Rousseau', 'Gustave Courbet',
  'Charles-Francois Daubigny', 'Winslow Homer', 'Canaletto (Giovanni Antonio Canal)', 'Francesco Guardi',
  'Claude Lorrain (Claude Gellee)', 'Rembrandt (Rembrandt van Rijn)', 'Johannes Vermeer', 'Pieter Bruegel the Elder',
  'El Greco (Domenikos Theotokopoulos)', 'Goya (Francisco de Goya y Lucientes)', 'Peter Paul Rubens',
  'Jean-Francois Millet', 'Eugene Delacroix', 'Thomas Eakins', 'James McNeill Whistler', 'Henri Rousseau (le Douanier)',
  'Aelbert Cuyp', 'Meyndert Hobbema', 'Salomon van Ruysdael', 'Jan van Goyen', 'Caspar David Friedrich',
  'Henri Fantin-Latour', 'Jean Simeon Chardin', 'Odilon Redon', 'Henri de Toulouse-Lautrec', 'Emanuel Leutze',
  'Fitz Henry Lane', 'Thomas Moran', 'William Michael Harnett', 'John Singleton Copley', 'George Caleb Bingham',
  'Katsushika Hokusai', 'Utagawa Hiroshige', 'Utagawa Kuniyoshi', 'Kitagawa Utamaro', 'Kobayashi Kiyochika',
  'Keisai Eisen', 'Totoya Hokkei', 'Torii Kiyonaga', 'Suzuki Harunobu', 'Tsukioka Yoshitoshi', 'Utagawa Kunisada',
  'Paul Klee', 'Marsden Hartley', 'Arthur Dove', 'Charles Demuth', 'Vasily Kandinsky', 'Juan Gris', 'Franz Marc',
  'Joseph Stella', 'Amedeo Modigliani', 'Egon Schiele', 'Robert Delaunay', 'Umberto Boccioni', 'Gustav Klimt',
  'Carleton E. Watkins', 'Gustave Le Gray', 'Eugene Atget', 'Roger Fenton', 'Edouard Baldus', "Timothy H. O'Sullivan",
  'Alfred Stieglitz', 'William Henry Fox Talbot', 'Eadweard Muybridge', 'Charles Marville', 'Francis Frith',
  'William Henry Jackson', 'Felice Beato', 'Edward J. Steichen', 'Julia Margaret Cameron', 'Nadar',
  'Samuel Bourne', 'Linnaeus Tripe', 'Peter Henry Emerson', 'Lewis M. Rutherfurd', 'John Adams Whipple'
];

const TAGS = {
  landscapes: ['landscapes', 'mountains', 'rivers', 'lakes', 'waterfalls', 'forests', 'valleys', 'hills'],
  seascapes: ['seascapes', 'oceans', 'coastlines', 'beaches', 'harbors', 'ships', 'waves', 'lighthouses'],
  cities: ['cities', 'cityscapes', 'streets', 'towns', 'city views', 'venice', 'london', 'rome',
    'new york city', 'new york', 'amsterdam', 'florence', 'edo', 'tokyo', 'kyoto', 'constantinople', 'cairo'],
  'still-life': ['still life', 'still lifes'],
  portraits: ['portraits', 'self-portraits'],
  'botanical-animals': ['flowers', 'birds', 'animals', 'horses', 'dogs', 'cats', 'insects', 'butterflies', 'fish',
    'plants', 'roses', 'irises', 'peonies', 'chrysanthemums', 'lilies', 'tulips', 'cows', 'sheep', 'deer', 'lions',
    'tigers', 'elephants', 'monkeys', 'rabbits', 'cranes', 'ducks', 'eagles', 'owls', 'peacocks', 'leaves',
    'cherry blossoms', 'plum blossoms', 'lotuses', 'poppies', 'sunflowers', 'bulls', 'goats', 'foxes', 'bears'],
  space: ['moon', 'astronomy', 'planets', 'comets', 'stars', 'constellations', 'eclipses', 'solar system']
};
const TAG_TO_CAT = new Map();
for (const [cat, terms] of Object.entries(TAGS)) for (const t of terms) TAG_TO_CAT.set(t, cat);
const SCENE_CATS = ['landscapes', 'seascapes', 'cities', 'portraits', 'still-life'];

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const IMPRESSIONIST_SET = new Set(IMPRESSIONISTS.map(norm));
const FAMOUS_SET = new Set(FAMOUS.map(norm));
const log = (...a) => process.stderr.write(`[met] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (t) => `${Math.round((Date.now() - t) / 1000)}s`;

// ---------- polite HTTP ----------

const slots = new Map();           // host -> time of the next free request slot
const block = { until: 0, strikes: 0, gaveUp: false };

async function throttle(host) {
  for (;;) {
    const now = Date.now();
    const at = Math.max(now, slots.get(host) || 0, host === API_HOST ? block.until : 0);
    slots.set(host, at + (host === API_HOST ? API_GAP_MS : IMAGE_GAP_MS));
    if (at <= now) return;
    await sleep(at - now);
    if (host !== API_HOST || Date.now() >= block.until) return;
  }
}

// The API answers 403 (an HTML challenge page) when its bot filter has blocked
// us. Retrying straight away only makes that worse: pause every worker, try
// again a few times with longer pauses, then give up on the rest of the run.
function apiBlocked() {
  if (Date.now() < block.until || block.gaveUp) return;
  if (block.strikes >= BLOCK_PAUSES_MS.length) {
    block.gaveUp = true;
    log('the API keeps answering 403 (blocked by its bot filter); stopping early');
    return;
  }
  const pause = BLOCK_PAUSES_MS[block.strikes++];
  block.until = Date.now() + pause;
  log(`API answered 403 (blocked); pausing ${pause / 1000}s`);
}

// Returns the Response, or null for a definitive miss (other 4xx).
// Throws after the retries are used up.
async function request(url, headers = {}) {
  const host = new URL(url).host;
  const isApi = host === API_HOST;
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (isApi && block.gaveUp) throw new Error('blocked');
    if (attempt) await sleep(500 * 2 ** (attempt - 1) + Math.random() * 300);
    await throttle(host);
    if (isApi && block.gaveUp) throw new Error('blocked');
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) {
        if (isApi) block.strikes = 0;
        return res;
      }
      await res.body?.cancel().catch(() => {});
      if (isApi && res.status === 403) apiBlocked();
      else if (res.status !== 429 && res.status < 500) return null;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function getJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(800 * attempt);
    const res = await request(url, { Accept: 'application/json' });
    if (!res) return null;
    try {
      return await res.json();
    } catch (e) {
      lastErr = e; // truncated body or an HTML challenge page: try again
    }
  }
  throw lastErr;
}

// Runs worker over items a few at a time until stop() says enough.
async function pool(items, worker, stop) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length && !stop()) {
      const item = items[i++];
      try {
        await worker(item);
      } catch {
        // skip individual failures
      }
    }
  }));
}

// ---------- the Open Access CSV ----------

async function openCsv() {
  const local = process.env.MET_OPENACCESS_CSV;
  if (local) return Readable.toWeb(createReadStream(local));
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    try {
      const res = await fetch(CSV_URL, { headers: { 'User-Agent': UA } });
      if (res.ok) return res.body;
      await res.body?.cancel().catch(() => {});
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`could not download the Met Open Access CSV: ${lastErr.message}`);
}

// Streaming CSV parser (quoted fields, doubled quotes, newlines inside quotes).
// Calls onRow with an array of strings for every record.
async function parseCsv(stream, onRow) {
  const decoder = new TextDecoder('utf-8');
  let row = [];
  let field = '';
  let inQuotes = false;
  let rest = '';
  const feed = (text, last) => {
    const s = rest + text;
    rest = '';
    let seg = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (inQuotes) {
        if (c !== 34) continue;
        if (i + 1 === s.length && !last) { // cannot tell yet whether this quote is doubled
          field += s.slice(seg, i);
          rest = '"';
          return;
        }
        field += s.slice(seg, i);
        if (s.charCodeAt(i + 1) === 34) { field += '"'; i++; } else inQuotes = false;
        seg = i + 1;
      } else if (c === 34) {
        field += s.slice(seg, i);
        inQuotes = true;
        seg = i + 1;
      } else if (c === 44) {
        row.push(field + s.slice(seg, i));
        field = '';
        seg = i + 1;
      } else if (c === 10) {
        let f = field + s.slice(seg, i);
        if (f.endsWith('\r')) f = f.slice(0, -1);
        row.push(f);
        onRow(row);
        row = [];
        field = '';
        seg = i + 1;
      }
    }
    field += s.slice(seg);
  };
  for await (const chunk of stream) feed(decoder.decode(chunk, { stream: true }), false);
  feed(decoder.decode(), true);
  if (field || row.length) { row.push(field); onRow(row); }
}

// ---------- metadata -> categories ----------

const ART_CLASS = /paintings|prints|photographs|drawings|pastels|watercolors/i;
const NOT_ART_CLASS = /books|albums|ephemera|ornament|negatives|ceramics|textiles|sculpture|furniture|costume|manuscripts|codices|periodicals|cards|lacquer|metalwork|jewelry|glass|screens|scrolls?\b|fans/i;
const NOT_ART_NAME = /\bfan\b|album|book|baseball|card|screen|handscroll|scroll|negative|stereograph|daguerreotype case|cover|playbill|map\b/i;

function categorise(o) {
  const { department: dept, classification: cls } = o;
  const culture = norm(o.culture);
  const artist = norm(o.artist);
  const tags = o.tags.map(norm);
  const cats = new Set();

  const isPhoto = dept === 'Photographs';
  if (isPhoto) cats.add('photography');

  if (dept === 'Asian Art' && /prints/i.test(cls) && culture.includes('japan')) cats.add('japanese-prints');

  if (IMPRESSIONIST_SET.has(artist) && /paintings|pastels|drawings/i.test(cls)) cats.add('impressionism');

  if (!isPhoto && o.year >= 1900 && /paintings|drawings|prints|watercolors/i.test(cls) &&
    (/^Modern/i.test(dept) || tags.includes('abstraction'))) {
    cats.add('modern-abstract');
  }

  const tagCats = tags.map((t) => TAG_TO_CAT.get(t)).filter(Boolean);
  for (const c of tagCats) if (SCENE_CATS.includes(c)) cats.add(c);
  // Subject tags like "Horses" or "Moon" also turn up on battle scenes and
  // landscapes; only count them when they make up at least half of the tags,
  // i.e. they are the subject rather than an incidental detail.
  for (const c of ['botanical-animals', 'space']) {
    const n = tagCats.filter((x) => x === c).length;
    if (n && n * 2 >= tags.length) cats.add(c);
  }
  return [...cats];
}

// The Met writes sizes as height × width, e.g. "28 13/16 × 36 3/4 in. (73.2 × 93.4 cm)"
// or "Image: 20.5 × 27.5 cm (...)". Returns width / height, or null.
function physicalRatio(dimensions) {
  if (!dimensions) return null;
  const part = /\bimage\b/i.test(dimensions) ? dimensions.slice(dimensions.search(/\bimage\b/i)) : dimensions;
  const m = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(\s*[x×]\s*\d)?\s*cm/i.exec(part);
  if (!m || m[3]) return null; // three numbers: an object with depth, not a flat picture
  const h = Number(m[1]);
  const w = Number(m[2]);
  return h > 0 && w > 0 ? w / h : null;
}

const clean = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function shorten(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 30)).replace(/[\s,;:.\-–(]+$/, '')}…`;
}

// Reads the CSV and returns every candidate with its categories and ranking score.
async function loadCandidates() {
  const started = Date.now();
  const candidates = [];
  let col = null;
  let rows = 0;
  await parseCsv(await openCsv(), (r) => {
    if (!col) {
      col = Object.fromEntries(r.map((name, i) => [name.replace(/^﻿/, ''), i]));
      for (const need of ['Object ID', 'Is Public Domain', 'Department', 'Classification', 'Dimensions', 'Tags']) {
        if (!(need in col)) throw new Error(`Met Open Access CSV has no "${need}" column`);
      }
      return;
    }
    rows++;
    if (r[col['Is Public Domain']] !== 'True') return;
    const department = r[col.Department];
    const classification = r[col.Classification] || '';
    const objectName = r[col['Object Name']] || '';
    if (department === 'Photographs') {
      if (classification !== 'Photographs') return;
    } else if (!ART_CLASS.test(classification) || NOT_ART_CLASS.test(classification)) return;
    if (NOT_ART_NAME.test(objectName)) return;
    const phys = physicalRatio(r[col.Dimensions]);
    if (!phys || phys < MIN_RATIO - 0.05 || phys > MAX_RATIO + 0.08) return;

    const artist = clean((r[col['Artist Display Name']] || '').split('|')[0]);
    const o = {
      objectID: Number(r[col['Object ID']]),
      department,
      classification,
      culture: r[col.Culture],
      artist,
      year: Number(r[col['Object Begin Date']]) || 0,
      tags: (r[col.Tags] || '').split('|').filter(Boolean)
    };
    if (!o.objectID) return;
    const cats = categorise(o);
    if (!cats.length) return;

    const highlight = r[col['Is Highlight']] === 'True';
    const artistKey = norm(artist);
    const score = (highlight ? 100 : 0) +
      (r[col['Is Timeline Work']] === 'True' ? 30 : 0) +
      (r[col['Gallery Number']] ? 25 : 0) +                 // on view
      (FAMOUS_SET.has(artistKey) ? 35 : 0) +
      (/paintings/i.test(classification) ? 30 : 0) -
      40 * Math.abs(phys - IDEAL_RATIO);
    candidates.push({
      objectID: o.objectID, cats, score, highlight, artistKey,
      titleKey: `${norm(r[col.Title]) || o.objectID}|${artistKey}`
    });
  });
  log(`read ${rows} records from the Open Access CSV in ${secs(started)}; ${candidates.length} landscape-shaped public-domain candidates`);
  return candidates;
}

// ---------- image probe ----------

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { bad: true };
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const m = buf[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
    }
    if (m === 0xda || m === 0xd9) return { bad: true };
    p += 2 + buf.readUInt16BE(p + 2);
  }
  return { more: true };
}

// Reads just enough of the image to learn its pixel size; the byte length
// comes from the Content-Range header.
async function probeImage(url) {
  for (const want of [65536, 1048576]) {
    const res = await request(url, { Range: `bytes=0-${want - 1}` });
    if (!res) return null;
    if (!/^image\/jpeg/i.test(res.headers.get('content-type') || '')) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const range = res.headers.get('content-range');
    const bytes = range ? Number(range.split('/')[1]) : Number(res.headers.get('content-length'));
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    while (got < want) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    await reader.cancel().catch(() => {});
    const size = jpegSize(Buffer.concat(chunks));
    if (size.width) return { ...size, bytes };
    if (size.bad) return null;
  }
  return null;
}

// Fetches one candidate's record and vets its image. Returns a work or null.
async function evaluate(cand, stats) {
  const o = await getJson(`${API}/objects/${cand.objectID}`);
  if (!o || !o.isPublicDomain || !o.primaryImage || !/\.jpe?g$/i.test(o.primaryImage)) { stats.noImage++; return null; }

  const src = encodeURI(decodeURI(o.primaryImage));
  const img = await probeImage(src);
  if (!img) { stats.imgFail++; return null; }
  const ratio = img.width / img.height;
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) { stats.shape++; return null; }
  if (img.width < MIN_WIDTH) { stats.tooSmall++; return null; }
  if (img.width > MAX_WIDTH || img.bytes > MAX_BYTES) { stats.tooBig++; return null; }

  // The Met serves only two useful sizes: the original and "web-large" (~600px on the long side).
  const small = encodeURI(decodeURI(o.primaryImageSmall || o.primaryImage.replace('/original/', '/web-large/')));
  const artist = clean(o.artistDisplayName);
  return {
    src: small !== src ? [src, small] : [src],
    title: shorten(clean(o.title) || clean(o.objectName) || 'Untitled', 140),
    sub: [artist, clean(o.objectDate)].filter(Boolean).join(', '),
    cats: cand.cats,
    thumb: small,
    ar: Math.round(ratio * 100) / 100
  };
}

// ---------- main ----------

export default async function fetchWorks() {
  const started = Date.now();
  Object.assign(block, { until: 0, strikes: 0, gaveUp: false });

  const candidates = await loadCandidates();
  // Best first; object id breaks ties so runs are repeatable.
  candidates.sort((a, b) => b.score - a.score || a.objectID - b.objectID);

  const tried = new Set();       // object ids already requested
  const seenSrc = new Set();     // image urls already taken
  const seenTitle = new Set();   // title + artist already taken (duplicate records, other impressions)
  const perArtist = new Map();
  const count = Object.fromEntries(Object.keys(TARGET).map((c) => [c, 0]));
  const stats = { requested: 0, noImage: 0, imgFail: 0, shape: 0, tooSmall: 0, tooBig: 0, failed: 0, dupe: 0 };
  const accepted = [];

  const artistCap = (key) => (!key || /^(unidentified|unknown|anonymous)/.test(key) ? MAX_UNNAMED : MAX_PER_ARTIST);
  const artistFull = (key) => (perArtist.get(key) || 0) >= artistCap(key);
  const full = () => accepted.length >= MAX_TOTAL;

  for (const cat of Object.keys(TARGET)) {
    const available = candidates.filter((c) => c.cats.includes(cat)).length;
    let left = Math.ceil((TARGET[cat] - count[cat]) * TRIES_PER_WORK);
    const stop = () => block.gaveUp || full() || left <= 0 || count[cat] >= TARGET[cat];
    const queue = candidates.filter((c) => c.cats.includes(cat) && !tried.has(c.objectID));
    await pool(queue, async (cand) => {
      // Re-checked here because other workers may have filled a cap meanwhile.
      if (tried.has(cand.objectID) || seenTitle.has(cand.titleKey) || artistFull(cand.artistKey)) return;
      tried.add(cand.objectID);
      seenTitle.add(cand.titleKey);
      perArtist.set(cand.artistKey, (perArtist.get(cand.artistKey) || 0) + 1); // reserve a place
      left--;
      stats.requested++;
      let work = null;
      try {
        work = await evaluate(cand, stats);
      } catch {
        stats.failed++;
      }
      if (work && seenSrc.has(work.src[0])) { stats.dupe++; work = null; }
      if (!work || full()) {
        perArtist.set(cand.artistKey, perArtist.get(cand.artistKey) - 1);
        return;
      }
      seenSrc.add(work.src[0]);
      for (const c of work.cats) count[c]++;
      accepted.push({ work, highlight: cand.highlight, score: cand.score });
    }, stop);
    log(`${cat}: ${count[cat]}/${TARGET[cat]} (${available} candidates); total ${accepted.length}, ${stats.requested} records requested, ${secs(started)}`);
    if (full() || block.gaveUp) break;
  }
  if (block.gaveUp && !accepted.length) throw new Error('The Met API blocked this client (HTTP 403); no works fetched');

  accepted.sort((a, b) => Number(b.highlight) - Number(a.highlight)); // stable: category order otherwise
  log(`done: ${accepted.length} works in ${secs(started)}; per category ${JSON.stringify(count)}`);
  log(`skipped: ${JSON.stringify(stats)}`);
  return accepted.map((a) => a.work);
}
