(function () {
  'use strict';

  var cfg = Object.assign({
    categories: 'all',
    sources: 'all',
    myPhotos: true,
    maxCrop: 0.3,
    frame: 'random',
    vividOnly: false,
    generative: true,
    minutesPerPhoto: 5,
    fadeSeconds: 3,
    drift: true,
    brightness: 0.85,
    night: { from: 22, to: 7, brightness: 0.45 },
    caption: 'never',
    clock: false
  }, window.ARTFRAME_CONFIG || {});

  // Category ids are shared with scripts/sources/*.mjs.
  var CATEGORIES = [
    ['landscapes', 'Landscapes'],
    ['seascapes', 'Sea & Coast'],
    ['cities', 'Cities & Architecture'],
    ['impressionism', 'Impressionism'],
    ['still-life', 'Still Life'],
    ['portraits', 'Portraits'],
    ['japanese-prints', 'Japanese Prints'],
    ['modern-abstract', 'Modern & Abstract'],
    ['botanical-animals', 'Flowers & Animals'],
    ['photography', 'Photography'],
    ['space', 'Space']
  ];

  var FADE_MS = Math.max(0, Number(cfg.fadeSeconds) || 0) * 1000;
  var MAX_CROP = Math.min(0.9, Math.max(0, Number(cfg.maxCrop)));
  var LOAD_TIMEOUT_MS = 45000;
  var PREFS_KEY = 'artframe.prefs.v1';
  var VIVID_MIN = 25;       // colour variety a work needs for "Vivid only"
  var Gen = window.ArtFrameGenerative || null; // code-drawn art (generative.js)

  var $ = function (id) { return document.getElementById(id); };
  var slides = [$('slideA'), $('slideB')];
  var front = 0;            // index of the slide currently shown
  var bundledPhotos = [];   // the owner's photos baked into the app
  var livePhotos = [];      // the owner's photos served live from their computer
  var localItems = [];      // both of the above
  var artItems = [];        // bundled museum catalogue
  var sources = [];         // [{id, label}]
  var playlist = [];
  var position = -1;
  var timer = null;
  var busy = false;
  var generation = 0;       // bumped whenever the playlist is rebuilt
  var captionTimer = null;
  var prefs = readPrefs();  // choices made with the remote; override config.js

  // ---------- diagnostics ----------
  // A short rolling log kept on the TV, for checking how a long session went
  // (read it from the web inspector: JSON.parse(localStorage['freesaver.log'])).
  var stats = { shown: 0, failed: 0, drawn: 0 };
  function logEvent(what, detail) {
    try {
      var log = JSON.parse(localStorage.getItem('freesaver.log') || '[]');
      log.push([new Date().toISOString(), what, detail === undefined ? '' : detail]);
      localStorage.setItem('freesaver.log', JSON.stringify(log.slice(-400)));
    } catch (e) { /* no storage */ }
  }
  window.addEventListener('error', function (e) { logEvent('error', String(e.message).slice(0, 200)); });
  document.addEventListener('visibilitychange', function () { logEvent(document.hidden ? 'hidden' : 'visible'); });
  setInterval(function () {
    var v = $('keepawake');
    logEvent('beat', [stats.shown, stats.failed, stats.drawn, v.paused ? 'video-paused' : 'video-ok',
      window.performance && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) + 'MB' : ''].join(' '));
  }, 10 * 60000);

  // ---------- helpers ----------

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }

  // What kind of picture this is, for keeping the rotation varied.
  var KINDS = ['photography', 'space', 'modern-abstract', 'japanese-prints', 'impressionism'];
  function kindOf(item) {
    if (item.gen) return 'generative';
    if (!item.cats) return 'mine';
    for (var i = 0; i < KINDS.length; i++) if (item.cats.indexOf(KINDS[i]) >= 0) return KINDS[i];
    return item.cats[0] || 'other';
  }

  // Orders pictures so the kinds are mixed: a big category gets more turns
  // than a small one, but not in proportion (square root), and the same kind
  // does not come up twice in a row when there is a choice.
  function arrange(items) {
    var buckets = {};
    items.forEach(function (it) { var k = kindOf(it); (buckets[k] = buckets[k] || []).push(it); });
    var kinds = Object.keys(buckets);
    kinds.forEach(function (k) { shuffle(buckets[k]); });
    var out = [];
    var last = null;
    while (out.length < items.length) {
      var open = kinds.filter(function (k) { return buckets[k].length; });
      var pool = open.length > 1 ? open.filter(function (k) { return k !== last; }) : open;
      var total = 0;
      var weights = pool.map(function (k) { var w = Math.sqrt(buckets[k].length); total += w; return w; });
      var r = Math.random() * total;
      var pickAt = 0;
      while (pickAt < pool.length - 1 && (r -= weights[pickAt]) > 0) pickAt++;
      last = pool[pickAt];
      out.push(buckets[last].pop());
    }
    return out;
  }

  function say(text) { $('message').textContent = text || ''; }

  // Share of a picture lost when it is cropped to fill the screen.
  function cropLoss(ratio) {
    var box = $('stage').getBoundingClientRect(); // the frame's window, or the whole screen
    var screen = box.width / box.height;
    return 1 - Math.min(ratio, screen) / Math.max(ratio, screen);
  }

  function readPrefs() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch (e) { /* no storage */ }
    p = p || {};
    return { cats: p.cats || {}, sources: p.sources || {}, photos: p.photos, frame: p.frame, vivid: p.vivid, gen: p.gen,
             curated: p.curated, mature: p.mature,
             hidden: p.hidden || {}, favs: p.favs || {}, favOnly: !!p.favOnly, set: p.set || {}, seenHint: !!p.seenHint };
  }

  function writePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* no storage */ }
  }

  function listed(setting, id) {
    return !setting || setting === 'all' || setting.indexOf(id) >= 0;
  }
  function catOn(id) { return id in prefs.cats ? prefs.cats[id] : listed(cfg.categories, id); }
  function sourceOn(id) { return id in prefs.sources ? prefs.sources[id] : listed(cfg.sources, id); }
  function vividOn() { return typeof prefs.vivid === 'boolean' ? prefs.vivid : !!cfg.vividOnly; }
  // Curated: only the works picked as strong wall art. Off shows everything.
  function curatedOn() { return typeof prefs.curated === 'boolean' ? prefs.curated : cfg.curatedOnly !== false; }
  function matureOn() { return typeof prefs.mature === 'boolean' ? prefs.mature : !!cfg.matureThemes; }
  function genOn() { return !!Gen && (typeof prefs.gen === 'boolean' ? prefs.gen : cfg.generative !== false); }
  function photosOn() { return typeof prefs.photos === 'boolean' ? prefs.photos : cfg.myPhotos !== false; }

  // Settings changed from the menu, falling back to config.js.
  function opt(key, fallback) { return key in prefs.set ? prefs.set[key] : fallback; }
  function holdMs() { return Math.max(0.1, Number(opt('minutes', cfg.minutesPerPhoto)) || 5) * 60000; }
  function nightOn() { return !!opt('night', !!cfg.night); }
  function clockOn() { return !!opt('clock', !!cfg.clock); }
  function captionMode() { return opt('caption', cfg.caption || 'never'); }
  function frameEveryMin() { return Number(opt('frameEvery', cfg.frameChangeMinutes)) || 0; }
  function restHours() { return Number(opt('rest', cfg.frameRestHours == null ? 4 : cfg.frameRestHours)) || 0; }

  // 'random' means one frame picked when the app starts and kept until it closes.
  var Border = window.ArtFrameBorder;
  var sessionFrame = Border.random();
  var frameSince = Date.now();
  var frameNudged = Date.now();
  function frameChoice() { return prefs.frame || cfg.frame || 'random'; }
  function applyFrame(nudge) {
    var choice = frameChoice();
    // OLED care: after a few hours the frame steps aside for the rest of
    // the session, since it is the one thing on screen that never changes.
    var resting = restHours() > 0 && Date.now() - frameSince > restHours() * 3600000;
    Border.apply(resting ? 'none' : (choice === 'random' ? sessionFrame : choice), nudge);
  }
  // For panels where a fixed frame is a worry: with the frame set to
  // 'random', swap to a different style as often as the owner chooses. Each
  // style has different widths, so its edges land on different pixels.
  // Called just as a new picture fades in.
  var frameChanged = Date.now();
  function rotateFrame() {
    var every = frameEveryMin();
    if (frameChoice() !== 'random' || every <= 0 || Border.styles.length < 2) return;
    if (Date.now() - frameChanged < every * 60000 - 5000) return;
    frameChanged = Date.now();
    var next;
    do { next = Border.random(); } while (next === sessionFrame);
    sessionFrame = next;
    applyFrame();
  }

  // Called after each picture change: every quarter of an hour, shift the
  // frame's edges by a pixel or two.
  function careForPanel() {
    if (Date.now() - frameNudged < 15 * 60000) return;
    frameNudged = Date.now();
    var px = function () { return Math.floor(Math.random() * 5) - 2; };
    setTimeout(function () { applyFrame([px(), px()]); }, FADE_MS + 4000);
  }

  function loadImage(urls) {
    // Tries each URL in turn; resolves with the first that loads.
    return new Promise(function (resolve, reject) {
      var i = 0;
      function attempt() {
        if (i >= urls.length) { stats.failed++; reject(new Error('image failed')); return; }
        var url = urls[i++];
        var img = new Image();
        var done = false;
        var guard = setTimeout(function () {
          if (done) return;
          done = true; img.src = ''; attempt();
        }, LOAD_TIMEOUT_MS);
        img.onload = function () {
          if (done) return;
          done = true; clearTimeout(guard);
          var ready = function () {
            resolve({ url: url, width: img.naturalWidth, height: img.naturalHeight, el: img });
          };
          // Decode off-screen now, so the fade does not stutter while a
          // large picture is unpacked.
          if (img.decode) img.decode().then(ready, ready); else ready();
        };
        img.onerror = function () {
          if (done) return;
          done = true; clearTimeout(guard); attempt();
        };
        img.src = url;
      }
      attempt();
    });
  }

  // Gets a picture ready to show: downloads it, or draws it if it is generative.
  function obtain(item) {
    if (!item.gen) return loadImage(item.urls);
    var box = $('stage').getBoundingClientRect();
    // Draw at the panel's real pixel density (2x on a 4K TV) so it is sharp.
    var density = Math.min(window.devicePixelRatio || 1, 2);
    var opts = { width: Math.round(box.width * density), height: Math.round(box.height * density) };
    if (item.fixed) { opts.style = item.fixed[0]; opts.seed = item.fixed[1]; opts.mood = item.fixed[2]; } // a saved favourite
    else if (vividOn()) opts.mood = 'vivid'; // otherwise the generator picks freely, quiet pieces included
    return Gen.make(opts).then(function (made) {
      item.title = made.title || '';
      item.sub = made.sub || '';
      item.made = [made.style, made.seed, made.mood];
      return loadImage([made.url]);
    });
  }

  // ---------- content ----------

  function loadLocal() {
    return fetch('photos.json')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        return (list || []).map(function (p) {
          return { urls: [p.src], title: p.title || '', sub: '' };
        });
      })
      .catch(function () { return []; });
  }

  // The catalogue ships inside the app (art.json, built by `npm run
  // art:refresh`); only the images are fetched over the network.
  function loadArt() {
    return fetch('art.json')
      .then(function (r) {
        if (!r.ok) throw new Error('art.json ' + r.status);
        return r.json();
      })
      .then(function (body) {
        var labels = {};
        (body.sources || []).forEach(function (s) { labels[s.id] = s.label; });
        var works = (body.works || []).map(function (w) {
          return {
            ar: w.ar,
            v: w.v,
            tier: w.t || 1,
            mature: !!w.m,
            urls: w.src,
            title: w.title || '',
            sub: [w.sub, labels[w.source]].filter(Boolean).join('  ·  '),
            cats: w.cats || [],
            source: w.source
          };
        });
        sources = (body.sources || []).filter(function (s) {
          return works.some(function (w) { return w.source === s.id; });
        });
        return works;
      })
      .catch(function (err) {
        console.error('art list failed:', err && (err.stack || err.message || err));
        return [];
      });
  }

  function selection() {
    var favKeys = Object.keys(prefs.favs);
    if (prefs.favOnly && favKeys.length) {
      return favKeys.map(function (k) {
        var f = prefs.favs[k];
        if (f.g) return { gen: true, fixed: f.g, title: f.t || '', sub: f.s || '' };
        if (f.k) return localItems.filter(function (p) { return p.key === f.k; })[0] || null; // one of the owner's photos
        return { urls: f.u, title: f.t || '', sub: f.s || '', cats: f.c || [], source: f.o };
      }).filter(Boolean);
    }
    var items = photosOn() ? localItems.filter(function (p) { return !prefs.hidden[idOf(p)]; }) : [];
    artItems.forEach(function (w) {
      if (prefs.hidden[w.urls[0]]) return; // thumbs-downed with the remote
      if (!sourceOn(w.source) || !w.cats.some(catOn)) return;
      if (w.tier > 1 && curatedOn()) return;
      if (w.mature && !matureOn()) return;
      // Leave out works too far from the window's shape to crop well.
      if (w.ar && cropLoss(w.ar) > MAX_CROP) return;
      if (vividOn() && typeof w.v === 'number' && w.v < VIVID_MIN) return;
      items.push(w);
    });
    if (genOn()) {
      // Code-drawn pictures are made fresh each time, so they are slots in
      // the rotation rather than fixed works: about one in four.
      var slots = Math.max(12, Math.round(items.length / 3));
      for (var i = 0; i < slots; i++) items.push({ gen: true, title: '', sub: '' });
    }
    return items;
  }

  function restart() {
    generation++;
    busy = false;
    clearTimeout(timer);
    dropPrepared();
    playlist = arrange(selection());
    position = -1;
    if (!playlist.length) {
      slides.forEach(function (s) { s.classList.remove('visible'); });
      $('caption').classList.remove('visible');
      say(localItems.length || artItems.length
        ? 'Nothing selected.\nPress OK to choose what to show.'
        : 'No pictures to show.\nAdd photos to the photos folder and deploy again.');
      return;
    }
    step(1, false);
  }

  // ---------- display ----------

  function applyDrift(img) {
    if (!cfg.drift) return;
    var zoomIn = Math.random() < 0.5;
    var dx = (Math.random() * 2 - 1) * 1.2;
    var dy = (Math.random() * 2 - 1) * 1.2;
    var near = 'scale(1.01) translate(0%, 0%)';
    var far = 'scale(1.06) translate(' + dx + '%, ' + dy + '%)';
    img.style.transition = 'none';
    img.style.transform = zoomIn ? near : far;
    void img.offsetWidth; // commit the start position before animating
    img.style.transition = 'transform ' + Math.round((holdMs() + FADE_MS * 2) / 1000) + 's linear';
    img.style.transform = zoomIn ? far : near;
  }

  function showCaption(item, sticky) {
    var cap = $('caption');
    clearTimeout(captionTimer);
    if (!item || (!item.title && !item.sub)) { cap.classList.remove('visible'); return; }
    $('capTitle').textContent = item.title;
    $('capSub').textContent = item.sub;
    cap.classList.add('visible');
    if (!sticky) {
      captionTimer = setTimeout(function () { cap.classList.remove('visible'); }, 9000);
    }
  }

  function present(item, loaded, announce) {
    var back = 1 - front;
    var slide = slides[back];
    var old = slide.querySelector('img');
    var img = loaded.el; // already downloaded and decoded
    img.alt = '';
    // Every landscape picture fills the whole screen, cropping the edges.
    // Only upright ones (e.g. a portrait phone photo) are shown whole, over
    // a blurred version of themselves.
    var fills = loaded.width / loaded.height > 1.1;
    slide.classList.toggle('fill', fills);
    slide.classList.toggle('framed', !fills);
    slide.querySelector('.backdrop').style.backgroundImage = fills ? '' : 'url("' + loaded.url + '")';
    if (old.src.indexOf('blob:') === 0) URL.revokeObjectURL(old.src); // free the last drawn picture
    slide.replaceChild(img, old);
    applyDrift(img);

    stats.shown++;
    if (item.gen) stats.drawn++;
    slide.classList.add('visible');
    slides[front].classList.remove('visible');
    front = back;
    say('');

    if (captionMode() === 'always') showCaption(item, true);
    else if (captionMode() === 'onChange' || announce) showCaption(item, false);
    else $('caption').classList.remove('visible');
  }

  // The next picture is fetched and decoded ahead of time, while the current
  // one is on screen, so transitions and skips start instantly.
  var prepared = null;

  function dropPrepared() {
    if (!prepared) return;
    prepared.promise.then(function (l) {
      if (l.url.indexOf('blob:') === 0) URL.revokeObjectURL(l.url);
    }, function () {});
    prepared = null;
  }

  function prepareNext() {
    if (playlist.length < 2 || busy) return;
    var next = playlist[(position + 1) % playlist.length];
    if (prepared && prepared.item === next) return;
    dropPrepared();
    prepared = { item: next, promise: obtain(next) };
    prepared.promise.catch(function () {});
  }

  // The timed move to the next picture. If the owner's photos changed on
  // their computer in the meantime, rebuild the rotation first.
  var photosChanged = false;
  function advance() {
    if (photosChanged && !menu.open) { photosChanged = false; restart(); return; }
    step(1, false);
  }
  function reschedule() {
    if (busy || !playlist.length) return;
    clearTimeout(timer);
    timer = setTimeout(advance, holdMs());
  }

  // direction: 1 next, -1 previous. announce: show the caption (manual skip).
  function step(direction, announce) {
    if (busy || !playlist.length) return;
    busy = true;
    clearTimeout(timer);
    var mine = generation;
    var tries = 0;

    function tryNext() {
      if (mine !== generation) return;
      if (tries++ >= Math.min(playlist.length, 8)) {
        // Nothing would load: most likely the network is down. Draw a
        // picture instead of sitting on a stale one, and try again shortly.
        var again = function () { busy = false; timer = setTimeout(advance, 60000); };
        if (!Gen) { again(); return; }
        var spare = { gen: true, title: '', sub: '' };
        obtain(spare).then(function (loaded) {
          if (mine !== generation) return;
          present(spare, loaded, false);
          playlist.splice(position + 1, 0, spare); // so favourites and captions refer to it
          position++;
          again();
        }, again);
        return;
      }
      var wrapped = direction > 0 && position === playlist.length - 1;
      position = (position + direction + playlist.length) % playlist.length;
      if (wrapped && playlist.length > 2) {
        var last = playlist[playlist.length - 1];
        playlist = arrange(playlist);
        if (playlist[0] === last) playlist.push(playlist.shift()); // no immediate repeat
      }
      var item = playlist[position];
      var ready;
      if (prepared && prepared.item === item) { ready = prepared.promise; prepared = null; }
      else ready = obtain(item);
      ready.then(function (loaded) {
        if (mine !== generation) return;
        if (!announce) rotateFrame(); // not on a manual skip, so flipping through pictures stays calm
        present(item, loaded, announce);
        busy = false;
        timer = setTimeout(advance, holdMs());
        setTimeout(function () { if (mine === generation) prepareNext(); }, FADE_MS + 1500);
        careForPanel();
      }, tryNext);
    }
    tryNext();
  }

  // ---------- chooser (press OK) ----------

  var menu = { open: false, rows: [], focus: 0, dirty: false };

  function buildRows() {
    var rows = [];
    var counts = {};
    var allowed = function (w) { return !(w.tier > 1 && curatedOn()) && !(w.mature && !matureOn()); };
    artItems.forEach(function (w) {
      if (!sourceOn(w.source) || !allowed(w)) return;
      w.cats.forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
    });
    if (localItems.length || tvPhotos) rows.push({ heading: 'Yours' });
    if (localItems.length) {
      rows.push({
        label: 'My photos', count: localItems.length, on: photosOn(),
        toggle: function () { prefs.photos = !photosOn(); }
      });
    }
    if (tvPhotos) {
      rows.push({ label: 'Add photos from your phone', count: '', plain: true, soft: true, toggle: function () { closeMenu(); openPair(); } });
    }
    rows.push({ heading: 'Show' });
    var favCount = Object.keys(prefs.favs).length;
    if (favCount) {
      rows.push({
        label: 'Favourites only', count: favCount, on: prefs.favOnly,
        toggle: function () { prefs.favOnly = !prefs.favOnly; }
      });
    }
    if (artItems.some(function (w) { return w.tier > 1; })) {
      rows.push({
        label: 'Best picks only', count: artItems.filter(function (w) { return w.tier === 1 && !w.mature; }).length, on: curatedOn(),
        toggle: function () { prefs.curated = !curatedOn(); }
      });
    }
    var matureCount = artItems.filter(function (w) { return w.mature; }).length;
    if (matureCount) {
      rows.push({
        label: 'Mature themes', count: matureCount, on: matureOn(),
        toggle: function () { prefs.mature = !matureOn(); }
      });
    }
    rows.push({
      label: 'Vivid only', count: '', on: vividOn(),
      toggle: function () { prefs.vivid = !vividOn(); }
    });
    if (Gen) {
      rows.push({
        label: 'Generative art', count: '\u221e', on: genOn(),
        toggle: function () { prefs.gen = !genOn(); }
      });
    }
    CATEGORIES.forEach(function (c) {
      var total = artItems.filter(function (w) { return w.cats.indexOf(c[0]) >= 0; }).length;
      if (!total) return;
      rows.push({
        label: c[1], count: counts[c[0]] || 0, on: catOn(c[0]),
        toggle: function () { prefs.cats[c[0]] = !catOn(c[0]); }
      });
    });
    if (sources.length > 1) {
      rows.push({ heading: 'From' });
      sources.forEach(function (s) {
        rows.push({
          label: s.label,
          count: artItems.filter(function (w) { return w.source === s.id && allowed(w); }).length,
          on: sourceOn(s.id),
          toggle: function () { prefs.sources[s.id] = !sourceOn(s.id); }
        });
      });
    }
    var hiddenCount = Object.keys(prefs.hidden).length;
    if (hiddenCount) {
      rows.push({ heading: 'Hidden' });
      rows.push({
        label: 'Bring back hidden pictures', count: hiddenCount, on: false,
        toggle: function () { prefs.hidden = {}; }
      });
    }
    rows.push({ heading: 'Frame' });
    [['random', 'Mix of frames'], ['none', 'No frame']].concat(Border.styles).forEach(function (f) {
      rows.push({
        label: f[1], count: '', radio: true, on: frameChoice() === f[0],
        toggle: function () { prefs.frame = f[0]; frameSince = Date.now(); applyFrame(); }
      });
    });

    rows.push({ heading: 'Settings' });
    rows.push(cycleRow('Change picture every', 'minutes', Number(opt('minutes', cfg.minutesPerPhoto)),
      [[1, '1 min'], [2, '2 min'], [5, '5 min'], [10, '10 min'], [15, '15 min'], [30, '30 min'], [60, '1 hour']], reschedule));
    rows.push(cycleRow('Brightness', 'brightness', Number(opt('brightness', cfg.brightness)),
      [[0.4, '40%'], [0.55, '55%'], [0.7, '70%'], [0.85, '85%'], [1, '100%']], updateDimmer));
    rows.push(cycleRow('Dim at night', 'night', nightOn(), [[false, 'Off'], [true, 'On']], updateDimmer));
    rows.push(cycleRow('Titles', 'caption', captionMode(),
      [['never', 'Hidden'], ['onChange', 'Briefly'], ['always', 'Always']], function () {
        if (captionMode() === 'always') showCaption(playlist[position], true);
        else $('caption').classList.remove('visible');
      }));
    rows.push(cycleRow('Clock', 'clock', clockOn(), [[false, 'Off'], [true, 'On']], applyClock));
    rows.push(cycleRow('Change frame', 'frameEvery', frameEveryMin(),
      [[0, 'Each session'], [240, 'Every 4 hours'], [60, 'Every hour'], [15, 'Every 15 min'], [0.01, 'Every picture']],
      function () { frameChanged = Date.now(); }));
    rows.push(cycleRow('Frame rests after', 'rest', restHours(),
      [[0, 'Never'], [2, '2 hours'], [4, '4 hours'], [8, '8 hours']], function () { applyFrame(); }));

    rows.push({ heading: 'Help' });
    if (devState && devState.devMode) {
      // Shown only on sideloaded installs. OK renews it straight away.
      rows.push({
        label: 'Stays installed for', count: Math.floor(devState.hoursLeft / 24) + ' days', plain: true, soft: true,
        toggle: function () { keepInstalled().then(function () { if (menu.open) renderMenu(); }); }
      });
    }
    rows.push({ label: 'Remote buttons', count: '', plain: true, soft: true, toggle: function () { closeMenu(); showHint(); } });
    return rows;
  }

  // A settings row that steps through a list of values with OK or left/right.
  function cycleRow(label, key, current, choices, after) {
    var at = 0;
    choices.forEach(function (c, i) { if (c[0] === current) at = i; });
    return {
      label: label, value: choices[at][1], soft: true,
      cycle: function (dir) {
        prefs.set[key] = choices[(at + dir + choices.length) % choices.length][0];
        if (after) after();
      }
    };
  }

  function renderMenu() {
    var keep = menu.focus;
    menu.rows = buildRows();
    var list = $('menuList');
    list.textContent = '';
    menu.rows.forEach(function (row, i) {
      var el = document.createElement('div');
      if (row.heading) {
        el.className = 'heading';
        el.textContent = row.heading;
      } else {
        el.className = 'row' + (row.radio ? ' radio' : '') + (row.cycle || row.plain ? ' cycle on' : '') +
          (row.on ? ' on' : '') + (i === keep ? ' focus' : '');
        var box = document.createElement('span'); box.className = 'box';
        var name = document.createElement('span'); name.className = 'name'; name.textContent = row.label;
        var num = document.createElement('span'); num.className = 'num'; num.textContent = row.cycle ? row.value : row.count;
        el.appendChild(box); el.appendChild(name); el.appendChild(num);
        el.addEventListener('click', function () { menu.focus = i; toggleRow(); });
      }
      list.appendChild(el);
    });
    $('menuTotal').textContent = selection().filter(function (w) { return !w.gen; }).length + ' pictures selected' +
      (genOn() ? ' + generative' : '');
    var focused = list.querySelector('.focus');
    if (focused && focused.scrollIntoView) focused.scrollIntoView({ block: 'nearest' });
  }

  function moveFocus(delta) {
    var i = menu.focus;
    do { i += delta; } while (menu.rows[i] && menu.rows[i].heading);
    if (menu.rows[i]) { menu.focus = i; renderMenu(); }
  }

  function toggleRow(dir) {
    var row = menu.rows[menu.focus];
    if (!row || row.heading) return;
    if (row.cycle) row.cycle(dir || 1);
    else if (dir) return; // left/right only act on settings rows
    else row.toggle();
    if (!row.soft) menu.dirty = true; // settings apply at once; content changes rebuild the rotation
    writePrefs();
    if (menu.open) renderMenu();
  }

  function openMenu() {
    menu.open = true;
    menu.dirty = false;
    menu.rows = buildRows();
    menu.focus = 0;
    while (menu.rows[menu.focus] && menu.rows[menu.focus].heading) menu.focus++;
    renderMenu();
    $('menu').classList.add('open');
  }

  function closeMenu() {
    menu.open = false;
    $('menu').classList.remove('open');
    if (menu.dirty) restart();
  }

  // ---------- brightness, clock, keep-awake ----------

  function updateDimmer() {
    var level = Number(opt('brightness', cfg.brightness)) || 1;
    var n = cfg.night || { from: 22, to: 7, brightness: 0.45 };
    if (nightOn() && typeof n.from === 'number' && typeof n.to === 'number') {
      var h = new Date().getHours();
      var isNight = n.from > n.to ? (h >= n.from || h < n.to) : (h >= n.from && h < n.to);
      if (isNight) level = Math.min(level, Number(n.brightness) || level);
    }
    level = Math.min(1, Math.max(0.1, level));
    $('dimmer').style.opacity = String(1 - level);
  }

  function updateClock() {
    var d = new Date();
    var h = d.getHours() % 12 || 12;
    var m = d.getMinutes();
    $('clock').textContent = h + ':' + (m < 10 ? '0' : '') + m;
  }

  function applyClock() {
    $('clock').style.display = clockOn() ? 'block' : 'none';
    updateClock();
  }

  function keepAwake() {
    var v = $('keepawake');
    var play = function () {
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* retried below */ });
    };
    play();
    setInterval(function () { if (v.paused) play(); }, 15000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) play();
    });
  }

  // ---------- "never show this again" (press Down twice) ----------

  var hideArmed = null; // the picture a first Down press is asking about

  function notice(title, sub) {
    clearTimeout(captionTimer);
    $('capTitle').textContent = title;
    $('capSub').textContent = sub || '';
    $('caption').classList.add('visible');
    captionTimer = setTimeout(function () {
      $('caption').classList.remove('visible');
      hideArmed = null;
    }, 6000);
  }

  function hideCurrent() {
    var item = playlist[position];
    if (!item || busy) return;
    if (item.gen) { step(1, false); return; } // drawn pictures never repeat anyway
    if (hideArmed !== item) {
      hideArmed = item;
      notice('Never show this picture again?', 'Press Down once more to hide it');
      return;
    }
    hideArmed = null;
    prefs.hidden[idOf(item)] = 1;
    writePrefs();
    playlist.splice(position, 1);
    position--;
    notice('Hidden', 'You can bring hidden pictures back from the menu (OK)');
    if (playlist.length) step(1, false); else restart();
  }

  // ---------- favourites (press Up) ----------

  // What a picture is known by in favourites and the hidden list. The
  // owner's photos have a stable key, since their addresses can change.
  function idOf(item) { return item.key || item.urls[0]; }
  function favKey(item) {
    if (item.gen) return item.made ? 'gen:' + item.made.join(':') : null;
    return idOf(item);
  }

  function toggleFavourite() {
    var item = playlist[position];
    var key = item && favKey(item);
    if (!key || busy) return;
    if (prefs.favs[key]) {
      delete prefs.favs[key];
      notice('Removed from favourites', item.title);
    } else {
      prefs.favs[key] = item.gen
        ? { g: item.made, t: item.title, s: item.sub }
        : (item.key ? { k: item.key } : { u: item.urls, t: item.title, s: item.sub, c: item.cats, o: item.source });
      notice('\u2665  Saved to favourites', item.title);
    }
    writePrefs();
  }

  // ---------- first-run guide ----------

  function showHint() { $('hint').classList.add('open'); }
  function hideHint() {
    $('hint').classList.remove('open');
    if (!prefs.seenHint) { prefs.seenHint = true; writePrefs(); }
  }

  // ---------- the owner's photos, served live from their computer ----------

  var photoServers = ((window.FREESAVER_LOCAL || {}).photoServers || []).concat(cfg.photoServers || []);
  var photoBase = null;     // the address that answered last time
  var photoVersion = null;

  function fetchJson(url, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var guard = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      clearTimeout(guard);
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  // Resolves to true if the set of live photos changed.
  function refreshLivePhotos() {
    var order = photoBase ? [photoBase].concat(photoServers.filter(function (s) { return s !== photoBase; })) : photoServers.slice();
    function attempt(i) {
      if (i >= order.length) return Promise.resolve(false); // computer asleep or away: keep what we have
      var base = order[i].replace(/\/+$/, '');
      return fetchJson(base + '/photos.json', 5000).then(function (body) {
        photoBase = order[i];
        var fresh = (body.photos || []).map(function (p) {
          return { key: p.key || p.src, urls: [/^https?:/.test(p.src) ? p.src : base + p.src], title: p.title || '', sub: '', ar: p.ar };
        });
        if (body.version === photoVersion) {
          // Same pictures. Album links can expire, so keep their addresses
          // current without disturbing the rotation.
          var byKey = {};
          fresh.forEach(function (f) { byKey[f.key] = f; });
          livePhotos.forEach(function (old) { if (byKey[old.key]) old.urls = byKey[old.key].urls; });
          return false;
        }
        photoVersion = body.version;
        livePhotos = fresh;
        localItems = bundledPhotos.concat(livePhotos);
        return true;
      }, function () { return attempt(i + 1); });
    }
    return attempt(0);
  }

  // ---------- staying installed ----------
  // LG removes sideloaded apps when the TV's Developer Mode session runs out.
  // The app's bundled service (service/service.js) resets that clock, the
  // same as pressing Extend in the Developer Mode app, so the app looks
  // after itself for as long as it is opened now and then.
  var devState = null; // {devMode, hoursLeft} from the last call

  function devMode(extend) {
    return new Promise(function (resolve) {
      if (!window.PalmServiceBridge) { resolve(null); return; }
      var guard = setTimeout(function () { resolve(null); }, 40000);
      try {
        var bridge = new window.PalmServiceBridge();
        bridge.onservicecallback = function (text) {
          clearTimeout(guard);
          try { resolve(JSON.parse(text)); } catch (e) { resolve(null); }
        };
        bridge.call('luna://com.freesaver.app.service/devmode', JSON.stringify({ extend: !!extend }));
      } catch (e) { clearTimeout(guard); resolve(null); }
    });
  }

  function keepInstalled() {
    return devMode(true).then(function (r) {
      if (r && r.returnValue) devState = r;
      logEvent('devmode', r ? (r.devMode ? (r.hoursLeft + 'h' + (r.extended ? ' extended' : ' NOT extended')) : 'not in developer mode') : 'no answer');
      return r;
    });
  }

  // ---------- photos kept on the TV, added from a phone ----------
  // The app's background service (service/photos.js) runs a small web server
  // on the home network while the app is open. A phone reaches it through
  // the QR code on the "Add your photos" screen.
  var tvPhotos = null;   // {port, urls, count} once the service has answered
  var photoBridge = null;
  var pairPoll = null;

  function startTvPhotos() {
    return new Promise(function (resolve) {
      if (!window.PalmServiceBridge) { resolve(null); return; }
      var guard = setTimeout(function () { resolve(null); }, 15000);
      try {
        photoBridge = new window.PalmServiceBridge(); // kept: the subscription holds the server open
        photoBridge.onservicecallback = function (text) {
          clearTimeout(guard);
          var r = null;
          try { r = JSON.parse(text); } catch (e) { /* ignored */ }
          if (r && r.returnValue && r.port) {
            tvPhotos = r;
            var local = 'http://127.0.0.1:' + r.port;
            if (photoServers.indexOf(local) < 0) photoServers.unshift(local);
          }
          logEvent('photos', r ? (r.returnValue ? r.count + ' on tv' : r.errorText) : 'no answer');
          resolve(tvPhotos);
        };
        photoBridge.call('luna://com.freesaver.app.service/serve', JSON.stringify({ subscribe: true }));
      } catch (e) { clearTimeout(guard); resolve(null); }
    });
  }

  function openPair() {
    if (!tvPhotos || !tvPhotos.urls || !tvPhotos.urls.length) {
      notice('The TV is not on a network', 'Connect it to Wi-Fi to add photos from a phone');
      return;
    }
    var url = tvPhotos.urls[0];
    $('pairUrl').textContent = url;
    $('pairCount').textContent = '';
    if (window.FreeSaverQR) {
      try { window.FreeSaverQR.draw($('pairCode'), url, { size: 360, level: 'M' }); } catch (e) { logEvent('qr', e.message); }
    }
    $('pair').classList.add('open');
    var before = livePhotos.length;
    pairPoll = setInterval(function () {
      refreshLivePhotos().then(function (changed) {
        if (changed) photosChanged = true;
        var added = livePhotos.length - before;
        $('pairCount').textContent = livePhotos.length ? livePhotos.length + ' of your photos on this TV' + (added > 0 ? '  (+' + added + ' just now)' : '') : '';
      });
    }, 4000);
  }

  function closePair() {
    $('pair').classList.remove('open');
    clearInterval(pairPoll);
    if (photosChanged) { photosChanged = false; restart(); } // show what was just added
  }

  // ---------- remote control ----------

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27 };

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if ($('hint').classList.contains('open')) { hideHint(); e.preventDefault(); return; }
    if ($('pair').classList.contains('open')) { closePair(); e.preventDefault(); return; }
    if (menu.open) {
      if (k === KEY.UP) moveFocus(-1);
      else if (k === KEY.DOWN) moveFocus(1);
      else if (k === KEY.OK) toggleRow();
      else if (k === KEY.LEFT) toggleRow(-1);
      else if (k === KEY.RIGHT) toggleRow(1);
      else if (k === KEY.BACK || k === KEY.ESC) closeMenu();
      else return;
      e.preventDefault();
      return;
    }
    if (k === KEY.RIGHT) step(1, true);
    else if (k === KEY.LEFT) step(-1, true);
    else if (k === KEY.DOWN) hideCurrent();
    else if (k === KEY.UP) toggleFavourite();
    else if (k === KEY.OK) openMenu();
    else if (k === KEY.BACK || k === KEY.ESC) window.close();
    else return;
    e.preventDefault();
  });

  $('stage').addEventListener('click', function () { if (menu.open) closeMenu(); else openMenu(); });

  // ---------- start ----------

  slides.forEach(function (s) { s.style.transitionDuration = FADE_MS + 'ms'; });
  logEvent('start', navigator.userAgent.replace(/.*(Chrome\/[\d.]+).*/, '$1'));
  applyFrame();
  keepAwake();
  updateDimmer();
  setInterval(updateDimmer, 60000);
  applyClock();
  setInterval(updateClock, 10000);
  if (!prefs.seenHint) { showHint(); setTimeout(hideHint, 30000); }
  setTimeout(keepInstalled, 20000);
  setInterval(keepInstalled, 12 * 3600000);
  $('hint').addEventListener('click', hideHint);

  fetch('appinfo.json').then(function (r) { return r.json(); }).then(function (info) {
    var v = document.createElement('small');
    v.textContent = info.version;
    $('menuTitle').appendChild(v);
  }).catch(function () {});

  $('pair').addEventListener('click', closePair);

  // The owner's photos: ask the TV's own photo service first. Do not hold the
  // first picture up for long if it is slow to answer.
  var booted = false;
  var live = Promise.race([
    startTvPhotos().then(refreshLivePhotos).then(function (changed) {
      if (changed && booted) photosChanged = true; // answered late: pick them up at the next change
      return changed;
    }),
    new Promise(function (r) { setTimeout(function () { r(false); }, 4000); })
  ]);
  Promise.all([loadLocal(), loadArt(), live]).then(function (loaded) {
    bundledPhotos = loaded[0];
    localItems = bundledPhotos.concat(livePhotos);
    artItems = loaded[1];
    booted = true;
    restart();
  });
  setInterval(function () {
    if (!photoServers.length) return;
    refreshLivePhotos().then(function (changed) { if (changed) photosChanged = true; });
  }, 5 * 60000);
})();
