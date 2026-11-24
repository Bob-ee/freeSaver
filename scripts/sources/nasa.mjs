// NASA Image and Video Library (https://images-api.nasa.gov) — no API key.
// Curated "space" imagery: nebulae, galaxies, planets, the Sun, Earth from
// orbit. Images are hot-linked from images-assets.nasa.gov.
//
// Curation is search queries + text filters (subject must match the group's
// "want" pattern in the title/keywords; anything that smells like people,
// hardware, diagrams or artist's concepts is dropped), then a size check:
// the chosen rendition's real pixel size is read from the image header.

export const id = 'nasa';
export const label = 'NASA';

const API = 'https://images-api.nasa.gov/search';
const UA = 'art-frame-catalogue/1.0 (node fetch)';

const MIN_W = 1920;          // smallest acceptable width of the original
const MAX_W = 6000;          // widest file a TV should be asked to decode
const MAX_BYTES = 8e6;
// The TV crops to 16:9; outside this window more than a quarter is lost.
const MIN_RATIO = 1.33, MAX_RATIO = 2.37;
const IDEAL_RATIO = 16 / 9;
const TARGET = 380;          // overall ceiling
const SEARCH_CONCURRENCY = 3;
const PROBE_CONCURRENCY = 8;

// ---- what to ask for ------------------------------------------------------

const DEEP = /nebula|galax|supernova|star[- ]?(cluster|form|birth|burst)|stellar|globular|pillars|milky way|magellanic|andromeda|deep field|cosmic|interstellar|orion|carina|tarantula|eagle|lagoon|helix|messier|\bM\d{1,3}\b|\bNGC ?\d+|\bIC ?\d+|quasar|black hole|stars?\b|constellation|zeta oph|cassiopeia|cygnus|rho oph|pleiades|celestial|galactic/i;
const PLANETS = /jupiter|jovian|great red spot|saturn|\brings?\b|neptune|uranus|pluto|charon|\bio\b|europa|ganymede|callisto|enceladus|titan|mimas|dione|tethys|rhea|iapetus|triton|mercury|venus|\bmars\b|martian|crater|dunes?|\bmoon\b|lunar|earthrise|comet|\bsun\b|solar (flare|prominence|eruption|filament|dynamics)|corona|sunspot|ceres|vesta/i;
const EARTH = /aurora|earth|city lights|night|limb|airglow|sunrise|sunset|moonrise|moonset|hurricane|typhoon|cyclone|storm|clouds?|ocean|sea\b|island|atoll|reef|coast|desert|mountain|himalaya|alps|glacier|river|delta|lake|volcano|bahamas|sahara|milky way|stars|noctilucent|thunderstorm|lightning|from (space|orbit)|blue marble/i;

