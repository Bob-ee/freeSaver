/*
 * qr.js - tiny dependency-free QR code generator (ISO/IEC 18004), byte mode only.
 *
 *   FreeSaverQR.matrix(text, level)  -> array of rows of booleans (true = dark), no quiet zone.
 *                                       text is encoded as UTF-8; level is 'L'|'M'|'Q'|'H' (default 'M').
 *                                       Smallest version 1..40 that fits; throws Error if too long.
 *   FreeSaverQR.draw(canvas, text, opts) -> paints the code (opts: size, level, dark, light).
 *
 * The returned matrix also carries .version and .mask. matrix() accepts optional 3rd/4th
 * arguments (forced mask 0..7, minimum version) used only by the test suite.
 * Plain ES5, no modules; works in browsers (window.FreeSaverQR) and Node (module.exports).
 */
(function () {
  'use strict';

  // Per version 1..40 (index 0 unused): EC codewords per block, and number of blocks.
  // Level order in each table is L, M, Q, H.
  var ECC_PER_BLOCK = [
    [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_BLOCKS = [
    [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];
  var LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
  var FORMAT_BITS = [1, 0, 3, 2]; // 2-bit indicator for L, M, Q, H

  // ---- GF(256), primitive polynomial 0x11D ----
  var EXP = [], LOG = [];
  (function () {
    var x = 1, i;
    for (i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) { x ^= 0x11D; } }
    for (i = 255; i < 512; i++) { EXP[i] = EXP[i - 255]; }
  })();

  function gfMul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }

  // Reed-Solomon: remainder of data(x) * x^degree divided by prod_{i<degree}(x - a^i).
  function rsRemainder(data, degree) {
    var gen = [1], i, j;
    for (i = 0; i < degree; i++) {
      var next = [];
      for (j = 0; j <= gen.length; j++) { next[j] = 0; }
      for (j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= gfMul(gen[j], EXP[i]);
      }
      gen = next; // gen[0] is the leading coefficient (always 1)
    }
    var rem = [];
    for (i = 0; i < degree; i++) { rem[i] = 0; }
    for (i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (j = 0; j < degree; j++) { rem[j] ^= gfMul(gen[j + 1], factor); }
    }
    return rem;
  }

  // ---- version geometry ----
  function alignPositions(ver) {
    if (ver === 1) { return []; }
    var n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
    var step = ver === 32 ? 26 : Math.ceil((size - 13) / (2 * n - 2)) * 2;
    var res = [6], p;
    for (p = size - 7; res.length < n; p -= step) { res.splice(1, 0, p); }
    return res;
  }

  function totalCodewords(ver) {
    var raw = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { var na = Math.floor(ver / 7) + 2; raw -= (25 * na - 10) * na - 55; }
    if (ver >= 7) { raw -= 36; }
    return Math.floor(raw / 8);
  }

  function dataCodewords(ver, lvl) {
    return totalCodewords(ver) - ECC_PER_BLOCK[lvl][ver] * NUM_BLOCKS[lvl][ver];
  }

  function utf8(str) {
    var out = [], i, c, d;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) {
        d = str.charCodeAt(i + 1);
        if (d >= 0xDC00 && d < 0xE000) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
      }
      if (c < 0x80) { out.push(c); }
      else if (c < 0x800) { out.push(0xC0 | c >> 6, 0x80 | c & 63); }
      else if (c < 0x10000) { out.push(0xE0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63); }
      else { out.push(0xF0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63); }
    }
    return out;
  }

  // ---- codeword stream: header + data + padding, then RS blocks interleaved ----
  function buildCodewords(bytes, ver, lvl) {
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) { bits.push((val >>> i) & 1); } }
    var capBits = dataCodewords(ver, lvl) * 8, i;
    put(4, 4);                              // byte mode indicator 0100
    put(bytes.length, ver < 10 ? 8 : 16);   // character count
    for (i = 0; i < bytes.length; i++) { put(bytes[i], 8); }
    put(0, Math.min(4, capBits - bits.length));  // terminator
    put(0, (8 - bits.length % 8) % 8);           // byte-align
    var data = [];
    for (i = 0; i < bits.length; i += 8) {
      data.push(bits[i] << 7 | bits[i + 1] << 6 | bits[i + 2] << 5 | bits[i + 3] << 4 |
                bits[i + 4] << 3 | bits[i + 5] << 2 | bits[i + 6] << 1 | bits[i + 7]);
    }
    for (i = 0; data.length < capBits / 8; i ^= 1) { data.push(i ? 0x11 : 0xEC); }

    var nb = NUM_BLOCKS[lvl][ver], ecc = ECC_PER_BLOCK[lvl][ver], total = totalCodewords(ver);
    var shortCount = nb - total % nb, shortData = Math.floor(total / nb) - ecc;
    var dBlocks = [], eBlocks = [], pos = 0, b, len;
    for (b = 0; b < nb; b++) {
      len = shortData + (b < shortCount ? 0 : 1);
      var blk = data.slice(pos, pos + len);
      pos += len;
      dBlocks.push(blk);
      eBlocks.push(rsRemainder(blk, ecc));
    }
    var out = [];
    for (i = 0; i <= shortData; i++) {
      for (b = 0; b < nb; b++) { if (i < dBlocks[b].length) { out.push(dBlocks[b][i]); } }
    }
    for (i = 0; i < ecc; i++) { for (b = 0; b < nb; b++) { out.push(eBlocks[b][i]); } }
    return out;
  }

  // ---- matrix construction ----
  function bchFormat(data5) {
    var rem = data5, i;
    for (i = 0; i < 10; i++) { rem = (rem << 1) ^ ((rem >>> 9) * 0x537); }
    return ((data5 << 10) | rem) ^ 0x5412;
  }

  function bchVersion(ver) {
    var rem = ver, i;
    for (i = 0; i < 12; i++) { rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25); }
    return (ver << 12) | rem;
  }

  function newGrid(size) {
    var g = [], y, x, row;
    for (y = 0; y < size; y++) { row = []; for (x = 0; x < size; x++) { row.push(false); } g.push(row); }
    return g;
  }

  // Draws every function pattern; returns { m: modules, f: isFunction } (format bits left blank).
  function baseMatrix(ver) {
    var size = ver * 4 + 17, m = newGrid(size), f = newGrid(size), i, j;
    function set(x, y, dark) { if (x >= 0 && y >= 0 && x < size && y < size) { m[y][x] = dark; f[y][x] = true; } }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var d = Math.max(Math.abs(dx), Math.abs(dy));
          set(cx + dx, cy + dy, d !== 4 && d !== 2);
        }
      }
    }
    for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var ap = alignPositions(ver), n = ap.length;
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) { continue; }
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
    // reserve format areas (real bits written later) and the always-dark module
    for (i = 0; i < 9; i++) { f[8][i] = f[i][8] = true; }
    for (i = 0; i < 8; i++) { f[8][size - 1 - i] = f[size - 1 - i][8] = true; }
    set(8, size - 8, true);
    if (ver >= 7) {
      var v = bchVersion(ver);
      for (i = 0; i < 18; i++) {
        var bit = ((v >>> i) & 1) === 1, a = size - 11 + i % 3, b = Math.floor(i / 3);
        set(a, b, bit); set(b, a, bit);
      }
    }
    return { m: m, f: f };
  }

  function placeData(m, f, cw) {
    var size = m.length, bitIdx = 0, total = cw.length * 8, right, vert, j, x, y, up;
    for (right = size - 1; right >= 1; right -= 2) {
      if (right === 6) { right = 5; }
      for (vert = 0; vert < size; vert++) {
        for (j = 0; j < 2; j++) {
          x = right - j;
          up = ((right + 1) & 2) === 0;
          y = up ? size - 1 - vert : vert;
          if (!f[y][x] && bitIdx < total) {
            m[y][x] = ((cw[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
        }
      }
    }
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return x * y % 2 + x * y % 3 === 0;
      case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
      default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
    }
  }

  function writeFormat(m, lvl, mask) {
    var size = m.length, bits = bchFormat(FORMAT_BITS[lvl] << 3 | mask), i;
    function bit(k) { return ((bits >>> k) & 1) === 1; }
    for (i = 0; i <= 5; i++) { m[i][8] = bit(i); }
    m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
    for (i = 9; i < 15; i++) { m[8][14 - i] = bit(i); }
    for (i = 0; i < 8; i++) { m[8][size - 1 - i] = bit(i); }
    for (i = 8; i < 15; i++) { m[size - 15 + i][8] = bit(i); }
    m[size - 8][8] = true;
  }

  // Standard penalty rules: N1 runs (3 + extra), N2 2x2 blocks (3), N3 finder-like (40), N4 balance (10/5%).
  function penalty(m) {
    var size = m.length, score = 0, dark = 0, x, y, k, c;
    function lineScore(get) {
      var s = 0, i, runLen = 1;
      for (i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) { runLen++; }
        else { if (runLen >= 5) { s += 3 + runLen - 5; } runLen = 1; }
      }
      return s;
    }
    for (y = 0; y < size; y++) {
      score += lineScore(function (i) { return m[y][i]; });
      for (x = 0; x < size; x++) { if (m[y][x]) { dark++; } }
    }
    for (x = 0; x < size; x++) { score += lineScore(function (i) { return m[i][x]; }); }
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) { score += 3; }
      }
    }
    // N3: 10111010000 or 00001011101 (dark = 1) in any row/column
    var A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (y = 0; y < size; y++) {
      for (x = 0; x + 11 <= size; x++) {
        var ra = true, rb = true, ca = true, cb = true;
        for (k = 0; k < 11; k++) {
          var h = m[y][x + k] ? 1 : 0, v = m[x + k][y] ? 1 : 0;
          if (h !== A[k]) { ra = false; } if (h !== B[k]) { rb = false; }
          if (v !== A[k]) { ca = false; } if (v !== B[k]) { cb = false; }
        }
        score += 40 * ((ra ? 1 : 0) + (rb ? 1 : 0) + (ca ? 1 : 0) + (cb ? 1 : 0));
      }
    }
    var tot = size * size;
    score += 10 * Math.floor(Math.abs(dark * 20 - tot * 10) / tot);
    return score;
  }

  function matrix(text, level, forceMask, minVersion) {
    var lvl = LEVELS[level === undefined ? 'M' : level];
    if (lvl === undefined) { throw new Error('QR: bad error-correction level ' + level); }
    var bytes = utf8(String(text)), ver;
    for (ver = Math.max(1, minVersion || 1); ver <= 40; ver++) {
      if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver, lvl) * 8) { break; }
    }
    if (ver > 40) { throw new Error('QR: text too long (' + bytes.length + ' bytes)'); }

    var cw = buildCodewords(bytes, ver, lvl);
    var base = baseMatrix(ver), size = ver * 4 + 17;
    placeData(base.m, base.f, cw);

    var best = null, bestScore = 0, bestMask = 0, mask, x, y, cand;
    for (mask = 0; mask < 8; mask++) {
      if (forceMask !== undefined && forceMask !== null && forceMask !== mask) { continue; }
      cand = [];
      for (y = 0; y < size; y++) {
        cand[y] = base.m[y].slice();
        for (x = 0; x < size; x++) {
          if (!base.f[y][x] && maskBit(mask, x, y)) { cand[y][x] = !cand[y][x]; }
        }
      }
      writeFormat(cand, lvl, mask);
      var s = penalty(cand);
      if (best === null || s < bestScore) { best = cand; bestScore = s; bestMask = mask; }
    }
    best.version = ver;
    best.mask = bestMask;
    return best;
  }

  function draw(canvas, text, opts) {
    opts = opts || {};
    var m = matrix(text, opts.level || 'M'), n = m.length + 8;
    var size = opts.size || 360;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var px = Math.max(1, Math.floor(size * dpr / n));   // whole device pixels per module
    var dim = px * n;
    canvas.width = dim;
    canvas.height = dim;
    canvas.style.width = (dim / dpr) + 'px';
    canvas.style.height = (dim / dpr) + 'px';
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.light || '#fff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = opts.dark || '#111';
    for (var y = 0; y < m.length; y++) {
      for (var x = 0; x < m.length; x++) {
        if (m[y][x]) { ctx.fillRect((x + 4) * px, (y + 4) * px, px, px); }
      }
    }
  }

  var api = { matrix: matrix, draw: draw };
  if (typeof window !== 'undefined') { window.FreeSaverQR = api; }
  else if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
