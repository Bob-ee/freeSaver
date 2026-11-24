// Draws a picture frame (moulding, fillet, mat) around the stage using only
// CSS and generated noise - no image files. Every call uses a fresh random
// seed, so the wood grain and mat are slightly different each session.
(function () {
  'use strict';

  // Sizes are in % of screen height. `profile` runs from the outer edge of
  // the moulding to its inner edge.
  var STYLES = {
    walnut: {
      label: 'Walnut',
      rail: 3.3, fillet: 0.32, mat: 1.1, grain: 'wood', grainStrength: 0.95,
      profile: ['#1d120b 0%', '#553621 7%', '#4a2e1b 22%', '#3c2415 58%', '#22140c 74%', '#5f4028 86%', '#38220f 100%'],
      fillet4: ['#8a744a', '#6e5b38', '#b79c66', '#c9ae78'],
      mats: ['#cdc6b6', '#c4bfb1', '#bfb8a4']
    },
    oak: {
      label: 'Natural oak',
      rail: 3.0, fillet: 0, mat: 1.1, grain: 'wood', grainStrength: 0.8,
      profile: ['#7d6444 0%', '#b89a70 8%', '#ab8d63 30%', '#a08259 62%', '#7a6142 78%', '#b1936a 90%', '#8b7150 100%'],
      mats: ['#cfcabd', '#c6c4bc', '#d1c9b6']
    },
    ebony: {
      label: 'Black lacquer',
      rail: 2.4, fillet: 0.3, mat: 1.2, grain: 'fine', grainStrength: 0.35,
      profile: ['#050505 0%', '#2b2b2c 9%', '#161617 26%', '#0c0c0d 60%', '#030303 78%', '#262627 90%', '#0a0a0a 100%'],
      fillet4: ['#8f7a4c', '#75633d', '#bfa56c', '#d2b87f'],
      mats: ['#c9c6bf', '#b6b7b4', '#30343a', '#3a3531']
    },
    gilt: {
      label: 'Antique gilt',
      rail: 4.0, fillet: 0.36, mat: 1.0, grain: 'fine', grainStrength: 0.7,
      profile: ['#3d2c10 0%', '#b8944a 6%', '#8a6a2c 14%', '#c9a85c 22%', '#6f5422 33%', '#a98742 44%',
                '#d6b96e 52%', '#93732f 62%', '#55401a 74%', '#bf9d50 84%', '#e0c67c 91%', '#7a5e26 100%'],
      fillet4: ['#1b1610', '#231c14', '#2e251a', '#352b1e'],
      mats: ['#2c382f', '#28303c', '#3b2828', '#c8bfa9']
    },
    float: {
      label: 'Thin float frame',
      rail: 1.2, fillet: 0, mat: 0.45, grain: 'fine', grainStrength: 0.3, bevel: 0, plainMat: true,
      profile: ['#060606 0%', '#3a3a3b 22%', '#19191a 55%', '#070707 100%'],
      mats: ['#000000']
    }
  };

  var BEVEL = 0.22; // the white cut edge of the mat, % of screen height

  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  // A tile of generated grey noise, as a CSS background image.
  function noise(w, h, fx, fy, octaves, seed, contrast) {
    var c = contrast;
    var o = (1 - c) / 2;
    var row = c + ' 0 0 0 ' + o + ' ';
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + w + "' height='" + h + "'>" +
      "<filter id='n' x='0' y='0' width='100%' height='100%'>" +
      "<feTurbulence type='fractalNoise' baseFrequency='" + fx + ' ' + fy + "' numOctaves='" + octaves +
      "' seed='" + seed + "' stitchTiles='stitch'/>" +
      "<feColorMatrix values='" + row + row + row + "0 0 0 0 1'/></filter>" +
      "<rect width='100%' height='100%' filter='url(#n)'/></svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  function grain(style, lengthwise, seed) {
    if (style.grain === 'wood') {
      // Long streaks running along the length of each piece of moulding.
      return lengthwise === 'x'
        ? noise(1024, 256, 0.004, 0.22, 4, seed, style.grainStrength)
        : noise(256, 1024, 0.22, 0.004, 4, seed, style.grainStrength);
    }
    return noise(256, 256, 0.9, 0.9, 2, seed, style.grainStrength);
  }

  function el(className, css) {
    var d = document.createElement('div');
    d.className = className;
    for (var k in css) d.style[k] = css[k];
    return d;
  }

  function apply(id) {
    var host = document.getElementById('frame');
    var style = STYLES[id];
    host.textContent = '';
    document.body.classList.toggle('framed-view', !!style);
    if (!style) {
      document.documentElement.style.setProperty('--edge', '0px');
      return;
    }

    var u = window.innerHeight / 100;
    var W = Math.round(style.rail * u);
    var F = Math.round(style.fillet * u);
    var M = Math.round(style.mat * u);
    var B = Math.round((style.bevel === 0 ? 0 : BEVEL) * u);
    var seed = Math.floor(Math.random() * 100000);
    var profile = style.profile.join(', ');

    // Four mitred lengths of moulding, lit from the upper left.
    var rails = [
      ['top', 'x', 'to bottom', 1.12, { top: 0, left: 0, width: '100%', height: W + 'px' },
        'polygon(0 0, 100% 0, calc(100% - ' + W + 'px) 100%, ' + W + 'px 100%)'],
      ['bottom', 'x', 'to top', 0.78, { bottom: 0, left: 0, width: '100%', height: W + 'px' },
        'polygon(' + W + 'px 0, calc(100% - ' + W + 'px) 0, 100% 100%, 0 100%)'],
      ['left', 'y', 'to right', 1.0, { top: 0, left: 0, width: W + 'px', height: '100%' },
        'polygon(0 0, 100% ' + W + 'px, 100% calc(100% - ' + W + 'px), 0 100%)'],
      ['right', 'y', 'to left', 0.88, { top: 0, right: 0, width: W + 'px', height: '100%' },
        'polygon(0 ' + W + 'px, 100% 0, 100% 100%, 0 calc(100% - ' + W + 'px))']
    ];
    rails.forEach(function (r, i) {
      var rail = el('rail', r[4]);
      rail.style.position = 'absolute';
      rail.style.backgroundImage = grain(style, r[1], seed + i * 7) + ', linear-gradient(' + r[2] + ', ' + profile + ')';
      rail.style.backgroundBlendMode = 'overlay';
      rail.style.clipPath = r[5];
      rail.style.webkitClipPath = r[5];
      rail.style.filter = 'brightness(' + r[3] + ')';
      host.appendChild(rail);
    });

    // Fillet (a thin inner lip) and the mat.
    var matColor = pick(style.mats);
    var f4 = style.fillet4 || ['transparent', 'transparent', 'transparent', 'transparent'];
    var mat = el('mat', {
      position: 'absolute', top: W + 'px', left: W + 'px', right: W + 'px', bottom: W + 'px',
      boxSizing: 'border-box',
      borderStyle: 'solid', borderWidth: F + 'px',
      borderTopColor: f4[0], borderLeftColor: f4[1], borderRightColor: f4[2], borderBottomColor: f4[3],
      backgroundColor: matColor
    });
    if (!style.plainMat) {
      mat.style.backgroundImage = noise(256, 256, 0.7, 0.7, 3, seed + 31, 0.16); // paper tooth
      mat.style.backgroundBlendMode = 'overlay';
      // The moulding casts a soft shadow onto the mat, heaviest at the top.
      mat.style.boxShadow = 'inset 0 ' + Math.round(0.25 * u) + 'px ' + Math.round(0.5 * u) + 'px rgba(0,0,0,0.45), ' +
                            'inset 0 0 ' + Math.round(0.2 * u) + 'px rgba(0,0,0,0.5)';
    }
    host.appendChild(mat);

    // The bevel: the pale core of the mat board where the window is cut.
    if (B) {
      var inset = (W + F + M) + 'px';
      host.appendChild(el('bevel', {
        position: 'absolute', top: inset, left: inset, right: inset, bottom: inset,
        boxSizing: 'border-box', borderStyle: 'solid', borderWidth: B + 'px',
        borderTopColor: '#9f998d', borderLeftColor: '#b3ada0',
        borderRightColor: '#e3ddd0', borderBottomColor: '#ece6da'
      }));
    }

    document.documentElement.style.setProperty('--edge', (W + F + M + B) + 'px');
  }

  var current = 'none';
  window.ArtFrameBorder = {
    styles: Object.keys(STYLES).map(function (id) { return [id, STYLES[id].label]; }),
    random: function () { return pick(Object.keys(STYLES)); },
    apply: function (id) { current = STYLES[id] ? id : 'none'; apply(current); }
  };
  window.addEventListener('resize', function () { apply(current); });
})();