// [group, query string, pages, allowed centers]
const DEEP_CENTERS = ['JPL', 'GSFC', 'MSFC', 'STScI'];
const QUERIES = [
  ['deep', 'q=nebula', 4, DEEP_CENTERS],
  ['deep', 'q=galaxy', 6, DEEP_CENTERS],
  ['deep', 'q=galaxies', 3, DEEP_CENTERS],
  ['deep', 'q=supernova', 3, DEEP_CENTERS],
  ['deep', 'q=star%20cluster', 3, DEEP_CENTERS],
  ['deep', 'q=star%20forming', 3, DEEP_CENTERS],
  ['deep', 'q=hubble&center=GSFC', 5, DEEP_CENTERS],
  ['deep', 'q=hubble%20space%20telescope&center=JPL', 4, DEEP_CENTERS],
  ['deep', 'q=spitzer', 5, DEEP_CENTERS],
  ['deep', 'q=wide-field%20infrared%20survey%20explorer', 3, DEEP_CENTERS],
  ['deep', 'q=galaxy%20evolution%20explorer', 2, DEEP_CENTERS],
  ['deep', 'q=chandra', 3, DEEP_CENTERS],
  ['deep', 'q=webb%20nebula', 2, DEEP_CENTERS],
  ['deep', 'q=webb%20galaxy', 2, DEEP_CENTERS],
  ['deep', 'q=webb%20telescope%20image', 2, DEEP_CENTERS],
  ['deep', 'center=STScI', 2, DEEP_CENTERS],
  ['deep', 'q=milky%20way', 4, DEEP_CENTERS],
  ['deep', 'q=andromeda', 1, DEEP_CENTERS],
  ['deep', 'q=magellanic%20cloud', 2, DEEP_CENTERS],
  ['deep', 'q=deep%20field', 1, DEEP_CENTERS],
  ['deep', 'q=herschel', 2, DEEP_CENTERS],
  ['deep', 'q=nustar', 1, DEEP_CENTERS],
  ['deep', 'q=galaxy%20cluster', 2, DEEP_CENTERS],
  ['deep', 'q=stars%20infrared', 3, DEEP_CENTERS],
  ['deep', 'q=cosmic%20dust', 2, DEEP_CENTERS],
  ['deep', 'q=stellar%20nursery', 2, DEEP_CENTERS],
  ['deep', 'q=hubble%20heritage', 2, DEEP_CENTERS],
  ['deep', 'q=spiral%20galaxy', 3, DEEP_CENTERS],
  ['deep', 'q=planetary%20nebula', 2, DEEP_CENTERS],
  ['deep', 'q=supernova%20remnant', 2, DEEP_CENTERS],

  ['planets', 'q=junocam', 3, ['JPL']],
  ['planets', 'q=jupiter%20juno', 4, ['JPL']],
  ['planets', 'q=great%20red%20spot', 2, ['JPL', 'GSFC']],
  ['planets', 'q=jupiter%20hubble', 1, ['JPL', 'GSFC']],
  ['planets', 'q=saturn%20cassini%20natural%20color', 3, ['JPL']],
  ['planets', 'q=saturn%20rings', 4, ['JPL', 'GSFC']],
  ['planets', 'q=pluto%20new%20horizons', 2, ['JPL', 'GSFC', 'HQ']],
  ['planets', 'q=neptune%20voyager', 1, ['JPL']],
  ['planets', 'q=enceladus', 2, ['JPL']],
  ['planets', 'q=titan%20saturn', 2, ['JPL']],
  ['planets', 'q=europa%20jupiter', 1, ['JPL']],
  ['planets', 'q=io%20volcano', 1, ['JPL']],
  ['mars', 'q=mars%20hirise%20dunes', 2, ['JPL']],
  ['mars', 'q=hirise%20enhanced%20color', 2, ['JPL']],
  ['mars', 'q=hirise', 6, ['JPL']],
  ['planets', 'q=juno%20perijove', 3, ['JPL']],
  ['planets', 'q=cassini%20natural%20color%20view', 3, ['JPL']],
  ['planets', 'q=saturn%20true%20color', 2, ['JPL']],
  ['planets', 'q=jupiter%20enhanced%20color', 2, ['JPL']],
  ['planets', 'q=sun%20sdo&center=GSFC', 3, ['GSFC']],
  ['planets', 'q=earthrise', 1, ['JPL', 'GSFC', 'JSC', 'HQ']],
  ['planets', 'q=solar%20dynamics%20observatory', 3, ['GSFC']],
  ['planets', 'q=solar%20flare', 2, ['GSFC']],
  ['planets', 'q=comet', 2, ['JPL', 'GSFC']],

  ['earth', 'q=aurora&center=JSC', 4, ['JSC']],
  ['earth', 'q=city%20lights&center=JSC', 3, ['JSC']],
  ['earth', 'q=earth%20observation%20night&center=JSC', 3, ['JSC']],
  ['earth', 'q=earth%20limb&center=JSC', 3, ['JSC']],
  ['earth', 'q=airglow&center=JSC', 2, ['JSC']],
  ['earth', 'q=milky%20way&center=JSC', 2, ['JSC']],
  ['earth', 'q=hurricane%20eye&center=JSC', 2, ['JSC']],
  ['earth', 'q=sunrise%20orbital&center=JSC', 2, ['JSC']],
  ['earth', 'q=earth%20observation%20reef&center=JSC', 1, ['JSC']],
  ['earth', 'q=earth%20observation%20himalayas&center=JSC', 1, ['JSC']],
  ['earth', 'q=earth%20observation%20sahara&center=JSC', 1, ['JSC']],
  ['earth', 'q=earth%20observation%20bahamas&center=JSC', 1, ['JSC']],
  ['sat', 'q=blue%20marble', 2, ['GSFC']],
  ['sat', 'q=landsat&center=GSFC', 3, ['GSFC']],
  ['sat', 'q=phytoplankton%20bloom', 1, ['GSFC']],
  ['sat', 'q=modis&center=GSFC', 2, ['GSFC']],
  ['sat', 'q=earth%20observatory&center=GSFC', 2, ['GSFC']],
  ['earth', 'q=earth%20observation%20sunglint&center=JSC', 1, ['JSC']],
  ['earth', 'q=earth%20observation%20clouds&center=JSC', 2, ['JSC']],
  ['earth', 'q=earth%20observation%20volcano&center=JSC', 1, ['JSC']],
  ['sat', 'q=earth%20at%20night%20suomi', 1, ['GSFC']],
];

