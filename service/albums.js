'use strict';
/*
 * albums.js - resolve a shared-album link (pasted on a phone) into a list of photos.
 *
 * Runs inside the freeSaver background service on the TV (Node.js 16, no npm packages,
 * core modules only). Supported providers:
 *
 *   immich  Self-hosted Immich share links  (https://host/share/<key> or https://host/s/<slug>)
 *           Uses Immich's public API with the share key only. Plain http:// servers are
 *           allowed (many home servers have no TLS); certificate checking is never disabled,
 *           so a self-signed https server is reported as an error instead.
 *           Password-protected share links are NOT supported.
 *   google  Google Photos shared albums     (https://photos.app.goo.gl/<code>,
 *           https://photos.google.com/share/<id>?key=<key>)
 *           UNOFFICIAL: there is no public API for this. We fetch the album's public HTML
 *           page and read the data Google embeds in it (AF_initDataCallback blocks that
 *           hold the lh3.googleusercontent.com/pw/... base URLs plus width/height/time).
 *           That format is undocumented and can change without notice, which would break
 *           this path. The page only embeds the first page of the album (300 items as
 *           observed); the rest is fetched by Google's own web client through a private
 *           RPC which is deliberately not used here, so larger albums are truncated.
 *   icloud  iCloud Shared Albums with "Public Website" (https://www.icloud.com/sharedalbum/#<token>)
 *           Also unofficial: uses the JSON endpoints the public website itself uses
 *           (sharedstreams webstream + webasseturls). Image URLs are signed and expire.
 *
 * API:
 *   kindOf(url)            -> 'immich' | 'google' | 'icloud' | null   (no network)
 *   resolve(url, cb)       -> cb(err) or cb(null, { kind, title, photos: [...] })
 *   EXPIRES                -> how long (ms) resolved image URLs stay valid; 0 = no expiry.
 *                             Re-resolve before this elapses.
 *
 * photo = { id, src, thumb, width, height, taken }  (width/height/taken are number|null)
 * Only still pictures that a TV browser can decode (JPEG/WebP/PNG) are returned; videos are
 * dropped. At most MAX_PHOTOS (2000) photos are returned. Order: Immich newest first,
 * Google in the album's own order, iCloud newest first.
 *
 * Errors are Error objects with a short user-facing message (suitable for a phone screen).
 */

var https = require('https');
var http = require('http');
var urlLib = require('url');
var zlib = require('zlib');

var MAX_PHOTOS = 2000;
var TIMEOUT_MS = 15000;
var MAX_BYTES = 20 * 1024 * 1024;
var MAX_REDIRECTS = 5;

// Conservative refresh intervals for resolved URLs (ms). 0 = never expires.
//  icloud: signed asset URLs last roughly 1-2 hours, refresh well before.
//  google: lh3 /pw/ base URLs have stayed valid as long as the album stays shared, but they
//          are not documented as permanent, so refresh a few times a day (a re-resolve is a
//          single page fetch).
//  immich: share-key URLs are stable until the link is revoked or expires.
exports.EXPIRES = { icloud: 45 * 60 * 1000, google: 6 * 60 * 60 * 1000, immich: 0 };

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------------------
// errors

function fail(message, code) {
  var e = new Error(message);
  if (code) e.code = code;
  return e;
}

var CERT_CODES = {
  DEPTH_ZERO_SELF_SIGNED_CERT: 1, SELF_SIGNED_CERT_IN_CHAIN: 1, UNABLE_TO_VERIFY_LEAF_SIGNATURE: 1,
  UNABLE_TO_GET_ISSUER_CERT: 1, UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 1, CERT_HAS_EXPIRED: 1,
  CERT_NOT_YET_VALID: 1, ERR_TLS_CERT_ALTNAME_INVALID: 1
};

// ---------------------------------------------------------------------------------------
// HTTP helper
//   opts: { url, method, headers, json (object, POSTed as JSON), body (string), noRedirect,
//           timeout, maxBytes }
//   cb(err, { status, headers, body (Buffer), url (final URL) })
// err.code: TIMEOUT | TOOBIG | CERT | DNS | REFUSED | NET | REDIRECTS | BADURL

