// Art Institute of Chicago source for the art-frame catalogue.
// Public-domain works with an image, landscape-shaped for a 16:9 TV,
// categorised from the museum's own subject / style / classification terms.
// API docs: https://api.artic.edu/docs/  (no key needed)
//
// Things worth knowing about this museum's servers:
//  - search stops at 1000 results per query, so several narrower queries are run;
//  - anonymous API use is limited to about 60 requests a minute;
//  - the image server only serves certain widths. `3000,` gives the image at
//    3000px wide, or at its native width if smaller (never upscaled); `1686,`
//    and `843,` are the other sizes that work. Occasionally `3000,` redirects
//    to the 843px version, so each chosen work is probed and those are dropped;
//  - images return 403 if the request carries a Referer from another site.

export const id = 'aic';
export const label = 'Art Institute of Chicago';

const API = 'https://api.artic.edu/api/v1/artworks/search';
const IIIF = 'https://www.artic.edu/iiif/2';
const HEADERS = {
  'AIC-User-Agent': 'artframe-tv (personal project)',
  'Content-Type': 'application/json'
};
const FIELDS = [
  'id', 'title', 'artist_title', 'date_display', 'image_id', 'thumbnail',
  'artwork_type_title', 'department_title', 'place_of_origin',
  'style_titles', 'subject_titles', 'classification_titles'
].join(',');

const TARGET = 600;          // works to return
const MIN_AR = 1.33;         // narrower or wider than this loses over a quarter
const MAX_AR = 2.37;         // of the picture when cropped to 16:9
const IDEAL_AR = 16 / 9;
const MIN_WIDTH = 1920;      // native pixel width needed to fill the screen
const MAX_PER_ARTIST = 12;
const API_GAP_MS = 1100;     // keeps under 60 requests a minute
const PROBE_CONCURRENCY = 4;

const TYPES = ['Painting', 'Print', 'Drawing and Watercolor', 'Photograph'];

// Museum terms (lower case) that put a work in each category.
const SUBJECTS = {
  landscapes: ['landscape', 'landscapes', 'traditional landscapes', 'mountain', 'mountains', 'river', 'rivers'],
  seascapes: ['seascapes', 'sea', 'seas', 'ocean', 'oceans', 'coastal scenes', 'coasts', 'beach', 'beaches',
    'harbor', 'harbors', 'ships', 'shipwrecks'],
  cities: ['cityscapes', 'city', 'city scenes', 'urban life', 'urban', 'street', 'streets', 'street scenes',
    'towns', 'townscapes', 'skyscrapers'],
  'still-life': ['still life', 'still lifes'],
  'botanical-animals': ['animals', 'flowers', 'birds', 'bird', 'horse', 'horses', 'dog', 'dogs', 'cat', 'cats',
    'insects', 'fish', 'cattle', 'sealife', 'plants', 'botanical', 'botanical/floral', 'sunflowers'],
  space: ['moon', 'stars', 'astronomy', 'planets', 'comets', 'constellations', 'eclipses', 'night sky']
};
const STYLES = {
  impressionism: ['impressionism', 'post-impressionism', 'pointillism', 'neo-impressionism'],
  'modern-abstract': ['modernism', 'modern movement', 'cubism', 'expressionism', 'fauvism', 'surrealism',
    'abstraction', 'abstract expressionism', 'futurism', 'constructivism', 'suprematism', 'de stijl',
    'bauhaus', 'dada', 'precisionism', 'orphism', 'synchromism', 'avant-garde']
};
const ABSTRACT_SUBJECTS = ['abstract', 'abstraction', 'abstract figures', 'abstract shapes', 'abstract forms',
  'abstract motifs', 'abstract patterns', 'abstract objects'];
const QUOTAS = {
  landscapes: 110, seascapes: 60, cities: 60, 'still-life': 40, portraits: 60, impressionism: 80,
  'japanese-prints': 90, 'modern-abstract': 40, 'botanical-animals': 70, photography: 80, space: 20
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`[aic] ${msg}\n`);
const lower = (list) => (Array.isArray(list) ? list : []).map((s) => String(s).toLowerCase());
const hasAny = (list, wanted) => wanted.some((w) => list.includes(w));