const MARS = /\bmars\b|martian|dunes?|crater|canyon|valles|polar/i;
// earth = photographs taken by crews in orbit; sat = satellite views of Earth.
const WANT = { deep: DEEP, planets: PLANETS, mars: MARS, earth: EARTH, sat: EARTH };
const GROUP_CAP = { deep: 190, planets: 90, mars: 40, earth: 100, sat: 50 };

// ---- what to refuse -------------------------------------------------------

// Checked against title + keywords + whole description.
const NOT_REAL = /\ban artist\b|artist depicts|\brepresentation\b|perspective view|3-?D (perspective|view)|artist'?s?['’]?s? (concept|impression|rendering|rendition|illustration|view|depiction)|artist concept|artistic|illustration|concept art|rendering|animated|simulat|visuali[sz]ation|computer[- ]generated|diagram|infographic|schematic|\b(graphs?|charts?|plots?|spectra|spectrogram|histogram|timeline)\b|spectrum (of|shows|reveals|from)|annotated|labell?ed|\blabels\b|poster|logo|insignia|emblem|(mission|crew|embroidered) patch|montage|collage|side[- ]by[- ]side|before[- ]and[- ]after|\binset\b|©|copyright|all rights reserved|creative commons|\bCC[- ]BY/i;

// Multi-panel composites, call-outs and sky maps: recognisable only from the
// way captions describe them. Deliberately strict; checked against the caption.
const COMPOSITE = /postage[- ]stamp|\bthese (two |three |four |\w+ )?(colou?r |natural colou?r )?(images|views|photographs|pictures)|two photographs|\bleft and\b|image (left|right)\b|\bpanels?\b|\b(left|right|top|bottom|upper|lower|middle|center|centre)[- ](panel|image|picture|frame|view|row|column|half|inset)|\((left|right|top|bottom|center|middle|upper|lower)[^)]{0,20}\)|\b(on|at|to) (the )?(far |upper |lower |top |bottom )?(left|right)\b|\b(at|on|in) (the )?(top|bottom)\b|left to right|from left|clockwise|\binsets?\b|zoom(ed|s)?[- ]in|outlin(e|ed|es)\b|circled?\b|circles\b|arrows?\b|\bbox(es|ed)?\b|\bsquares?\b|rectangle|dashed|dotted|cross-?hairs?|scale bar|\bgraphic\b|this figure|\b(two|three|four|five|six|seven|eight|nine|several|these|both) (images|views|pictures|frames|galaxies shown)|images (show|were|are|reveal)|pictures show|\btrio\b|\bquartet of images|\bseries of\b|all[- ]sky|whole sky|entire sky|full[- ]sky|sky map|map of|\bmaps?\b|projection|contours?|overla(y|id|in)|locations? of|position of|\bmarked\b|\bmarks\b|indicated by|pinpoint|\bdata points|\bcurves?\b|light[- ]curve|pixelated|blurry/i;

