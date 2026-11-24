// The owner's own pictures, handled entirely on the TV.
//
// While freeSaver is open, this runs a small web server on the home network.
// The TV shows a QR code pointing at it; the owner's phone opens that page
// (phone.html) and can
//   - send photos, which are stored on the TV, and
//   - link shared albums (albums.js reads them),
// and the app asks this same server what to show. Nothing goes through a
// computer or a cloud service of ours.
//
// Phone-facing addresses all sit under /k/<token>/, where the token is a
// random string carried by the QR code. The app-facing ones answer only to
// the TV itself. Runs on the TV's Node 16 with no packages.
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var childProcess = require('child_process');

var albumsLib = null;
try { albumsLib = require('./albums'); } catch (e) { /* shared albums not in this build */ }

var PORT = 8377;
var MAX_PHOTOS = 500;
var MAX_PHOTO_BYTES = 25 * 1024 * 1024;
var MAX_THUMB_BYTES = 1024 * 1024;
var MIN_FREE_BYTES = 300 * 1024 * 1024;   // always leave the TV this much room
var DEFAULT_ALBUM_REFRESH = 6 * 3600000;

// Storage that survives app updates where possible.
var ROOT = (function () {
  var candidates = ['/media/internal/freesaver', path.join(__dirname, 'data')];
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (!fs.existsSync(candidates[i])) fs.mkdirSync(candidates[i]);
      fs.writeFileSync(path.join(candidates[i], '.w'), '');
      fs.unlinkSync(path.join(candidates[i], '.w'));
      return candidates[i];
    } catch (e) { /* try the next */ }
  }
  return os.tmpdir();
})();
var PHOTO_DIR = path.join(ROOT, 'photos');
var THUMB_DIR = path.join(ROOT, 'thumbs');
var STATE_FILE = path.join(ROOT, 'state.json');
var ALBUM_FILE = path.join(ROOT, 'albums.json');
[PHOTO_DIR, THUMB_DIR].forEach(function (d) { try { if (!fs.existsSync(d)) fs.mkdirSync(d); } catch (e) { /* reported on use */ } });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, value) {
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(value));
    fs.renameSync(file + '.tmp', file);
  } catch (e) { /* storage full or gone; nothing more to do */ }
}

// state: { token, photos: { id: {w, h, bytes, added} }, albums: [ {id, url, kind, title, count, error, checked} ] }
var state = readJson(STATE_FILE, {});
state.photos = state.photos || {};
state.albums = state.albums || [];
if (!state.token) state.token = newToken();
var albumPhotos = readJson(ALBUM_FILE, {}); // { albumId: [ {id, src, thumb, width, height, taken} ] }
saveState();

function newToken() {
  var alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes
  var bytes = crypto.randomBytes(10);
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
function saveState() { writeJson(STATE_FILE, state); }

function freeBytes() {
  try {
    var line = String(childProcess.execSync('df -k ' + JSON.stringify(ROOT) + ' 2>/dev/null | tail -1')).trim().split(/\s+/);
    var kb = Number(line[3]);
    return isFinite(kb) ? kb * 1024 : null;
  } catch (e) { return null; }
}

function addresses() {
  var found = [];
  var nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) found.push(a.address);
    });
  });
  return found;
}

function photoIds() {
  return Object.keys(state.photos).sort(function (a, b) { return state.photos[b].added - state.photos[a].added; });
}

// ---------- what the app shows ----------

function listing() {
  var photos = [];
  photoIds().forEach(function (id) {
    var p = state.photos[id];
    photos.push({ key: 'u:' + id, src: '/p/' + id + '.jpg', title: '', ar: p.w && p.h ? Math.round(p.w / p.h * 100) / 100 : null, mtime: p.added });
  });
  state.albums.forEach(function (album) {
    (albumPhotos[album.id] || []).forEach(function (p) {
      photos.push({
        key: 'a:' + album.id + ':' + p.id, src: p.src, title: '',
        ar: p.width && p.height ? Math.round(p.width / p.height * 100) / 100 : null, mtime: p.taken || null
      });
    });
  });
  var hash = crypto.createHash('sha1');
  photos.forEach(function (p) { hash.update(p.key + '\n'); });
  return { photos: photos, version: hash.digest('hex').slice(0, 12) };
}

// ---------- shared albums ----------

var resolving = {};

function refreshAlbum(album, done) {
  if (!albumsLib) { if (done) done(new Error('Shared albums are not available in this build')); return; }
  if (resolving[album.id]) { if (done) done(null, album); return; }
  resolving[album.id] = true;
  albumsLib.resolve(album.url, function (err, result) {
    delete resolving[album.id];
    album.checked = Date.now();
    if (err) {
      album.error = String(err.message || err).slice(0, 200);
      // Keep showing what we had: one failed check should not empty the frame.
    } else {
      album.error = null;
      album.kind = result.kind || album.kind;
      album.title = result.title || album.title || '';
      album.count = result.photos.length;
      albumPhotos[album.id] = result.photos;
      writeJson(ALBUM_FILE, albumPhotos);
    }
    saveState();
    if (done) done(err, album);
  });
}