function request(opts, cb) {
  var done = false;
  function finish(err, res) {
    if (done) return;
    done = true;
    cb(err, res);
  }
  var redirects = 0;

  function go(urlStr, method, body) {
    var u;
    try { u = urlLib.parse(urlStr); } catch (e) { return finish(fail('That link is not valid', 'BADURL')); }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) {
      return finish(fail('That link is not valid', 'BADURL'));
    }
    var lib = u.protocol === 'https:' ? https : http;
    var headers = { 'Accept-Encoding': 'gzip, deflate, br' };
    var k;
    for (k in (opts.headers || {})) headers[k] = opts.headers[k];
    var payload = null;
    if (body != null) {
      payload = Buffer.from(body, 'utf8');
      headers['Content-Length'] = payload.length;
    }
    var timedOut = false;
    var req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.path, method: method, headers: headers
    }, function (res) {
      var status = res.statusCode;
      var loc = res.headers.location;
      if (!opts.noRedirect && loc && (status === 301 || status === 302 || status === 303 || status === 307 || status === 308)) {
        res.resume();
        if (++redirects > MAX_REDIRECTS) return finish(fail('The link redirects too many times', 'REDIRECTS'));
        var next = urlLib.resolve(urlStr, loc);
        if (status === 307 || status === 308) return go(next, method, body);
        return go(next, 'GET', null);
      }
      var stream = res;
      var enc = String(res.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      } catch (e) { return finish(fail('Could not read the reply', 'NET')); }
      var chunks = [];
      var size = 0;
      var max = opts.maxBytes || MAX_BYTES;
      stream.on('data', function (c) {
        size += c.length;
        if (size > max) {
          req.destroy();
          return finish(fail('The album page is too large', 'TOOBIG'));
        }
        chunks.push(c);
      });
      stream.on('end', function () {
        finish(null, { status: status, headers: res.headers, body: Buffer.concat(chunks), url: urlStr });
      });
      stream.on('error', function () { finish(fail('Could not read the reply', 'NET')); });
      res.on('error', function () { finish(fail('Could not read the reply', 'NET')); });
    });
    req.setTimeout(opts.timeout || TIMEOUT_MS, function () {
      timedOut = true;
      req.destroy();
      finish(fail('Could not reach the album (timed out)', 'TIMEOUT'));
    });
    req.on('error', function (e) {
      if (timedOut || done) return;
      var c = e && e.code;
      if (c && CERT_CODES[c]) {
        return finish(fail('The server\'s security certificate is not trusted (for example self-signed). ' +
          'Use a trusted certificate, or an http:// address on your home network', 'CERT'));
      }
      if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return finish(fail('Could not find that server (check the address)', 'DNS'));
      if (c === 'ECONNREFUSED') return finish(fail('The server refused the connection', 'REFUSED'));
      if (c === 'ETIMEDOUT' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return finish(fail('Could not reach the album (timed out)', 'TIMEOUT'));
      if (c === 'ECONNRESET') return finish(fail('The connection was interrupted', 'NET'));
      finish(fail('Could not reach the album', 'NET'));
    });
    if (payload) req.write(payload);
    req.end();
  }

  var method = opts.method || (opts.json !== undefined || opts.body != null ? 'POST' : 'GET');
  var body = opts.body != null ? opts.body : null;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    opts.headers = opts.headers || {};
    if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  }
  go(opts.url, method, body);
}

function parseJson(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return undefined; }
}

// run fn(item, done) over items with limited concurrency; cb(err, results[])
function mapLimit(items, limit, fn, cb) {
  var results = new Array(items.length);
  var next = 0, running = 0, finished = false, completed = 0;
  if (!items.length) return cb(null, results);
  function launch() {
    while (!finished && running < limit && next < items.length) {
      (function (i) {
        running++;
        fn(items[i], function (err, r) {
          running--;
          if (finished) return;
          if (err) { finished = true; return cb(err); }
          results[i] = r;
          completed++;
          if (completed === items.length) { finished = true; return cb(null, results); }
          launch();
        });
      })(next++);
    }
  }
  launch();
}