function categorise(a) {
  const subjects = lower(a.subject_titles);
  const styles = lower(a.style_titles);
  const classes = lower(a.classification_titles);
  const type = a.artwork_type_title || '';
  const cats = [];
  for (const [cat, terms] of Object.entries(SUBJECTS)) if (hasAny(subjects, terms)) cats.push(cat);
  if (classes.includes('still life') && !cats.includes('still-life')) cats.push('still-life');
  if (subjects.some((s) => s.startsWith('portrait') || s === 'self-portraits') || classes.includes('portrait')) {
    cats.push('portraits');
  }
  if (hasAny(styles, STYLES.impressionism)) cats.push('impressionism');
  const japanese = styles.includes('japanese (culture or style)') ||
    (a.department_title === 'Arts of Asia' && /japan/i.test(a.place_of_origin || ''));
  if (japanese && (type === 'Print' || classes.includes('woodblock print'))) cats.push('japanese-prints');
  if (hasAny(styles, STYLES['modern-abstract']) || hasAny(subjects, ABSTRACT_SUBJECTS) ||
      a.department_title === 'Modern Art') {
    cats.push('modern-abstract');
  }
  if (type === 'Photograph') cats.push('photography');
  return cats;
}

// Each query is a set of extra filters plus how many pages (of 100) to read.
function buildQueries() {
  const type = (t) => ({ term: { 'artwork_type_title.keyword': t } });
  const types = { terms: { 'artwork_type_title.keyword': TYPES } };
  const titleCase = (s) => s.replace(/(^|[\s-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  const styleVariants = (list) => [...new Set(list.flatMap((s) => [s, titleCase(s)]))];
  const queries = [
    { name: 'paintings', must: [type('Painting')], pages: 10 },
    { name: 'japanese prints', must: [type('Print'), { term: { 'style_titles.keyword': 'Japanese (culture or style)' } }], pages: 8 },
    { name: 'photographs', must: [type('Photograph')], pages: 8 },
    { name: 'drawings and watercolours', must: [type('Drawing and Watercolor')], pages: 5 },
    { name: 'prints', must: [type('Print')], pages: 4 }
  ];
  for (const [cat, terms] of Object.entries(SUBJECTS)) {
    queries.push({ name: `subject: ${cat}`, must: [types, { terms: { 'subject_titles.keyword': terms } }], pages: 6 });
  }
  queries.push({ name: 'subject: portraits', must: [types, { terms: { 'subject_titles.keyword': ['portrait', 'portraits', 'self-portraits'] } }], pages: 6 });
  for (const [cat, terms] of Object.entries(STYLES)) {
    queries.push({ name: `style: ${cat}`, must: [types, { terms: { 'style_titles.keyword': styleVariants(terms) } }], pages: 6 });
  }
  return queries;
}

async function withRetry(what, fn, tries = 4) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err.fatal) break;
      await sleep(1500 * 2 ** attempt);
    }
  }
  log(`skipped ${what}: ${lastError?.message || lastError}`);
  return null;
}

let lastApiCall = 0;
async function searchPage(query, page) {
  const wait = lastApiCall + API_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastApiCall = Date.now();
  const body = {
    limit: 100,
    page,
    fields: FIELDS,
    query: { bool: { must: [{ term: { is_public_domain: true } }, { exists: { field: 'image_id' } }, ...query.must] } }
  };
  const res = await fetch(API, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.fatal = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
    throw err;
  }
  return res.json();
}

async function collectCandidates() {
  const byId = new Map();
  for (const query of buildQueries()) {
    let kept = 0;
    for (let page = 1; page <= query.pages; page++) {
      const json = await withRetry(`${query.name} page ${page}`, () => searchPage(query, page));
      if (!json) break;
      const rows = json.data || [];
      for (const a of rows) {
        const t = a.thumbnail;
        if (!a.image_id || !t?.width || !t?.height) continue;
        if (!TYPES.includes(a.artwork_type_title)) continue;
        if (t.width < MIN_WIDTH) continue;
        const ratio = t.width / t.height;
        if (ratio < MIN_AR || ratio > MAX_AR) continue;
        const score = a._score || 0;
        const seen = byId.get(a.id);
        if (seen) {
          if (score > seen.score) seen.score = score;
          continue;
        }
        const cats = categorise(a);
        if (!cats.length) continue;
        byId.set(a.id, {
          imageId: a.image_id,
          title: String(a.title || 'Untitled').trim(),
          artist: String(a.artist_title || '').trim(),
          date: String(a.date_display || '').replace(/\s+/g, ' ').trim(),
          ar: Math.round(ratio * 100) / 100,
          ratio,
          cats,
          score
        });
        kept++;
      }
      const totalPages = json.pagination?.total_pages || 0;
      if (rows.length < 100 || page >= totalPages) break;
    }
    log(`${query.name}: ${kept} new candidates (${byId.size} total)`);
  }
  // one entry per image, and one per title + artist (the museum holds several
  // impressions of some prints); the most popular copy is kept
  const unique = new Map();
  const images = new Set();
  for (const c of [...byId.values()].sort((x, y) => y.score - x.score)) {
    const key = `${c.title.toLowerCase()}|${c.artist.toLowerCase()}`;
    if (unique.has(key) || images.has(c.imageId)) continue;
    unique.set(key, c);
    images.add(c.imageId);
  }
  return [...unique.values()];
}

