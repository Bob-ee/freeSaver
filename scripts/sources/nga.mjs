// National Gallery of Art, Washington — open data (CC0), no API key.
// Metadata: the CSV dumps at github.com/NationalGalleryOfArt/opendata.
// Images:   the gallery's IIIF server (api.nga.gov/iiif), hot-linked.
//
// Only "open access" (public domain) images are used. Categories come from
// the gallery's own terms (theme, keyword, style, school) and classification.
// There is no popularity field, so "well known" is approximated by: painting,
// currently on view, catalogued in a systematic catalogue, named artist.

export const id = 'nga';
export const label = 'National Gallery of Art';

const DATA = 'https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data';
const UA = 'art-frame-catalogue/1.0 (node fetch)';

const MIN_W = 1920;
const BEST_W = 3840;         // widest rendition the TV is asked to decode
const FALLBACK_W = 1920;
const THUMB_W = 600;        // small rendition for build-time scoring
// The TV crops to 16:9; outside this window more than a quarter is lost.
const MIN_RATIO = 1.33, MAX_RATIO = 2.37;
const IDEAL_RATIO = 16 / 9;
const TOTAL_CAP = 680;
const ARTIST_CAP = 8;
const ANON_CAP = 3;

// Per-category quota, filled scarcest pool first. A work chosen for one
// category keeps all of its categories, so final counts can exceed these.
const QUOTA = {
  'japanese-prints': 30,
  'modern-abstract': 40,
  'still-life': 70,
  seascapes: 90,
  cities: 90,
  portraits: 60,
  photography: 80,
  'botanical-animals': 110,
  impressionism: 130,
  landscapes: 190,
};

const log = (...a) => console.error('[nga]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- streaming CSV --------------------------------------------------------

// RFC 4180 parser that accepts text in arbitrary chunks (quoted fields may
// contain commas, quotes and newlines, and may straddle chunk boundaries).
function csvParser(onRow) {
  let row = [], field = '', quoted = false, quotePending = false, crPending = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); onRow(row); row = []; };
  return {
    write(chunk) {
      let i = 0;
      const n = chunk.length;
      while (i < n) {
        if (quoted) {
          if (quotePending) {
            quotePending = false;
            if (chunk.charCodeAt(i) === 34) { field += '"'; i++; continue; }
            quoted = false; // the pending quote closed the field
            continue;
          }
          const q = chunk.indexOf('"', i);
          if (q === -1) { field += chunk.slice(i); return; }
          field += chunk.slice(i, q);
          quotePending = true;
          i = q + 1;
          continue;
        }
        if (crPending) { crPending = false; if (chunk.charCodeAt(i) === 10) { i++; continue; } }
        let j = i;
        for (; j < n; j++) {
          const c = chunk.charCodeAt(j);
          if (c === 44 || c === 10 || c === 13 || c === 34) break;
        }
        if (j > i) field += chunk.slice(i, j);
        if (j === n) return;
        const c = chunk.charCodeAt(j);
        if (c === 44) endField();
        else if (c === 34) quoted = true;
        else { endRow(); if (c === 13) crPending = true; }
        i = j + 1;
      }
    },
    end() { if (field !== '' || row.length) endRow(); },
  };
}

// Streams one CSV file, calling onRecord(get) per data row, where get(name)
// returns the named column. Retries the whole file on a transient failure.
async function readCsv(name, onRecord, tries = 4) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(`${DATA}/${name}.csv`, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(240000),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`HTTP ${res.status} for ${name}.csv`), { fatal: res.status !== 429 && res.status < 500 });
      }
      let col = null, rows = 0, cur = null;
      const get = (k) => { const i = col[k]; return i === undefined ? '' : (cur[i] ?? ''); };
      const parser = csvParser((r) => {
        if (!col) { col = Object.fromEntries(r.map((h, i) => [h.replace(/^﻿/, '').trim(), i])); return; }
        cur = r; rows++; onRecord(get);
      });
      const decoder = new TextDecoder('utf-8');
      for await (const chunk of res.body) parser.write(decoder.decode(chunk, { stream: true }));
      parser.write(decoder.decode());
      parser.end();
      return rows;
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      log(`${name}.csv attempt ${attempt + 1} failed (${e.message}); retrying`);
      onRecord.reset?.();
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// ---- category rules (all from NGA's own terms) ----------------------------