// newest first; items without a date keep their relative position (stable)
function sortNewestFirst(list, getTaken) {
  var idx = list.map(function (it, i) { return { it: it, i: i }; });
  idx.sort(function (a, b) {
    var ta = getTaken(a.it), tb = getTaken(b.it);
    if (ta == null || tb == null) return a.i - b.i;
    return tb - ta || a.i - b.i;
  });
  return idx.map(function (x) { return x.it; });
}

function parseTime(s) {
  if (typeof s !== 'string' || !s) return null;
  // Immich timeline timestamps have no zone suffix (they are UTC)
  var t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z');
  return isNaN(t) ? null : t;
}

// ---------------------------------------------------------------------------------------
// link classification

function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  var s = input.trim();
  if (!s || s.length > 2000 || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\//i.test(s)) s = 'https://' + s;   // "photos.app.goo.gl/abc"
    else return null;
  }
  var u;
  try { u = urlLib.parse(s); } catch (e) { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return null;
  return u;
}

function classify(u) {
  var host = u.hostname.toLowerCase();
  var path = u.pathname || '/';
  var hash = u.hash || '';

  if (host === 'photos.app.goo.gl') return /^\/[A-Za-z0-9_-]{6,}\/?$/.test(path) ? { kind: 'google' } : null;
  if (host === 'photos.google.com') {
    return /^\/(u\/\d+\/)?share\/[A-Za-z0-9_-]{10,}/.test(path) ? { kind: 'google' } : null;
  }
  if (host === 'goo.gl' || host === 'www.goo.gl') return /^\/photos\/[A-Za-z0-9_-]+/.test(path) ? { kind: 'google' } : null;

  if (host === 'www.icloud.com' || host === 'icloud.com') {
    if (/^\/sharedalbum(\/|$)/i.test(path)) {
      var m = /^#?([A-Za-z0-9]{8,})/.exec(hash) || /^\/sharedalbum\/([A-Za-z0-9]{8,})/i.exec(path);
      return { kind: 'icloud', token: m ? m[1] : null };
    }
    return null;
  }
  // share.icloud.com/photos/... and photos.icloud.com/shared/album/... are other (newer or
  // non-public) iCloud link types that this module cannot read: recognised, then rejected.
  if (host === 'share.icloud.com' || host === 'photos.icloud.com') {
    return { kind: 'icloud', unsupported: true };
  }
  if (/(^|\.)(google|googleusercontent|goo\.gl|icloud|apple)\.com$/.test(host)) return null;

  var im = /^\/share\/([A-Za-z0-9_-]{8,})\/?$/.exec(path);
  if (im) return { kind: 'immich', key: im[1], slug: null };
  var sm = /^\/s\/([^\/]{1,200})\/?$/.exec(path);
  if (sm) {
    var slug;
    try { slug = decodeURIComponent(sm[1]); } catch (e) { return null; }
    return { kind: 'immich', key: null, slug: slug };
  }
  return null;
}

exports.kindOf = function (url) {
  try {
    var u = normalizeUrl(url);
    if (!u) return null;
    var c = classify(u);
    return c ? c.kind : null;
  } catch (e) {
    return null;
  }
};

// ---------------------------------------------------------------------------------------
// Immich

var PASSWORD_MSG = 'This link is password protected, which is not supported. Create a share link without a password';
var GONE_MSG = 'The album is private or the link has expired';