// For planets and moons, skip instrument products that are not pictures.
const INSTRUMENT = /false[- ]colou?r|ultraviolet|spectromet|\bVIMS\b|\bCIRS\b|\bUVIS\b|\bJIRAM\b|\bJADE\b|\bMWR\b|microwave|radio (science|occultation|wave)|occultation|thermal|temperature|\bradar\b|\bSAR\b|cylindrical|stereographic|map-projected|basemap|elevation|topograph|\bstereo\b|density waves?|\bprofile\b|\bscan\b|magnetic field|magnetosphere|\bplasma\b|\bx-rays?\b|aurora[el]?s?\b|wavelengths? of|methane (band|filter)|clear[- ]filter|unprocessed|\braw\b|black[- ]and[- ]white|monochrome|grayscale|greyscale/i;
const COLOUR = /natural[- ]colou?r|true[- ]colou?r|enhanced[- ]colou?r|colou?r[- ]enhanced|colou?r (view|image|images|mosaic|composite|portrait|picture|photo)|in colou?r\b|colou?rful|red, green,? and blue|approximately (natural|true)|\bcolors\b/i;

// Checked against title + keywords + the first part of the description.
const NOT_WALL = /astronauts?|cosmonauts?|crew ?members?|\bcrew\b|flight engineers?|commander|spacewalk|\beva\b|official portrait|technicians?|students?|employees?|administrator|director|team members?|press|briefing|conference|ceremony|award|visit|tour|workshop|speaks|speaking|talks|panel|audience|clean ?room|laborator|facility|building|hangar|launch|rocket|booster|liftoff|rollout|\bpad\b|test (flight|stand|facility|article|chamber|run|bed)|testing|tested|hardware|mirrors\b|mirror segment|primary mirror|sunshield|antenna|spacecraft (being|arrives|arrived)|assembly|assembled|install|integration|mock-?up|model of|prototype|rover|lander|helicopter|parachute|heat ?shield|selfie|soyuz|dragon|cygnus|progress (resupply|spacecraft|\d)|starliner|shuttle|orbiter (atlantis|discovery|endeavour|columbia|challenger)|canadarm|robotic arm|docked|docking|payload|experiment|interior|cupola|module|airlock|telescope mirror|\bdish\b|deep space network|control room|exhibit|museum|display(ed)? at|sculpture|drawing|painting|sketch|microscope|micrograph|aircraft|airplane|jetliner|balloon|flight test/i;

// Checked against title + keywords only (these words are normal in captions).
const NOT_WALL_HEAD = /scientists?|researchers?|engineers?|instrument|\bevent\b|portrait of (dr|mr|ms|mrs|astronaut)|\bteam\b|spacecraft|telescope|observatory$|comparison|animation|artist/i;

const BAD_TITLE = /\bmaps?\b|mosaic of|global mosaic|topograph|elevation|temperature|ozone|aerosol|concentration|anomal|data|model\b|\bradar\b|mineral|abundance|geologic|context|locator|location of|landing site|trajectory|orbit diagram|\bfig(ure)?\b|\bpart \d|frames?\b|sequence|movie|video|stereo|anaglyph|3-?d\b|black and white|raw image|calibration|noise|test image|first light|engineering/i;

// Reviewed by eye and found unsuitable (multi-panel figures, labelled graphics,
// artist's views, station hardware in shot, near-black frames) even though the
// caption gave no hint. The text filters above still do the bulk of the work.
const REJECT = new Set([
  'GSFC_20171208_Archive_e001297', 'PIA22347', 'PIA26328', 'PIA26322',
  'PIA25794', 'PIA23760', 'PIA23233', 'iss073e0705168',
  'iss073e0251575', 'iss073e0273067', 'iss073e0134504',
  'PIA18928', 'PIA16690', 'PIA18851', 'PIA11970',
  'PIA11969', 'PIA17005', 'PIA10955', 'PIA16214',
  'PIA17996', 'PIA17253', 'PIA13192', 'PIA13318',
  'PIA03542', 'PIA15412', 'PIA12074', 'PIA16839',
  'PIA10227', 'PIA10750', 'PIA10749', 'PIA15659',
  'PIA18912', 'PIA11805', 'GSFC_20171208_Archive_e002157', 'PIA17842',
  'PIA04935', 'GSFC_20171208_Archive_e001417', 'PIA15631', 'PIA14090',
  'PIA12175', 'PIA07911', 'PIA12985', 'PIA22796',
  'PIA24970', 'PIA20292', 'PIA14901', 'GSFC_20171208_Archive_e000761',
  'GSFC_20171208_Archive_e000960', 'GSFC_20171208_Archive_e001131', 'GSFC_20171208_Archive_e002073', 'PIA00708',
  'PIA22867', 'iss043e218074', 'iss074e0814088', 'iss075e0155946',
  'iss074e0351378', 'iss074e0342246', 'iss074e0342635', 'iss074e0149410',
  'iss074e0037338', 'iss073e1047080',
]);

