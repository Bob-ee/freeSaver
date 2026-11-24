// Wikimedia Commons source for the art-frame catalogue: the "modern and vibrant" one.
// Two halves:
//   A. public-domain modern art (Kandinsky, Klee, af Klint, Marc, Macke, Van Gogh,
//      shin-hanga prints ...) found through each artist's Commons category tree;
//   B. contemporary photography from Commons "Featured pictures" and the Picture of
//      the Year finalists. These are mostly CC BY / CC BY-SA, so every photo carries
//      its photographer and licence in `sub`.
// API: https://commons.wikimedia.org/w/api.php (no key).
//
// Things worth knowing about Commons:
//  - anonymous scripts get about 10 API requests a minute (HTTP 429 with Retry-After
//    beyond that). A request may carry 500 files as long as it does not ask for URLs
//    (asking for url/thumburl drops it to 50), so URLs are built here from the file
//    name instead: /thumb/<md5[0]>/<md5[0..1]>/<name>/<width>px-<name>;
//  - thumbnails are only rendered at fixed widths. 120, 250, 330, 500, 960, 1280,
//    1920 and 3840 are served; anything else is HTTP 400;
//  - nothing in the metadata says whether a picture is any good on a wall, so every
//    candidate's 120px thumbnail is decoded with ffmpeg and measured: colourfulness
//    (Hasler-Susstrunk), brightness, flat borders, and a small hash for spotting
//    the same picture uploaded twice. Without ffmpeg (or curl) that step is skipped.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const id = 'commons';
export const label = 'Wikimedia Commons';

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'freeSaver/1.0 (open-source TV picture frame)';
const THUMB_HOST = 'https://upload.wikimedia.org/wikipedia/commons/thumb';
const FILE_HOST = 'https://upload.wikimedia.org/wikipedia/commons';
const FFMPEG_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];

const MIN_AR = 1.33;
const MAX_AR = 2.37;
const IDEAL_AR = 16 / 9;
const BIG = 3840;               // widest standard thumbnail
const ART_MIN_WIDTH = 2560;     // art narrower than this is not worth showing on a 4K panel
const ORIGINAL_MAX_BYTES = 6 * 1024 * 1024; // originals under 3840px wide are used directly up to this size
const MAX_PIXELS = 400e6;       // the thumbnailer struggles with gigapixel originals

const ART_TARGET = 280;
const PHOTO_QUOTAS = { landscapes: 170, seascapes: 85, cities: 125, 'botanical-animals': 135, space: 30, 'modern-abstract': 35 };
const MAX_PER_ARTIST = 20;
const MAX_PER_PHOTOGRAPHER = 25;
const MAX_JAPANESE = 75;
const PHOTO_PAGES = 15;         // x500 newest featured pictures at least 3840px wide
const POTY_YEARS = [2012, 2013, 2014, 2015, 2016, 2017, 2018];
const SCORE_CONCURRENCY = 3;
const SCORE_BUDGET_MS = 8 * 60 * 1000;
// COMMONS_QUICK=1 reads a small slice (one page of photographs, five artists) for a smoke test.
const QUICK = !!process.env.COMMONS_QUICK;
const ART_SCORED_PER_ARTIST = 45;
const PHOTO_SCORED_PER_PERSON = 40;

// Vibrancy thresholds (colourfulness is Hasler-Susstrunk M on a 64x64 decode; brightness is mean luma 0-255).
const ART_MIN_COLOUR = 38;
const ART_MIN_BRIGHT = 80;
const PHOTO_MIN_COLOUR = 42;
const PHOTO_MIN_BRIGHT = 62;
const NIGHT_MIN_COLOUR = 55;    // dusk, aurora and night-sky photos may be darker if they are this colourful
const NIGHT_MIN_BRIGHT = 40;
const MAX_DARK_FRACTION = 0.6;  // share of pixels with luma under 32

// [artist, deepcategory roots, base categories, options]
const M = ['modern-abstract'];
const IM = ['impressionism', 'modern-abstract'];
const JP = ['japanese-prints'];
const ARTISTS = [
  ['Wassily Kandinsky', ['Paintings by Wassily Kandinsky'], M],
  ['Paul Klee', ['Paintings by Paul Klee'], M],
  ['Hilma af Klint', ['Paintings by Hilma af Klint'], M],
  ['Robert Delaunay', ['Paintings by Robert Delaunay'], M],
  ['Franz Marc', ['Paintings by Franz Marc'], M],
  ['August Macke', ['Paintings by August Macke'], M],
  ['Piet Mondrian', ['Paintings by Piet Mondrian'], M],
  ['Kazimir Malevich', ['Paintings by Kazimir Malevich'], M],
  ['Theo van Doesburg', ['Paintings by Theo van Doesburg'], M],
  ['Egon Schiele', ['Paintings by Egon Schiele'], M],
  ['Edvard Munch', ['Paintings by Edvard Munch'], M],
  ['Odilon Redon', ['Paintings by Odilon Redon'], M],
  ['Paul Signac', ['Paintings by Paul Signac'], IM],
  ['Henri-Edmond Cross', ['Paintings by Henri-Edmond Cross'], IM],
  ['Vincent van Gogh', ['Paintings by Vincent van Gogh'], IM],
  ['Paul Gauguin', ['Paintings by Paul Gauguin'], IM],
  ['Georges Seurat', ['Paintings by Georges Seurat'], IM],
  ['Théo van Rysselberghe', ['Paintings by Théo van Rysselberghe'], IM],
  ['Maximilien Luce', ['Paintings by Maximilien Luce'], IM],
  ['Claude Monet', ['Paintings by Claude Monet'], ['impressionism']],
  ['Henri Rousseau', ['Paintings by Henri Rousseau'], M],
  ['Félix Vallotton', ['Paintings by Félix Vallotton'], M],
  ['Ernst Ludwig Kirchner', ['Paintings by Ernst Ludwig Kirchner'], M],
  ['Alexej von Jawlensky', ['Paintings by Alexej von Jawlensky'], M],
  ['Marianne von Werefkin', ['Paintings by Marianne von Werefkin'], M],
  ['Umberto Boccioni', ['Paintings by Umberto Boccioni'], M],
  ['Juan Gris', ['Paintings by Juan Gris'], M],
  ['Amadeo de Souza-Cardoso', ['Paintings by Amadeo de Souza-Cardoso'], M],
  ['Marsden Hartley', ['Paintings by Marsden Hartley'], M],
  ['Tom Thomson', ['Paintings by Tom Thomson'], M],
  ['Nicholas Roerich', ['Paintings by Nicholas Roerich'], M],
  ['Nikolai Astrup', ['Paintings by Nikolai Astrup'], M],
  ['Harald Sohlberg', ['Paintings by Harald Sohlberg'], M],
  ['Ferdinand Hodler', ['Paintings by Ferdinand Hodler'], M],
  ['Akseli Gallen-Kallela', ['Paintings by Akseli Gallen-Kallela'], M],
  ['Giovanni Giacometti', ['Paintings by Giovanni Giacometti'], M],
  ['Gustav Klimt', ['Paintings by Gustav Klimt'], M],
  ['Alphonse Mucha', ['The Slav Epic', 'Paintings by Alfons Mucha'], M],
  ['Katsushika Hokusai', ['36 Views of Mount Fuji'], JP],
  ['Utagawa Hiroshige', ['The Fifty-three Stations of the Tōkaidō', 'Prints by Utagawa Hiroshige'], JP],
  ['Kawase Hasui', ['Kawase Hasui'], JP],
  ['Hiroshi Yoshida', ['Yoshida Hiroshi'], JP],
  ['Takahashi Shōtei', ['Takahashi Shōtei'], JP],
  ['Ohara Koson', ['Ohara Koson'], JP]
];