const has = (set, re) => { for (const t of set) if (re.test(t)) return true; return false; };

const RE = {
  landscape: /landscape|riverscape|^(countryside|pastoral)$/i,
  sea: /^(seascapes?|marine|sea|ocean|coast|coastline|coastal scene|shore|seashore|seaside|harbor|harborscape|beach|beach scene|ships?|shipwreck|sailing ships?|surf|waves?)$/i,
  city: /^(cityscape.*|city|urban scene|street|street scene|streetscape|town|city park|new york city)$/i,
  still: /^(still life|still|flowers|fruit)$/i,
  portrait: /^portrait$/i,
  impress: /^(impressionist|post-impressionist|neo-impressionist)$/i,
  modern: /^(cubist|fauve|abstraction|abstract expressionist|futurist|german expressionist|austrian expressionist|surrealist|minimalist|non-representational|geometric|abstract)$/i,
  // Bare "animal"/"plant" themes are applied too loosely to be trusted alone.
  nature: /^(birds?|mammal|fish|insect|reptile|botanical|flowers?)$/i,
};

function categories(o, t) {
  const cats = [];
  if (o.cls === 'Photograph') return ['photography'];
  if (o.cls === 'Print' && (t.school.has('Japanese') || t.style.has('Ukiyo-e'))) cats.push('japanese-prints');
  if (has(t.theme, RE.landscape) || has(t.keyword, RE.landscape) || t.vtheme.has('landscape')) cats.push('landscapes');
  if (has(t.theme, RE.sea) || has(t.keyword, RE.sea)) cats.push('seascapes');
  if (has(t.theme, RE.city) || has(t.keyword, RE.city)) cats.push('cities');
  if (has(t.theme, RE.still) && t.vtheme.has('still') || t.theme.has('still life') || t.keyword.has('Still life')) cats.push('still-life');
  if (has(t.theme, RE.portrait) || (o.cls === 'Painting' && t.vtheme.has('portrait'))) cats.push('portraits');
  if (has(t.style, RE.impress)) cats.push('impressionism');
  if (has(t.style, RE.modern) || has(t.theme, RE.modern) || t.vtheme.has('non-representational')) cats.push('modern-abstract');
  if (t.vtheme.has('animal') || t.vtheme.has('botanical') || has(t.theme, RE.nature)) cats.push('botanical-animals');
  return cats;
}

// Which objects are worth showing at all, by medium.
function suitable(o, t) {
  const m = o.medium.toLowerCase();
  if (/\[(verso|reverse)\]/i.test(o.title)) return false;
  // Works on paper about war or death do not belong on the wall.
  if (o.cls !== 'Painting' && (t.vtheme.has('military') || has(t.theme, /^(death|.*\bwar\b.*)$/i) || has(t.keyword, /^(death|war|battle|execution)$/i))) return false;
  if (o.cls === 'Painting') return true;
  if (o.cls === 'Drawing') return /watercolor|gouache|pastel|\boil\b|tempera/.test(m) && !/album|sketchbook/.test(m);
  if (o.cls === 'Print') return /color|chromolithograph/.test(m);
  if (o.cls === 'Photograph') {
    // No motion studies, stereograph pairs, war dead or nudes on the wall.
    if (has(t.theme, /^(technology|nude|death|.*war.*|poverty|military)$/i)) return false;
    if (has(t.keyword, /^(motion|stereograph|death|war|soldiers?|female nude|male nude|nude|battlefield)$/i)) return false;
    if (t.vtheme.has('military') || t.vtheme.has('figure')) return false;
    return true;
  }
  return false;
}