function refreshInterval(album) {
  var per = albumsLib && albumsLib.EXPIRES && albumsLib.EXPIRES[album.kind];
  return per > 0 ? per : DEFAULT_ALBUM_REFRESH;
}

function refreshStaleAlbums() {
  state.albums.forEach(function (album) {
    if (Date.now() - (album.checked || 0) > refreshInterval(album) * 0.8) refreshAlbum(album);
  });
}

// ---------- http plumbing ----------

function send(res, code, body, headers) {
  var data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  var h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
  h['Content-Length'] = Buffer.byteLength(data);
  res.writeHead(code, h);
  res.end(data);
}

function sendFile(req, res, file, type) {
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { send(res, 404, { error: 'Not found' }); return; }
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': st.size, 'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', function () { res.destroy(); }).pipe(res);
  });
}

function readBody(req, limit, done) {
  var chunks = [];
  var size = 0;
  var over = false;
  req.on('data', function (c) {
    if (over) return;
    size += c.length;
    if (size > limit) { over = true; chunks = []; done({ code: 413, message: 'That file is too large' }); req.resume(); return; }
    chunks.push(c);
  });
  req.on('end', function () { if (!over) done(null, Buffer.concat(chunks)); });
  req.on('error', function () { if (!over) { over = true; done({ code: 400, message: 'Upload was interrupted' }); } });
}