// Most popular first, nudged towards shapes close to 16:9, a fair share for
// every category and no single artist taking over.
function choose(candidates, target, excluded = new Set()) {
  const ranked = candidates.filter((c) => !excluded.has(c)).sort((a, b) => b.score - a.score);
  const weight = ranked.length * 0.25;
  ranked.forEach((c, i) => { c.key = i + weight * Math.abs(c.ratio - IDEAL_AR); });
  const queues = {};
  for (const cat of Object.keys(QUOTAS)) {
    queues[cat] = ranked.filter((c) => c.cats.includes(cat)).sort((a, b) => a.key - b.key);
  }
  const chosen = new Set();
  const perCat = Object.fromEntries(Object.keys(QUOTAS).map((c) => [c, 0]));
  const perArtist = new Map();
  const take = (c) => {
    chosen.add(c);
    for (const cat of c.cats) perCat[cat]++;
    if (c.artist) perArtist.set(c.artist, (perArtist.get(c.artist) || 0) + 1);
  };
  const nextFor = (cat) => {
    const queue = queues[cat];
    while (queue.length) {
      const c = queue.shift();
      if (chosen.has(c)) continue;
      if (c.artist && (perArtist.get(c.artist) || 0) >= MAX_PER_ARTIST) continue;
      return c;
    }
    return null;
  };
  let progressed = true;
  while (progressed && chosen.size < target) {
    progressed = false;
    for (const cat of Object.keys(QUOTAS)) {
      if (chosen.size >= target) break;
      if (perCat[cat] >= QUOTAS[cat]) continue;
      const c = nextFor(cat);
      if (c) { take(c); progressed = true; }
    }
  }
  // quotas met early: top up with the best of whatever is left
  const rest = ranked.filter((c) => !chosen.has(c)).sort((a, b) => a.key - b.key);
  for (const c of rest) {
    if (chosen.size >= target) break;
    if (c.artist && (perArtist.get(c.artist) || 0) >= MAX_PER_ARTIST) continue;
    take(c);
  }
  return [...chosen];
}

const imageUrl = (imageId, width) => `${IIIF}/${imageId}/full/${width},/0/default.jpg`;

// true = large image is served, false = it is not, null = could not tell.
async function largeImageWorks(imageId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(imageUrl(imageId, 3000), {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(20000)
      });
      if (res.status === 200) return true;
      if ((res.status >= 300 && res.status < 400) || res.status === 404) return false;
      if (res.status === 403) return null; // the server's bot challenge, not a verdict on the image
    } catch { /* retry */ }
    await sleep(1000 * 2 ** attempt);
  }
  return null;
}

async function probe(works) {
  const good = [];
  const bad = new Set();
  let unknown = 0;
  let next = 0;
  async function worker() {
    while (next < works.length) {
      const c = works[next++];
      const ok = await largeImageWorks(c.imageId);
      if (ok === false) { bad.add(c); continue; }
      if (ok === null) unknown++;
      good.push(c);
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  return { good, bad, unknown };
}

export default async function fetchWorks() {
  const started = Date.now();
  const candidates = await collectCandidates();
  log(`${candidates.length} landscape-shaped candidates with a category`);

  let chosen = choose(candidates, TARGET);
  const rejected = new Set();
  for (let round = 0; round < 3; round++) {
    const unchecked = chosen.filter((c) => c.checked === undefined);
    if (!unchecked.length) break;
    const { bad, unknown } = await probe(unchecked);
    for (const c of unchecked) c.checked = !bad.has(c);
    for (const c of bad) rejected.add(c);
    log(`image check: ${unchecked.length} probed, ${bad.size} without a large image${unknown ? `, ${unknown} could not be checked (kept)` : ''}`);
    if (!bad.size) break;
    chosen = choose(candidates, TARGET, rejected);
  }
  chosen = chosen.filter((c) => !rejected.has(c));

  const works = chosen
    .sort((a, b) => b.score - a.score)
    .map((c) => ({
      src: [imageUrl(c.imageId, 3000), imageUrl(c.imageId, 1686), imageUrl(c.imageId, 843)],
      title: c.title,
      sub: [c.artist, c.date].filter(Boolean).join(', '),
      cats: c.cats,
      ar: c.ar,
      thumb: imageUrl(c.imageId, 600) // 200, 400 and 600 are the small widths the server allows
    }));
  log(`${works.length} works in ${Math.round((Date.now() - started) / 1000)}s`);
  return works;
}