const EMPTY = { theme: new Set(), vtheme: new Set(), keyword: new Set(), style: new Set(), school: new Set(), catalogued: false };
const DERIVATIVE = /^(after|follower of|imitator of|style of|circle of|workshop of|studio of|copy after|attributed to|possibly|manner of|school of)\s+/i;
const ANONYMOUS = /^(anonymous|unknown|american|british|french|german|italian|dutch|flemish|spanish|chinese|japanese|netherlandish|north italian|venetian|florentine|european|english|austrian|swiss|russian)\b.*\b(century|artist)\b|^anonymous/i;

function artistKey(attribution) {
  let a = attribution.trim();
  while (DERIVATIVE.test(a)) a = a.replace(DERIVATIVE, '');
  return a.split(/\s+(?:and|with|after|,)\s+/i)[0].toLowerCase();
}

function score(o, t) {
  let s = 0;
  if (o.cls === 'Painting') s += 6; else s += 2;
  if (o.cls === 'Photograph') {
    // Views beat group portraits and documentary shots.
    if (t.vtheme.has('landscape') || t.vtheme.has('architecture') || t.vtheme.has('still') || t.vtheme.has('botanical') || has(t.theme, /^(landscape|seascape|cityscape|Nature)$/)) s += 3;
    if (t.vtheme.has('portrait')) s -= 2;
  }
  if (o.onView) s += 4;
  if (t.catalogued) s += 1;
  if (t.style.size) s += 1;
  if (o.wikidata) s += 0.5;
  if (ANONYMOUS.test(o.attribution)) s -= 3;
  if (DERIVATIVE.test(o.attribution)) s -= 2;
  if (o.w >= 3000) s += 1;
  s += 2 * (1 - Math.min(1, Math.abs(o.w / o.h - IDEAL_RATIO) / 0.45)); // nearer 16:9 is better
  return s;
}

function iiif(base, w, target) {
  // Never upscale: ask for the native size when the scan is not wider.
  return w > target ? `${base}/full/${target},/0/default.jpg` : `${base}/full/full/0/default.jpg`;
}

// ---- main -----------------------------------------------------------------