function isLoopback(req) {
  var a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function isJpeg(buf) { return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff; }
var ID = /^[a-f0-9]{12}$/;

// ---------- the phone's page ----------

function phoneState() {
  return {
    tv: 'your TV',
    freeBytes: freeBytes(),
    limitPhotos: MAX_PHOTOS,
    photos: photoIds().map(function (id) {
      var p = state.photos[id];
      return { id: id, thumb: './thumb/' + id + '.jpg', width: p.w, height: p.h, bytes: p.bytes, added: p.added };
    }),
    albums: state.albums.map(function (a) {
      return { id: a.id, kind: a.kind, title: a.title || '', url: a.url, count: a.count || 0, error: a.error || null, checked: a.checked || null };
    })
  };
}

function handlePhone(req, res, rest) {
  var method = req.method;
  var m;

  if ((rest === '' || rest === 'index.html') && (method === 'GET' || method === 'HEAD')) {
    fs.readFile(path.join(__dirname, 'phone.html'), function (err, html) {
      if (err) { send(res, 500, 'The phone page is missing from this build.', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
      send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    });
    return;
  }
  if (rest === 'state' && method === 'GET') { send(res, 200, phoneState()); return; }

  if (rest === 'upload' && method === 'POST') {
    if (Object.keys(state.photos).length >= MAX_PHOTOS) { send(res, 413, { error: 'The TV already holds ' + MAX_PHOTOS + ' photos. Delete some first.' }); return; }
    var free = freeBytes();
    if (free !== null && free < MIN_FREE_BYTES) { send(res, 507, { error: 'The TV is out of space' }); return; }
    readBody(req, MAX_PHOTO_BYTES, function (err, buf) {
      if (err) { send(res, err.code, { error: err.message }); return; }
      if (!isJpeg(buf)) { send(res, 415, { error: 'Only JPEG pictures can be stored' }); return; }
      var id = crypto.randomBytes(6).toString('hex');
      fs.writeFile(path.join(PHOTO_DIR, id + '.jpg'), buf, function (werr) {
        if (werr) { send(res, 507, { error: 'The TV could not save the photo' }); return; }
        state.photos[id] = {
          w: Math.max(0, parseInt(req.headers['x-width'], 10) || 0),
          h: Math.max(0, parseInt(req.headers['x-height'], 10) || 0),
          bytes: buf.length, added: Date.now()
        };
        saveState();
        send(res, 200, { id: id });
      });
    });
    return;
  }

  m = /^thumb\/([a-f0-9]{12})(\.jpg)?$/.exec(rest);
  if (m && method === 'POST') {
    if (!state.photos[m[1]]) { send(res, 404, { error: 'No such photo' }); return; }
    readBody(req, MAX_THUMB_BYTES, function (err, buf) {
      if (err) { send(res, err.code, { error: err.message }); return; }
      if (!isJpeg(buf)) { send(res, 415, { error: 'Only JPEG' }); return; }
      fs.writeFile(path.join(THUMB_DIR, m[1] + '.jpg'), buf, function () { send(res, 200, {}); });
    });
    return;
  }
  if (m && (method === 'GET' || method === 'HEAD')) {
    var thumb = path.join(THUMB_DIR, m[1] + '.jpg');
    sendFile(req, res, fs.existsSync(thumb) ? thumb : path.join(PHOTO_DIR, m[1] + '.jpg'), 'image/jpeg');
    return;
  }

  m = /^photo\/([a-f0-9]{12})$/.exec(rest);
  if (m && method === 'DELETE') {
    delete state.photos[m[1]];
    saveState();
    [path.join(PHOTO_DIR, m[1] + '.jpg'), path.join(THUMB_DIR, m[1] + '.jpg')].forEach(function (f) { fs.unlink(f, function () {}); });
    send(res, 200, {});
    return;
  }

  if (rest === 'albums' && method === 'POST') {
    readBody(req, 8192, function (err, buf) {
      var url = '';
      try { url = String(JSON.parse(String(buf || '{}')).url || '').trim(); } catch (e) { /* handled below */ }
      if (err || !url) { send(res, 400, { error: 'Paste a shared album link first' }); return; }
      if (!albumsLib) { send(res, 400, { error: 'Shared albums are not available in this build' }); return; }
      var kind = albumsLib.kindOf(url);
      if (!kind) { send(res, 400, { error: 'That link is not a shared album freeSaver can read' }); return; }
      if (state.albums.some(function (a) { return a.url === url; })) { send(res, 400, { error: 'That album is already linked' }); return; }
      if (state.albums.length >= 20) { send(res, 400, { error: 'Twenty albums is the limit' }); return; }
      var album = { id: crypto.randomBytes(4).toString('hex'), url: url, kind: kind, title: '', count: 0, error: null, checked: 0 };
      albumsLib.resolve(url, function (rerr, result) {
        if (rerr) { send(res, 400, { error: String(rerr.message || rerr).slice(0, 200) }); return; }
        album.title = result.title || '';
        album.count = result.photos.length;
        album.checked = Date.now();
        albumPhotos[album.id] = result.photos;
        state.albums.push(album);
        saveState();
        writeJson(ALBUM_FILE, albumPhotos);
        send(res, 200, { id: album.id, kind: album.kind, title: album.title, count: album.count });
      });
    });
    return;
  }

  m = /^albums\/([a-f0-9]{8})(\/refresh)?$/.exec(rest);
  if (m) {
    var album = state.albums.filter(function (a) { return a.id === m[1]; })[0];
    if (!album) { send(res, 404, { error: 'No such album' }); return; }
    if (!m[2] && method === 'DELETE') {
      state.albums = state.albums.filter(function (a) { return a.id !== m[1]; });
      delete albumPhotos[m[1]];
      saveState();
      writeJson(ALBUM_FILE, albumPhotos);
      send(res, 200, {});
      return;
    }
    if (m[2] && method === 'POST') {
      refreshAlbum(album, function (err) {
        if (err) send(res, 400, { error: String(err.message || err).slice(0, 200) });
        else send(res, 200, { count: album.count });
      });
      return;
    }
  }

  send(res, 404, { error: 'Not found' });
}

// ---------- the server ----------

var server = null;
var albumTimer = null;

function handle(req, res) {
  var url = String(req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, HEAD, OPTIONS', 'Access-Control-Allow-Headers': '*' });
    res.end();
    return;
  }

  var k = /^\/k\/([A-Za-z0-9]+)(?:\/(.*))?$/.exec(url);
  if (k) {
    // Same length compare, then constant-time, so the token cannot be guessed a character at a time.
    var given = Buffer.from(k[1]);
    var real = Buffer.from(state.token);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) { send(res, 404, { error: 'This link is no longer valid. Scan the code on the TV again.' }); return; }
    if (k[2] === undefined) { res.writeHead(302, { Location: '/k/' + state.token + '/' }); res.end(); return; }
    handlePhone(req, res, k[2]);
    return;
  }

  // Everything else is for the app on this TV only.
  if (!isLoopback(req)) { send(res, 404, { error: 'Not found' }); return; }
  if (url === '/photos.json') { refreshStaleAlbums(); send(res, 200, listing()); return; }
  if (url === '/health') { send(res, 200, { ok: true, name: 'freeSaver photos', count: listing().photos.length }); return; }
  var p = /^\/p\/([a-f0-9]{12})\.jpg$/.exec(url);
  if (p && ID.test(p[1])) { sendFile(req, res, path.join(PHOTO_DIR, p[1] + '.jpg'), 'image/jpeg'); return; }
  send(res, 404, { error: 'Not found' });
}

// Starts the server if it is not running; calls back with how to reach it.
exports.start = function (done) {
  var info = function () {
    return {
      port: PORT, token: state.token, storage: ROOT,
      urls: addresses().map(function (a) { return 'http://' + a + ':' + PORT + '/k/' + state.token + '/'; }),
      count: listing().photos.length, albums: !!albumsLib
    };
  };
  if (server) { done(null, info()); return; }
  var s = http.createServer(function (req, res) {
    try { handle(req, res); } catch (e) { try { send(res, 500, { error: 'Something went wrong on the TV' }); } catch (e2) { /* connection gone */ } }
  });
  s.on('error', function (e) { server = null; done(e); });
  s.listen(PORT, '0.0.0.0', function () {
    server = s;
    refreshStaleAlbums();
    albumTimer = setInterval(refreshStaleAlbums, 10 * 60000);
    done(null, info());
  });
};

exports.stop = function () {
  if (albumTimer) clearInterval(albumTimer);
  albumTimer = null;
  if (server) server.close();
  server = null;
};

// A new token: every link and QR code handed out before stops working.
exports.resetToken = function () { state.token = newToken(); saveState(); };