const EXTMETA = 'LicenseShortName|License|Copyrighted|Artist|Attribution|ObjectName|DateTimeOriginal|ImageDescription|Categories|Assessments|Restrictions';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`[commons] ${msg}\n`);
const round2 = (n) => Math.round(n * 100) / 100;

function stripHtml(s) {
  return String(s || '')
    .replace(/<(div|span)[^>]*display:\s*none[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t\r\f\v]+/g, ' ').trim();
}
const oneLine = (s) => stripHtml(s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- API access

let apiCalls = 0;
// One request at a time; a 429 or a maxlag error waits as long as the server asks.
async function api(params) {
  const url = new URL(API);
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5', ...params });
  for (let attempt = 0; attempt < 8; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(60000) });
    } catch (err) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(120, Number(res.headers.get('retry-after')) || 20 * (attempt + 1));
      await res.arrayBuffer().catch(() => {});
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`API HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    if (!json) { await sleep(3000); continue; }
    if (json.error) {
      if (json.error.code === 'maxlag' || json.error.code === 'ratelimited') { await sleep(6000 * (attempt + 1)); continue; }
      throw new Error(`API ${json.error.code}: ${json.error.info}`);
    }
    apiCalls++;
    return json;
  }
  throw new Error('API kept refusing');
}

const INFO = { prop: 'imageinfo', iiprop: 'size|mime|extmetadata', iiextmetadatafilter: EXTMETA, iiextmetadatalanguage: 'en' };

// Search results (up to `pages` x 500) with their file info, in search order.
async function searchFiles(query, pages, sort) {
  const out = [];
  let cont = {};
  for (let page = 0; page < pages; page++) {
    const json = await api({ ...INFO, generator: 'search', gsrnamespace: '6', gsrlimit: '500', gsrsearch: query, ...(sort ? { gsrsort: sort } : {}), ...cont });
    const got = (json.query && json.query.pages) || [];
    got.sort((a, b) => (a.index || 0) - (b.index || 0));
    out.push(...got);
    if (!json.continue || !json.continue.gsroffset) break;
    cont = json.continue;
  }
  return out;
}

async function categoryFiles(category) {
  const out = [];
  let cont = {};
  for (let page = 0; page < 3; page++) {
    const json = await api({ ...INFO, generator: 'categorymembers', gcmtitle: `Category:${category}`, gcmtype: 'file', gcmlimit: '500', ...cont });
    out.push(...((json.query && json.query.pages) || []));
    if (!json.continue || !json.continue.gcmcontinue) break;
    cont = json.continue;
  }
  return out;
}

// ---------------------------------------------------------------- URLs

function urls(name, width, bytes) {
  const file = name.replace(/ /g, '_');
  const hash = createHash('md5').update(file).digest('hex');
  const enc = encodeURIComponent(file).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const dir = `${hash[0]}/${hash.slice(0, 2)}/${enc}`;
  // very long names get a fixed thumbnail file name
  const tail = Buffer.byteLength(file) > 160 ? 'thumbnail.jpg' : enc;
  const thumb = (w) => `${THUMB_HOST}/${dir}/${w}px-${tail}`;
  let src;
  if (width >= BIG) src = [thumb(3840), thumb(1920)];
  else if (bytes <= ORIGINAL_MAX_BYTES) src = [`${FILE_HOST}/${dir}`, thumb(1920)];
  else src = [thumb(1920), thumb(1280)];
  return { src, thumb: thumb(500), probe: thumb(120) };
}

// ---------------------------------------------------------------- reading a file page

function meta(page) {
  const ii = page.imageinfo && page.imageinfo[0];
  if (!ii || ii.mime !== 'image/jpeg' || !ii.width || !ii.height) return null;
  const em = ii.extmetadata || {};
  const val = (k) => (em[k] && em[k].value != null ? String(em[k].value) : '');
  const name = page.title.replace(/^File:/, '');
  return {
    name,
    width: ii.width,
    height: ii.height,
    bytes: ii.size || 0,
    ar: ii.width / ii.height,
    licence: oneLine(val('LicenseShortName')),
    licenceCode: val('License').toLowerCase(),
    copyrighted: val('Copyrighted').toLowerCase(),
    artist: stripHtml(val('Artist')),
    attribution: oneLine(val('Attribution')),
    objectName: em.ObjectName && em.ObjectName.source === 'commons-desc-page' ? oneLine(val('ObjectName')) : '',
    date: oneLine(val('DateTimeOriginal')),
    desc: oneLine(val('ImageDescription')).slice(0, 600),
    cats: val('Categories'),
    assessments: val('Assessments').toLowerCase(),
    restrictions: val('Restrictions').toLowerCase()
  };
}

const shapeOk = (m) => m.ar >= MIN_AR && m.ar <= MAX_AR && m.width * m.height <= MAX_PIXELS;
// 1 at 16:9, falling to 0 at the edges of the window
const shapeScore = (ar) => (ar >= IDEAL_AR ? 1 - (ar - IDEAL_AR) / (MAX_AR - IDEAL_AR) : 1 - (IDEAL_AR - ar) / (IDEAL_AR - MIN_AR));

// Things nobody wants on the living-room wall, whatever the half.
const NEVER = /\b(nudes?|nudity|naked|akt|desnud[ao]s?|nu (couché|debout|assis)|bathers?|baigneu(r|se)s?|erotic\w*|topless|corpses?|cadavers?|dead (man|woman|body|bodies|child|mother|soldiers?)|death ?bed|crucifi\w+|execution|massacre|war|battle\w*|soldiers?|troops|army|military|weapons?|rifles?|guns?|artillery|warships?|bombers?|fighter (jet|aircraft)|missiles?|nazi\w*|swastika|skulls?|skeletons?|surgery|surgical|autops\w+|anatom\w+|wounds?|blood|slaughter\w*|maps?|diagrams?|charts?|coats? of arms|heraldry|flags?|logos?|banknotes?|coins?|stamps?|postage|manuscripts?|documents?|posters?)\b/i;

// ---------------------------------------------------------------- art

// not the picture itself: details, frames, backs, museum snapshots, reproductions
const ART_NOT_THE_WORK = /\b(details?|detalle|détail|dettaglio|ausschnitt|cropped|crop|framed?|with frame|frame|verso|reverse|back ?side|rückseite|signature|x-?ray|infrared|radiograph\w*|raking|exhibition|ausstellung|exposition|installation view|museum view|gallery view|in situ|interior|visitors?|room|salle|saal|wall|photograph of|sketch(es|book)?|studies|study for|étude|studie|skizze|drawing|dessin|zeichnung|lithograph\w*|etching|woodcut|holzschnitt|engraving|book|cover|catalogue|catalog|letter|brief|carte|postcard|tapestry|replica|copy after|after|reproduction|forgery|photo by|tombe?|grave|grab|house|maison|museum|musée|monument|plaque|statue|memorial|self-?portraits?|selbstbildnis|autoportrait|portraits?|bildnis|retrato)\b/i;
const ART_NOT_THE_WORK_CATS = /\b(Framed paintings|Details of|Paintings in frames|Exhibitions?|Museum interiors|Graves|Signatures|Photographs of|Derivative works)\b/i;
const CAMERA_NAME = /\b((IMG|DSC[FN]?|DSCN|MG|DJI|PXL|SAM|WP)[ _-]?\d{3,}|P[A-Z]?\d{6,})\b/;

const ART_SUBJECT = {
  seascapes: /\b(sea|seascape|ocean|coast|shore|beach|harbou?r|port|bay|boats?|sailboats?|ships?|waves?|marine|mer|plage|meer|hafen|strand|fjord|regatta|lagoon|cap|calanque|antibes|saint-tropez|st\.? tropez|venice|venise|venedig)\b/i,
  cities: /\b(city|cityscape|street|rue|boulevard|town|village|bridge|pont|paris|london|venice|venise|houses?|häuser|stadt|cathedral|church|kirche|église|eiffel|edo|tokyo|kyoto|temple|shrine|pagoda|moscow|murnau)\b/i,
  landscapes: /\b(landscape|landschaft|paysage|mountains?|berg\w*|hills?|valley|river|lake|see|forest|wald|woods?|trees?|bäume|fields?|wheat ?fields?|meadow|garden|jardin|garten|orchard|sunset|sunrise|snow|winter|spring|autumn|summer|fuji|park|olive|cypress\w*|vineyard|path|road|pines?|poplars?|moonlight|evening|morning|rain|waterfall|falls|canyon|island|himalaya\w*)\b/i,
  'still-life': /\b(still[- ]life|stilleben|stillleben|nature morte|vase|bouquet|sunflowers?|irises|fruit|apples?)\b/i,
  'botanical-animals': /\b(flowers?|blumen|fleurs|roses?|irises|iris|sunflowers?|tournesols|poppies|blossoms?|almond blossom|chrysanthemums?|lilies|peon(y|ies)|horses?|pferde?|cows?|kühe|deer|rehe?|fox|fuchs|tigers?|cats?|katze|dogs?|hund|birds?|vögel|swans?|cranes?|herons?|egrets?|monkeys?|affe|lions?|fish|geese|ducks?|crows?|owls?|sparrows?|butterfl(y|ies))\b/i
};

function artTitle(m, artist) {
  const names = artist.split(/[\s-]+/).filter((w) => w.length > 3 && !/^(van|von|der)$/i.test(w));
  const artistRe = new RegExp(`\\b(${[artist, ...names].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|vincent|wassily|vassily|kandinskij|vasily|malewitsch|gogh|hokusai|hiroshige|hasui|yoshida|koson|mucha|alfons|doesburg|rysselberghe|kallela)\\b`, 'gi');
  const tidy = (s) => s
    .replace(/\.(jpe?g|tiff?|png)$/i, '')
    .replace(/_/g, ' ')
    .replace(/google art project|google arts? (and|&) culture|\bGAC\b|\bGAP\b|\bWGA\w*|\bDSC\w*|project yorck|the yorck project/gi, ' ')
    .replace(/\((cropped|crop|restored|retouched|edit(ed)?|high res\w*|hd|[a-z]{0,4}\s?[\d.\-/ ]{3,}[a-z]?)\)/gi, ' ')
    .replace(/\b(F|JH|W|H|inv\.?|no\.?|nr\.?|cat\.?)\s?\d{2,}\w*/gi, ' ')
    .replace(/\b\d{2,3}\s?[x×]\s?\d{2,3}(\s?cm)?\b/gi, ' ')
    .replace(/\bc(irc)?a?\.?\s?(?=1[5-9]\d\d)/gi, ' ')
    .replace(/\b1[5-9]\d\d(\s?[-–/]\s?\d{2,4})?\b/g, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^\s*(japanese|french|german|dutch|english|italian|spanish|russian|norwegian|finnish|swedish)\s*:\s*/i, ' ')
    .replace(/『[^』]*』\s*-?/g, ' ')
    .replace(/,*\s*\blot\b\.?\s*\d*/gi, ' ')
    .replace(/\s+(par|by|von|de)\s*$/i, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/\(\s*\)/g, ' ');
  let t = m.objectName && m.objectName.length <= 90 && !/[{}|]|label QS/.test(m.objectName) ? m.objectName : '';
  if (t) t = tidy(t).replace(/\s+/g, ' ').replace(/^[\s,.;:'"-]+|[\s,;:'"-]+$/g, '').trim();
  if (!t || t.length < 3 || !/[a-zA-Z]{3}/.test(t)) {
    const parts = tidy(m.name).split(/\s+[-–—]\s+|\s*,\s*(?=\d)|\s+by\s+(?=[A-Z])|\s*;\s*/)
      .map((p) => p.replace(artistRe, ' ').replace(/\s+/g, ' ').replace(/^[\s,.;:'"()-]+|[\s,;:'"(-]+$/g, '').trim())
      .filter((p) => p.length >= 3 && /[a-zA-ZÀ-ɏ]{3}/.test(p) && !/^(museum|musée|national|gallery|galerie|collection|oil on canvas|private collection|google|art institute|metropolitan|moma|tate)\b/i.test(p));
    parts.sort((a, b) => b.length - a.length);
    t = parts[0] || '';
  }
  t = t.replace(/\s+\(\s*\)/g, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/[\s,.;:(-]+$/g, '').trim();
  if (t.length > 80) t = t.slice(0, 78).replace(/\s+\S*$/, '') + '…';
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

function artYear(m) {
  const src = `${m.date} `;
  const y = src.match(/\b(1[5-9]\d\d)\b/);
  if (y) return (/\b(circa|c\.|ca\.|about|around)\b/i.test(src) ? 'c. ' : '') + y[1];
  const fromName = m.name.match(/\b(1[6-9]\d\d)\b/);
  return fromName ? fromName[1] : '';
}

function artCandidate(page, artist, baseCats, rank) {
  const m = meta(page);
  if (!m || !shapeOk(m) || m.width < ART_MIN_WIDTH) return null;
  // public domain or CC0 only; a photographer's own CC licence on the scan is not accepted
  const pd = /^(public domain|pd\b|cc0|no restrictions)/i.test(m.licence) || /^(pd|cc0)$/.test(m.licenceCode);
  if (!pd || m.copyrighted === 'true') return null;
  const text = `${m.name} ${m.objectName}`;
  if (NEVER.test(text) || ART_NOT_THE_WORK.test(text) || ART_NOT_THE_WORK_CATS.test(m.cats) || CAMERA_NAME.test(m.name)) return null;
  const title = artTitle(m, artist);
  if (!title) return null;
  const cats = [...baseCats];
  for (const [cat, re] of Object.entries(ART_SUBJECT)) if (re.test(`${title} ${m.name}`) && !cats.includes(cat)) cats.push(cat);
  const year = artYear(m);
  const gap = /google art project|google arts/i.test(`${m.name} ${m.cats}`) ? 1 : 0;
  const fp = /featured|quality/.test(m.assessments) ? 1 : 0;
  return {
    kind: 'art', m, creator: artist, title, sub: year ? `${artist}, ${year}` : artist, cats,
    key: `${artist}|${title.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '')}`,
    prior: gap * 2 + fp * 2 + shapeScore(m.ar) + (m.width >= BIG ? 1 : 0) - rank / 500
  };
}

// ---------------------------------------------------------------- photographs

const PHOTO_SUBJECT = [
  ['space', /\b(milky way|galax(y|ies)|nebulae?|star ?trails?|astrophotograph\w*|night sk(y|ies)|starry|zodiacal|comets?|lunar eclipse|solar eclipse|noctilucent|perseids?|orion|andromeda|constellations?|supermoon|full moon|moonrise|airglow)\b/i],
  ['botanical-animals', /\b(birds?|aves|passeriformes|kingfishers?|bee-eaters?|parrots?|macaws?|flamingos?|owls?|eagles?|hummingbirds?|herons?|egrets?|puffins?|toucans?|rollers?|sunbirds?|peacocks?|peafowl|pelicans?|ducks?|swans?|geese|animals?|mammals?|mammalia|wildlife|fox(es)?|deer|lions?|tigers?|leopards?|cheetahs?|elephants?|giraffes?|zebras?|bears?|wolves|wolf|squirrels?|monkeys?|lemurs?|whales?|dolphins?|seals?|turtles?|tortoises?|frogs?|chameleons?|geckos?|lizards?|iguanas?|fish(es)?|coral|reef|nudibranch\w*|butterfl(y|ies)|lepidoptera|dragonfl(y|ies)|damselfl(y|ies)|odonata|flowers?|flowering|blossoms?|bloom\w*|inflorescence|petals?|tulips?|roses?|orchids?|orchidaceae|lotus|sunflowers?|poppies|poppy|lavender|lil(y|ies)|dahlias?|crocus\w*|magnoli\w+|plantae|plants?|leaves|leaf|fungi|mushrooms?|ferns?|cactus|cacti|succulents?)\b/i],
  ['seascapes', /\b(sea|seas|seascapes?|ocean|coasts?|coastal|coastline|shore|seashore|beach(es)?|lighthouses?|cliffs?|bay|cove|harbou?rs?|fjords?|lagoons?|surf|waves?|tide|tidal|atoll|archipelago|islands?|isle|cape|pier|jetty|sea stacks?|skerr(y|ies)|mediterranean|atlantic|pacific|baltic|adriatic|aegean|caribbean)\b/i],
  ['cities', /\b(skylines?|cityscapes?|city|cities|downtown|skyscrapers?|towers?|bridges?|streets?|architecture|cathedrals?|church(es)?|basilica|mosques?|temples?|pagodas?|shrines?|palaces?|castles?|château|schloss|monaster(y|ies)|abbey|old town|plaza|piazza|canal|blue hour|illuminated|at night|by night|night view|dusk|twilight|windmills?|fortress|citadel|pyramids?|dome)\b/i],
  ['landscapes', /\b(landscapes?|mountains?|mount|peaks?|alps|alpine|glaciers?|valley|valleys|lakes?|rivers?|waterfalls?|falls|cascades?|forests?|woods|trees?|meadows?|fields?|hills?|canyons?|gorges?|deserts?|dunes?|volcano\w*|crater|geysers?|hot springs?|national park|nature reserve|sunsets?|sunrises?|aurora|northern lights|rainbow|autumn|fall colou?rs|winter|snow|fog|mist|panorama|prairie|steppe|savanna\w*|tundra|wetlands?|marsh|moor|rice terraces?|terraces|vineyards?|countryside|rural|plateau|cliff|rock formations?|badlands|salt flats?|iceberg\w*|ice|fjell|dolomit\w+|himalaya\w*|andes|patagonia|highlands?|icelan\w+)\b/i],
  ['modern-abstract', /\b(aerial|abstract|patterns?|textures?|from above|drone|bird'?s[- ]eye|reflections?|macro|close-?up|crystals?|minerals?|agate|soap film|bubbles?|ice crystals?|frost|salt (pans?|ponds?)|tulip fields|fields from)\b/i]
];

// Subjects that never suit the frame, tested on title, categories and description.
const PHOTO_NEVER = /\b(fractals?|mandelbrot|mandelbulb\w*|computer[- ]generated|renderings?|rendered|doors?|doorway|gate|walls?|offices?|ministry|prosecutor\w*|parliament|town hall|rathaus|archaeological|archéologique|replicas?|facade|façade|portraits?|people|person|persons|man|men|woman|women|girls?|boys?|child|children|kids?|baby|family|bride|wedding|monks?|priests?|pilgrims?|worshippers?|dancers?|musicians?|singers?|actors?|actress\w*|politicians?|president|athletes?|players?|football\w*|soccer|rugby|tennis|cycling|cyclists?|olympic\w*|championships?|sports?|festival|carnival|parade|protest\w*|demonstration|crowds?|fishermen|farmers?|workers?|vendors?|market|insects?|insecta|flies|fly|diptera|spiders?|araneae|arachnid\w*|wasps?|hornets?|beetles?|coleoptera|bugs?|hemiptera|ants?|mosquito\w*|ticks?|mites?|larvae?|caterpillars?|maggots?|cockroach\w*|centipedes?|scorpions?|snakes?|serpentes|vipers?|mating|copulat\w+|carcass\w*|prey|feeding on|eating a|kill|roadkill|specimens?|taxiderm\w*|fossils?|bones?|teeth|museum (specimens?|objects?|exhibits?)|artefacts?|artifacts?|sculptures?|statues?|reliefs?|paintings?|frescos?|frescoes|murals?|mosaics?|engravings?|lithographs?|prints?|drawings?|illustrations?|altars?|altarpieces?|organs?|pulpits?|naves?|choirs?|ceilings?|interiors?|inside|crypts?|tombs?|graves?|cemeter(y|ies)|locomotives?|trains?|trams?|railway\w*|aircraft|airplanes?|aeroplanes?|airliners?|helicopters?|boeing|airbus|cars?|automobiles?|trucks?|buses|bus|motorcycles?|tractors?|tanks?|rockets?|launch|spacecraft|satellites?|astronauts?|microscop\w+|micrograph\w*|sem image|x-ray|cross[- ]section|shells?|mollusca|gastropoda|bivalvia|food|dish|cuisine|fruit|vegetables?|cheese|bread|meat|instruments?|tools?|machines?|engines?|factory|industrial|power (plant|station)|mine|quarry|refinery|construction|demolition|ruined|abandoned|derelict|slum|rubbish|pollution|fire|wildfire|flood|disaster|earthquake|historical photographs?|black and white|monochrome|sepia|photochrom\w*|daguerreotype\w*|18\d\d|19[0-6]\d)\b/i;
const NIGHTY = /\b(night|dusk|twilight|blue hour|aurora|northern lights|milky way|star|stars|starry|galaxy|nebula|moon|illuminated|fireworks|sunset|sunrise|dawn|evening)\b/i;

function photographer(m) {
  let a = (m.artist || '').split('\n')[0];
  a = a.replace(/^this (photo|image|picture|file) was (taken|created|made) by\s+/i, '').replace(/(?<=[a-z]{3})\.\s.*$/, '').replace(/\(talk\)|\btalk\b\s*$/gi, ' ').replace(/^(photo(graph)?(ed)?|picture|image|created|taken)?\s*(by|:)\s+/i, '').replace(/^user:/i, '')
    .replace(/\b(own work|derivative work).*$/i, ' ').replace(/https?:\S+/g, ' ').replace(/\S+@\S+/g, ' ').replace(/\([^)]*\)\s*$/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s,.;:/-]+|[\s,.;:/-]+$/g, '').trim();
  if (!a || a.length < 2 || /^(unknown|anonymous|see below|various|n\/a)$/i.test(a)) a = m.attribution.replace(/https?:\S+/g, ' ').replace(/\s*[/,]?\s*(CC|Wikimedia|Wikipedia)\b.*$/i, '').replace(/^(photo(graph)?\s*)?(by|:|©)\s*/i, '').trim();
  if (a.length > 48) a = a.split(/\s*[;,/|]\s*|\s+-\s+/)[0].slice(0, 48).trim();
  return a.length >= 2 && !/^(unknown|anonymous)$/i.test(a) ? a : '';
}

function photoLicence(m) {
  const s = m.licence.replace(/\s+/g, ' ');
  let x = s.match(/^CC[ -]BY(-SA)?[ -](\d\.\d)(\s[a-z]{2,5})?$/i);
  if (x) return `CC BY${x[1] ? '-SA' : ''} ${x[2]}`;
  if (/^(CC0|CC0 1\.0)/i.test(s)) return 'CC0';
  if (/^(public domain|pd\b)/i.test(s)) return 'Public domain';
  return '';
}

function photoTitle(m) {
  let t = m.name.replace(/\.(jpe?g)$/i, '').replace(/_/g, ' ');
  t = t
    .replace(/\b(19|20)\d\d[-.\/ ]?[01]\d[-.\/ ]?[0-3]\d\b([ T_-]?\d{2}[-:.]?\d{2}([-:.]?\d{2})?)?/g, ' ')
    .replace(/\b[0-3]?\d[.\/-][01]?\d[.\/-](19|20)\d\d\b/g, ' ')
    .replace(/\bDD \d+(\s?-\s?\d+)?\b/g, ' ')
    .replace(/\b(HDR|PAN|PANO|FS|ND|LE|edit\d*|edited|crop(ped)?|retouched|denoised?|stitch(ed)?|version|ver|v\d|nr|no|img|dsc\w*|mg|jpg|msu|wlm|wle|wlx|at)\s?\d*\s*$/gi, ' ')
    .replace(/\((cropped|crop|edit\w*|retouched|\d+|[A-Z]{0,3}\s?\d[\d\s.-]*)\)/gi, ' ')
    .replace(/\b(IMG|DSC[FN]?|DJI|PXL|MG|P)[ _-]?\d{3,}\w*/g, ' ')
    .replace(/[-–—,;. ]+\b\d{1,5}[a-z]?\s*$/i, ' ')
    .replace(/^\s*\d{2,}[a-z]?\s*[-–—,. ]\s*/i, ' ')
    .replace(/\s+-\s+(?=[-,]|$)/g, ' ')
    .replace(/\(\s*\)/g, ' ').replace(/\s+,/g, ',').replace(/(,\s*){2,}/g, ', ').replace(/\s+/g, ' ')
    .replace(/^[\s,.;:–—-]+|[\s,;:–—(-]+$/g, '').trim();
  for (let i = 0; i < 2; i++) t = t.replace(/[-–—,;. ]+\b\d{1,5}[a-z]?\s*$/i, '').replace(/[\s,;:–—(-]+$/g, '').trim();
  const latin = (t.match(/[a-zA-ZÀ-ɏ]/g) || []).length;
  if (t.length < 4 || latin < t.replace(/[\s\d\W]/g, '').length * 0.6) {
    const d = m.desc.replace(/^(english|en|description)\s*:\s*/i, '').split(/(?<=[a-z)])[.;]\s|\s[-–—]\s|\n/)[0].trim();
    if (d.length >= 4) t = d;
  }
  if (t.length > 80) {
    const cut = t.slice(0, 80);
    t = (cut.lastIndexOf(',') > 30 ? cut.slice(0, cut.lastIndexOf(',')) : cut.replace(/\s+\S*$/, '') + '…');
  }
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

function photoCandidate(page, rank, poty) {
  const m = meta(page);
  if (!m || !shapeOk(m) || m.width < BIG) return null;
  const licence = photoLicence(m);
  const who = photographer(m);
  if (!licence || !who) return null;
  const hay = `${m.name.replace(/_/g, ' ')} | ${m.cats}`;
  // artwork scans and old photographs are featured too; this half is contemporary photography only
  if (/PD-Art|PD-old|PD-scan|Artworks|Google Art Project|Paintings|Photochrom|Restored|Historical images/i.test(m.cats)) return null;
  if (NEVER.test(hay) || PHOTO_NEVER.test(hay) || PHOTO_NEVER.test(m.desc.slice(0, 200))) return null;
  const year = (m.date.match(/\b(19|20)\d\d\b/) || [''])[0];
  if (year && Number(year) < 2005) return null;
  const subjectText = `${m.name.replace(/_/g, ' ')} | ${m.cats.replace(/\b(Quality images|Featured pictures|Valued images|Pictures of the Year|Taken with|Photographs taken|Images (by|from|with)|Uploaded (by|with|via)|Files (by|from|with)|CC-|Self-published|Media (by|from|with)|License)[^|]*/gi, ' ')}`;
  let subject = '';
  for (const [cat, re] of PHOTO_SUBJECT) if (re.test(subjectText)) { subject = cat; break; }
  if (!subject) return null;
  const title = photoTitle(m);
  if (!title) return null;
  const cats = ['photography', subject];
  return {
    kind: 'photo', m, creator: who, title, sub: `Photo: ${who}, ${licence}`, cats, subject,
    nighty: NIGHTY.test(subjectText),
    key: `${who}|${title.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
    prior: (poty ? 1.5 : 0) + (/poty/.test(m.assessments) ? 0.3 : 0) + shapeScore(m.ar) - rank / 8000
  };
}

