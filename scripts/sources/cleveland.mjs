// Cleveland Museum of Art source for the art-frame catalogue.
// CC0 works with an image, landscape-shaped for a 16:9 TV.
// API docs: https://openaccess-api.clevelandart.org/  (no key needed)
//
// Things worth knowing about this museum's data:
//  - every work has a "print" JPEG (longest side about 3400px, typically 2-6 MB)
//    and a small "web" JPEG (893px high); the "full" file is a huge TIFF and unusable;
//  - the API publishes real pixel sizes and file sizes, so nothing needs probing;
//  - there are no subject tags. Type, department, collection and culture are used
//    where they settle a category; otherwise the museum's own title and
//    description text is matched against a fixed word list;
//  - results come back in the museum's default order, which leads with its
//    best-known works, and that order is kept as the popularity ranking.

export const id = 'cleveland';
export const label = 'Cleveland Museum of Art';

const API = 'https://openaccess-api.clevelandart.org/api/artworks/';
const FIELDS = [
  'id', 'accession_number', 'title', 'creation_date', 'creation_date_earliest', 'creators', 'culture',
  'technique', 'department', 'collection', 'type', 'images', 'is_highlight', 'share_license_status',
  'description', 'did_you_know'
].join(',');

const TARGET = 600;          // works to return
const MIN_AR = 1.33;         // narrower or wider than this loses over a quarter
const MAX_AR = 2.37;         // of the picture when cropped to 16:9
const IDEAL_AR = 16 / 9;
const MIN_WIDTH = 1920;
const MAX_WIDTH = 6000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PER_ARTIST = 12;
const PAGE = 1000;
const CONCURRENCY = 3;

// What to read: [name, extra query parameters, number of pages of 1000].
const QUERIES = [
  ['paintings', { type: 'Painting' }, 4],
  ['photographs', { type: 'Photograph' }, 2],
  ['japanese prints', { type: 'Print', department: 'Japanese Art' }, 2],
  ['prints', { type: 'Print' }, 3],
  ['drawings', { type: 'Drawing' }, 2]
];

const QUOTAS = {
  landscapes: 110, seascapes: 60, cities: 60, 'still-life': 40, portraits: 60, impressionism: 70,
  'japanese-prints': 90, 'modern-abstract': 40, 'botanical-animals': 80, photography: 90, space: 20
};