// ---- small helpers --------------------------------------------------------

const log = (...a) => console.error('[nasa]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'user-agent': UA, ...(opts.headers || {}) },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok || res.status === 206) return res;
      // 4xx other than 429 will not improve by retrying.
      if (res.status !== 429 && res.status < 500) {
        await res.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      }
      await res.body?.cancel().catch(() => {});
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
    }
    await sleep(600 * 2 ** i + Math.random() * 300);
  }
  throw lastErr;
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await worker(items[i], i); } catch { out[i] = null; }
    }
  }));
  return out;
}

// Pixel size from the first bytes of a JPEG or PNG; null if not found.
function sizeFromHeader(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), gray: buf[25] === 0 || buf[25] === 4 };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const m = buf[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m >= 0xd0 && m <= 0xd9) { p += 2; continue; }
    const len = buf.readUInt16BE(p + 2);
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7), gray: buf[p + 9] === 1 };
    }
    p += 2 + len;
  }
  return null;
}

// Reads just enough of an image to learn its real dimensions and byte size.
async function probe(url) {
  for (const span of [65535, 1048575]) {
    const res = await request(url, { headers: { range: `bytes=0-${span}` } });
    const type = res.headers.get('content-type') || '';
    const total = Number((res.headers.get('content-range') || '').split('/')[1])
      || Number(res.headers.get('content-length')) || 0;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!/^image\//.test(type)) return null;
    const dim = sizeFromHeader(buf);
    if (dim) return { ...dim, bytes: total, type };
    if (buf.length <= span) break; // whole file read already
  }
  return null;
}

const clean = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const httpsUrl = (u) => encodeURI(decodeURI(String(u).replace(/^http:/, 'https:')));
const ext = (u) => (String(u).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

function centerName(center) {
  if (!center) return 'NASA';
  if (/^STScI/.test(center)) return 'NASA/STScI';
  return `NASA/${center}`;
}

function credit(d) {
  const sc = clean(d.secondary_creator);
  // Use NASA's own compact credit line when it is one ("NASA/JPL-Caltech/UCLA").
  if (/^NASA\b/.test(sc) && sc.length <= 44 && !/[:;]|et al/i.test(sc)) {
    const parts = sc.split(/\s*[\/,]\s*|\s+(?=ESA\b|CSA\b|STScI\b)/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts.join('/');
  }
  return centerName(d.center);
}

function year(d) {
  // The GSFC Flickr archive was bulk-loaded in 2017; its date_created is the
  // upload date, so look for the real release date in the caption instead.
  if (/^GSFC_2017\d+_Archive/.test(d.nasa_id)) {
    const m = String(d.description || '').slice(0, 400).match(/(?:release|taken|acquired|image)[^.\n]{0,30}?\b((?:19|20)\d\d)\b/i);
    return m ? m[1] : '';
  }
  const y = String(d.date_created || '').slice(0, 4);
  return /^(19|20)\d\d$/.test(y) ? y : '';
}

function title(d) {
  let t = clean(d.title);
  const idLike = !t || t.toLowerCase() === String(d.nasa_id).toLowerCase() || /^[A-Za-z]{0,6}[-_]?\d[\w-]*$/.test(t);
  if (idLike) {
    if (!/^iss\d+e\d+$/i.test(d.nasa_id)) return '';
    // Fall back to the first sentence of the caption for ISS frames.
    const first = clean(d.description).split(/(?<=[a-z)])\.\s/)[0];
    t = first && first.length <= 90 && !/^iss\d/i.test(first) ? first : 'Earth from the International Space Station';
  }
  t = t.replace(/\s*\((archive|nasa)[^)]*\)\s*$/i, '').replace(/^[A-Z]{2,5}[- ]?\d{2,}[A-Z]?\s*[-:]\s*/, '');
  return t.length > 110 ? `${t.slice(0, 107).replace(/\s+\S*$/, '')}…` : t;
}

// ---- pipeline -------------------------------------------------------------