export default async function fetchWorks() {
  const started = Date.now();

  // objectid -> best open-access primary image
  const images = new Map();
  // objectid -> terms
  const terms = new Map();
  // objectid -> object record
  const objects = new Map();

  const onImage = (get) => {
    if (get('openaccess') !== '1' || get('viewtype') !== 'primary') return;
    const w = Number(get('width')), h = Number(get('height'));
    const oid = get('depictstmsobjectid');
    const base = get('iiifurl');
    if (!oid || !w || !h || !/^https:\/\/api\.nga\.gov\/iiif\/[0-9a-f-]+$/i.test(base)) return;
    if (w < MIN_W || w / h < MIN_RATIO || w / h > MAX_RATIO) return;
    const mp = Number(get('maxpixels')) || 0;
    if (mp && mp < MIN_W) return; // size-restricted image
    const seq = Number(get('sequence')) || 0;
    const prev = images.get(oid);
    if (!prev || seq < prev.seq) images.set(oid, { base, w, h, seq });
  };
  onImage.reset = () => images.clear();

  const onTerm = (get) => {
    const type = get('termtype');
    if (type !== 'Theme' && type !== 'Keyword' && type !== 'Style' && type !== 'School' && type !== 'Systematic Catalogue Volume') return;
    const oid = get('objectid');
    let t = terms.get(oid);
    if (!t) terms.set(oid, t = { theme: new Set(), vtheme: new Set(), keyword: new Set(), style: new Set(), school: new Set(), catalogued: false });
    const term = get('term');
    if (type === 'Theme') { t.theme.add(term); const v = get('visualbrowsertheme'); if (v) t.vtheme.add(v); }
    else if (type === 'Keyword') t.keyword.add(term);
    else if (type === 'Style') t.style.add(term);
    else if (type === 'School') t.school.add(term);
    else if (!/^("homeless"|intentionally not)/.test(term)) t.catalogued = true;
  };
  onTerm.reset = () => terms.clear();

  const WANTED = new Set(['Painting', 'Drawing', 'Print', 'Photograph']);
  const onObject = (get) => {
    const cls = get('classification');
    if (!WANTED.has(cls) || get('isvirtual') === '1') return;
    const title = get('title').replace(/\s+/g, ' ').trim();
    if (!title) return;
    objects.set(get('objectid'), {
      id: get('objectid'), cls, title,
      attribution: get('attribution').replace(/\s+/g, ' ').trim(),
      date: get('displaydate').replace(/\s+/g, ' ').trim(),
      medium: get('medium'),
      onView: get('locationid') !== '',
      wikidata: get('wikidataid') !== '',
    });
  };
  onObject.reset = () => objects.clear();

  log('downloading open-data CSVs (about 195 MB)…');
  const [nImg, nTerm, nObj] = await Promise.all([
    readCsv('published_images', onImage),
    readCsv('objects_terms', onTerm),
    readCsv('objects', onObject),
  ]);
  log(`read ${nImg} images, ${nTerm} terms, ${nObj} objects in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // Build the candidate pool.
  const pool = [];
  for (const [oid, img] of images) {
    const o = objects.get(oid);
    if (!o) continue;
    const t = terms.get(oid) || EMPTY;
    if (!suitable(o, t)) continue;
    const cats = categories(o, t);
    if (!cats.length) continue;
    Object.assign(o, img);
    pool.push({ o, cats, score: score(o, t), artist: artistKey(o.attribution) });
  }
  pool.sort((a, b) => b.score - a.score || Number(a.o.id) - Number(b.o.id));
  log(`${pool.length} eligible works with at least one category`);

  // Fill each category's quota from the best-scoring works, scarcest pool
  // first, with a per-artist cap so nobody dominates.
  const poolSize = {};
  for (const p of pool) for (const c of p.cats) poolSize[c] = (poolSize[c] || 0) + 1;
  const order = Object.keys(QUOTA).filter((c) => poolSize[c]).sort((a, b) => poolSize[a] - poolSize[b]);

  const chosen = new Set();
  const perArtist = new Map();
  const perCat = {};
  const seenTitle = new Set();
  const take = (p) => {
    chosen.add(p);
    perArtist.set(p.artist, (perArtist.get(p.artist) || 0) + 1);
    for (const c of p.cats) perCat[c] = (perCat[c] || 0) + 1;
  };
  for (const cat of order) {
    for (const p of pool) {
      if ((perCat[cat] || 0) >= QUOTA[cat] || chosen.size >= TOTAL_CAP) break;
      if (chosen.has(p) || !p.cats.includes(cat)) continue;
      const cap = !p.artist || ANONYMOUS.test(p.o.attribution) ? ANON_CAP : ARTIST_CAP;
      if ((perArtist.get(p.artist) || 0) >= cap) continue;
      const key = `${p.artist}|${p.o.title.toLowerCase()}`;
      if (seenTitle.has(key)) continue; // same artist, same title: a duplicate impression
      seenTitle.add(key);
      take(p);
    }
  }

  const works = [...chosen]
    .sort((a, b) => b.score - a.score || Number(a.o.id) - Number(b.o.id))
    .map(({ o, cats }) => {
      const date = /^n\.?d\.?$/i.test(o.date) ? '' : o.date;
      const outW = Math.min(o.w, BEST_W);
      const outH = Math.round(o.h * outW / o.w);
      return {
        src: [iiif(o.base, o.w, BEST_W), `${o.base}/full/${FALLBACK_W},/0/default.jpg`],
        thumb: `${o.base}/full/${THUMB_W},/0/default.jpg`,
        title: o.title.replace(/\s*\[(obverse|recto)\]\s*$/i, ''),
        sub: [o.attribution, date].filter(Boolean).join(', '),
        cats,
        ar: Math.round((outW / outH) * 100) / 100,
      };
    });

  log(`${works.length} works in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return works;
}