// Word lists, matched against the museum's title for the work. Descriptions are
// not used for these: they mention genres in passing too often to be trusted.
const WORDS = {
  landscapes: /\b(landscapes?|mountains?|rivers?|valley|forest|woods|lake|waterfall|falls|meadows?|fields?|hills?|countryside|sunset|sunrise|twilight|pastoral)\b/,
  seascapes: /\b(seascapes?|marine|sea|ocean|coast|seashore|shore|beach|harbou?r|bay|ships?|shipwreck|surf|waves?|sailing|yachts?)\b/,
  cities: /\b(cityscapes?|city|street|streets|boulevard|avenue|town|venice|paris|london|rome|florence|amsterdam|manhattan|brooklyn|cathedral|piazza|quays?)\b/,
  'still-life': /\b(still[- ]lifes?|nature morte)\b/,
  'botanical-animals': /\b(flowers?|blossoms?|peon(y|ies)|roses?|chrysanthemums?|lotus|iris(es)?|orchids?|lil(y|ies)|bamboo|pines?|birds?|cranes?|geese|ducks?|eagles?|hawks?|sparrows?|horses?|dogs?|pupp(y|ies)|cats?|tigers?|lions?|deer|cattle|cows?|oxen|sheep|fish|carp|trout|butterfl(y|ies)|insects?|monkeys?|rabbits?|hares?|elephants?)\b/,
  space: /\b(full moon|new moon|harvest moon|comets?|eclipse|planets?|constellations?|astronom\w*|milky way|starry)\b/
};
// Phrases that contain one of the words above but mean something else.
const NOT_WHAT_IT_SEEMS = /\b(bird'?s[- ]eye|red sea|sea ?horses?|sea gods?|tiger hill|judge?ment of paris|paris and oenone|town hall|rue de la cité|stag at)\b/g;
const PORTRAIT = /\b(self-)?portraits?\b/;
const IMPRESSIONISM = /\b(post-|neo-)?impressionis(m|t|ts)\b/;
const MODERN = /\b(abstract(ion|ed)?|cubis[mt]s?|fauv(e|es|ism|ist)|expressionis[mt]s?|modernis[mt]s?|futuris[mt]s?|surrealis[mt]s?|precisionis[mt]s?|synchromis[mt]s?)\b/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`[cleveland] ${msg}\n`);
const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function categorise(a) {
  const fullTitle = clean(a.title).toLowerCase();
  const title = fullTitle.replace(NOT_WHAT_IT_SEEMS, ' ');
  // style words rarely appear in titles, so for those the museum's description is read too
  const text = `${fullTitle} ${clean(a.description).toLowerCase()} ${clean(a.did_you_know).toLowerCase()}`;
  const culture = (a.culture || []).join(' ');
  const year = a.creation_date_earliest;
  const cats = [];
  for (const [cat, words] of Object.entries(WORDS)) if (words.test(title)) cats.push(cat);
  if (PORTRAIT.test(title) || /portrait/i.test(a.collection || '')) cats.push('portraits');
  if (a.type !== 'Photograph' && year >= 1860 && year <= 1930 && IMPRESSIONISM.test(text)) cats.push('impressionism');
  if (a.type === 'Print' && (a.department === 'Japanese Art' || /\bjapan\b/i.test(culture))) cats.push('japanese-prints');
  if (a.type !== 'Photograph' && year >= 1900 && MODERN.test(text)) cats.push('modern-abstract');
  if (a.type === 'Photograph') cats.push('photography');
  return cats;
}

function artistOf(a) {
  const makers = (a.creators || []).filter((c) => c && c.description);
  const main = makers.find((c) => /artist|painter|photographer|printmaker|draftsman/i.test(c.role || '')) || makers[0];
  if (main) return clean(main.description).replace(/\s*\([^()]*\)\s*$/, '').trim();
  return clean((a.culture || [])[0]); // unsigned works: the museum's culture line, e.g. "Japan, Edo period"
}

async function fetchPage(params, skip) {
  const qs = new URLSearchParams({ cc0: '1', has_image: '1', ...params, limit: String(PAGE), skip: String(skip), fields: FIELDS });
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${API}?${qs}`, { signal: AbortSignal.timeout(90000) });
      if (res.ok) return await res.json();
      lastError = new Error(`HTTP ${res.status}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) break;
    } catch (err) {
      lastError = err;
    }
    await sleep(2000 * 2 ** attempt);
  }
  throw lastError;
}