function consider(item, group, centers) {
  const d = item.data?.[0];
  if (!d || d.media_type !== 'image' || !d.nasa_id || REJECT.has(d.nasa_id)) return null;
  const center = String(d.center || '');
  if (!centers.some((c) => center === c || center.startsWith(`${c} `))) return null;
  // JPL: only the Photojournal catalogue (PIAxxxxx). JSC: only frames shot
  // from orbit. GSFC: nothing with a staff photographer credit.
  if (center === 'JPL' && !/^PIA\d+$/.test(d.nasa_id)) return null;
  if (center === 'JSC' && !/^(iss\d{3}e\d+|sts\d{3}-?[\w-]+|s\d{2,3}e\d+|as\d{2}-\d+-\d+)$/i.test(d.nasa_id)) return null;
  if (center === 'GSFC' && d.photographer) return null;
  // Station frames shot by partner-agency crew are credited to that agency.
  if (/credit:\s*(esa|jaxa|csa|roscosmos|asi|dlr|cnes)\b/i.test(String(d.description || ''))) return null;

  const kw = (d.keywords || []).join('; ');
  const desc = clean(d.description);
  const head = `${d.title || ''} | ${kw}`;
  if (!WANT[group].test(head)) return null;
  if (NOT_REAL.test(`${head} | ${desc}`)) return null;
  if (NOT_WALL.test(`${head} | ${desc.slice(0, 500)}`)) return null;
  if (NOT_WALL_HEAD.test(d.title || '')) return null;
  if (BAD_TITLE.test(d.title || '')) return null;
  if (group !== 'earth' && COMPOSITE.test(`${d.title || ''} | ${desc}`)) return null;
  if (group === 'planets' || group === 'mars') {
    if (INSTRUMENT.test(`${head} | ${desc}`)) return null;
    // Photojournal frames are mostly greyscale; keep the ones said to be colour.
    if (center === 'JPL' && !/junocam|hirise/i.test(`${head} | ${desc}`) && !COLOUR.test(`${head} | ${desc}`)) return null;
  }

  const links = (item.links || []).filter((l) => l.render === 'image' && l.href);
  const pick = (tag) => links.find((l) => l.href.includes(`~${tag}.`));
  const orig = pick('orig');
  if (!orig) return null;
  const t = title(d);
  if (!t) return null;
  // A small rendition for build-time scoring (640px "~small", else "~thumb").
  const small = pick('small') || pick('thumb');
  if (!small) return null;
  return { d, group, orig, large: pick('large'), medium: pick('medium'), thumb: httpsUrl(small.href), title: t };
}

// Decides which rendition the TV should load. Returns null to reject.
async function resolve(c) {
  const origUrl = httpsUrl(c.orig.href);
  const origExt = ext(origUrl);
  let o = c.orig.width && c.orig.height
    ? { w: c.orig.width, h: c.orig.height, bytes: c.orig.size || 0, verified: false }
    : null;
  if (!o) {
    if (origExt !== 'jpg' && origExt !== 'jpeg' && origExt !== 'png') return null;
    const p = await probe(origUrl);
    if (!p) return null;
    o = { ...p, verified: true };
  }
  const ratio = o.w / o.h;
  if (o.w < MIN_W || ratio < MIN_RATIO || ratio > MAX_RATIO) return null;

  const largeUrl = c.large ? httpsUrl(c.large.href) : '';
  const mediumUrl = c.medium ? httpsUrl(c.medium.href) : '';
  const origOk = (origExt === 'jpg' || origExt === 'jpeg') && o.w <= MAX_W && o.bytes > 0 && o.bytes <= MAX_BYTES;

  const tryOrig = async () => {
    const p = o.verified ? o : await probe(origUrl);
    if (!p || p.gray || p.w < MIN_W || p.w > MAX_W || p.bytes > MAX_BYTES) return null;
    if (!/jpeg/.test(p.type || 'image/jpeg')) return null;
    const r = p.w / p.h;
    if (r < MIN_RATIO || r > MAX_RATIO) return null;
    return { src: [origUrl, largeUrl || mediumUrl].filter(Boolean), w: p.w, h: p.h, bytes: p.bytes };
  };
  const tryLarge = async () => {
    if (!largeUrl) return null;
    const p = await probe(largeUrl);
    // "~large" is 1920 on the long edge; allow a few pixels of rounding.
    if (!p || p.gray || p.w < MIN_W - 20 || !/jpeg/.test(p.type)) return null;
    const r = p.w / p.h;
    if (r < MIN_RATIO || r > MAX_RATIO) return null;
    return { src: [largeUrl, mediumUrl].filter(Boolean), w: p.w, h: p.h, bytes: p.bytes };
  };

  const got = (origOk ? await tryOrig().catch(() => null) : null) || await tryLarge().catch(() => null);
  if (!got) return null;
  return { ...c, ...got, origW: o.w };
}

