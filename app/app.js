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

  var HOLD_MS = Math.max(0.1, Number(cfg.minutesPerPhoto) || 5) * 60000;
  var FADE_MS = Math.max(0, Number(cfg.fadeSeconds) || 0) * 1000;
  var MAX_CROP = Math.min(0.9, Math.max(0, Number(cfg.maxCrop)));
  var LOAD_TIMEOUT_MS = 45000;
  var PREFS_KEY = 'artframe.prefs.v1';
  var VIVID_MIN = 32;       // colourfulness score a work needs for "Vivid only"
  var Gen = window.ArtFrameGenerative || null; // code-drawn art (generative.js)

  var $ = function (id) { return document.getElementById(id); };
  var slides = [$('slideA'), $('slideB')];
  var front = 0;            // index of the slide currently shown
  var localItems = [];      // the owner's own photos
  var artItems = [];        // bundled museum catalogue
  var sources = [];         // [{id, label}]
  var playlist = [];
  var position = -1;
  var timer = null;
  var busy = false;
  var generation = 0;       // bumped whenever the playlist is rebuilt
  var captionTimer = null;
  var prefs = readPrefs();  // choices made with the remote; override config.js

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
             hidden: p.hidden || {} };
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
  function genOn() { return !!Gen && (typeof prefs.gen === 'boolean' ? prefs.gen : cfg.generative !== false); }
  function photosOn() { return typeof prefs.photos === 'boolean' ? prefs.photos : cfg.myPhotos !== false; }

  // 'random' means one frame picked when the app starts and kept until it closes.
  var Border = window.ArtFrameBorder;
  var sessionFrame = Border.random();
  function frameChoice() { return prefs.frame || cfg.frame || 'random'; }
  function applyFrame() {
    var choice = frameChoice();
    Border.apply(choice === 'random' ? sessionFrame : choice);
  }

  function loadImage(urls) {
    // Tries each URL in turn; resolves with the first that loads.
    return new Promise(function (resolve, reject) {
      var i = 0;
      function attempt() {
        if (i >= urls.length) { reject(new Error('image failed')); return; }
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
    if (vividOn()) opts.mood = 'vivid'; // otherwise the generator picks freely, quiet pieces included
    return Gen.make(opts).then(function (made) {
      item.title = made.title || '';
      item.sub = made.sub || '';
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
    var items = photosOn() ? localItems.slice() : [];
    artItems.forEach(function (w) {
      if (prefs.hidden[w.urls[0]]) return; // thumbs-downed with the remote
      if (!sourceOn(w.source) || !w.cats.some(catOn)) return;
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
    img.style.transition = 'transform ' + Math.round((HOLD_MS + FADE_MS * 2) / 1000) + 's linear';
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

    slide.classList.add('visible');
    slides[front].classList.remove('visible');
    front = back;
    say('');

    if (cfg.caption === 'always') showCaption(item, true);
    else if (cfg.caption === 'onChange' || announce) showCaption(item, false);
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
        busy = false;
        timer = setTimeout(function () { step(1, false); }, 60000); // network hiccup: retry in a minute
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
        present(item, loaded, announce);
        busy = false;
        timer = setTimeout(function () { step(1, false); }, HOLD_MS);
        setTimeout(function () { if (mine === generation) prepareNext(); }, FADE_MS + 1500);
      }, tryNext);
    }
    tryNext();
  }

  // ---------- chooser (press OK) ----------

  var menu = { open: false, rows: [], focus: 0, dirty: false };

  function buildRows() {
    var rows = [];
    var counts = {};
    artItems.forEach(function (w) {
      if (!sourceOn(w.source)) return;
      w.cats.forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
    });
    if (localItems.length) {
      rows.push({ heading: 'Yours' });
      rows.push({
        label: 'My photos', count: localItems.length, on: photosOn(),
        toggle: function () { prefs.photos = !photosOn(); }
      });
    }
    rows.push({ heading: 'Show' });
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
          count: artItems.filter(function (w) { return w.source === s.id; }).length,
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
    [['random', 'A new one each time'], ['none', 'No frame']].concat(Border.styles).forEach(function (f) {
      rows.push({
        label: f[1], count: '', radio: true, on: frameChoice() === f[0],
        toggle: function () { prefs.frame = f[0]; applyFrame(); }
      });
    });
    return rows;
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
        el.className = 'row' + (row.radio ? ' radio' : '') + (row.on ? ' on' : '') + (i === keep ? ' focus' : '');
        var box = document.createElement('span'); box.className = 'box';
        var name = document.createElement('span'); name.className = 'name'; name.textContent = row.label;
        var num = document.createElement('span'); num.className = 'num'; num.textContent = row.count;
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

  function toggleRow() {
    var row = menu.rows[menu.focus];
    if (!row || row.heading) return;
    row.toggle();
    menu.dirty = true;
    writePrefs();
    renderMenu();
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
    var level = Number(cfg.brightness) || 1;
    var n = cfg.night;
    if (n && typeof n.from === 'number' && typeof n.to === 'number') {
      var h = new Date().getHours();
      var isNight = n.from > n.to ? (h >= n.from || h < n.to) : (h >= n.from && h < n.to);
      if (isNight) level = Number(n.brightness) || level;
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
    prefs.hidden[item.urls[0]] = 1;
    writePrefs();
    playlist.splice(position, 1);
    position--;
    notice('Hidden', 'You can bring hidden pictures back from the menu (OK)');
    if (playlist.length) step(1, false); else restart();
  }

  // ---------- remote control ----------

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27 };

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if (menu.open) {
      if (k === KEY.UP) moveFocus(-1);
      else if (k === KEY.DOWN) moveFocus(1);
      else if (k === KEY.OK) toggleRow();
      else if (k === KEY.BACK || k === KEY.ESC || k === KEY.LEFT || k === KEY.RIGHT) closeMenu();
      else return;
      e.preventDefault();
      return;
    }
    if (k === KEY.RIGHT) step(1, true);
    else if (k === KEY.LEFT) step(-1, true);
    else if (k === KEY.DOWN) hideCurrent();
    else if (k === KEY.OK || k === KEY.UP) openMenu();
    else if (k === KEY.BACK || k === KEY.ESC) window.close();
    else return;
    e.preventDefault();
  });

  $('stage').addEventListener('click', function () { if (menu.open) closeMenu(); else openMenu(); });

  // ---------- start ----------

  slides.forEach(function (s) { s.style.transitionDuration = FADE_MS + 'ms'; });
  applyFrame();
  keepAwake();
  updateDimmer();
  setInterval(updateDimmer, 60000);
  if (cfg.clock) {
    $('clock').style.display = 'block';
    updateClock();
    setInterval(updateClock, 10000);
  }

  Promise.all([loadLocal(), loadArt()]).then(function (loaded) {
    localItems = loaded[0];
    artItems = loaded[1];
    restart();
  });
})();