// ---------------------------------------------------------------- measuring pictures

function findFfmpeg() {
  for (const bin of FFMPEG_PATHS) {
    try { if (spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0) return bin; } catch { /* next */ }
  }
  return null;
}

// Thumbnails are fetched with curl, not fetch(): upload.wikimedia.org answers HTTP/1.1
// requests for not-yet-cached thumbnails with 429, and Node's fetch only speaks HTTP/1.1.
function fetchBytes(url) {
  return new Promise((resolve) => {
    const p = spawn('curl', ['-s', '-f', '--http2', '--max-time', '30', '-A', UA, url], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
  });
}

const N = 64;
function decode(ffmpeg, jpeg) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${N}:${N}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => { clearTimeout(timer); const b = Buffer.concat(chunks); resolve(b.length === N * N * 3 ? b : null); });
    p.stdin.on('error', () => {});
    p.stdin.end(jpeg);
  });
}

function measure(px) {
  const n = N * N;
  let sRg = 0, sYb = 0, sRg2 = 0, sYb2 = 0, sL = 0, dark = 0, white = 0, sSat = 0;
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    const rg = r - g, yb = 0.5 * (r + g) - b;
    sRg += rg; sYb += yb; sRg2 += rg * rg; sYb2 += yb * yb;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    luma[i] = l; sL += l;
    if (l < 32) dark++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (l > 225 && mx - mn < 20) white++;
    sSat += mx - mn; // chroma: saturation weighted by value
  }
  const mRg = sRg / n, mYb = sYb / n;
  const colour = Math.sqrt(Math.max(0, sRg2 / n - mRg * mRg) + Math.max(0, sYb2 / n - mYb * mYb)) + 0.3 * Math.sqrt(mRg * mRg + mYb * mYb);
  // flat edges: a mount, a frame against a wall, or letterboxing
  const side = (pick) => {
    let s = [0, 0, 0], s2 = 0, c = 0;
    const cells = [];
    for (let k = 0; k < N; k++) for (let d = 0; d < 2; d++) cells.push(pick(k, d));
    for (const i of cells) { for (let ch = 0; ch < 3; ch++) s[ch] += px[i * 3 + ch]; c++; }
    const mean = s.map((v) => v / c);
    for (const i of cells) for (let ch = 0; ch < 3; ch++) s2 += (px[i * 3 + ch] - mean[ch]) ** 2;
    return { mean, sd: Math.sqrt(s2 / (c * 3)) };
  };
  const sides = [side((k, d) => d * N + k), side((k, d) => (N - 1 - d) * N + k), side((k, d) => k * N + d), side((k, d) => k * N + N - 1 - d)];
  const flat = sides.filter((s) => s.sd < 9);
  let border = false;
  if (flat.length >= 3) {
    const a = flat[0].mean;
    border = flat.every((s) => Math.hypot(s.mean[0] - a[0], s.mean[1] - a[1], s.mean[2] - a[2]) < 28);
  }
  // 8x8 difference hash of the luma, for spotting the same picture twice
  const cell = (cx, cy) => { let s = 0; for (let y = cy * 8; y < cy * 8 + 8; y++) for (let x = cx * 7; x < cx * 7 + 8; x++) s += luma[y * N + Math.min(x, N - 1)]; return s; };
  const hash = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash.push(cell(x, y) > cell(x + 1, y) ? 1 : 0);
  return { colour, bright: sL / n, dark: dark / n, white: white / n, chroma: sSat / n, border, hash, rgb: [0, 1, 2].map((ch) => { let s = 0; for (let i = 0; i < n; i++) s += px[i * 3 + ch]; return s / n; }) };
}