export default async function fetchWorks() {
  const started = Date.now();

  // 1. Search.
  const jobs = [];
  for (const [group, q, pages, centers] of QUERIES) {
    for (let page = 1; page <= pages; page++) jobs.push({ group, q, page, centers });
  }
  const seen = new Map();
  const dead = new Set(); // queries that ran out of pages
  let failed = 0;
  await pool(jobs, SEARCH_CONCURRENCY, async (job) => {
    if (dead.has(job.q)) return;
    let items;
    try {
      const res = await request(`${API}?${job.q}&media_type=image&page_size=100&page=${job.page}`);
      items = (await res.json())?.collection?.items || [];
    } catch (e) {
      failed++;
      log(`search failed, skipping: ${job.q} page ${job.page} (${e.message})`);
      return;
    }
    if (items.length < 100) dead.add(job.q);
    for (const it of items) {
      const nid = it.data?.[0]?.nasa_id;
      if (!nid || seen.has(nid)) continue;
      const c = consider(it, job.group, job.centers);
      if (c) seen.set(nid, c);
    }
  });
  const candidates = [...seen.values()];
  log(`${jobs.length} searches (${failed} failed), ${candidates.length} candidates after text filters`);

  // 2. Rank so the caps keep the best: big, directly usable originals first.
  const score = (c) => {
    const w = c.orig.width || 0;
    let s = 0;
    if (w >= 3000 && w <= MAX_W) s += 3; else if (w >= 2400) s += 2; else if (!w) s += 1;
    // Nearer 16:9 is better (up to one point), when the size is known.
    if (w && c.orig.height) s += 1 - Math.min(1, Math.abs(w / c.orig.height - IDEAL_RATIO) / 0.45);
    if (c.d.center !== 'JSC' && /hubble|webb|spitzer|chandra|juno|cassini|new horizons|voyager/i.test(`${c.d.title} ${(c.d.keywords || []).join(' ')}`)) s += 1;
    return s;
  };
  candidates.sort((a, b) => score(b) - score(a) || String(b.d.date_created).localeCompare(String(a.d.date_created)) || a.d.nasa_id.localeCompare(b.d.nasa_id));

  // 3. De-duplicate on title, then resolve renditions group by group until
  //    each group's cap is met (so we do not probe more than we need).
  const titleCount = new Map();
  const queue = { deep: [], planets: [], mars: [], earth: [], sat: [] };
  for (const c of candidates) {
    const key = c.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const n = titleCount.get(key) || 0;
    if (n >= (c.d.center === 'JSC' ? 2 : 1)) continue;
    titleCount.set(key, n + 1);
    queue[c.group].push(c);
  }

  const works = [];
  for (const group of Object.keys(queue)) {
    const cap = Math.min(GROUP_CAP[group], TARGET - works.length);
    const picked = [];
    const list = queue[group];
    for (let at = 0; at < list.length && picked.length < cap; at += PROBE_CONCURRENCY * 4) {
      const batch = list.slice(at, at + PROBE_CONCURRENCY * 4);
      const done = await pool(batch, PROBE_CONCURRENCY, resolve);
      for (const r of done) if (r && picked.length < cap) picked.push(r);
    }
    log(`${group}: ${picked.length} of ${list.length} candidates kept`);
    for (const r of picked) {
      const sub = [credit(r.d), year(r.d)].filter(Boolean).join(', ');
      works.push({ src: r.src, thumb: r.thumb, title: r.title, sub, cats: ['space'], ar: Math.round((r.w / r.h) * 100) / 100 });
    }
  }

  log(`${works.length} works in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return works;
}