function immichResolve(u, c, cb) {
  var base = u.protocol + '//' + u.host;
  var auth = c.key ? 'key=' + encodeURIComponent(c.key) : 'slug=' + encodeURIComponent(c.slug);
  var jsonHeaders = { 'Accept': 'application/json', 'User-Agent': BROWSER_UA };

  function api(path, extra, done) {
    request({ url: base + '/api' + path + '?' + auth + (extra ? '&' + extra : ''), headers: jsonHeaders }, done);
  }

  // Turns a non-200 reply into a user-facing error, or null when it is OK.
  function httpError(res) {
    if (res.status === 200) return null;
    var json = parseJson(res.body);
    var msg = json && typeof json.message === 'string' ? json.message : '';
    if (res.status === 401 || res.status === 403) {
      return /password/i.test(msg) ? fail(PASSWORD_MSG, 'PASSWORD') : fail(GONE_MSG, 'GONE');
    }
    if (res.status === 404) return json ? fail(GONE_MSG, 'GONE') : fail('That address is not an Immich server', 'NOTIMMICH');
    if (res.status >= 500) return fail('The Immich server had an error, try again later', 'SERVER');
    return fail('Could not read the album (HTTP ' + res.status + ')', 'HTTP');
  }

  api('/shared-links/me', '', function (err, res) {
    if (err) return cb(err);
    var e = httpError(res);
    if (e) return cb(e);
    var link = parseJson(res.body);
    if (!link || typeof link !== 'object' || Array.isArray(link)) return cb(fail('That address is not an Immich server', 'NOTIMMICH'));
    if (link.passwordRequired) return cb(fail(PASSWORD_MSG, 'PASSWORD'));

    var title = (link.album && link.album.albumName) || link.description || 'Shared album';
    var items = [];        // { id, taken, width, height }

    function addAssets(list) {
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a || a.type !== 'IMAGE' || a.isTrashed || !a.id) continue;
        var ex = a.exifInfo || {};
        items.push({
          id: a.id,
          taken: parseTime(a.fileCreatedAt || a.localDateTime),
          width: typeof ex.exifImageWidth === 'number' ? ex.exifImageWidth : null,
          height: typeof ex.exifImageHeight === 'number' ? ex.exifImageHeight : null
        });
      }
    }

    function finish() {
      items = sortNewestFirst(items, function (x) { return x.taken; }).slice(0, MAX_PHOTOS);
      if (!items.length) return cb(fail('That album has no pictures in it', 'EMPTY'));

      // "fullsize" exists on current Immich (it redirects to the preview when there is no
      // separate fullsize file, so it is never a HEIC/RAW original); older servers reject
      // it, so probe the first image once and fall back to "preview" (about 1440 px).
      request({ url: base + '/api/assets/' + encodeURIComponent(items[0].id) + '/thumbnail?size=fullsize&' + auth,
                headers: { 'User-Agent': BROWSER_UA }, noRedirect: true, maxBytes: 64 * 1024 * 1024 }, function (perr, pres) {
        var sizeName = (!perr && (pres.status === 200 || pres.status === 302)) ? 'fullsize' : 'preview';
        var photos = items.map(function (it) {
          var p = base + '/api/assets/' + encodeURIComponent(it.id) + '/thumbnail?size=';
          return {
            id: it.id,
            src: p + sizeName + '&' + auth,
            thumb: p + 'thumbnail&' + auth,
            width: it.width, height: it.height, taken: it.taken
          };
        });
        cb(null, { kind: 'immich', title: title, photos: photos });
      });
    }

    if (Array.isArray(link.assets)) addAssets(link.assets);
    if (link.type !== 'ALBUM' || !link.album || !link.album.id) return finish();
    if (Array.isArray(link.album.assets) && link.album.assets.length) {
      addAssets(link.album.assets);
      return finish();
    }
    var albumId = encodeURIComponent(link.album.id);

    // Album: older servers list assets in GET /albums/:id, current ones (v2+/v3) only via
    // the timeline endpoints, which also accept the share key.
    api('/albums/' + albumId, '', function (aerr, ares) {
      if (aerr) return cb(aerr);
      var ae = httpError(ares);
      if (ae) return cb(ae);
      var album = parseJson(ares.body) || {};
      if (album.albumName) title = album.albumName;
      if (Array.isArray(album.assets) && album.assets.length) {
        addAssets(album.assets);
        return finish();
      }
      api('/timeline/buckets', 'albumId=' + albumId + '&order=desc', function (berr, bres) {
        if (berr) return cb(berr);
        var be = httpError(bres);
        if (be) return cb(be);
        var buckets = parseJson(bres.body);
        if (!Array.isArray(buckets)) return cb(fail('This Immich server is not supported', 'UNSUPPORTED'));
        var want = [], total = 0, i;
        for (i = 0; i < buckets.length && total < MAX_PHOTOS * 1.2; i++) {   // newest buckets first
          if (buckets[i] && buckets[i].timeBucket) { want.push(buckets[i].timeBucket); total += buckets[i].count || 0; }
        }
        mapLimit(want, 4, function (tb, done) {
          api('/timeline/bucket', 'albumId=' + albumId + '&order=desc&timeBucket=' + encodeURIComponent(tb), function (e2, r2) {
            if (e2) return done(e2);
            var e3 = httpError(r2);
            if (e3) return done(e3);
            done(null, parseJson(r2.body));
          });
        }, function (merr, parts) {
          if (merr) return cb(merr);
          parts.forEach(function (b) {
            if (!b || !Array.isArray(b.id)) return;
            for (var j = 0; j < b.id.length; j++) {
              if (b.isImage && b.isImage[j] === false) continue;
              if (b.isTrashed && b.isTrashed[j]) continue;
              items.push({ id: b.id[j], taken: parseTime(b.fileCreatedAt && b.fileCreatedAt[j]), width: null, height: null });
            }
          });
          finish();
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------------------
// Google Photos (unofficial)

function googleResolve(inputUrl, cb) {
  var headers = {
    'User-Agent': BROWSER_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    // pre-accepted consent so EU visitors are not bounced to consent.google.com
    'Cookie': 'SOCS=CAI; CONSENT=YES+'
  };
  request({ url: inputUrl, headers: headers, maxBytes: MAX_BYTES }, function (err, res) {
    if (err) return cb(err);
    var finalHost = '';
    try { finalHost = urlLib.parse(res.url).hostname || ''; } catch (e) { /* ignore */ }
    if (finalHost === 'consent.google.com' || finalHost === 'accounts.google.com') {
      return cb(fail(GONE_MSG, 'GONE'));
    }
    if (res.status === 404 || res.status === 403 || res.status === 410) return cb(fail(GONE_MSG, 'GONE'));
    if (res.status !== 200) return cb(fail('Could not read the album (HTTP ' + res.status + ')', 'HTTP'));
    var html = res.body.toString('utf8');
    var parsed = googleParse(html);
    if (!parsed) {
      if (/photos\.google\.com\/share\//.test(res.url) && /AF_initDataCallback/.test(html)) {
        return cb(fail('Could not read this album (it may be empty, or Google changed its page)', 'GOOGLE'));
      }
      return cb(fail('That link is not a shared album', 'NOTALBUM'));
    }
    if (!parsed.photos.length) return cb(fail('That album has no pictures in it', 'EMPTY'));
    cb(null, { kind: 'google', title: parsed.title, photos: parsed.photos.slice(0, MAX_PHOTOS) });
  });
}

// Accepts only https://lh3.googleusercontent.com/pw/<id> (album media). Avatars live under
// /a/ or /a-/ and other artwork under other prefixes, so they never match.
var LH3_PW = /^https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]{20,}$/;

function googleParse(html) {
  var title = '';
  var tm = /<title>([^<]*)<\/title>/i.exec(html);
  if (tm) title = decodeEntities(tm[1]).replace(/\s*-\s*Google Photos\s*$/i, '').trim();

  var best = null;
  var re = /AF_initDataCallback\(\{key:\s*'ds:\d+'[^]*?data:/g;
  var m;
  while ((m = re.exec(html))) {
    var start = m.index + m[0].length;
    var end = html.indexOf(', sideChannel', start);
    if (end < 0) continue;
    var data;
    try { data = JSON.parse(html.slice(start, end)); } catch (e) { continue; }
    if (!Array.isArray(data) || !Array.isArray(data[1])) continue;
    var photos = googleItems(data[1]);
    if (photos && (!best || photos.length > best.photos.length)) best = { photos: photos, meta: data[3] };
  }
  if (!best) {
    // Structure changed: fall back to a plain scan for ["https://lh3...pw/..",W,H arrays.
    var scanned = googleScan(html);
    if (!scanned.length) return null;
    return { title: title || 'Shared album', photos: scanned };
  }
  if (best.meta && typeof best.meta[1] === 'string' && best.meta[1]) title = best.meta[1];
  return { title: title || 'Shared album', photos: best.photos };
}

// data[1] is the list of album items: [mediaId, [baseUrl, w, h, ...], takenMs, ..., {extras}]
function googleItems(list) {
  var out = [], seen = {}, found = false;
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (!Array.isArray(it) || typeof it[0] !== 'string' || !Array.isArray(it[1])) continue;
    var u = it[1][0];
    if (typeof u !== 'string' || !LH3_PW.test(u)) continue;
    found = true;
    if (seen[it[0]] || seen[u]) continue;
    seen[it[0]] = seen[u] = true;
    // videos carry an extra trailing object with key 76647426 (video stream info)
    var last = it[it.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last) && last['76647426'] !== undefined) continue;
    out.push(googlePhoto(it[0], u, it[1][1], it[1][2], it[2]));
  }
  return found ? out : null;
}

function googleScan(html) {
  var out = [], seen = {};
  var re = /\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]{20,})",(\d+),(\d+)/g;
  var m;
  while ((m = re.exec(html))) {
    if (seen[m[1]]) continue;
    seen[m[1]] = true;
    out.push(googlePhoto(m[1], m[1], +m[2], +m[3], null));
  }
  return out;
}

function googlePhoto(id, base, w, h, taken) {
  return {
    id: id,
    src: base + '=w3840-h2160',
    thumb: base + '=w480-h480',
    width: typeof w === 'number' && w > 0 ? w : null,
    height: typeof h === 'number' && h > 0 ? h : null,
    taken: typeof taken === 'number' && taken > 0 ? taken : null
  };
}

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------------------
// iCloud shared albums (unofficial)

var B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Partition number from the token: 'A' + 1 char, otherwise the next 2 chars, base62.
// (Apple answers wrong partitions with a 330 redirect, which is followed below.)
var icloudHost = function (token) {
  var n;
  if (token.charAt(0) === 'A') n = B62.indexOf(token.charAt(1));
  else n = B62.indexOf(token.charAt(1)) * 62 + B62.indexOf(token.charAt(2));
  if (n < 0 || isNaN(n)) return null;
  return 'p' + (n < 10 ? '0' + n : String(n)) + '-sharedstreams.icloud.com';
};
var icloudScheme = 'https';

// Test hook only: point the iCloud code at a local mock server.
exports._test = {
  setIcloud: function (scheme, hostFn) { icloudScheme = scheme; icloudHost = hostFn; }
};

function icloudResolve(c, cb) {
  if (c.unsupported) {
    return cb(fail('That iCloud link type is not supported. In Photos, open the shared album, turn on "Public Website" and use the link that starts with icloud.com/sharedalbum', 'UNSUPPORTED'));
  }
  if (!c.token) return cb(fail('That link is not a shared album', 'NOTALBUM'));
  var token = c.token;
  var host = icloudHost(token);
  if (!host) return cb(fail('That link is not a shared album', 'NOTALBUM'));
  var hdr = { 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'application/json', 'User-Agent': BROWSER_UA,
              'Origin': 'https://www.icloud.com' };

  function post(h, path, obj, done) {
    request({ url: icloudScheme + '://' + h + '/' + token + '/sharedstreams/' + path, method: 'POST',
              headers: hdr, body: JSON.stringify(obj), noRedirect: true }, done);
  }

  var hops = 0;
  function stream(h) {
    post(h, 'webstream', { streamCtag: null }, function (err, res) {
      if (err) return cb(err);
      if (res.status === 330) {
        var j = parseJson(res.body) || {};
        var nh = j['X-Apple-MMe-Host'];
        if (typeof nh === 'string' && /^[a-z0-9.-]+(:\d+)?$/i.test(nh) && ++hops <= 3) return stream(nh);
        return cb(fail('Could not read the iCloud album', 'HTTP'));
      }
      if (res.status === 404 || res.status === 400 || res.status === 401 || res.status === 403) return cb(fail(GONE_MSG, 'GONE'));
      if (res.status !== 200) return cb(fail('Could not read the iCloud album (HTTP ' + res.status + ')', 'HTTP'));
      var data = parseJson(res.body);
      if (!data || !Array.isArray(data.photos)) return cb(fail(GONE_MSG, 'GONE'));
      withStream(h, data);
    });
  }

  function withStream(h, data) {
    var picks = [];
    data.photos.forEach(function (p) {
      if (!p || !p.photoGuid || p.mediaAssetType === 'video' || !p.derivatives) return;
      var recs = [];
      Object.keys(p.derivatives).forEach(function (k) {
        var d = p.derivatives[k];
        if (k === 'PosterFrame' || !d || !d.checksum) return;
        var side = Math.max(+d.width || 0, +d.height || 0) || parseInt(k, 10) || 0;
        recs.push({ d: d, side: side });
      });
      if (!recs.length) return;
      recs.sort(function (a, b) { return a.side - b.side || (+a.d.fileSize || 0) - (+b.d.fileSize || 0); });
      var best = recs[recs.length - 1];
      // thumb: the smallest derivative that is still at least ~300 px, else the largest below that
      var small = recs[0], r;
      for (r = 0; r < recs.length; r++) if (recs[r].side >= 300) { small = recs[r]; break; }
      if (small.side < 300) small = recs[recs.length - 1];
      picks.push({
        guid: p.photoGuid, best: best.d, small: small.d, taken: parseTime(p.dateCreated || p.batchDateCreated),
        w: +best.d.width || +p.width || null, h: +best.d.height || +p.height || null
      });
    });
    picks = sortNewestFirst(picks, function (x) { return x.taken; }).slice(0, MAX_PHOTOS);
    if (!picks.length) return cb(fail('That album has no pictures in it', 'EMPTY'));

    var chunks = [];
    for (var i = 0; i < picks.length; i += 25) chunks.push(picks.slice(i, i + 25).map(function (x) { return x.guid; }));
    mapLimit(chunks, 3, function (guids, done) {
      post(h, 'webasseturls', { photoGuids: guids }, function (err, res) {
        if (err) return done(err);
        if (res.status !== 200) return done(fail('Could not read the iCloud album (HTTP ' + res.status + ')', 'HTTP'));
        var j = parseJson(res.body);
        done(null, (j && j.items) || {});
      });
    }, function (err, parts) {
      if (err) return cb(err);
      var items = {};
      parts.forEach(function (p) { for (var k in p) items[k] = p[k]; });
      var urlFor = function (d) {
        var it = items[d.checksum];
        return it && it.url_location && it.url_path ? 'https://' + it.url_location + it.url_path : null;
      };
      var photos = [];
      picks.forEach(function (p) {
        var src = urlFor(p.best);
        if (!src) return;
        photos.push({ id: p.guid, src: src, thumb: urlFor(p.small) || src, width: p.w, height: p.h, taken: p.taken });
      });
      if (!photos.length) return cb(fail('Could not read the iCloud album', 'HTTP'));
      cb(null, { kind: 'icloud', title: (typeof data.streamName === 'string' && data.streamName) || 'Shared album', photos: photos });
    });
  }

  stream(host);
}

// ---------------------------------------------------------------------------------------

exports.resolve = function (url, callback) {
  var called = false;
  function cb(err, res) {
    if (called) return;
    called = true;
    if (err) return callback(err instanceof Error ? err : fail('Could not read the album'));
    callback(null, res);
  }
  try {
    var u = normalizeUrl(url);
    var c = u && classify(u);
    if (!c) return cb(fail('That link is not a shared album', 'NOTALBUM'));
    if (c.kind === 'immich') return immichResolve(u, c, cb);
    if (c.kind === 'google') return googleResolve(u.href, cb);
    return icloudResolve(c, cb);
  } catch (e) {
    cb(fail('Could not read the album'));
  }
};