const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

// Measures as many as it can inside the time budget; the rest stay unmeasured.
async function scoreAll(cands, ffmpeg) {
  const deadline = Date.now() + SCORE_BUDGET_MS;
  let next = 0, done = 0, failed = 0, streak = 0;
  const worker = async () => {
    while (next < cands.length && Date.now() < deadline && streak < 40) {
      const c = cands[next++];
      const u = urls(c.m.name, c.m.width, c.m.bytes);
      let jpeg = await fetchBytes(u.probe);
      if (!jpeg) { await sleep(4000); jpeg = await fetchBytes(u.probe); }
      const px = jpeg && (await decode(ffmpeg, jpeg));
      if (px) { c.v = measure(px); streak = 0; } else { failed++; streak++; }
      if (++done % 400 === 0) log(`measured ${done}/${cands.length}`);
      await sleep(60);
    }
  };
  await Promise.all(Array.from({ length: SCORE_CONCURRENCY }, worker));
  if (done < cands.length) log(`measuring stopped at ${done}/${cands.length} (${streak >= 40 ? 'thumbnails are being refused' : 'time budget'})`);
  if (failed) log(`${failed} thumbnails could not be read`);
}

function vibrant(c) {
  const v = c.v;
  if (!v) return true; // not measured: left to the catalogue builder's own colour check
  if (v.border || v.dark > MAX_DARK_FRACTION || v.white > 0.45) return false;
  if (c.kind === 'art') return v.colour >= ART_MIN_COLOUR && v.bright >= ART_MIN_BRIGHT;
  if (v.colour >= PHOTO_MIN_COLOUR && v.bright >= PHOTO_MIN_BRIGHT) return true;
  return c.nighty && v.colour >= NIGHT_MIN_COLOUR && v.bright >= NIGHT_MIN_BRIGHT;
}

