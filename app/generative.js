// Generative art for Art Frame. Draws modern, print-like pictures with
// Canvas 2D - no image files, no network. Every picture is fully determined
// by its style, seed and size.
//
//   ArtFrameGenerative.styles                -> [[id, 'Name'], ...]
//   ArtFrameGenerative.make({style, seed, width, height})
//                                            -> Promise<{url, title, sub}>
(function () {
  'use strict';

  var TAU = Math.PI * 2;

  // ---------- seeded randomness ----------

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function makeRng(seed) {
    var r = mulberry32(seed);
    r.range = function (a, b) { return a + (b - a) * r(); };
    r.int = function (a, b) { return a + Math.floor(r() * (b - a + 1)); };
    r.pick = function (list) { return list[Math.floor(r() * list.length)]; };
    r.chance = function (p) { return r() < p; };
    r.shuffle = function (list) {
      var out = list.slice();
      for (var i = out.length - 1; i > 0; i--) {
        var j = Math.floor(r() * (i + 1));
        var t = out[i]; out[i] = out[j]; out[j] = t;
      }
      return out;
    };
    return r;
  }

  // Smooth 2D value noise in 0..1.
  function makeNoise(R) {
    var perm = new Uint8Array(512);
    var vals = new Float32Array(256);
    var i;
    for (i = 0; i < 256; i++) { perm[i] = i; vals[i] = R(); }
    for (i = 255; i > 0; i--) {
      var j = Math.floor(R() * (i + 1));
      var t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    for (i = 0; i < 256; i++) perm[i + 256] = perm[i];
    function n(x, y) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var xf = x - xi, yf = y - yi;
      xi &= 255; yi &= 255;
      var u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
      var v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
      var a = vals[perm[perm[xi] + yi]], b = vals[perm[perm[xi + 1] + yi]];
      var c = vals[perm[perm[xi] + yi + 1]], d = vals[perm[perm[xi + 1] + yi + 1]];
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
    n.fbm = function (x, y, oct) {
      var sum = 0, amp = 0.5, norm = 0;
      for (var o = 0; o < oct; o++) {
        sum += n(x, y) * amp; norm += amp;
        x = x * 2.03 + 17.1; y = y * 2.03 + 9.7; amp *= 0.5;
      }
      return sum / norm;
    };
    return n;
  }

  // ---------- colour ----------

  function rgb(hex) {
    var v = parseInt(hex.slice(1), 16);
    return [v >> 16 & 255, v >> 8 & 255, v & 255];
  }
  function css(c, a) {
    c = typeof c === 'string' ? rgb(c) : c;
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (a === undefined ? 1 : a) + ')';
  }
  function mix(a, b, t) {
    a = typeof a === 'string' ? rgb(a) : a;
    b = typeof b === 'string' ? rgb(b) : b;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function lum(c) {
    c = typeof c === 'string' ? rgb(c) : c;
    return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  }
  function dist(a, b) {
    a = typeof a === 'string' ? rgb(a) : a;
    b = typeof b === 'string' ? rgb(b) : b;
    var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.5 + db * db * 0.2) / 255;
  }
  // Colour along a list of evenly spaced stops, t in 0..1.
  function ramp(stops, t) {
    t = Math.min(0.99999, Math.max(0, t)) * (stops.length - 1);
    var i = Math.floor(t);
    return mix(stops[i], stops[i + 1], t - i);
  }

  // Curated palettes: bg is the paper/ground, ink the strong contrasting
  // accent, cols the working colours.
  var PALETTES = [
    { bg: '#E9DFCB', ink: '#1B1B1E', cols: ['#D5402B', '#1F4E9C', '#F0B323', '#1B1B1E', '#E8805A'] },
    { bg: '#EFE3D0', ink: '#232B5C', cols: ['#F25C54', '#F7B267', '#F4845F', '#5B3A8C', '#232B5C'] },
    { bg: '#12263A', ink: '#EBE3CC', cols: ['#F4D35E', '#EE964B', '#F95738', '#06BCC1', '#EBE3CC'] },
    { bg: '#ECE1CC', ink: '#17255A', cols: ['#1F3FA6', '#F26B5E', '#F2C14E', '#2E8B6E', '#E88FB4'] },
    { bg: '#EFDFC6', ink: '#2D3047', cols: ['#C8553D', '#F28F3B', '#588B8B', '#F6C7AE', '#2D3047'] },
    { bg: '#F1E6D6', ink: '#3D405B', cols: ['#F6BD60', '#F28482', '#84A59D', '#E07A5F', '#3D405B'] },
    { bg: '#101935', ink: '#F1E9DA', cols: ['#7D5BA6', '#FF5E5B', '#00CECB', '#FFED66', '#F1E9DA'] },
    { bg: '#ECE5D3', ink: '#1B4332', cols: ['#1B4332', '#2D6A4F', '#F4A259', '#BC4B51', '#F4E285'] },
    { bg: '#E6DFCF', ink: '#0D0D0D', cols: ['#0B3C8C', '#F26A1B', '#F2B705', '#0D0D0D', '#8FB8DE'] },
    { bg: '#2A1A2E', ink: '#EEE5D3', cols: ['#E63462', '#FE5F55', '#F7B32B', '#7FC8A9', '#EEE5D3'] },
    { bg: '#DDE7E0', ink: '#073B4C', cols: ['#0077B6', '#00B4D8', '#FF6B6B', '#FFD166', '#073B4C'] },
    { bg: '#E8DCC5', ink: '#2F4858', cols: ['#D1603D', '#DDB967', '#5E8C9E', '#2F4858', '#F2C9A1'] },
    { bg: '#0E2A33', ink: '#F0E7D8', cols: ['#F2545B', '#F3A712', '#A4D4B4', '#19A7A8', '#F0E7D8'] },
    { bg: '#F3E4D4', ink: '#240046', cols: ['#7B2CBF', '#FF7F51', '#FFB5A7', '#240046', '#F9C74F'] },
    { bg: '#EAE2CD', ink: '#283618', cols: ['#606C38', '#283618', '#DDA15E', '#BC6C25', '#E63946'] },
    { bg: '#E5E0D4', ink: '#0A2463', cols: ['#0A2463', '#3E92CC', '#D8315B', '#F2B134', '#1E1B18'] },
    { bg: '#151E3F', ink: '#F0E6D2', cols: ['#F26419', '#86BBD8', '#F6AE2D', '#4F86C6', '#F0E6D2'] },
    { bg: '#EEE0D3', ink: '#2E294E', cols: ['#D7263D', '#F46036', '#2E294E', '#1B998B', '#C5D86D'] },
    { bg: '#1F2421', ink: '#EDE6D6', cols: ['#216869', '#49A078', '#F2C14E', '#F78154', '#EDE6D6'] },
    { bg: '#E3D9C6', ink: '#3A1F2B', cols: ['#9B2948', '#FF7251', '#FFCA7B', '#3A1F2B', '#4BA3A8'] },
    { bg: '#F0D9CF', ink: '#2B2D42', cols: ['#EF476F', '#2B2D42', '#F78C6B', '#06A77D', '#FFD166'] },
    { bg: '#1C1A3B', ink: '#F4E9DA', cols: ['#F84AA7', '#FF8A5B', '#FFD98A', '#5B6CFF', '#F4E9DA'] }
  ];

  // Quiet palettes: ink, graphite, stone and earth on warm paper, plus a few
  // near-black grounds. Where there is an accent it is the last colour.
  var QUIET = [
    { bg: '#DCD5C7', ink: '#2A2A2C', cols: ['#2A2A2C', '#55565A', '#8A8882', '#B5AFA3'] },
    { bg: '#D9D4C8', ink: '#1F2A44', cols: ['#1F2A44', '#3E4C6B', '#7C879C', '#B9A58A'] },
    { bg: '#DDD3C0', ink: '#3A2A20', cols: ['#3A2A20', '#6B4E3A', '#A0805E', '#C4AE8E'] },
    { bg: '#17181B', ink: '#D8D0C0', cols: ['#D8D0C0', '#8C8A84', '#4A4B4F', '#B5532F'] },
    { bg: '#D8D5C8', ink: '#2F3A34', cols: ['#2F3A34', '#5F6F62', '#9AA590', '#C2B59A'] },
    { bg: '#DBCFBF', ink: '#40302B', cols: ['#40302B', '#7D7469', '#C29A7C', '#9A5B45'] },
    { bg: '#151A26', ink: '#CFC9BA', cols: ['#CFC9BA', '#6F7C98', '#39445E', '#C2A15A'] },
    { bg: '#DAD4C6', ink: '#232323', cols: ['#232323', '#6E6A62', '#A39D90', '#B98A3C'] },
    { bg: '#141B19', ink: '#D5CFBF', cols: ['#D5CFBF', '#7E9488', '#3B4D46', '#B7694A'] },
    { bg: '#D3D6D2', ink: '#263238', cols: ['#263238', '#546A76', '#93A3A8', '#B7A68C'] },
    { bg: '#DCD3C3', ink: '#2B2B2B', cols: ['#2B2B2B', '#8C8478', '#BDB3A2', '#A8442F'] },
    { bg: '#1B1917', ink: '#D9CFBD', cols: ['#D9CFBD', '#9A8E7C', '#5A5148', '#C9A66B'] }
  ];

  // ---------- invented palettes ----------
  //
  // Colour schemes are built in OKLCH (perceptual lightness, chroma, hue) so
  // that lightness structure and harmony can be chosen deliberately, then
  // brought into sRGB by reducing chroma until the colour fits.

  function oklch(L, C, h) {
    var hr = h * Math.PI / 180, ca = Math.cos(hr), sa = Math.sin(hr);
    function lin(c) {
      var a = c * ca, b = c * sa;
      var l = L + 0.3963377774 * a + 0.2158037573 * b;
      var m = L - 0.1055613458 * a - 0.0638541728 * b;
      var q = L - 0.0894841775 * a - 1.2914855480 * b;
      l = l * l * l; m = m * m * m; q = q * q * q;
      return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * q];
    }
    function fits(v) { return v[0] >= -0.0005 && v[0] <= 1.0005 && v[1] >= -0.0005 && v[1] <= 1.0005 && v[2] >= -0.0005 && v[2] <= 1.0005; }
    var v = lin(C);
    if (!fits(v)) {
      var lo = 0, hi = C;
      for (var i = 0; i < 14; i++) { var mid = (lo + hi) / 2; if (fits(lin(mid))) lo = mid; else hi = mid; }
      v = lin(lo);
    }
    var out = '#';
    for (var k = 0; k < 3; k++) {
      var c = Math.min(1, Math.max(0, v[k]));
      c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      var n = Math.round(c * 255).toString(16);
      out += n.length < 2 ? '0' + n : n;
    }
    return out;
  }

  // The lightness at which each hue is at its most characteristic: yellows
  // high, blues and violets low. Keeps vivid colours clean instead of muddy.
  var NATURAL = [[0, 0.62], [30, 0.66], [60, 0.75], [90, 0.86], [110, 0.86], [140, 0.72], [165, 0.67],
    [200, 0.66], [230, 0.58], [265, 0.48], [300, 0.52], [330, 0.6], [360, 0.62]];
  function naturalL(h) {
    h = ((h % 360) + 360) % 360;
    for (var i = 1; i < NATURAL.length; i++) {
      if (h <= NATURAL[i][0]) {
        var a = NATURAL[i - 1], b = NATURAL[i];
        return a[1] + (b[1] - a[1]) * (h - a[0]) / (b[0] - a[0]);
      }
    }
    return 0.62;
  }

  function vividScheme(R) {
    var h0 = R.range(0, 360), hues, drop = [0, 0, 0, 0], weak = -1;
    var kind = R.pick(['analogous', 'analogous', 'split', 'triad', 'tonal', 'duotone']);
    if (kind === 'analogous') { hues = [h0, h0 + R.range(22, 34), h0 - R.range(24, 38), h0 + 180 + R.range(-15, 15)]; drop = [0, 0.06, -0.14, 0]; }
    else if (kind === 'split') { hues = [h0, h0 + 150, h0 + 210, h0 + R.range(15, 30)]; drop = [0, 0, 0, -0.16]; }
    else if (kind === 'triad') { hues = [h0, h0 + 120, h0 + 240, h0 + 120]; drop = [0, 0, 0, -0.2]; weak = 2; }
    else if (kind === 'tonal') { hues = [h0, h0 + 10, h0 - 10, h0 + 180]; drop = [-0.2, 0, 0.14, 0]; }
    else { var warm = R.range(20, 85), cool = R.range(195, 275); hues = [warm, cool, warm + R.range(10, 22), cool - R.range(15, 30)]; drop = [0, 0, 0.1, -0.16]; }
    var dark = R.chance(0.33);
    var bg = dark
      ? oklch(R.range(0.2, 0.26), R.range(0.035, 0.065), R.chance(0.5) ? hues[0] : R.range(240, 300))
      : oklch(R.range(0.885, 0.91), R.range(0.018, 0.034), R.chance(0.7) ? R.range(68, 95) : hues[0]);
    var ink = dark ? oklch(0.92, 0.025, R.range(70, 95)) : oklch(R.range(0.2, 0.26), 0.04, R.chance(0.5) ? hues[1] : R.range(250, 290));
    var cols = hues.map(function (h, i) {
      var L = naturalL(h) + drop[i] + R.range(-0.04, 0.04);
      L = dark ? Math.max(0.6, Math.min(0.88, L)) : Math.max(0.36, Math.min(0.83, L));
      return oklch(L, R.range(0.13, 0.2) * (i === weak ? 0.55 : 1), h);
    });
    cols.push(ink);
    return { bg: bg, ink: ink, cols: cols };
  }

  function quietScheme(R) {
    var tone = R.pick([[260, 0.006], [R.range(50, 90), R.range(0.02, 0.045)], [R.range(220, 270), R.range(0.02, 0.05)],
      [R.range(140, 170), R.range(0.02, 0.04)], [R.range(-30, 20), R.range(0.02, 0.04)]]);
    var h = tone[0], c = tone[1];
    var accentHue = R.pick([15, 35, 55, 80, 150, 200, 265]);
    var hasAccent = R.chance(0.7);
    var accent = oklch(R.range(0.56, 0.66), R.range(0.07, 0.105), accentHue);
    var j = function () { return R.range(-0.02, 0.02); };
    if (R.chance(0.25)) {
      var paper = oklch(0.86 + j(), 0.02, R.range(70, 95));
      return { bg: oklch(R.range(0.17, 0.21), Math.min(0.02, c), h), ink: paper,
        cols: [paper, oklch(0.64 + j(), c, h), oklch(0.42 + j(), c, h), hasAccent ? accent : oklch(0.52, c * 1.4, h)] };
    }
    var d = oklch(0.27 + j(), c, h);
    return { bg: oklch(R.range(0.845, 0.872), R.range(0.012, 0.024), R.chance(0.75) ? R.range(70, 95) : h), ink: d,
      cols: [d, oklch(0.43 + j(), c * 1.2, h), oklch(0.59 + j(), c * 1.1, h), hasAccent ? accent : oklch(0.73, c, h)] };
  }

  // Throws out schemes that would print badly: inks too close to the ground
  // or to each other, or everything sitting at one middling lightness.
  function schemeOk(P, mood) {
    var i, j, clear = 0, lo = 1, hi = 0;
    for (i = 0; i < P.cols.length; i++) {
      if (dist(P.cols[i], P.bg) > 0.17) clear++;
      var l = lum(P.cols[i]);
      lo = Math.min(lo, l); hi = Math.max(hi, l);
      for (j = 0; j < i; j++) if (dist(P.cols[i], P.cols[j]) < (mood === 'quiet' ? 0.05 : 0.09)) return false;
    }
    if (clear < Math.min(4, P.cols.length - (mood === 'quiet' ? 1 : 0))) return false;
    if (hi - lo < (mood === 'quiet' ? 0.22 : 0.28)) return false;
    return Math.abs(lum(P.ink) - lum(P.bg)) > 0.45;
  }

  function inventPalette(R, mood) {
    for (var t = 0; t < 12; t++) {
      var P = mood === 'quiet' ? quietScheme(R) : vividScheme(R);
      if (schemeOk(P, mood)) return P;
    }
    return null;
  }

  // A dark-to-light ramp whose hue drifts along an arc while chroma swells in
  // the middle. Used for reliefs and facets.
  function inventRamp(R, mood) {
    var quiet = mood === 'quiet';
    var h0, arc, mid, guard = 0;
    do {
      h0 = R.range(0, 360); arc = (R.chance(0.5) ? 1 : -1) * (quiet ? R.range(0, 45) : R.range(50, 150));
      mid = (((h0 + arc * 0.45) % 360) + 360) % 360;
      // Yellow-greens at middling lightness turn to olive mud.
    } while (!quiet && mid > 78 && mid < 140 && guard++ < 20);
    var peak = quiet ? R.range(0.02, 0.055) : R.range(0.13, 0.19);
    var lo = R.range(0.17, 0.25), hi = quiet ? R.range(0.82, 0.87) : R.range(0.86, 0.92);
    var out = [];
    for (var i = 0; i < 6; i++) {
      var t = i / 5;
      out.push(oklch(lo + (hi - lo) * t, 0.02 + peak * Math.pow(Math.sin(Math.PI * (0.12 + 0.76 * t)), 1.2), h0 + arc * t));
    }
    return out;
  }

  function inventAura(R, mood) {
    var quiet = mood === 'quiet';
    var hc = R.range(0, 360), k = quiet ? R.range(0.4, 0.9) : R.range(0.7, 1.4);
    var dark = R.chance(0.6);
    var Ls = dark ? [0.42, 0.6, 0.74, 0.86] : [0.5, 0.64, 0.76, 0.86];
    if (R.chance(0.5)) Ls.reverse();
    var hs = [-45, -15, 18, 52];
    var cols = hs.map(function (dh, i) {
      return oklch(Ls[i] - (quiet ? 0.06 : 0), quiet ? R.range(0.02, 0.05) : R.range(0.1, 0.17) * (Ls[i] > 0.8 ? 0.7 : 1), hc + dh * k);
    });
    return { base: dark ? oklch(0.2, quiet ? 0.015 : 0.06, hc - 60 * k) : oklch(quiet ? 0.83 : 0.87, quiet ? 0.015 : 0.04, hc + 60 * k), cols: cols };
  }

  function inventRiso(R, mood) {
    if (mood === 'quiet') {
      var h = R.range(0, 360);
      return { paper: oklch(0.89, 0.018, R.range(70, 95)), inks: [oklch(0.32, R.range(0.01, 0.045), h),
        oklch(0.6, R.range(0.04, 0.08), h + R.pick([150, 180, 210, 30])), oklch(0.76, 0.05, R.range(60, 95))] };
    }
    var h0 = R.range(0, 360), off = R.pick([[120, 240], [150, 210], [40, 180], [180, 220]]);
    return { paper: oklch(0.91, 0.025, R.range(68, 95)), inks: [h0, h0 + off[0], h0 + off[1]].map(function (hh) {
      return oklch(Math.max(0.55, naturalL(hh) + R.range(-0.03, 0.05)), R.range(0.16, 0.21), hh);
    }) };
  }

  function inventLand(R, mood) {
    var hh = R.range(0, 360), sky, sun, hills, i;
    function tones(Ls, Cs, h, drift) { return Ls.map(function (L, q) { return oklch(L, Cs[q], h + drift * q); }); }
    if (mood === 'quiet') {
      var c = R.range(0.012, 0.04);
      if (R.chance(0.25)) {
        return { sky: tones([0.15, 0.21, 0.31], [c, c, c], hh, 0), sun: oklch(0.86, 0.03, 85),
          hills: tones([0.37, 0.28, 0.2, 0.13], [c, c, c, c * 0.6], hh, 0) };
      }
      return { sky: tones([0.8, 0.83, 0.86], [0.014, 0.016, 0.02], R.chance(0.5) ? hh : 80, 0),
        sun: R.chance(0.5) ? oklch(0.9, 0.03, 85) : oklch(0.6, 0.12, R.range(30, 50)),
        hills: tones([0.72, 0.56, 0.39, 0.21], [c, c * 1.2, c * 1.2, c * 0.7], hh, 0) };
    }
    var kind = R.pick(['dusk', 'dusk', 'day', 'night']);
    if (kind === 'dusk') {
      var top = R.range(255, 300), warm = R.range(50, 78);
      return { sky: [oklch(0.32, 0.1, top), oklch(0.6, 0.15, top + R.range(60, 100)), oklch(0.81, 0.13, warm)], sun: oklch(0.91, 0.1, 92),
        hills: tones([0.62, 0.46, 0.31, 0.18], [0.12, 0.12, 0.09, 0.05], top + R.range(40, 90), -15) };
    }
    if (kind === 'night') {
      var n = R.range(250, 290);
      return { sky: tones([0.18, 0.28, 0.43], [0.06, 0.09, 0.1], n, 6), sun: oklch(0.92, 0.04, 90),
        hills: tones([0.5, 0.37, 0.25, 0.15], [0.09, 0.09, 0.07, 0.05], n + R.range(-25, 25), 0) };
    }
    var s0 = R.pick([R.range(60, 95), R.range(190, 240), R.range(-10, 30)]);
    return { sky: tones([0.89, 0.86, 0.81], [0.035, 0.06, 0.1], s0, R.range(-18, 18)), sun: oklch(0.64, 0.19, R.range(22, 45)),
      hills: tones([0.76, 0.59, 0.41, 0.23], [0.06, 0.1, 0.09, 0.05], hh, R.range(-12, 12)) };
  }

  // ---------- shared drawing helpers ----------

  // A small repeating screen (dots or rules) in one colour, for shading.
  function screenPattern(ctx, col, kind, sp) {
    sp = Math.max(4, Math.round(sp));
    var t = document.createElement('canvas');
    t.width = t.height = sp;
    var c = t.getContext('2d');
    c.fillStyle = typeof col === 'string' ? col : css(col);
    if (kind === 'dots') { c.beginPath(); c.arc(sp / 2, sp / 2, sp * 0.3, 0, TAU); c.fill(); }
    else c.fillRect(0, 0, sp, sp * 0.45);
    return ctx.createPattern(t, 'repeat');
  }

  // Shows the finished picture through one or more windows cut in a sheet of
  // paper: a matted panel, a diptych or triptych, a roundel, or an off-centre
  // panel with open space beside it.
  function mount(ctx, W, H, R, mood) {
    var kind = R.pick(['panel', 'panel', 'triptych', 'triptych', 'diptych', 'roundel']);
    var dark = R.chance(0.25);
    var paper = mood === 'quiet'
      ? (dark ? oklch(0.19, 0.012, R.range(0, 360)) : oklch(R.range(0.845, 0.87), 0.016, R.range(65, 95)))
      : (dark ? oklch(0.21, 0.035, R.range(240, 300)) : oklch(R.range(0.88, 0.905), 0.026, R.range(65, 95)));
    var m = H * R.range(0.075, 0.1), mx = m * 1.15, i;
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    if (kind === 'panel') ctx.rect(mx, m, W - 2 * mx, H - 2 * m);
    else if (kind === 'roundel') { ctx.moveTo(W / 2 + H * 0.41, H / 2); ctx.arc(W / 2, H / 2, H * 0.41, 0, TAU); }
    else {
      var n = kind === 'diptych' ? 2 : 3, gut = m * R.range(0.4, 0.75);
      var w = (W - 2 * mx - (n - 1) * gut) / n;
      for (i = 0; i < n; i++) ctx.rect(mx + i * (w + gut), m, w, H - 2 * m);
    }
    ctx.fillStyle = paper;
    ctx.fill('evenodd');
  }


  // Print texture: fine speckle plus soft, larger mottling.
  function texture(ctx, W, H, R, amount) {
    var size = 384, i;
    var tile = document.createElement('canvas');
    tile.width = tile.height = size;
    var tctx = tile.getContext('2d');
    var img = tctx.createImageData(size, size);
    var d = img.data;
    var s = (R() * 4294967296) >>> 0;
    for (i = 0; i < d.length; i += 4) {
      s = Math.imul(s, 1664525) + 1013904223 | 0;
      var v = ((s >>> 8) & 0xffff) / 65535;
      var w = v * 2 - 1;
      var c = w < 0 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = c;
      d[i + 3] = Math.abs(w) * Math.abs(w) * 255 * amount * (w < 0 ? 1.15 : 0.85);
    }
    tctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.fillStyle = ctx.createPattern(tile, 'repeat');
    ctx.fillRect(0, 0, W, H);

    // A second, coarser pass gives the paper some tooth.
    ctx.globalAlpha = 0.3;
    ctx.scale(2.3, 2.3);
    ctx.fillRect(0, 0, W / 2.3 + 1, H / 2.3 + 1);
    ctx.restore();
    tile.width = tile.height = 0;
  }

  // Soft radial blob of colour fading to nothing.
  function blob(ctx, x, y, r, col, alpha) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    var steps = 8;
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var a = Math.exp(-3.2 * t * t) - Math.exp(-3.2);
      g.addColorStop(t, css(col, Math.max(0, a / (1 - Math.exp(-3.2)) * alpha)));
    }
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Closed smooth curve through points (Catmull-Rom as beziers).
  function smoothClosed(ctx, pts) {
    var n = pts.length;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      ctx.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1]);
    }
    ctx.closePath();
  }

  // ---------- style: flow field ----------

  // Packs non-overlapping strokes that follow a vector field.
  function packFlow(o) {
    var cs = o.cell;
    var gw = Math.ceil((o.x1 - o.x0) / cs) + 1, gh = Math.ceil((o.y1 - o.y0) / cs) + 1;
    var grid = new Uint8Array(gw * gh);
    var R = o.rng, lines = [];

    function taken(x, y) {
      var gx = Math.floor((x - o.x0) / cs), gy = Math.floor((y - o.y0) / cs);
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return true;
      return grid[gy * gw + gx] === 1;
    }
    function discFree(x, y, r) {
      if (taken(x, y)) return false;
      for (var rr = cs; rr <= r; rr += cs) {
        var n = Math.max(6, Math.ceil(TAU * rr / cs));
        for (var k = 0; k < n; k++) {
          var a = k / n * TAU;
          if (taken(x + Math.cos(a) * rr, y + Math.sin(a) * rr)) return false;
        }
      }
      return true;
    }
    function frontFree(x, y, r, dir) {
      var n = Math.max(3, Math.ceil(Math.PI * r / cs));
      for (var k = 0; k <= n; k++) {
        var a = dir - Math.PI / 2 + k / n * Math.PI;
        if (taken(x + Math.cos(a) * r, y + Math.sin(a) * r)) return false;
      }
      return true;
    }
    function stamp(x, y, r) {
      var gx0 = Math.max(0, Math.floor((x - r - o.x0) / cs)), gx1 = Math.min(gw - 1, Math.floor((x + r - o.x0) / cs));
      var gy0 = Math.max(0, Math.floor((y - r - o.y0) / cs)), gy1 = Math.min(gh - 1, Math.floor((y + r - o.y0) / cs));
      var r2 = r * r;
      for (var gy = gy0; gy <= gy1; gy++) {
        var cy = o.y0 + (gy + 0.5) * cs - y;
        for (var gx = gx0; gx <= gx1; gx++) {
          var cx = o.x0 + (gx + 0.5) * cs - x;
          if (cx * cx + cy * cy <= r2) grid[gy * gw + gx] = 1;
        }
      }
    }
    function walk(x, y, r, flip, maxSteps) {
      var out = [], prev = o.angle(x, y) + flip;
      for (var s = 0; s < maxSteps; s++) {
        // The field has no direction of its own: keep heading the way we were.
        var a = o.angle(x, y);
        if (Math.cos(a - prev) < 0) a += Math.PI;
        if (Math.cos(a - prev) < 0.985) break;
        prev = a;
        x += Math.cos(a) * cs; y += Math.sin(a) * cs;
        if (!o.inside(x, y) || !frontFree(x, y, r, a)) break;
        out.push(x, y);
      }
      return out;
    }

    o.classes.forEach(function (cl) {
      var r = cl.w / 2 + o.gap + cl.w * 0.12;
      for (var t = 0; t < cl.tries; t++) {
        var x = o.x0 + R() * (o.x1 - o.x0), y = o.y0 + R() * (o.y1 - o.y0);
        var want = cl.len * (0.35 + 0.65 * R());
        if (!o.inside(x, y) || !discFree(x, y, r)) continue;
        var steps = Math.ceil(want / cs / 2);
        var fwd = walk(x, y, r, 0, steps), back = walk(x, y, r, Math.PI, steps);
        var pts = [];
        for (var i = back.length - 2; i >= 0; i -= 2) pts.push(back[i], back[i + 1]);
        pts.push(x, y);
        for (i = 0; i < fwd.length; i++) pts.push(fwd[i]);
        if (pts.length / 2 * cs < cl.min) continue;
        for (i = 0; i < pts.length; i += 2) stamp(pts[i], pts[i + 1], cl.w / 2 + cs * 0.5);
        lines.push({ pts: pts, w: cl.w });
      }
    });
    return lines;
  }

  function styleFlow(ctx, W, H, R, P, mood) {
    var u = Math.min(W, H) / 1080;
    var noise = makeNoise(R);
    var light = lum(P.bg) > 0.5;
    var layout = R.pick(['panel', 'panel', 'bleed', 'bleed', 'disc', 'split']);

    // Ground the strokes sit on.
    var ground = P.bg;
    if (layout !== 'bleed' && R.chance(0.6)) {
      ground = light ? P.ink : R.pick(P.cols.filter(function (c) { return lum(c) > 0.3 && lum(c) < 0.8; }).concat([P.ink]));
    } else if (layout === 'bleed' && light && R.chance(0.35)) {
      ground = P.ink;
    }
    var cols = P.cols.concat([P.bg]).filter(function (c) { return dist(c, ground) > 0.16; });

    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);

    var m = Math.round(H * 0.085);
    var cx = W / 2, cy = H / 2, rad = H * 0.43;
    var x0 = -80 * u, y0 = -80 * u, x1 = W + 80 * u, y1 = H + 80 * u;
    var inside = function () { return true; };
    ctx.save();
    ctx.beginPath();
    if (layout === 'panel') {
      x0 = m * 1.15; y0 = m; x1 = W - m * 1.15; y1 = H - m;
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      inside = function (x, y) { return x > x0 && x < x1 && y > y0 && y < y1; };
    } else if (layout === 'split') {
      // Two or three windows onto the same field.
      var parts = R.int(2, 3), gut = m * R.range(0.4, 0.7);
      x0 = m * 1.15; y0 = m; x1 = W - m * 1.15; y1 = H - m;
      var partW = (x1 - x0 - (parts - 1) * gut) / parts;
      for (var pi = 0; pi < parts; pi++) ctx.rect(x0 + pi * (partW + gut), y0, partW, y1 - y0);
      inside = function (x, y) {
        if (x <= x0 || x >= x1 || y <= y0 || y >= y1) return false;
        return (x - x0) % (partW + gut) < partW;
      };
    } else if (layout === 'disc') {
      x0 = cx - rad; x1 = cx + rad; y0 = cy - rad; y1 = cy + rad;
      ctx.arc(cx, cy, rad, 0, TAU);
      inside = function (x, y) { var dx = x - cx, dy = y - cy; return dx * dx + dy * dy < rad * rad; };
    } else {
      ctx.rect(0, 0, W, H);
    }
    ctx.fillStyle = ground;
    ctx.fill();
    ctx.clip();

    // The field: smooth noise, optionally swirled around a point.
    var freq = R.range(0.55, 1.5) / H;
    var turn = R.range(0.7, 1.9) * TAU;
    var base = R.range(0, TAU);
    var swirl = R.chance(0.35) ? R.range(0.35, 0.8) : 0;
    var sx = W * R.range(0.25, 0.75), sy = H * R.range(0.25, 0.75);
    var angle = function (x, y) {
      var a = base + (noise.fbm(x * freq, y * freq, 2) - 0.5) * turn;
      if (swirl) {
        var b = Math.atan2(y - sy, x - sx) + Math.PI / 2;
        // Blend as undirected lines (double angles) so there are no fold lines.
        a = 0.5 * Math.atan2(Math.sin(2 * a) * (1 - swirl) + Math.sin(2 * b) * swirl, Math.cos(2 * a) * (1 - swirl) + Math.cos(2 * b) * swirl);
      }
      return a;
    };

    var mood = R.pick(['bold', 'bold', 'mixed', 'mixed', 'fine']);
    var k = layout === 'disc' ? 0.7 : 1;
    var classes;
    if (mood === 'bold') {
      classes = [
        { w: 64 * u * k, tries: 60, len: 1500 * u, min: 260 * u },
        { w: 30 * u * k, tries: 260, len: 1300 * u, min: 160 * u },
        { w: 13 * u * k, tries: 1200, len: 1000 * u, min: 80 * u },
        { w: 5 * u, tries: 5000, len: 800 * u, min: 30 * u }
      ];
    } else if (mood === 'mixed') {
      classes = [
        { w: 26 * u * k, tries: 160, len: 1400 * u, min: 200 * u },
        { w: 11 * u, tries: 900, len: 1100 * u, min: 100 * u },
        { w: 4.5 * u, tries: 6000, len: 900 * u, min: 40 * u }
      ];
    } else {
      classes = [
        { w: 9 * u, tries: 500, len: 1500 * u, min: 150 * u },
        { w: 4 * u, tries: 9000, len: 1200 * u, min: 50 * u }
      ];
    }
    var lines = packFlow({
      rng: R, cell: Math.max(2, 3 * u), x0: x0, y0: y0, x1: x1, y1: y1,
      inside: inside, angle: angle, classes: classes, gap: R.range(2.5, 6) * u
    });

    // Colour drifts across the picture so neighbouring strokes relate.
    var cf = R.range(0.6, 1.4) / H;
    var spread = R.range(0.5, 1.3);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    lines.forEach(function (ln) {
      var p = ln.pts, mid = (p.length >> 2) * 2;
      var t = noise.fbm(p[mid] * cf + 40, p[mid + 1] * cf + 40, 2) * cols.length * 1.8 + R() * spread;
      ctx.strokeStyle = cols[Math.floor(t) % cols.length];
      ctx.lineWidth = ln.w;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (var i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      if (p.length === 2) ctx.lineTo(p[0] + 0.01, p[1]);
      ctx.stroke();
    });
    ctx.restore();
    return 0.1;
  }

  // ---------- style: aura (soft colour fields) ----------

  var AURAS = [
    { base: '#1B1340', cols: ['#5B2A86', '#E0527A', '#FF8C5A', '#FFD27D'] },
    { base: '#EFD3BD', cols: ['#F7A072', '#EE6C6C', '#B565A7', '#F9D17A'] },
    { base: '#0C2D48', cols: ['#145DA0', '#2E8BC0', '#7FD1B9', '#F3E9A8'] },
    { base: '#2A0E1C', cols: ['#8E1B3A', '#E0452C', '#F78F3A', '#F6C96A'] },
    { base: '#2C2A5E', cols: ['#7161EF', '#B79CED', '#EF8FB3', '#F9C6A9'] },
    { base: '#1E2D24', cols: ['#3A7D5C', '#9BC88B', '#EAD98B', '#E98E5A'] },
    { base: '#10214A', cols: ['#2B59C3', '#7AA7F0', '#F56B4C', '#F9B36A'] },
    { base: '#EDD0C8', cols: ['#E8798A', '#D9455F', '#F2A65A', '#7A4EA3'] },
    { base: '#F0DDA9', cols: ['#F9B531', '#F47C3C', '#E8505B', '#69B7A8'] },
    { base: '#06141F', cols: ['#0F4C5C', '#1FA2A0', '#9FE0C6', '#E36A6A'] },
    { base: '#E9DCC9', cols: ['#2F6FDE', '#F2684A', '#F6B44A', '#F29CB7'] },
    { base: '#231942', cols: ['#5E548E', '#9F86C0', '#E0B1CB', '#F2A65A'] }
  ];

  var AURAS_QUIET = [
    { base: '#1B1D24', cols: ['#3A3F52', '#6B6470', '#A08C7C', '#C9B79C'] },
    { base: '#CFC8BA', cols: ['#9C8F7E', '#6F7480', '#D9C3A5', '#B79C8A'] },
    { base: '#20211F', cols: ['#4A4F45', '#7C7A68', '#B5A88C', '#8A5A44'] },
    { base: '#D2CEC6', cols: ['#8E98A3', '#B5B0A6', '#5E6772', '#C8B49C'] },
    { base: '#1A1F2B', cols: ['#2F3B55', '#5A6A8A', '#9AA3B0', '#C9B9A0'] },
    { base: '#D8CCBB', cols: ['#C19A7C', '#A6765E', '#8C8478', '#DCCDB6'] },
    { base: '#232021', cols: ['#4B3F42', '#7A6164', '#B08F86', '#D1BFA8'] },
    { base: '#CDD0CA', cols: ['#8FA097', '#5F7068', '#C3C0AE', '#A9A08C'] }
  ];

  function styleAura(ctx, W, H, R, P, mood) {
    var A = R.chance(0.5) ? inventAura(R, mood) : R.pick(mood === 'quiet' ? AURAS_QUIET : AURAS);
    var D = Math.max(W, H);
    var cols = R.shuffle(A.cols);
    var variant = R.pick(['orb', 'orb', 'mist', 'strata']);
    var i;

    ctx.fillStyle = A.base;
    ctx.fillRect(0, 0, W, H);

    function field(n, alpha, ox, oy, scale) {
      for (var j = 0; j < n; j++) {
        var c = cols[j % cols.length];
        blob(ctx, ox + R.range(-0.1, 1.1) * W * scale, oy + R.range(-0.1, 1.1) * H * scale,
          D * R.range(0.28, 0.6) * scale, c, alpha * R.range(0.7, 1));
      }
    }

    if (variant === 'strata') {
      // Soft horizontal bands melting into each other, tilted a little.
      var order = R.shuffle(cols);
      var bands = R.int(3, 4);
      var tilt = R.range(-0.12, 0.12) * H;
      var lg = ctx.createLinearGradient(W / 2 - tilt, 0, W / 2 + tilt, H);
      var at = 0;
      lg.addColorStop(0, css(mix(A.base, order[0], 0.35)));
      for (i = 0; i < bands; i++) {
        at += (1 / bands) * R.range(0.75, 1.25);
        lg.addColorStop(Math.min(0.97, Math.max(0.05, at - 0.5 / bands)), css(order[i % order.length]));
      }
      lg.addColorStop(1, css(mix(A.base, order[(bands - 1) % order.length], 0.45)));
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, W, H);
      for (i = 0; i < 3; i++) {
        blob(ctx, W * R.range(0, 1), H * R.range(0.1, 0.9), D * R.range(0.3, 0.5), order[(i + 1) % order.length], 0.4);
      }
    } else {
      field(R.int(5, 8), 0.85, 0, 0, 1);
    }

    if (variant === 'orb') {
      // A crisp disc holding its own gradient, floating on the field.
      var r = H * R.range(0.24, 0.36);
      var ox = W * R.pick([0.5, 0.5, 0.36, 0.64]) + R.range(-0.02, 0.02) * W;
      var oy = H * R.range(0.46, 0.54);
      var inner = R.shuffle(cols);
      blob(ctx, ox, oy + r * 0.25, r * 2.1, lum(A.base) > 0.5 ? '#FFFFFF' : inner[0], 0.28);
      ctx.save();
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, TAU);
      ctx.clip();
      var ga = R.range(0, TAU);
      var g = ctx.createLinearGradient(ox - Math.cos(ga) * r, oy - Math.sin(ga) * r, ox + Math.cos(ga) * r, oy + Math.sin(ga) * r);
      g.addColorStop(0, css(inner[0]));
      g.addColorStop(0.5, css(inner[1]));
      g.addColorStop(1, css(inner[2]));
      ctx.fillStyle = g;
      ctx.fillRect(ox - r, oy - r, r * 2, r * 2);
      for (i = 0; i < 3; i++) {
        var ba = R.range(0, TAU), bd = r * R.range(0.3, 0.9);
        blob(ctx, ox + Math.cos(ba) * bd, oy + Math.sin(ba) * bd, r * R.range(0.8, 1.3), inner[(i + 2) % inner.length], 0.8);
      }
      ctx.restore();
    } else if (variant === 'mist') {
      // A glowing ring gives the haze something to hang on.
      var mr = H * R.range(0.2, 0.3), mw = mr * R.range(0.28, 0.5);
      var mx = W * R.pick([0.5, 0.38, 0.62]), my = H * R.range(0.46, 0.54);
      var mc = lum(A.base) > 0.5 ? R.pick(cols) : mix(cols.slice().sort(function (p, q) { return lum(q) - lum(p); })[0], '#FFFFFF', 0.25);
      var rg = ctx.createRadialGradient(mx, my, mr - mw, mx, my, mr + mw);
      for (i = 0; i <= 10; i++) {
        var rt = i / 10, ra = Math.exp(-Math.pow((rt - 0.5) * 4.4, 2));
        rg.addColorStop(rt, css(mc, i === 0 || i === 10 ? 0 : ra * 0.9));
      }
      ctx.fillStyle = rg;
      ctx.fillRect(mx - mr - mw, my - mr - mw, (mr + mw) * 2, (mr + mw) * 2);
    }
    return 0.16;
  }

  // ---------- style: Bauhaus grid ----------

  function styleBauhaus(ctx, W, H, R, P) {
    var light = lum(P.bg) > 0.5;
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);

    // Square cells in a centred panel with a paper margin.
    var mx = H * 0.08, options = [];
    for (var c = 4; c <= 9; c++) {
      var s0 = (W - 2 * mx) / c, r0 = Math.floor((H - 2 * mx * 0.8) / s0);
      var my0 = (H - r0 * s0) / 2;
      if (r0 >= 2 && my0 <= mx * 1.9) options.push([c, r0, s0, my0]);
    }
    var o = R.pick(options);
    var cols = o[0], rows = o[1], s = o[2], my = o[3];

    var inks = R.shuffle(P.cols.filter(function (q) { return dist(q, P.bg) > 0.14; })).slice(0, 3);
    var grounds = [P.bg, P.bg, inks[0], inks[0], inks[1]];
    // Each picture speaks a small vocabulary of shapes.
    var motifs = R.pick([
      ['quarter', 'quarter', 'half', 'circle'],
      ['quarter', 'quarter', 'arcs', 'dot'],
      ['quarter', 'tri', 'tri', 'bars'],
      ['half', 'half', 'circle', 'bars'],
      ['leaf', 'quarter', 'quarter', 'circle'],
      ['arcs', 'arcs', 'quarter', 'rings'],
      ['tri', 'tri', 'quarter', 'dot'],
      ['quarter', 'half', 'rings', 'bars']
    ]);

    function pair() {
      var g = R.pick(grounds), f, guard = 0;
      do { f = R.pick(inks.concat([P.bg])); } while (dist(f, g) < 0.14 && guard++ < 20);
      return [g, f];
    }

    // Some pictures shade a share of their shapes with a dot or line screen.
    var screened = R.chance(0.35) ? R.range(0.15, 0.4) : 0;
    var screenKind = R.pick(['dots', 'lines']), screens = {};
    function screenOf(col) {
      var key = typeof col === 'string' ? col : css(col);
      if (!screens[key]) screens[key] = screenPattern(ctx, col, screenKind, s / R.pick([7, 9, 12]));
      return screens[key];
    }

    function cell(x, y, sz, type) {
      var pr = pair(), rot = R.int(0, 3), i;
      var useScreen = screened && type !== 'bars' && type !== 'rings' && type !== 'arcs' && type !== 'dot' && R.chance(screened);
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, sz, sz); ctx.clip();
      ctx.fillStyle = typeof pr[0] === 'string' ? pr[0] : css(pr[0]);
      ctx.fillRect(x - 1, y - 1, sz + 2, sz + 2);
      ctx.translate(x + sz / 2, y + sz / 2);
      ctx.rotate(rot * Math.PI / 2);
      ctx.translate(-sz / 2, -sz / 2);
      ctx.fillStyle = ctx.strokeStyle = useScreen ? screenOf(pr[1]) : pr[1];
      ctx.beginPath();
      if (type === 'quarter') {
        ctx.moveTo(0, 0); ctx.arc(0, 0, sz, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
      } else if (type === 'half') {
        ctx.arc(sz / 2, 0, sz / 2, 0, Math.PI); ctx.closePath(); ctx.fill();
      } else if (type === 'circle') {
        ctx.arc(sz / 2, sz / 2, sz * 0.5, 0, TAU); ctx.fill();
      } else if (type === 'dot') {
        ctx.arc(sz / 2, sz / 2, sz * 0.2, 0, TAU); ctx.fill();
      } else if (type === 'rings') {
        ctx.lineWidth = sz * 0.09;
        for (i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(sz / 2, sz / 2, sz * (0.5 - 0.045) * i / 3, 0, TAU); ctx.stroke(); }
      } else if (type === 'arcs') {
        ctx.lineWidth = sz * 0.125;
        for (i = 1; i <= 4; i++) { ctx.beginPath(); ctx.arc(0, 0, sz * (i / 4 - 0.0625), 0, Math.PI / 2); ctx.stroke(); }
      } else if (type === 'leaf') {
        ctx.arc(0, 0, sz, 0, Math.PI / 2); ctx.arc(sz, sz, sz, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill();
      } else if (type === 'tri') {
        ctx.moveTo(0, 0); ctx.lineTo(sz, 0); ctx.lineTo(0, sz); ctx.closePath(); ctx.fill();
      } else if (type === 'bars') {
        for (i = 0; i < 4; i++) ctx.fillRect(0, sz * (i / 4), sz, sz / 8);
      }
      ctx.restore();
    }

    var used = [], x, y;
    var bx = (W - cols * s) / 2;
    // A few double-size cells break the rhythm.
    var bigs = cols * rows >= 12 ? R.int(1, Math.max(1, Math.round(cols * rows / 14))) : 0;
    if (rows < 2) bigs = 0;
    for (var b = 0; b < bigs; b++) {
      var gx = R.int(0, cols - 2), gy = R.int(0, rows - 2);
      if (used[gy * cols + gx] || used[gy * cols + gx + 1] || used[(gy + 1) * cols + gx] || used[(gy + 1) * cols + gx + 1]) continue;
      used[gy * cols + gx] = used[gy * cols + gx + 1] = used[(gy + 1) * cols + gx] = used[(gy + 1) * cols + gx + 1] = 1;
      cell(bx + gx * s, my + gy * s, s * 2, R.pick(motifs.filter(function (q) { return q !== 'dot' && q !== 'bars'; })));
    }
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        if (used[y * cols + x]) continue;
        cell(bx + x * s, my + y * s, s, R.pick(motifs));
      }
    }
    return 0.12;
  }

  // ---------- style: risograph ----------

  var RISO = [
    { paper: '#EFE6D4', inks: ['#FF48B0', '#0078BF', '#FFD900'] },
    { paper: '#EDE3CF', inks: ['#F15060', '#00838A', '#FFB511'] },
    { paper: '#E9E4D6', inks: ['#FF6C2F', '#3255A4', '#62C6B8'] },
    { paper: '#F0E4D0', inks: ['#FF48B0', '#00A95C', '#FFD900'] },
    { paper: '#E6E1D6', inks: ['#765BA7', '#FF6C2F', '#5EC8E5'] },
    { paper: '#EEDFC8', inks: ['#3D5588', '#F65058', '#FFB511'] },
    { paper: '#EFD9D0', inks: ['#0078BF', '#F15060', '#FFD900'] },
    { paper: '#DCE3DD', inks: ['#FF665E', '#235BA8', '#F7C331'] },
    { paper: '#E8DDC6', inks: ['#00838A', '#FF6C2F', '#E45D9F'] },
    { paper: '#EDE6D6', inks: ['#407060', '#FF7477', '#FFB511'] }
  ];

  var RISO_QUIET = [
    { paper: '#E3DBCB', inks: ['#2B2B2B', '#8C8478', '#B9A27F'] },
    { paper: '#E2DCCF', inks: ['#1F2A44', '#A65A3A', '#9A9A92'] },
    { paper: '#E1DCCD', inks: ['#3A4A3F', '#B98A3C', '#8A8580'] },
    { paper: '#E4DACA', inks: ['#2B2B2B', '#9C3F2E', '#C2B8A3'] },
    { paper: '#DEDDD4', inks: ['#33415C', '#7D8597', '#B7A68C'] },
    { paper: '#E3D8C6', inks: ['#4A3728', '#A0805E', '#6E7B74'] }
  ];

  function styleRiso(ctx, W, H, R, P, mood) {
    var S = R.chance(0.5) ? inventRiso(R, mood) : R.pick(mood === 'quiet' ? RISO_QUIET : RISO);
    var u = Math.min(W, H) / 1080;
    var inks = R.shuffle(S.inks);
    ctx.fillStyle = css(mix(S.paper, '#8A7F6A', 0.07));
    ctx.fillRect(0, 0, W, H);

    // Speckle tile used to knock tiny holes out of each ink layer.
    var tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    var tctx = tile.getContext('2d');
    var img = tctx.createImageData(256, 256), d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var v = R();
      d[i + 3] = v > 0.62 ? (v - 0.62) / 0.38 * 200 : 0;
    }
    tctx.putImageData(img, 0, 0);

    var layer = document.createElement('canvas');
    layer.width = W; layer.height = H;
    var L = layer.getContext('2d');

    // Shapes sit on loose anchor points around the middle of the sheet.
    var anchors = [];
    var n = R.int(5, 7);
    for (i = 0; i < n; i++) {
      anchors.push([W * (0.2 + 0.6 * ((i + R.range(0.15, 0.85)) / n)), H * R.range(0.32, 0.68)]);
    }
    anchors = R.shuffle(anchors);
    var kinds = R.shuffle(['disc', 'disc', 'ring', 'half', 'arch', 'pill', 'bars', 'blob', 'quarter', 'dots']);
    var ai = 0;

    function shape(kind, x, y, sz) {
      var rot = R.pick([0, 0, Math.PI / 2, Math.PI, -Math.PI / 2]) + R.range(-0.05, 0.05), j;
      L.save();
      L.translate(x, y);
      L.rotate(rot);
      L.beginPath();
      if (kind === 'disc') { L.arc(0, 0, sz * 0.5, 0, TAU); L.fill(); }
      else if (kind === 'ring') { L.lineWidth = sz * R.range(0.1, 0.2); L.arc(0, 0, sz * 0.45, 0, TAU); L.stroke(); }
      else if (kind === 'half') { L.arc(0, 0, sz * 0.55, 0, Math.PI); L.closePath(); L.fill(); }
      else if (kind === 'quarter') { L.moveTo(-sz * 0.4, -sz * 0.4); L.arc(-sz * 0.4, -sz * 0.4, sz * 0.9, 0, Math.PI / 2); L.closePath(); L.fill(); }
      else if (kind === 'arch') {
        var aw = sz * 0.36;
        L.moveTo(-aw, sz * 0.5); L.lineTo(-aw, -sz * 0.1); L.arc(0, -sz * 0.1, aw, Math.PI, 0); L.lineTo(aw, sz * 0.5); L.closePath(); L.fill();
      } else if (kind === 'pill') {
        var ph = sz * 0.22;
        L.arc(-sz * 0.4, 0, ph, Math.PI / 2, Math.PI * 1.5); L.arc(sz * 0.4, 0, ph, -Math.PI / 2, Math.PI / 2); L.closePath(); L.fill();
      } else if (kind === 'bars') {
        var nb = R.int(4, 7), bw = sz * 0.9 / (nb * 2 - 1);
        for (j = 0; j < nb; j++) L.fillRect(-sz * 0.45 + j * bw * 2, -sz * 0.42, bw, sz * 0.84);
      } else if (kind === 'dots') {
        var nd = R.int(5, 7), step = sz * 0.9 / nd;
        for (j = 0; j < nd * nd; j++) {
          L.moveTo(0, 0);
          L.beginPath();
          L.arc(-sz * 0.45 + (j % nd + 0.5) * step, -sz * 0.45 + (Math.floor(j / nd) + 0.5) * step, step * 0.3, 0, TAU);
          L.fill();
        }
      } else {
        var pts = [], np = R.int(5, 7);
        for (j = 0; j < np; j++) {
          var a = j / np * TAU, rr = sz * R.range(0.34, 0.58);
          pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
        }
        smoothClosed(L, pts); L.fill();
      }
      L.restore();
    }

    inks.forEach(function (ink, li) {
      L.globalCompositeOperation = 'source-over';
      L.clearRect(0, 0, W, H);
      var count = li === 0 ? 2 : R.int(2, 3);
      for (var q = 0; q < count; q++) {
        var a = anchors[ai % anchors.length], kind = kinds[ai % kinds.length];
        ai++;
        var sz = H * R.range(0.34, 0.62) * (kind === 'dots' || kind === 'bars' ? 0.8 : 1);
        // Some shapes fade across, like a halftone gradient.
        if (R.chance(0.3) && kind !== 'ring') {
          var ga = R.range(0, TAU);
          var g = L.createLinearGradient(a[0] - Math.cos(ga) * sz * 0.5, a[1] - Math.sin(ga) * sz * 0.5,
            a[0] + Math.cos(ga) * sz * 0.5, a[1] + Math.sin(ga) * sz * 0.5);
          g.addColorStop(0, css(ink, 1));
          g.addColorStop(1, css(ink, 0.25));
          L.fillStyle = g;
        } else {
          L.fillStyle = ink;
        }
        L.strokeStyle = ink;
        shape(kind, a[0] + R.range(-0.03, 0.03) * W, a[1] + R.range(-0.04, 0.04) * H, sz);
      }
      // Uneven ink: speckled holes.
      L.globalCompositeOperation = 'destination-out';
      L.globalAlpha = 0.5;
      L.fillStyle = L.createPattern(tile, 'repeat');
      L.save();
      L.translate(R.int(0, 255), R.int(0, 255));
      L.fillRect(-256, -256, W + 512, H + 512);
      L.restore();
      L.globalAlpha = 1;

      // Print the layer slightly out of register.
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.92;
      ctx.translate(W / 2 + R.range(-5, 5) * u, H / 2 + R.range(-5, 5) * u);
      ctx.rotate(R.range(-0.004, 0.004));
      ctx.drawImage(layer, -W / 2, -H / 2);
      ctx.restore();
    });
    layer.width = layer.height = 0;
    tile.width = tile.height = 0;
    return 0.12;
  }

  // ---------- style: contours (layered paper relief) ----------

  var RELIEFS = [
    ['#0B2545', '#13466B', '#1F7A8C', '#7FB7A3', '#E8D9A8', '#F2A65A', '#E4572E'],
    ['#2A1A40', '#5B2A86', '#B5387A', '#EE6C4D', '#F7B267', '#F6E3B4'],
    ['#0F2D2A', '#1F5F4F', '#4E9F6D', '#B7CE7A', '#F3E3A0', '#F2A06A'],
    ['#F2E4CC', '#F2C48D', '#EE8E6B', '#D4526E', '#7E3F8F', '#2D2A5A'],
    ['#101935', '#27408B', '#3E7CB1', '#81C3D7', '#F0E6D2', '#F4A259'],
    ['#3B1F2B', '#8C2F39', '#D1603D', '#EDA35A', '#F3D9A4'],
    ['#F1E6D0', '#C9D7B5', '#7FB69E', '#3F8F8B', '#225E73', '#1B2F52'],
    ['#1B1B3A', '#693668', '#A74482', '#F84AA7', '#FF8A5B', '#FFD98A'],
    ['#F3E2C7', '#F7C59F', '#F28F6B', '#E4572E', '#8E2A3A', '#3A1730'],
    ['#14213D', '#1D4E89', '#00B2CA', '#7DCFB6', '#FBD1A2', '#F79256']
  ];

  var RELIEFS_QUIET = [
    ['#DAD3C5', '#B9B2A5', '#8F8A80', '#63605A', '#3C3B39', '#1E1E1F'],
    ['#D8D3C6', '#AEB3B8', '#7A869A', '#4A5874', '#28344E', '#141A2A'],
    ['#DDD2BD', '#C4AE8E', '#A0805E', '#6B4E3A', '#3A2A20', '#1C1512'],
    ['#D9D6C8', '#B4BBA8', '#84927F', '#566A5C', '#33443C', '#18211E'],
    ['#141518', '#22252B', '#343943', '#4B5361', '#6A7385', '#B98A3C'],
    ['#191614', '#2B2521', '#463B33', '#6B594B', '#9A8672', '#D5C8B2'],
    ['#DCD4C6', '#C9BBAA', '#B09A8A', '#8C6F66', '#5B4648', '#2A2228']
  ];

  function pickRamp(R, mood) {
    return R.chance(0.5) ? inventRamp(R, mood) : R.pick(mood === 'quiet' ? RELIEFS_QUIET : RELIEFS);
  }

  function styleContour(ctx, W, H, R, P, mood) {
    var stops = pickRamp(R, mood);
    if (R.chance(0.5)) stops = stops.slice().reverse();
    var u = Math.min(W, H) / 1080;
    var noise = makeNoise(R);
    var levels = R.int(7, 13);
    var cs = Math.max(4, Math.round(9 * u));
    var gw = Math.ceil(W / cs) + 1, gh = Math.ceil(H / cs) + 1;
    var f = new Float32Array(gw * gh);
    var freq = R.range(0.9, 1.9) / H;
    var warp = R.range(0, 0.5) * H;
    var island = R.chance(0.5);
    var px = W * R.range(0.3, 0.7), py = H * R.range(0.35, 0.65);
    var x, y, i, lo = 1e9, hi = -1e9;
    for (y = 0; y < gh; y++) {
      for (x = 0; x < gw; x++) {
        var wx = x * cs, wy = y * cs;
        var qx = wx + (noise(wx * freq * 0.6 + 31, wy * freq * 0.6) - 0.5) * warp;
        var qy = wy + (noise(wx * freq * 0.6, wy * freq * 0.6 + 57) - 0.5) * warp;
        var v = noise.fbm(qx * freq, qy * freq, 3);
        if (island) {
          var dx = (wx - px) / W, dy = (wy - py) / H;
          v += 0.42 * Math.exp(-(dx * dx * 5 + dy * dy * 4));
        }
        f[y * gw + x] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }

    ctx.fillStyle = css(stops[0]);
    ctx.fillRect(0, 0, W, H);
    var shadow = css(mix(stops[0], '#000000', 0.7), 0.3);
    var sdx = 3 * u, sdy = 5 * u;

    for (var k = 1; k < levels; k++) {
      var th = lo + (hi - lo) * (k / levels) * 0.985;
      var path = new Path2D();
      for (y = 0; y < gh - 1; y++) {
        var run = -1;
        for (x = 0; x < gw - 1; x++) {
          i = y * gw + x;
          var a = f[i], b = f[i + 1], c = f[i + gw + 1], d = f[i + gw];
          var ia = a > th, ib = b > th, ic = c > th, id = d > th;
          if (ia && ib && ic && id) { if (run < 0) run = x; continue; }
          if (run >= 0) { path.rect(run * cs, y * cs, (x - run) * cs, cs); run = -1; }
          if (!ia && !ib && !ic && !id) continue;
          var X = x * cs, Y = y * cs, first = true;
          var pt = function (qx2, qy2) { if (first) { path.moveTo(qx2, qy2); first = false; } else path.lineTo(qx2, qy2); };
          if (ia) pt(X, Y);
          if (ia !== ib) pt(X + cs * (th - a) / (b - a), Y);
          if (ib) pt(X + cs, Y);
          if (ib !== ic) pt(X + cs, Y + cs * (th - b) / (c - b));
          if (ic) pt(X + cs, Y + cs);
          if (ic !== id) pt(X + cs * (th - d) / (c - d), Y + cs);
          if (id) pt(X, Y + cs);
          if (id !== ia) pt(X, Y + cs * (th - a) / (d - a));
          path.closePath();
        }
        if (run >= 0) path.rect(run * cs, y * cs, (gw - 1 - run) * cs, cs);
      }
      ctx.save();
      ctx.translate(sdx, sdy);
      ctx.fillStyle = shadow;
      ctx.fill(path);
      ctx.restore();
      ctx.fillStyle = css(ramp(stops, k / (levels - 1)));
      ctx.fill(path);
    }
    if (R.chance(0.22)) {
      // An overprinted disc or ring floating above the relief.
      var or = H * R.range(0.16, 0.3), ox = W * R.range(0.25, 0.75), oy = H * R.range(0.35, 0.65);
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = ctx.strokeStyle = css(ramp(stops, R.range(0.45, 0.75)));
      ctx.beginPath(); ctx.arc(ox, oy, or, 0, TAU);
      if (R.chance(0.5)) ctx.fill(); else { ctx.lineWidth = or * R.range(0.12, 0.3); ctx.stroke(); }
      ctx.restore();
    }
    return 0.14;
  }

  // ---------- style: ranges (layered horizon) ----------

  var LANDS = [
    { sky: ['#2B2D5B', '#C2557A', '#F7A66B'], sun: '#FFD98A', hills: ['#D98A7E', '#9C4A78', '#4A2A5E', '#1F1535'] },
    { sky: ['#EFD2A7', '#F4B183', '#EE8A6A'], sun: '#E4572E', hills: ['#E3A27A', '#C8603F', '#8A3340', '#3A1A2B'] },
    { sky: ['#C9DDD3', '#EFDAB3', '#F6B89A'], sun: '#F26B4E', hills: ['#A9CBB9', '#5FA39A', '#2F7F7B', '#12393F'] },
    { sky: ['#0D1B3D', '#23366E', '#6A63A8'], sun: '#F2E6C4', hills: ['#6C7BC0', '#3B4C8A', '#1C2A5C', '#0A1230'] },
    { sky: ['#F3DE9E', '#F9B872', '#F28066'], sun: '#D94E4E', hills: ['#F0A66E', '#D9654F', '#8F3A5E', '#3F1D4A'] },
    { sky: ['#F1D0CB', '#F2B5B9', '#E790A5'], sun: '#FFEED2', hills: ['#B9D3C4', '#74AD9F', '#3F827D', '#1E4B52'] },
    { sky: ['#1F2A60', '#6B4E9B', '#F08A5D'], sun: '#FBD46D', hills: ['#E8785E', '#B13F64', '#6A2A5E', '#2A1A40'] },
    { sky: ['#E5DEC4', '#DCCFA0', '#E5B76E'], sun: '#C8553D', hills: ['#BFC79A', '#7E9E6A', '#47704E', '#233D2C'] },
    { sky: ['#12343B', '#1F6E72', '#E9C46A'], sun: '#F4E3B1', hills: ['#E9A15B', '#D1603D', '#7A2E3A', '#2B1425'] },
    { sky: ['#DCE6EC', '#B9D3E6', '#F4C9B8'], sun: '#F27D52', hills: ['#8FB3D9', '#4F7CB8', '#27468C', '#141F4D'] }
  ];

  var LANDS_QUIET = [
    { sky: ['#C9CBC6', '#D3D0C6', '#DBD3C4'], sun: '#E6DFCF', hills: ['#B4B8B5', '#8A9294', '#5A6468', '#2B3236'] },
    { sky: ['#1B2030', '#39415A', '#8A7F86'], sun: '#D9CDB8', hills: ['#5F6880', '#3D4660', '#252C42', '#12151F'] },
    { sky: ['#D9CDB8', '#D3C2A6', '#C9B08E'], sun: '#A65A3A', hills: ['#B8A486', '#8D775C', '#5C4A3A', '#2A211B'] },
    { sky: ['#D5D8CF', '#CBD0C4', '#C3C5B4'], sun: '#E4DDCB', hills: ['#A9B3A3', '#7B8B7B', '#4E6156', '#243029'] },
    { sky: ['#111214', '#1F2126', '#3A3B40'], sun: '#CFC7B6', hills: ['#4A4B50', '#34353A', '#222327', '#121214'] },
    { sky: ['#CFC6C2', '#D6C7BD', '#DCC5B0'], sun: '#B5532F', hills: ['#B7A7A2', '#8C7C7C', '#5A5058', '#2A2630'] },
    { sky: ['#C5CCD3', '#D0D2D0', '#DAD3C6'], sun: '#E5DDCC', hills: ['#9FADB9', '#6F8194', '#44566B', '#1E2937'] }
  ];

  function styleRanges(ctx, W, H, R, P, mood) {
    var S = R.chance(0.5) ? inventLand(R, mood) : R.pick(mood === 'quiet' ? LANDS_QUIET : LANDS);
    var u = Math.min(W, H) / 1080;
    var noise = makeNoise(R);
    var i, x;

    var horizon = H * R.range(0.5, 0.66);
    var g = ctx.createLinearGradient(0, 0, 0, horizon + H * 0.1);
    g.addColorStop(0, S.sky[0]); g.addColorStop(0.6, S.sky[1]); g.addColorStop(1, S.sky[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Sun with hard-edged halos, like overprinted discs.
    var sr = H * R.range(0.09, 0.17);
    var sx = W * R.pick([R.range(0.2, 0.36), R.range(0.64, 0.8), R.range(0.44, 0.56)]);
    var sy = horizon - H * R.range(0.12, 0.3);
    var halos = R.int(2, 4);
    for (i = halos; i >= 1; i--) {
      ctx.fillStyle = css(S.sun, 0.1);
      ctx.beginPath(); ctx.arc(sx, sy, sr * (1 + i * R.range(0.5, 0.62)), 0, TAU); ctx.fill();
    }
    ctx.fillStyle = S.sun;
    ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.fill();

    var n = R.int(6, 9);
    var step = Math.max(3, 4 * u);
    var peaky = R.range(0.1, 0.65);
    var bases = [];
    for (i = 0; i <= n; i++) bases.push(horizon + (H * 1.04 - horizon) * Math.pow(i / n, 1.35));
    for (i = 0; i < n; i++) {
      var t = i / (n - 1);
      var amp = H * (0.07 + 0.1 * Math.sin(t * Math.PI) + 0.05 * t) * R.range(0.8, 1.25);
      var fr = R.range(1.1, 2) / W * (1.5 - t * 0.8);
      var off = R.range(0, 100);
      var far = (1 - t) * peaky;
      ctx.beginPath();
      ctx.moveTo(-step, H + 10);
      for (x = -step; x <= W + step; x += step) {
        var v = noise.fbm(x * fr + off, i * 7.3, 4);
        var ridge = 1 - Math.abs(noise.fbm(x * fr * 1.7 + off, i * 3.1 + 50, 3) * 2 - 1);
        var hgt = v * (1 - far) + ridge * ridge * far * 0.9;
        ctx.lineTo(x, bases[i] - (hgt - 0.3) * amp * 2);
      }
      ctx.lineTo(W + step, H + 10);
      ctx.closePath();
      // Each range fades into haze towards its foot.
      var col = ramp(S.hills, t);
      var hg = ctx.createLinearGradient(0, bases[i] - amp, 0, bases[i + 1] + amp * 0.6);
      hg.addColorStop(0, css(col));
      hg.addColorStop(1, css(mix(col, t < 0.75 ? S.sky[2] : S.hills[S.hills.length - 1], 0.42 * (1 - t * 0.5))));
      ctx.fillStyle = hg;
      ctx.fill();
    }
    return 0.17;
  }

  // ---------- style: ink wash ----------

  // Splits every edge of a polygon and pushes the new point off the line.
  function roughen(pts, amt, R) {
    var out = [], n = pts.length;
    for (var i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var g = (R() + R() + R() - 1.5) * amt;
      out.push(a, [(a[0] + b[0]) / 2 - dy * g + dx * (R() - 0.5) * amt, (a[1] + b[1]) / 2 + dx * g + dy * (R() - 0.5) * amt]);
    }
    return out;
  }

  // Watercolour wash: many faint, differently ragged copies of one shape,
  // so the middle builds up and the edge feathers away.
  function wash(ctx, base, col, R, layers, alpha, rough) {
    base = roughen(base, rough * 0.7, R);
    ctx.fillStyle = css(col, alpha);
    for (var l = 0; l < layers; l++) {
      var p = roughen(roughen(roughen(roughen(base, rough, R), rough * 0.9, R), rough * 0.8, R), rough * 0.7, R);
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      for (var i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.closePath();
      ctx.fill();
    }
  }

  // One loaded-brush stroke: many bristles, solid where the brush lands and
  // breaking up into dry streaks as it runs out.
  function brush(ctx, x0, y0, x1, y1, width, col, R, noise, u) {
    var dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy);
    var nx = -dy / len, ny = dx / len;
    var n = Math.max(10, Math.round(width / (1.5 * u)));
    var segs = Math.max(10, Math.ceil(len / (14 * u)));
    var bow = R.range(-0.04, 0.04) * len, so = R.range(0, 500);
    var load = R.range(0.02, 0.2), dryness = R.range(0.35, 0.8);
    ctx.lineCap = 'butt';
    for (var b = 0; b < n; b++) {
      var across = b / (n - 1) - 0.5;
      var edge = Math.abs(across) * 2;
      var lw = u * R.range(2.2, 4.6), bo = R.range(0, 9);
      var t0 = R.range(0, 0.02) + edge * edge * R.range(0, 0.03), t1 = 1 - R.range(0, 0.1) * (0.4 + edge);
      var px = 0, py = 0, level = -1;
      for (var sI = 0; sI <= segs; sI++) {
        var t = t0 + (t1 - t0) * sI / segs;
        var off = across * width * (1 + 0.12 * Math.sin(t * 5 + so)) + bow * Math.sin(t * Math.PI) + (noise(t * 2.5 + bo, b * 0.11 + so) - 0.5) * 9 * u;
        var qx = x0 + dx * t + nx * off, qy = y0 + dy * t + ny * off;
        if (sI > 0) {
          var v = noise(t * (2.2 + len / (520 * u)) + so, b * 0.16 + so) * 0.75 + noise(t * 9 + so, b * 0.7) * 0.25;
          var a = Math.min(1, Math.max(0, (v - load - dryness * Math.pow(t, 1.6) * (0.6 + 0.5 * edge) + 0.28) * 5));
          var q = Math.round(a * 5);
          if (q !== level) {
            if (level > 0) ctx.stroke();
            level = q;
            if (q > 0) {
              ctx.strokeStyle = css(col, q / 5 * 0.82);
              ctx.lineWidth = lw;
              ctx.beginPath(); ctx.moveTo(px, py);
            }
          }
          if (q > 0) ctx.lineTo(qx, qy);
        }
        px = qx; py = qy;
      }
      if (level > 0) ctx.stroke();
    }
  }

  function styleInk(ctx, W, H, R, P, mood) {
    var u = Math.min(W, H) / 1080;
    var noise = makeNoise(R);
    // Ink belongs on paper: swap a dark ground for a light one.
    if (lum(P.bg) < 0.5) P = R.pick((mood === 'quiet' ? QUIET : PALETTES).filter(function (q) { return lum(q.bg) > 0.5; }));
    var tones = P.cols.filter(function (c) { return dist(c, P.bg) > 0.12; }).sort(function (a, b) { return lum(a) - lum(b); });
    var accent = P.cols[P.cols.length - 1];
    var variant = R.pick(['strata', 'strata', 'blots', 'strokes', 'strokes']);
    var i, j, pts;

    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);

    function disc(x, y, r, col, layers, alpha) {
      pts = [];
      for (j = 0; j < 28; j++) pts.push([x + Math.cos(j / 28 * TAU) * r, y + Math.sin(j / 28 * TAU) * r]);
      wash(ctx, pts, col, R, layers, alpha, 0.2);
    }

    if (variant === 'strata') {
      // Brushed bands with paper between, heavier towards the bottom.
      disc(W * R.range(0.25, 0.75), H * R.range(0.2, 0.32), H * R.range(0.05, 0.085), accent, 30, 0.05);
      var n = R.int(3, 5);
      var top = H * R.range(0.46, 0.54), span = H * 0.9 - top;
      for (i = 0; i < n; i++) {
        var t = n > 1 ? i / (n - 1) : 1;
        var bh = span / n * R.range(0.3, 0.55) * (0.6 + 0.8 * t);
        var yc = top + span * (i + 0.5) / n;
        var xl = W * (R.chance(0.5) ? R.range(0.08, 0.3) : R.range(0.05, 0.09));
        var xr = W * (R.chance(0.5) ? R.range(0.7, 0.92) : R.range(0.91, 0.95));
        brush(ctx, xl, yc + H * R.range(-0.008, 0.008), xr, yc + H * R.range(-0.012, 0.012), bh,
          mix(mix(tones[0], P.bg, 0.55), tones[0], t), R, noise, u);
      }
    } else if (variant === 'blots') {
      // A few pools of wash and one ruled line.
      var k = R.int(2, 3);
      var bx = W * R.range(0.3, 0.4), by = H * R.range(0.42, 0.5);
      for (i = 0; i < k; i++) {
        var br = H * R.range(0.15, 0.26) * (i === 0 ? 1.15 : 0.8);
        disc(bx, by, br, i === k - 1 ? accent : tones[i % tones.length], 36, 0.03);
        bx += br * R.range(1, 1.5); by += H * R.range(-0.1, 0.1);
      }
      ctx.strokeStyle = css(P.ink, 0.6);
      ctx.lineWidth = Math.max(1.5, 2.4 * u);
      var ly = H * R.range(0.72, 0.8);
      ctx.beginPath(); ctx.moveTo(W * 0.16, ly); ctx.lineTo(W * 0.84, ly); ctx.stroke();
    } else {
      // Dry-brush strokes and a small seal.
      var m = R.int(1, 3);
      var gap = H * R.range(0.2, 0.25);
      var sy = H * 0.5 - (m - 1) * gap / 2;
      for (i = 0; i < m; i++) {
        var bw = H * R.range(0.07, 0.15) * (m === 1 ? 1.4 : 1);
        var ax = W * R.range(0.1, 0.22), bx2 = W * R.range(0.74, 0.9);
        if (m > 1 && R.chance(0.45)) bx2 = ax + (bx2 - ax) * R.range(0.5, 0.75);
        var yy = sy + i * gap;
        brush(ctx, ax, yy + H * R.range(-0.012, 0.012), bx2, yy + H * R.range(-0.03, 0.03), bw, tones[i === 0 ? 0 : R.int(0, Math.min(1, tones.length - 1))], R, noise, u);
      }
      var ss = H * 0.036;
      ctx.fillStyle = css(accent, 0.9);
      ctx.fillRect(W * R.pick([0.86, 0.1]), Math.min(H * 0.86, sy + (m - 1) * gap + H * 0.16), ss, ss);
    }
    return 0.13;
  }

  // ---------- style: line studies ----------

  function styleLines(ctx, W, H, R, P, mood) {
    var u = Math.min(W, H) / 1080;
    var noise = makeNoise(R);
    // Fine lines read best as ink on paper: swap a dark ground for a light one.
    if (lum(P.bg) < 0.5) P = R.pick((mood === 'quiet' ? QUIET : PALETTES).filter(function (q) { return lum(q.bg) > 0.5; }));
    var light = true;
    var inks = P.cols.filter(function (c) { return dist(c, P.bg) > 0.2; });
    var accent = P.cols[P.cols.length - 1];
    var variant = R.pick(['ruled', 'hatch', 'hatch', 'arcs', 'arcs']);
    var lw = Math.max(1.8, 2.7 * u);
    var i, j, k;

    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.lineCap = 'round';

    // A ruled line with a slightly unsteady hand.
    function rule(x0, y0, x1, y1, id) {
      var len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
      var n = Math.max(2, Math.ceil(len / (60 * u)));
      var nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
      ctx.beginPath();
      for (var q = 0; q <= n; q++) {
        var t = q / n, o = (noise(t * len / (240 * u) + id * 7.7, id * 1.3) - 0.5) * 2.4 * u;
        var x = x0 + (x1 - x0) * t + nx * o, y = y0 + (y1 - y0) * t + ny * o;
        if (q === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    if (variant === 'ruled') {
      // A quiet field of ruled lines, with a few bands lightly tinted.
      var ph = H * R.range(0.62, 0.76), pw = Math.min(W * 0.86, ph * R.pick([1, 1.3, 1.7, 2.1]));
      var px = (W - pw) / 2, py = (H - ph) / 2;
      var rows = R.pick([12, 16, 20, 24, 32]);
      var rh = ph / rows;
      ctx.fillStyle = css(mix(P.bg, inks[inks.length - 1], 0.1));
      ctx.fillRect(px, py, pw, ph);
      var tint = R.pick(inks.concat([accent]));
      var every = R.pick([2, 3, 4]);
      for (i = 0; i < rows; i++) {
        var on = R.chance(0.5) ? i % every === 0 : noise(i * 0.45, 3.1) > 0.56;
        if (on) { ctx.fillStyle = css(tint, light ? 0.16 : 0.22); ctx.fillRect(px, py + i * rh, pw, rh); }
      }
      ctx.lineWidth = lw;
      ctx.strokeStyle = css(P.ink, 0.6);
      for (i = 0; i <= rows; i++) rule(px, py + i * rh, px + pw, py + i * rh, i);
      if (R.chance(0.55)) {
        var colsN = Math.round(pw / (rh * R.pick([1, 2, 3])));
        ctx.strokeStyle = css(P.ink, 0.4);
        for (i = 0; i <= colsN; i++) rule(px + pw * i / colsN, py, px + pw * i / colsN, py + ph, 100 + i);
      }
      // One accented band.
      ctx.fillStyle = css(accent, 0.7);
      ctx.fillRect(px, py + R.int(2, rows - 3) * rh, pw * R.pick([1, 0.5, 0.25]), rh);
    } else if (variant === 'hatch') {
      // Overlapping plain shapes, each shaded with one direction of hatching.
      var count = R.int(3, 5);
      var cx = 0, cy = H * 0.5, spec = [];
      for (i = 0; i < count; i++) {
        var s0 = H * R.range(0.3, 0.58);
        spec.push([cx, s0, R.range(-0.11, 0.11) * H]);
        cx += s0 * R.range(0.45, 0.8);
      }
      // Fit the group to the sheet and centre it.
      var gl = spec[0][0] - spec[0][1] * 0.55, gr = spec[count - 1][0] + spec[count - 1][1] * 0.55;
      var gfit = Math.min(1, W * 0.8 / (gr - gl));
      for (i = 0; i < count; i++) {
        var sz = spec[i][1] * gfit;
        var kind = R.pick(['rect', 'disc', 'disc', 'half']);
        var x = W / 2 + (spec[i][0] - (gl + gr) / 2) * gfit, y = cy + spec[i][2];
        ctx.save();
        ctx.beginPath();
        if (kind === 'rect') ctx.rect(x - sz * 0.36, y - sz * 0.5, sz * 0.72, sz);
        else if (kind === 'disc') ctx.arc(x, y, sz * 0.5, 0, TAU);
        else { ctx.arc(x, y + sz * 0.25, sz * 0.55, Math.PI, 0); ctx.closePath(); }
        ctx.clip();
        var ang = R.pick([0, Math.PI / 4, Math.PI / 2, -Math.PI / 4]);
        var sp = R.pick([9, 12, 16, 22]) * u;
        var isAccent = i === count - 1 && R.chance(0.7);
        ctx.strokeStyle = css(isAccent ? accent : inks[i % Math.max(1, inks.length - 1)], isAccent ? 0.95 : 0.82);
        ctx.lineWidth = lw * R.pick([1, 1, 1.5]);
        var ca = Math.cos(ang), sa = Math.sin(ang), reach = sz;
        for (var d = -reach; d <= reach; d += sp) {
          rule(x - sa * d - ca * reach, y + ca * d - sa * reach, x - sa * d + ca * reach, y + ca * d + sa * reach, i * 50 + d / sp);
        }
        ctx.restore();
      }
    } else {
      // Nested arches standing on one ground line.
      var ground = H * R.range(0.68, 0.76);
      var groups = R.int(2, 4);
      var gx = W * R.range(0.14, 0.24);
      var order = [];
      for (i = 0; i < groups; i++) {
        var rad = H * R.range(0.16, 0.4);
        gx += rad * (i === 0 ? 1 : R.range(0.55, 1));
        order.push([gx, rad]);
        gx += rad * R.range(0.55, 1);
      }
      // Fit the row of arches to the sheet and centre it.
      var left = order[0][0] - order[0][1], right = order[groups - 1][0] + order[groups - 1][1];
      var fit = Math.min(1, W * 0.84 / (right - left));
      R.shuffle(order).forEach(function (g, gi) {
        var ax = W / 2 + (g[0] - (left + right) / 2) * fit, ar = g[1] * fit;
        var step = R.pick([12, 16, 22, 30]) * u;
        var isAccent = gi === groups - 1 && R.chance(0.6);
        ctx.fillStyle = P.bg;
        ctx.beginPath(); ctx.arc(ax, ground, ar + step * 0.5, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = css(isAccent ? accent : inks[gi % Math.max(1, inks.length - 1)], 0.9);
        ctx.lineWidth = lw * R.pick([1, 1, 1.6]);
        var inner = ar * R.pick([0, 0.2, 0.45]);
        for (var rr = ar; rr > inner + step * 0.5; rr -= step) {
          ctx.beginPath(); ctx.arc(ax, ground, rr, Math.PI, 0); ctx.stroke();
        }
      });
      ctx.strokeStyle = css(P.ink, 0.8);
      ctx.lineWidth = lw * 1.3;
      rule(W * 0.08, ground, W * 0.92, ground, 1);
    }
    return 0.11;
  }

  // ---------- style: rings ----------

  function styleRings(ctx, W, H, R, P, mood) {
    var u = Math.min(W, H) / 1080;
    var noise = makeNoise(R);
    var light = lum(P.bg) > 0.5;
    var cols = P.cols.filter(function (c) { return dist(c, P.bg) > 0.12; });
    if (mood !== 'quiet') cols = R.shuffle(cols);
    var filled = mood !== 'quiet' || R.chance(0.45);
    var layout = R.pick(['bleed', 'bleed', 'disc', 'panel']);
    var i;

    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    var m = H * 0.085;
    if (layout === 'disc') ctx.arc(W / 2, H / 2, H * 0.42, 0, TAU);
    else if (layout === 'panel') ctx.rect(m * 1.15, m, W - m * 2.3, H - m * 2);
    else ctx.rect(0, 0, W, H);
    ctx.clip();
    if (filled) { ctx.fillStyle = css(cols[cols.length - 1]); ctx.fillRect(0, 0, W, H); }

    var centres = layout === 'disc' ? 1 : R.int(1, 3);
    var amp = R.range(0.1, 0.3), fq = R.range(0.6, 1.4);
    for (var c = 0; c < centres; c++) {
      var cx = layout === 'disc' ? W * R.range(0.42, 0.58) : W * R.range(0.12, 0.88);
      var cy = H * R.range(0.2, 0.8);
      var maxR = centres === 1 ? Math.max(W, H) * 1.1 : H * R.range(0.35, 0.8);
      var gap = R.range(13, 30) * u * (filled ? 1.6 : 1);
      var ox = R.range(0, 50), oy = R.range(0, 50);
      var sq = R.range(0.75, 1.1);
      var radii = [], rad = maxR;
      while (rad > gap * 0.6) { radii.push(rad); rad -= gap * R.range(0.6, 1.5); }
      for (i = 0; i < radii.length; i++) {
        var r = radii[i];
        var N = Math.max(40, Math.min(220, Math.round(r / (5 * u))));
        ctx.beginPath();
        for (var k = 0; k <= N; k++) {
          var a = k / N * TAU;
          var wob = 1 + amp * (noise.fbm(Math.cos(a) * fq + ox + r / (H * 1.6), Math.sin(a) * fq + oy, 2) - 0.5) * 2;
          var x = cx + Math.cos(a) * r * wob, y = cy + Math.sin(a) * r * wob * sq;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        if (filled) {
          var t = noise(i * 0.35 + c * 9, 4.2) * cols.length * 1.5;
          ctx.fillStyle = css(mix(cols[Math.floor(t) % cols.length], cols[(Math.floor(t) + 1) % cols.length], mood === 'quiet' ? t % 1 : 0));
          ctx.fill();
        } else {
          if (i === 0 && centres > 1) { ctx.fillStyle = P.bg; ctx.fill(); }
          var heavy = noise(i * 0.5, c * 5 + 1.7);
          ctx.strokeStyle = css(mood === 'quiet' ? P.ink : cols[Math.floor(noise(i * 0.22, c + 8.8) * cols.length * 1.6) % cols.length], light ? 0.5 + heavy * 0.4 : 0.35 + heavy * 0.4);
          ctx.lineWidth = Math.max(1.5, (1.6 + heavy * heavy * 7) * u);
          ctx.stroke();
        }
      }
      if (!filled && R.chance(0.6)) {
        ctx.fillStyle = css(mood === 'quiet' ? P.cols[P.cols.length - 1] : cols[0]);
        ctx.beginPath(); ctx.arc(cx, cy, gap * 0.45, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
    return 0.12;
  }

  // ---------- style: tile weave (Truchet) ----------

  function styleTruchet(ctx, W, H, R, P, mood) {
    var cols = R.shuffle(P.cols.filter(function (c) { return dist(c, P.bg) > 0.16; }));
    var rows = R.pick([3, 4, 4, 5, 6, 8]);
    var s = H / rows, n = Math.ceil(W / s) + 1, ox = (W - n * s) / 2;
    var variant = R.pick(['ribbon', 'ribbon', 'fill']);
    var crossP = variant === 'ribbon' && R.chance(0.5) ? R.range(0.1, 0.3) : 0;
    var x, y, i;

    var ground = R.chance(0.35) ? cols[cols.length - 1] : P.bg;
    var inks = cols.filter(function (c) { return dist(c, ground) > 0.16; });
    if (dist(P.bg, ground) > 0.16) inks.push(P.bg);
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, W, H);

    if (variant === 'fill') {
      // Two colours meeting along quarter circles; parity keeps regions whole.
      var A = inks[0], B = ground, line = R.chance(0.5) ? inks[1 % inks.length] : null;
      var flips = [];
      for (i = 0; i < rows * n; i++) flips.push(R.chance(0.5));
      // Grounds first, then the quarter discs, so no seams show between tiles.
      for (var pass = 0; pass < 2; pass++) for (y = 0; y < rows; y++) {
        for (x = 0; x < n; x++) {
          var flip = flips[y * n + x], X = Math.round(ox + x * s), Y = Math.round(y * s);
          var even = ((x + y) % 2 === 0) !== flip;
          ctx.fillStyle = even ? A : B;
          if (pass === 0) { ctx.fillRect(X, Y, Math.ceil(s) + 1, Math.ceil(s) + 1); continue; }
          ctx.fillStyle = even ? B : A;
          var c1 = flip ? [X + s, Y] : [X, Y], c2 = flip ? [X, Y + s] : [X + s, Y + s];
          var a1 = flip ? Math.PI / 2 : 0, a2 = flip ? -Math.PI / 2 : Math.PI;
          ctx.beginPath(); ctx.moveTo(c1[0], c1[1]); ctx.arc(c1[0], c1[1], s / 2, a1, a1 + Math.PI / 2); ctx.closePath(); ctx.fill();
          ctx.beginPath(); ctx.moveTo(c2[0], c2[1]); ctx.arc(c2[0], c2[1], s / 2, a2, a2 + Math.PI / 2); ctx.closePath(); ctx.fill();
          if (line) {
            ctx.strokeStyle = line; ctx.lineWidth = s * 0.05;
            ctx.beginPath(); ctx.arc(c1[0], c1[1], s / 2, a1, a1 + Math.PI / 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(c2[0], c2[1], s / 2, a2, a2 + Math.PI / 2); ctx.stroke();
          }
        }
      }
      return 0.12;
    }

    // Ribbons: nested stripes following the arcs, passing over and under.
    var w = s * R.range(0.2, 0.36);
    var stripes = [[1, inks[0]]];
    if (R.chance(0.75)) stripes.push([R.range(0.5, 0.68), inks[1 % inks.length]]);
    if (stripes.length > 1 && R.chance(0.6)) stripes.push([R.range(0.16, 0.3), inks[2 % inks.length]]);
    var gap = w + s * 0.07;
    function strand(draw) {
      ctx.lineCap = 'butt';
      ctx.strokeStyle = ground; ctx.lineWidth = gap;
      ctx.beginPath(); draw(); ctx.stroke();
      for (i = 0; i < stripes.length; i++) {
        ctx.strokeStyle = stripes[i][1]; ctx.lineWidth = w * stripes[i][0];
        ctx.beginPath(); draw(); ctx.stroke();
      }
    }
    for (y = 0; y < rows; y++) {
      for (x = 0; x < n; x++) {
        (function (X, Y, kind, flip) {
          ctx.save();
          ctx.beginPath(); ctx.rect(X - 0.5, Y - 0.5, s + 1, s + 1); ctx.clip();
          if (kind === 'cross') {
            var first = flip;
            strand(function () { if (first) { ctx.moveTo(X + s / 2, Y - 1); ctx.lineTo(X + s / 2, Y + s + 1); } else { ctx.moveTo(X - 1, Y + s / 2); ctx.lineTo(X + s + 1, Y + s / 2); } });
            strand(function () { if (!first) { ctx.moveTo(X + s / 2, Y - 1); ctx.lineTo(X + s / 2, Y + s + 1); } else { ctx.moveTo(X - 1, Y + s / 2); ctx.lineTo(X + s + 1, Y + s / 2); } });
          } else if (flip) {
            strand(function () { ctx.arc(X + s, Y, s / 2, Math.PI / 2, Math.PI); });
            strand(function () { ctx.arc(X, Y + s, s / 2, -Math.PI / 2, 0); });
          } else {
            strand(function () { ctx.arc(X, Y, s / 2, 0, Math.PI / 2); });
            strand(function () { ctx.arc(X + s, Y + s, s / 2, Math.PI, Math.PI * 1.5); });
          }
          ctx.restore();
        })(ox + x * s, y * s, R.chance(crossP) ? 'cross' : 'arc', R.chance(0.5));
      }
    }
    return 0.12;
  }

  // ---------- style: packed circles ----------

  function stylePack(ctx, W, H, R, P, mood) {
    var u = Math.min(W, H) / 1080;
    var noise = makeNoise(R);
    var ground = P.bg;
    if (R.chance(0.3)) ground = R.pick(P.cols);
    var cols = P.cols.concat([P.bg]).filter(function (c) { return dist(c, ground) > 0.16; });
    if (mood !== 'quiet') cols = R.shuffle(cols);
    var layout = R.pick(['bleed', 'bleed', 'bleed', 'panel', 'disc']);
    var m = H * 0.085, i, j;

    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    if (layout === 'panel') ctx.rect(m * 1.15, m, W - m * 2.3, H - m * 2);
    else if (layout === 'disc') ctx.arc(W / 2, H / 2, H * 0.42, 0, TAU);
    else ctx.rect(0, 0, W, H);
    ctx.fillStyle = ground;
    ctx.fill();
    ctx.clip();

    var scale = R.pick([
      [[0.36, 1], [0.2, 4], [0.1, 30], [0.05, 150], [0.025, 600], [0.012, 1800]],
      [[0.26, 3], [0.14, 12], [0.07, 80], [0.035, 400], [0.017, 1500]],
      [[0.11, 40], [0.075, 120], [0.05, 400], [0.03, 900]],
      [[0.3, 2], [0.05, 120], [0.028, 500], [0.015, 1200]]
    ]);
    var gap = R.range(3, 11) * u, placed = [];
    scale.forEach(function (cl) {
      for (var t = 0; t < cl[1]; t++) {
        var r = H * cl[0] * R.range(0.82, 1.1);
        var x = R.range(-0.04, 1.04) * W, y = R.range(-0.06, 1.06) * H, ok = true;
        for (j = 0; j < placed.length; j++) {
          var q = placed[j], dx = q[0] - x, dy = q[1] - y, rr = q[2] + r + gap;
          if (dx * dx + dy * dy < rr * rr) { ok = false; break; }
        }
        if (ok) placed.push([x, y, r]);
      }
    });

    var looks = ['solid'].concat(R.shuffle(['rings', 'half', 'screen', 'outline', 'solid']).slice(0, R.int(1, 2)));
    var halfAngle = R.range(0, TAU), cf = R.range(0.6, 1.5) / H;
    var screens = {};
    placed.forEach(function (c) {
      var x = c[0], y = c[1], r = c[2];
      var t = Math.floor(noise.fbm(x * cf + 9, y * cf + 3, 2) * cols.length * 1.8 + R() * 1.1);
      var col = cols[t % cols.length], other = cols[(t + 1 + Math.floor(R() * (cols.length - 1))) % cols.length];
      var look = r < 14 * u ? 'solid' : R.pick(looks);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
      if (look === 'outline') { ctx.strokeStyle = col; ctx.lineWidth = Math.max(2 * u, r * 0.12); ctx.beginPath(); ctx.arc(x, y, r * 0.94, 0, TAU); ctx.stroke(); return; }
      if (look === 'screen') {
        if (!screens[col]) screens[col] = screenPattern(ctx, col, 'lines', R.pick([13, 17, 22]) * u);
        ctx.save(); ctx.clip(); ctx.translate(x, y); ctx.rotate(halfAngle); ctx.fillStyle = screens[col];
        ctx.fillRect(-r - 2, -r - 2, r * 2 + 4, r * 2 + 4); ctx.restore(); return;
      }
      ctx.fill();
      if (look === 'rings') {
        var k = r > 80 * u ? R.int(2, 4) : R.int(1, 2);
        for (var q = 1; q <= k; q++) {
          ctx.fillStyle = q % 2 ? other : col;
          ctx.beginPath(); ctx.arc(x, y, r * (1 - q / (k + 1)), 0, TAU); ctx.fill();
        }
      } else if (look === 'half') {
        ctx.fillStyle = other;
        ctx.beginPath(); ctx.arc(x, y, r, halfAngle, halfAngle + Math.PI); ctx.closePath(); ctx.fill();
      }
    });
    ctx.restore();
    return 0.12;
  }

  // ---------- style: folded facets ----------

  function styleFacets(ctx, W, H, R, P, mood) {
    var stops = pickRamp(R, mood);
    if (R.chance(0.5)) stops = stops.slice().reverse();
    var noise = makeNoise(R);
    // A regular tessellation of triangles, shaded like pleated paper.
    var ny = R.pick([3, 4, 5, 6, 8, 10]);
    var h = H / ny, a = h * R.pick([2 / Math.sqrt(3), 2 / Math.sqrt(3), 1, 2]);
    var nx = Math.ceil(W / (a / 2)) + 2, ox = (W - (nx + 1) * a / 2) / 2;
    var mode = R.pick(['noise', 'sweep', 'sweep', 'radial']);
    var ang = R.range(0, TAU), dxs = Math.cos(ang), dys = Math.sin(ang);
    var fq = R.range(0.4, 1.2) / H, spread = R.range(0.02, 0.12), fold = R.range(0.05, 0.14);
    var px = W * R.range(0.2, 0.8), py = H * R.range(0.2, 0.8);
    var i, j;
    function value(x, y) {
      var nz = noise.fbm(x * fq, y * fq, 2);
      if (mode === 'sweep') return 0.5 + ((x - W / 2) * dxs + (y - H / 2) * dys) / (W * 0.55) * 0.5 + (nz - 0.5) * 0.4;
      if (mode === 'radial') { var d = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py)); return 1.05 - d / (W * 0.6) + (nz - 0.5) * 0.3; }
      return (nz - 0.5) * 2.1 + 0.5;
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.2;
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        var up = (i + j) % 2 === 0;
        var x0 = ox + i * a / 2, x1 = x0 + a / 2, x2 = x0 + a, yT = j * h, yB = yT + h;
        var base = ramp(stops, 0.1 + 0.9 * value(x1, yT + h * (up ? 0.62 : 0.38)) + R.range(-spread, spread));
        var sh = (up ? fold : -fold) * 0.6 + R.range(-fold, fold) * 0.5;
        ctx.fillStyle = ctx.strokeStyle = css(sh > 0 ? mix(base, '#FFFFFF', sh) : mix(base, '#000000', -sh));
        ctx.beginPath();
        if (up) { ctx.moveTo(x0, yB); ctx.lineTo(x1, yT); ctx.lineTo(x2, yB); }
        else { ctx.moveTo(x0, yT); ctx.lineTo(x2, yT); ctx.lineTo(x1, yB); }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    return 0.14;
  }

  // ---------- style: halftone ----------

  function styleHalftone(ctx, W, H, R, P, mood) {
    var u = Math.min(W, H) / 1080;
    var noise = makeNoise(R);
    var light = lum(P.bg) > 0.5;
    var inks = P.cols.filter(function (c) { return dist(c, P.bg) > 0.22; });
    if (mood !== 'quiet') inks = R.shuffle(inks);
    else inks = [inks[0], inks[1 % inks.length], P.cols[P.cols.length - 1]];
    var comp = R.pick(['sun', 'sun', 'twin', 'wave', 'bands']);
    var fq = R.range(0.5, 1.2) / H;

    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);

    function radial(cx, cy, r) {
      return function (x, y) { var d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)); return d > r ? 0 : Math.pow(1 - d / r, 1.15); };
    }
    var f1, f2;
    var sx = W * R.range(0.28, 0.72), sy = H * R.range(0.32, 0.5);
    if (comp === 'sun') {
      var hz = H * R.range(0.5, 0.68), wav = H * R.range(0.02, 0.07);
      f1 = radial(sx, sy, H * R.range(0.42, 0.7));
      f2 = function (x, y) { var t = (y - hz - (noise(x * fq * 1.5, 3.3) - 0.5) * wav * 2) / (H - hz); return t < 0 ? 0 : Math.min(1, 0.25 + t * 0.9); };
    } else if (comp === 'twin') {
      var off = H * R.range(0.25, 0.5), ta = R.range(-0.5, 0.5);
      f1 = radial(W / 2 - Math.cos(ta) * off, H / 2 - Math.sin(ta) * off, H * R.range(0.45, 0.65));
      f2 = radial(W / 2 + Math.cos(ta) * off, H / 2 + Math.sin(ta) * off, H * R.range(0.45, 0.65));
    } else if (comp === 'wave') {
      f1 = function (x, y) { return Math.max(0, Math.min(1, (noise.fbm(x * fq, y * fq, 2) - 0.34) * 2.6)); };
      f2 = function (x, y) { return Math.max(0, Math.min(1, (0.6 - noise.fbm(x * fq + 0.6, y * fq + 0.4, 2)) * 2.6)); };
    } else {
      var kk = R.range(1.5, 4) * Math.PI / H, ba = R.range(-0.3, 0.3);
      f1 = function (x, y) { return Math.max(0, 0.5 + 0.62 * Math.sin((y + x * ba) * kk + noise(x * fq, y * fq) * 3)); };
      f2 = radial(sx, sy, H * R.range(0.3, 0.5));
    }

    var sp = R.pick([16, 20, 26, 34]) * u;
    var a0 = R.pick([0.26, 0.79, 0.52]);
    [[f1, inks[0], a0, sp], [f2, inks[1 % inks.length], a0 + R.pick([0.52, 1.05]), sp * R.pick([1, 1, 1.3])]].forEach(function (sc) {
      var f = sc[0], c = Math.cos(sc[2]), sn = Math.sin(sc[2]), step = sc[3];
      var span = Math.sqrt(W * W + H * H) / 2 + step;
      ctx.beginPath();
      for (var a = -span; a <= span; a += step) {
        for (var b = -span; b <= span; b += step) {
          var x = W / 2 + a * c - b * sn, y = H / 2 + a * sn + b * c;
          if (x < -step || y < -step || x > W + step || y > H + step) continue;
          var v = f(x, y);
          if (v < 0.035) continue;
          var r = step * 0.72 * Math.sqrt(v);
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, TAU);
        }
      }
      ctx.save();
      if (light) ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = sc[1];
      ctx.fill();
      ctx.restore();
    });
    if (comp !== 'wave' && R.chance(0.5)) {
      // One solid spot of colour to anchor the screens.
      ctx.fillStyle = inks[2 % inks.length];
      ctx.beginPath(); ctx.arc(sx, sy, H * R.range(0.05, 0.11), 0, TAU); ctx.fill();
    }
    return 0.1;
  }

  // ---------- style: marbling ----------

  function styleMarble(ctx, W, H, R, P, mood) {
    var cols = P.cols.filter(function (c) { return dist(c, P.bg) > 0.1; }).concat([P.bg]);
    if (mood !== 'quiet') cols = R.shuffle(cols);
    var ground = R.chance(0.5) ? P.bg : P.ink;
    var M = 180, drops = [], i, j, k;

    // Drops of colour spread on the bath, each pushing the others outwards.
    // Most sites get several drops in a row, which makes ringed stones.
    var sites = R.int(30, 48), last = -1;
    var big = R.range(0.065, 0.1);
    var floods = R.int(7, 11);
    sites += floods;
    for (i = 0; i < sites; i++) {
      // The first drops are floods of colour that cover the bath.
      var flood = i < floods;
      var sx0 = W * R.range(-0.08, 1.08), sy0 = H * R.range(-0.1, 1.1), nest = flood ? 1 : R.int(1, 4);
      for (var q0 = 0; q0 < nest; q0++) {
        var cx = sx0 + R.range(-1, 1) * H * 0.012, cy = sy0 + R.range(-1, 1) * H * 0.012;
        var r = flood ? H * R.range(0.3, 0.5) : H * big * R.range(0.6, 1.5) * (q0 === 0 ? 1.2 : 0.8), r2 = r * r;
        for (j = 0; j < drops.length; j++) {
          var pts = drops[j].pts;
          for (k = 0; k < pts.length; k += 2) {
            var dx = pts[k] - cx, dy = pts[k + 1] - cy, d2 = dx * dx + dy * dy || 1e-6;
            var f = Math.sqrt(1 + r2 / d2);
            pts[k] = cx + dx * f; pts[k + 1] = cy + dy * f;
          }
        }
        var np = new Float32Array(M * 2);
        for (k = 0; k < M; k++) { np[k * 2] = cx + Math.cos(k / M * TAU) * r; np[k * 2 + 1] = cy + Math.sin(k / M * TAU) * r; }
        var ci;
        do { ci = Math.floor(R() * cols.length); } while (ci === last && cols.length > 1);
        last = ci;
        drops.push({ pts: np, col: cols[ci] });
      }
    }

    // Then the surface is combed or stirred.
    {
      var ns = R.int(2, 5);
      for (i = 0; i < ns; i++) {
        var vx = W * R.range(0.1, 0.9), vy = H * R.range(0.1, 0.9), vr = H * R.range(0.2, 0.45), turn = R.range(1.2, 3) * (R.chance(0.5) ? 1 : -1);
        for (j = 0; j < drops.length; j++) {
          var q = drops[j].pts;
          for (k = 0; k < q.length; k += 2) {
            var ddx = q[k] - vx, ddy = q[k + 1] - vy, dd = Math.sqrt(ddx * ddx + ddy * ddy);
            var th = turn * Math.exp(-dd / vr), ct = Math.cos(th), st = Math.sin(th);
            q[k] = vx + ddx * ct - ddy * st; q[k + 1] = vy + ddx * st + ddy * ct;
          }
        }
      }
    }

    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, W, H);
    for (j = 0; j < drops.length; j++) {
      var dp = drops[j].pts;
      ctx.fillStyle = drops[j].col;
      ctx.beginPath();
      ctx.moveTo(dp[0], dp[1]);
      for (k = 2; k < dp.length; k += 2) ctx.lineTo(dp[k], dp[k + 1]);
      ctx.closePath();
      ctx.fill();
    }
    return 0.14;
  }

  // ---------- style: colour blocks ----------

  function styleBlocks(ctx, W, H, R, P, mood) {
    var cols = P.cols.filter(function (c) { return dist(c, P.bg) > 0.1; });
    if (mood !== 'quiet') cols = R.shuffle(cols);
    var comp = R.pick(['horizon', 'horizon', 'stack', 'stack', 'columns']);
    var matted = R.chance(0.55);
    var m = matted ? H * 0.085 : 0;
    var x0 = m * 1.15, y0 = m, w = W - 2 * x0, h = H - 2 * m, i;

    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();

    // Bands whose widths follow a steady progression.
    function bands(n, grow) {
      var out = [], sum = 0, v = 1;
      for (var q = 0; q < n; q++) { out.push(v); sum += v; v *= grow; }
      return out.map(function (t) { return t / sum; });
    }
    function paint(order, sizes, from, span, vertical) {
      var at = from;
      for (var q = 0; q < sizes.length; q++) {
        ctx.fillStyle = order[q % order.length];
        if (vertical) ctx.fillRect(at, y0, sizes[q] * span + 1, h);
        else ctx.fillRect(x0, at, w, sizes[q] * span + 1);
        at += sizes[q] * span;
      }
    }

    if (comp === 'horizon') {
      // Sky, a sun, and bands of ground that slice its reflection.
      var hz = y0 + h * R.range(0.5, 0.68);
      var sky = R.chance(0.5) ? P.bg : cols[cols.length - 1];
      var land = cols.filter(function (c) { return dist(c, sky) > 0.14; });
      var sun = land[0];
      land = land.length > 2 ? land.slice(1) : land;
      var sr = h * R.range(0.12, 0.26), sx = x0 + w * R.range(0.25, 0.75);
      var sy = hz - sr * R.pick([0, 0, R.range(0.4, 1.3)]);
      ctx.fillStyle = sky;
      ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = sun;
      ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.fill();
      var n = R.int(3, 6), sizes = bands(n, R.range(1.15, 1.6));
      paint(land, sizes, hz, y0 + h - hz, false);
      if (R.chance(0.7)) {
        var at = hz;
        for (i = 0; i < n; i++) {
          var bh = sizes[i] * (y0 + h - hz);
          if (i % 2 === 0) {
            ctx.save();
            ctx.beginPath(); ctx.rect(x0, at, w, bh); ctx.clip();
            ctx.fillStyle = sun;
            ctx.beginPath(); ctx.arc(sx, 2 * hz - sy, sr, 0, TAU); ctx.fill();
            ctx.restore();
          }
          at += bh;
        }
      }
    } else {
      // Stripes, with a disc in which the same stripes are shifted.
      var vertical = comp === 'columns';
      var n2 = R.int(5, 9), grow = R.pick([1, 1, R.range(1.12, 1.4), R.range(0.72, 0.9)]);
      var sz = bands(n2, grow), order = cols.concat(R.chance(0.6) ? [P.bg] : []);
      var from = vertical ? x0 : y0, span = vertical ? w : h;
      paint(order, sz, from, span, vertical);
      var discs = R.int(1, 2), rad = h * R.range(0.24, 0.36);
      for (i = 0; i < discs; i++) {
        var dx = x0 + w * (discs === 1 ? R.range(0.3, 0.7) : (i ? R.range(0.6, 0.78) : R.range(0.22, 0.4)));
        var dy = y0 + h * R.range(0.42, 0.58), dr = rad * (i ? R.range(0.5, 0.8) : 1);
        ctx.save();
        ctx.beginPath();
        if (R.chance(0.3)) ctx.arc(dx, dy, dr, vertical ? Math.PI / 2 : Math.PI, vertical ? Math.PI * 1.5 : TAU); else ctx.arc(dx, dy, dr, 0, TAU);
        ctx.closePath(); ctx.clip();
        paint(order.slice(1).concat([order[0]]), sz, from + span * sz[0] * R.pick([0, 0.5, -0.5]), span, vertical);
        ctx.restore();
      }
    }
    ctx.restore();
    return 0.13;
  }

  // ---------- titles ----------

  var WORDS = {
    flow: [['Current', 'Drift', 'Murmuration', 'Tide', 'Slipstream', 'Undertow', 'Windfield', 'Meander', 'Eddy', 'Backwater', 'Jetstream', 'Furrow', 'Estuary', 'Headwind'], 'Flow field'],
    aura: [['Aura', 'Afterglow', 'Halo', 'Haze', 'Bloom', 'Glow', 'Daybreak', 'Stillness', 'Corona', 'Ember', 'Gloaming', 'Penumbra', 'First Light', 'Solstice'], 'Colour field'],
    bauhaus: [['Composition', 'Construction', 'Arrangement', 'Rhythm', 'Module', 'Counterpoint', 'Syncopation', 'Figure', 'Assembly', 'Pavilion', 'Cadence', 'Fugue'], 'Geometric grid'],
    riso: [['Overprint', 'Two Passes', 'Registration', 'Proof', 'Edition', 'Layer Study', 'Offset', 'Trial Proof', 'Pressroom', 'Makeready', 'Colour Trial', 'Overlay'], 'Risograph'],
    contour: [['Relief', 'Isoline', 'Terrain', 'Strata', 'Bathymetry', 'Elevation', 'Shoal', 'Plateau', 'Watershed', 'Sounding', 'Caldera', 'Lagoon', 'Escarpment'], 'Paper relief'],
    ranges: [['Horizon', 'Ridgeline', 'Range', 'Low Sun', 'Far Hills', 'Evening Range', 'Foothills', 'High Pass', 'Moonrise', 'Last Light', 'Valley Mist', 'The Divide'], 'Layered horizon'],
    ink: [['Wash', 'Ink Study', 'Tideline', 'Still Water', 'Grey Rain', 'Brushwork', 'Reed Bed', 'Low Cloud', 'Shoreline', 'Breath', 'Winter Field', 'One Stroke'], 'Ink wash'],
    lines: [['Line Study', 'Measure', 'Interval', 'Plan', 'Ruled Field', 'Threshold', 'Elevation', 'Arcade', 'Section', 'Survey', 'Colonnade', 'Margin'], 'Line study'],
    rings: [['Growth Rings', 'Ripple', 'Heartwood', 'Echo', 'Still Pond', 'Annual', 'Agate', 'Cross Section', 'Sapwood', 'Resonance', 'Geode', 'Dropped Stone'], 'Ring study'],
    truchet: [['Weave', 'Knotwork', 'Loop', 'Tessera', 'Braid', 'Lattice', 'Switchback', 'Interlace', 'Plait', 'Circuit', 'Meander Tile', 'Cloister'], 'Tile weave'],
    pack: [['Cluster', 'Colony', 'Pebbles', 'Constellation', 'Gathering', 'Spore', 'Droplets', 'Shoal', 'Seedbed', 'Assembly', 'Foam', 'Archipelago'], 'Packed circles'],
    facets: [['Facet', 'Fold', 'Crease', 'Prism', 'Scree', 'Shard', 'Origami', 'Cut Stone', 'Glacier', 'Pleat', 'Crystal', 'Faultline'], 'Folded facets'],
    halftone: [['Screen', 'Dot Gain', 'Rosette', 'Tint', 'Benday', 'Gradation', 'Newsprint', 'Raster', 'Moiré', 'Exposure', 'Half Light', 'Plate'], 'Halftone'],
    marble: [['Marbling', 'Ebru', 'Endpaper', 'Stone Pattern', 'Feather', 'Comb', 'Bath', 'Vein', 'Float', 'Nonpareil', 'Swirl', 'Bookbinder'], 'Marbling'],
    blocks: [['Horizon Line', 'Signal', 'Band Study', 'Meridian', 'Semaphore', 'Low Sun', 'Stripe', 'Interval', 'Daymark', 'Tidemark', 'Pennant', 'Zenith'], 'Colour blocks']
  };
  var MOODS = ['Quiet', 'Slow', 'Late', 'Open', 'Bright', 'Long', 'Second', 'Northern', 'Southern', 'Small', 'Distant', 'Warm',
    'Early', 'Low', 'Inland', 'Eastern', 'Western', 'Soft', 'Deep', 'Pale', 'First', 'Last', 'Hidden', 'Folded'];
  var WHEN = ['Morning', 'Evening', 'Midwinter', 'After Rain', 'August', 'At Dusk', 'Before Dawn', 'Noon', 'October', 'Low Tide', 'First Frost', 'Midsummer'];
  var ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

  function titleFor(style, seed) {
    var R = makeRng(seed ^ 0x51ED270B);
    var word = R.pick(WORDS[style][0]);
    var num = 1 + (seed >>> 0) % 9999;
    var form = R();
    if (form < 0.3) return word + ' No. ' + num;
    if (form < 0.5) return R.pick(MOODS) + ' ' + word;
    if (form < 0.64) return word + ', ' + R.pick(WHEN);
    if (form < 0.78) return word + ' ' + R.pick(ROMAN);
    if (form < 0.88) return 'Study for ' + word + ', No. ' + (1 + num % 99);
    return R.pick(MOODS) + ' ' + word + ', No. ' + (1 + num % 99);
  }

  // ---------- public API ----------

  var RENDER = {
    flow: styleFlow,
    aura: styleAura,
    bauhaus: styleBauhaus,
    riso: styleRiso,
    contour: styleContour,
    ranges: styleRanges,
    ink: styleInk,
    lines: styleLines,
    rings: styleRings,
    truchet: styleTruchet,
    pack: stylePack,
    facets: styleFacets,
    halftone: styleHalftone,
    marble: styleMarble,
    blocks: styleBlocks
  };

  var styles = [
    ['flow', 'Flow fields'],
    ['aura', 'Colour fields'],
    ['bauhaus', 'Geometric grids'],
    ['riso', 'Risograph prints'],
    ['contour', 'Paper reliefs'],
    ['ranges', 'Layered horizons'],
    ['ink', 'Ink washes'],
    ['lines', 'Line studies'],
    ['rings', 'Ring studies'],
    ['truchet', 'Tile weaves'],
    ['pack', 'Packed circles'],
    ['facets', 'Folded facets'],
    ['halftone', 'Halftones'],
    ['marble', 'Marbling'],
    ['blocks', 'Colour blocks']
  ];

  // Which moods each style is good in.
  var IN_MOOD = {
    vivid: ['flow', 'aura', 'bauhaus', 'riso', 'contour', 'ranges', 'rings', 'truchet', 'pack', 'facets', 'halftone', 'marble', 'blocks'],
    quiet: ['flow', 'aura', 'bauhaus', 'riso', 'contour', 'ranges', 'ink', 'lines', 'rings', 'truchet', 'pack', 'facets', 'halftone', 'marble', 'blocks']
  };

  // Styles that fill the whole sheet and so can be shown through a mount.
  var MOUNTABLE = { contour: 0.4, aura: 0.3, ranges: 0.3, truchet: 0.4, facets: 0.4, marble: 0.4 };

  function make(opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          var seed = typeof opts.seed === 'number' && isFinite(opts.seed)
            ? Math.floor(opts.seed) >>> 0
            : Math.floor(Math.random() * 4294967296) >>> 0;
          var mood = IN_MOOD[opts.mood] ? opts.mood : (Math.random() < 0.5 ? 'vivid' : 'quiet');
          var ids = IN_MOOD[mood];
          var style = opts.style;
          if (!RENDER[style]) style = ids[Math.floor(Math.random() * ids.length)];
          // A style that does not come in this mood gives way to one that does.
          else if (ids.indexOf(style) < 0) style = ids[seed % ids.length];
          var W = Math.max(64, Math.round(opts.width || 1920));
          var H = Math.max(64, Math.round(opts.height || 1080));
          var canvas = document.createElement('canvas');
          canvas.width = W; canvas.height = H;
          var ctx = canvas.getContext('2d');
          var R = makeRng(seed ^ hashString(mood === 'quiet' ? style + '/quiet' : style));
          var set = mood === 'quiet' ? QUIET : PALETTES;
          var P = set[Math.floor(R() * set.length)];
          // About half the time the picture gets a colour scheme of its own.
          if (R.chance(0.5)) P = inventPalette(R, mood) || P;
          var grain = RENDER[style](ctx, W, H, R, P, mood);
          if (MOUNTABLE[style] && R.chance(MOUNTABLE[style])) mount(ctx, W, H, R, mood);
          texture(ctx, W, H, R, grain || 0.12);
          canvas.toBlob(function (blob) {
            canvas.width = canvas.height = 0;
            if (!blob) { reject(new Error('could not encode picture')); return; }
            resolve({
              url: URL.createObjectURL(blob),
              title: titleFor(style, seed),
              sub: 'Generative  ·  ' + WORDS[style][1],
              style: style,
              mood: mood,
              seed: seed
            });
          }, 'image/jpeg', 0.92);
        } catch (err) { reject(err); }
      }, 0);
    });
  }

  window.ArtFrameGenerative = { styles: styles, make: make };
})();