async function collectCandidates() {
  const jobs = [];
  for (const [name, params, pages] of QUERIES) {
    for (let p = 0; p < pages; p++) jobs.push({ name, params, skip: p * PAGE, rows: [] });
  }
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        job.rows = (await fetchPage(job.params, job.skip)).data || [];
        log(`${job.name} ${job.skip + 1}-${job.skip + job.rows.length}`);
      } catch (err) {
        log(`skipped ${job.name} from ${job.skip}: ${err?.message || err}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const byId = new Map();
  for (const job of jobs) {
    job.rows.forEach((a, i) => {
      const rank = job.skip + i; // position in the museum's own ordering for this kind of work
      const seen = byId.get(a.id);
      if (seen) { if (rank < seen.rank) seen.rank = rank; return; }
      if (a.share_license_status !== 'CC0') return;
      const print = a.images?.print;
      const width = Number(print?.width);
      const height = Number(print?.height);
      const bytes = Number(print?.filesize);
      if (!print?.url || !width || !height) return;
      if (width < MIN_WIDTH || width > MAX_WIDTH) return;
      if (!bytes || bytes > MAX_BYTES) return; // unknown size is not worth the risk on a TV
      const ratio = width / height;
      if (ratio < MIN_AR || ratio > MAX_AR) return;
      if (/\bverso\b/i.test(a.title || '')) return; // backs of sheets
      const cats = categorise(a);
      if (!cats.length) return;
      const src = [print.url];
      if (a.images?.web?.url) src.push(a.images.web.url);
      byId.set(a.id, {
        src,
        title: clean(a.title) || 'Untitled',
        artist: artistOf(a),
        date: clean(a.creation_date),
        ar: Math.round(ratio * 100) / 100,
        ratio,
        cats,
        rank,
        highlight: a.is_highlight === true
      });
    });
  }
  // one entry per image, and one per title + artist (the museum holds several
  // sheets or impressions of some works); the best-ranked copy is kept
  const unique = new Map();
  const images = new Set();
  for (const c of [...byId.values()].sort((x, y) => x.rank - y.rank)) {
    const key = `${c.title.toLowerCase()}|${c.artist.toLowerCase()}`;
    if (unique.has(key) || images.has(c.src[0])) continue;
    unique.set(key, c);
    images.add(c.src[0]);
  }
  return [...unique.values()];
}

// Best-known first, nudged towards shapes close to 16:9, a fair share for
// every category and no single artist taking over.
function choose(candidates, target) {
  const ranked = [...candidates].sort((a, b) => (b.highlight - a.highlight) || (a.rank - b.rank));
  const weight = ranked.length * 0.25;
  ranked.forEach((c, i) => { c.order = i; c.key = i + weight * Math.abs(c.ratio - IDEAL_AR); });
  const queues = {};
  for (const cat of Object.keys(QUOTAS)) {
    queues[cat] = ranked.filter((c) => c.cats.includes(cat)).sort((a, b) => a.key - b.key);
  }
  const chosen = new Set();
  const perCat = Object.fromEntries(Object.keys(QUOTAS).map((c) => [c, 0]));
  const perArtist = new Map();
  const full = (c) => c.artist && (perArtist.get(c.artist) || 0) >= MAX_PER_ARTIST;
  const take = (c) => {
    chosen.add(c);
    for (const cat of c.cats) perCat[cat]++;
    if (c.artist) perArtist.set(c.artist, (perArtist.get(c.artist) || 0) + 1);
  };
  let progressed = true;
  while (progressed && chosen.size < target) {
    progressed = false;
    for (const cat of Object.keys(QUOTAS)) {
      if (chosen.size >= target) break;
      if (perCat[cat] >= QUOTAS[cat]) continue;
      const queue = queues[cat];
      while (queue.length) {
        const c = queue.shift();
        if (chosen.has(c) || full(c)) continue;
        take(c);
        progressed = true;
        break;
      }
    }
  }
  // quotas met early: top up with the best of whatever is left
  for (const c of ranked.filter((x) => !chosen.has(x)).sort((a, b) => a.key - b.key)) {
    if (chosen.size >= target) break;
    if (!full(c)) take(c);
  }
  return [...chosen].sort((a, b) => a.order - b.order);
}

export default async function fetchWorks() {
  const started = Date.now();
  const candidates = await collectCandidates();
  log(`${candidates.length} landscape-shaped candidates with a category`);
  const works = choose(candidates, TARGET).map((c) => ({
    src: c.src,
    title: c.title,
    sub: [c.artist, c.date].filter(Boolean).join(', '),
    cats: c.cats,
    ar: c.ar,
    thumb: c.src[1] || c.src[0] // the "web" JPEG (893px high) is the smallest the museum offers
  }));
  log(`${works.length} works in ${Math.round((Date.now() - started) / 1000)}s`);
  return works;
}