// ---------------------------------------------------------------- putting it together

function capBy(cands, keyOf, max) {
  const seen = new Map();
  return cands.filter((c) => { const k = keyOf(c); const n = seen.get(k) || 0; seen.set(k, n + 1); return n < max; });
}

function dedupe(cands) {
  // best first, so the copy that is kept is the best scan
  const kept = [];
  const keys = new Set();
  for (const c of cands) {
    if (keys.has(c.key)) continue;
    if (c.v && kept.some((k) => k.v && hamming(k.v.hash, c.v.hash) <= (k.creator === c.creator ? 9 : 5) && Math.abs(k.m.ar - c.m.ar) < 0.25)) continue;
    keys.add(c.key);
    kept.push(c);
  }
  return kept;
}

const quality = (c) => c.prior + (c.v ? Math.min(c.v.colour, 110) / 40 : -2);

export default async function fetchWorks() {
  const started = Date.now();
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) log('ffmpeg not found: vibrancy scoring and look-alike removal are skipped');

  // ---- photographs
  const photoByName = new Map();
  const addPhoto = (page, rank, poty) => {
    const name = page.title;
    if (photoByName.has(name)) { if (poty) photoByName.get(name).prior += 1.5; return; }
    const c = photoCandidate(page, rank, poty);
    if (c) photoByName.set(name, c);
  };
  try {
    const pages = await searchFiles('incategory:"Featured pictures on Wikimedia Commons" filemime:image/jpeg filew:>3839', QUICK ? 1 : PHOTO_PAGES, 'create_timestamp_desc');
    pages.forEach((p, i) => addPhoto(p, i, false));
    log(`featured pictures: ${pages.length} read, ${photoByName.size} candidates`);
  } catch (err) { log(`featured pictures failed: ${err.message}`); }
  for (const year of QUICK ? [] : POTY_YEARS) {
    try {
      const pages = await categoryFiles(`Pictures of the Year (${year})`);
      pages.forEach((p, i) => addPhoto(p, 4000 + i, true));
    } catch (err) { log(`picture of the year ${year} failed: ${err.message}`); }
  }
  log(`photographs: ${photoByName.size} candidates after ${apiCalls} API calls`);

  // ---- art
  const artByName = new Map();
  for (const [artist, roots, baseCats] of QUICK ? ARTISTS.filter((a) => /Kandinsky|Marc|Signac|Hokusai|Hasui/.test(a[0])) : ARTISTS) {
    let read = 0;
    for (const root of roots) {
      try {
        const pages = await searchFiles(`deepcategory:"${root}" filemime:image/jpeg filew:>${ART_MIN_WIDTH - 1}`, QUICK ? 1 : 2);
        read += pages.length;
        pages.forEach((p, i) => { if (!artByName.has(p.title)) { const c = artCandidate(p, artist, baseCats, i); if (c) artByName.set(p.title, c); } });
      } catch (err) { log(`${root} failed: ${err.message}`); }
    }
    log(`${artist}: ${read} files read, ${[...artByName.values()].filter((c) => c.creator === artist).length} candidates`);
  }
  log(`art: ${artByName.size} candidates after ${apiCalls} API calls (${Math.round((Date.now() - started) / 1000)}s)`);

  // ---- measure
  const byPrior = (a, b) => b.prior - a.prior;
  let art = capBy([...artByName.values()].sort(byPrior), (c) => c.creator, ART_SCORED_PER_ARTIST);
  let photos = capBy([...photoByName.values()].sort(byPrior), (c) => c.creator.toLowerCase(), PHOTO_SCORED_PER_PERSON);
  if (ffmpeg) {
    await scoreAll([...art, ...photos], ffmpeg);
    const before = [art.length, photos.length];
    art = art.filter(vibrant);
    photos = photos.filter(vibrant);
    log(`vibrancy kept ${art.length}/${before[0]} art and ${photos.length}/${before[1]} photographs`);
  }
  const byQuality = (a, b) => quality(b) - quality(a);
  art = dedupe(art.sort(byQuality));
  photos = dedupe(photos.sort(byQuality));

  // ---- choose
  art = capBy(art, (c) => c.creator, MAX_PER_ARTIST);
  let japanese = 0;
  art = art.filter((c) => !c.cats.includes('japanese-prints') || japanese++ < MAX_JAPANESE);
  // deal the artists round-robin so the list is not just the most colourful few
  const rounds = [];
  const seenArtist = new Map();
  for (const c of art) { const n = seenArtist.get(c.creator) || 0; seenArtist.set(c.creator, n + 1); (rounds[n] = rounds[n] || []).push(c); }
  art = rounds.flat().slice(0, ART_TARGET);

  const chosen = [];
  const perPerson = new Map();
  const perPersonSubject = new Map();
  for (const [subject, quota] of Object.entries(PHOTO_QUOTAS)) {
    let n = 0;
    for (const c of photos) {
      if (n >= quota) break;
      if (c.subject !== subject) continue;
      const who = c.creator.toLowerCase();
      if ((perPerson.get(who) || 0) >= MAX_PER_PHOTOGRAPHER) continue;
      const ks = `${who}|${subject}`;
      if ((perPersonSubject.get(ks) || 0) >= Math.max(6, Math.round(quota / 9))) continue;
      perPerson.set(who, (perPerson.get(who) || 0) + 1);
      perPersonSubject.set(ks, (perPersonSubject.get(ks) || 0) + 1);
      chosen.push(c);
      n++;
    }
  }

  const debug = !!process.env.COMMONS_DEBUG;
  const works = [...art, ...chosen].map((c) => {
    const u = urls(c.m.name, c.m.width, c.m.bytes);
    const w = { src: u.src, thumb: u.thumb, title: c.title, sub: c.sub, cats: c.cats, ar: round2(c.m.ar) };
    if (debug) w._ = { kind: c.kind, file: c.m.name, creator: c.creator, width: c.m.width, bytes: c.m.bytes, licence: c.m.licence, v: c.v && { colour: Math.round(c.v.colour), bright: Math.round(c.v.bright), dark: round2(c.v.dark) } };
    return w;
  });
  log(`${works.length} works (${art.length} art, ${chosen.length} photographs), ${apiCalls} API calls, ${Math.round((Date.now() - started) / 1000)}s`);
  return works;
}
