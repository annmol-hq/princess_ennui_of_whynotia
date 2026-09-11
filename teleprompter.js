/* ============================================================
   Glitch Teleprompter - reading page (prompter.html)

   Two independent systems:
     1. a steady baseline scroll (constant reading pace)
     2. a sabotage layer that multiplies/overrides that baseline for
        short random bursts, then gets out of the way cleanly.

   Plus the inverted brightness rule: the line sitting IN the reading
   zone is DIM, the lines above and below it are BRIGHT. This is
   backwards from every real teleprompter on purpose. See
   computeBrightness below - do not "fix" it.
   ============================================================ */
(function (global) {
  'use strict';

  var SCRIPT_KEY = 'prompter-script';
  var BETRAYAL_KEY = 'prompter-betrayal-count';

  /* Baseline reading pace, pixels per second. */
  var BASE_SPEED = 46;

  /* Brightness bounds. MIN lands on the reading zone, MAX lands far away. */
  var MIN_BRIGHTNESS = 0.14;
  var MAX_BRIGHTNESS = 1;

  var FALLBACK_LINE_HEIGHT = 62;

  /* Ceiling on how far one glitch may drag the script, as a fraction of
     viewport height. Stops a fast burst from skipping the reader past
     everything they had left to read. */
  var MAX_BURST_TRAVEL_RATIO = 0.6;

  /* ---------- canvas grain ---------- */

  /* A handful of small noise tiles, rendered once at startup and then
     cycled during a glitch. Repeating one tile across the viewport is
     vastly cheaper than painting every screen pixel per frame, and
     swapping which tile is showing hides the fact that it repeats. */
  var NOISE_TILE_SIZE = 96;
  var NOISE_TILE_COUNT = 5;

  /* Slight magenta bias so the grain belongs to the same palette as
     the glow rather than reading as neutral TV snow. */
  var NOISE_GREEN_BIAS = 0.62;

  /* Fraction of pixels left fully transparent. Kept low: the grain has
     to physically cover glyphs to interfere with reading. A sparse,
     screen-blended version looked like static but could not obscure
     anything, because screen blending only ever lightens. */
  var NOISE_SPARSITY = 0.3;

  /* Returns an array of data-URI strings, or an empty array where
     canvas is unavailable (jsdom, very old browsers), in which case the
     CSS gradient fallback in the stylesheet stays in place. */
  function makeNoiseTiles(doc, size, count, rand) {
    var d = doc || global.document;
    var px = size || NOISE_TILE_SIZE;
    var n = count || NOISE_TILE_COUNT;
    var random = rand || Math.random;
    var tiles = [];

    for (var t = 0; t < n; t++) {
      var canvas = d.createElement('canvas');
      if (!canvas || typeof canvas.getContext !== 'function') { return []; }
      canvas.width = px;
      canvas.height = px;

      var ctx;
      try { ctx = canvas.getContext('2d'); } catch (e) { return []; }
      if (!ctx || typeof ctx.createImageData !== 'function') { return []; }

      try {
        var img = ctx.createImageData(px, px);
        var data = img.data;
        for (var i = 0; i < data.length; i += 4) {
          var v = (random() * 255) | 0;
          data[i] = v;
          data[i + 1] = (v * NOISE_GREEN_BIAS) | 0;
          data[i + 2] = v;
          /* Mostly opaque, so the tile lands ON TOP of the glyphs and
             genuinely breaks them up, with a minority punched out to
             keep it reading as noise rather than a solid panel. */
          data[i + 3] = random() < NOISE_SPARSITY ? 0 : 100 + ((random() * 130) | 0);
        }
        ctx.putImageData(img, 0, 0);
        tiles.push(canvas.toDataURL('image/png'));
      } catch (e) {
        return [];
      }
    }
    return tiles;
  }

  /* ---------- the inverted brightness rule ---------- */

  /* distance = |line centre - reading zone centre|, in pixels.
     falloff  = distance at which a line reaches full brightness.

     distance 0    -> MIN_BRIGHTNESS (dim, unreadable, the joke)
     distance far  -> MAX_BRIGHTNESS (bright, glowing, distracting)

     If you ever find this returning HIGH at distance 0, it has been
     built backwards - the whole tool stops being funny. */
  function computeBrightness(distance, falloff, minB, maxB) {
    var lo = typeof minB === 'number' ? minB : MIN_BRIGHTNESS;
    var hi = typeof maxB === 'number' ? maxB : MAX_BRIGHTNESS;
    var span = falloff || 1;
    var t = Math.abs(distance) / span;
    if (t > 1) { t = 1; }
    if (t < 0) { t = 0; }
    return lo + (hi - lo) * t;
  }

  /* ---------- persistence ---------- */

  function storageOf(storage) {
    return storage || global.localStorage;
  }

  function loadScriptText(storage) {
    try { return storageOf(storage).getItem(SCRIPT_KEY) || ''; } catch (e) { return ''; }
  }

  function loadBetrayalCount(storage) {
    try {
      var raw = parseInt(storageOf(storage).getItem(BETRAYAL_KEY), 10);
      return isNaN(raw) || raw < 0 ? 0 : raw;
    } catch (e) { return 0; }
  }

  function saveBetrayalCount(n, storage) {
    try { storageOf(storage).setItem(BETRAYAL_KEY, String(n)); } catch (e) { /* ignore */ }
    return n;
  }

  function splitLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; });
  }

  /* ---------- the sabotage layer ---------- */

  var GLITCH_EFFECTS = ['speed', 'freeze', 'reverse', 'static', 'blank'];

  /* Not uniform. Speed and blank are the two that actually break a
     reader's place, so they carry the most weight. */
  var GLITCH_WEIGHTS = { speed: 32, blank: 23, static: 19, freeze: 14, reverse: 12 };

  /* The delay is measured from the END of one glitch to the START of
     the next, so minDelay is a guaranteed floor of undisturbed reading.
     Keep it at or above 2s: a build with sub-second gaps and violent
     speed bursts chewed through an entire script in the first three
     seconds and then sat at the end with nothing left to scroll.

     Glitches still need to bite, so duration stays long relative to the
     gap - this lands near a 20% duty cycle, roughly one interruption
     every three to five seconds. */
  var GLITCH_DEFAULTS = {
    minDelay: 2200,
    maxDelay: 4300,
    minDuration: 320,
    maxDuration: 1150
  };

  /* A scheduler that fires at random intervals. It never touches the
     baseline speed value itself - it only exposes a multiplier that the
     render loop applies on top, so when a glitch ends the baseline
     resumes exactly as it was. */
  function createGlitchEngine(options) {
    var opts = options || {};
    var random = opts.random || Math.random;
    var minDelay = opts.minDelay || GLITCH_DEFAULTS.minDelay;
    var maxDelay = opts.maxDelay || GLITCH_DEFAULTS.maxDelay;
    var minDuration = opts.minDuration || GLITCH_DEFAULTS.minDuration;
    var maxDuration = opts.maxDuration || GLITCH_DEFAULTS.maxDuration;
    var storage = opts.storage;

    var count = loadBetrayalCount(storage);
    var multiplier = 1;
    var active = false;
    var timer = null;
    var endTimer = null;
    var running = false;

    function between(lo, hi) { return lo + random() * (hi - lo); }

    function multiplierFor(effect) {
      /* Enough to throw the reader a few lines past their place, but
         bounded: at 20x a single burst outran an entire short script.
         See MAX_BURST_TRAVEL for the hard stop that backs this up. */
      if (effect === 'speed') { return between(5, 9); }
      if (effect === 'freeze') { return 0; }
      if (effect === 'reverse') { return -between(1.5, 3.2); }
      return 1; /* static and blank are visual only */
    }

    /* Weighted so the disorienting effects dominate. */
    function pickEffect() {
      var total = 0;
      var i;
      for (i = 0; i < GLITCH_EFFECTS.length; i++) {
        total += GLITCH_WEIGHTS[GLITCH_EFFECTS[i]] || 1;
      }
      var r = random() * total;
      var cum = 0;
      for (i = 0; i < GLITCH_EFFECTS.length; i++) {
        cum += GLITCH_WEIGHTS[GLITCH_EFFECTS[i]] || 1;
        if (r < cum) { return GLITCH_EFFECTS[i]; }
      }
      return GLITCH_EFFECTS[GLITCH_EFFECTS.length - 1];
    }

    /* Scaled off the configured range rather than hard-coded, so an
       explicit min/maxDuration from the caller is still respected. */
    function durationFor(effect) {
      var d = between(minDuration, maxDuration);
      if (effect === 'blank') { return d * 0.45; }
      /* short and punchy: a long fast burst is just a fast-forward */
      if (effect === 'speed') { return d * 0.7; }
      return d;
    }

    /* Fires one glitch event. The betrayal counter increments exactly
       once here - per event, never per frame. */
    function triggerGlitch(forcedEffect, forcedDuration) {
      var effect = forcedEffect || pickEffect();
      var duration = forcedDuration || durationFor(effect);

      /* Usually stack a visual on top of a motion effect, so a speed
         burst also blinds you rather than merely moving fast. */
      var visual = null;
      if ((effect === 'speed' || effect === 'freeze' || effect === 'reverse') && random() < 0.72) {
        visual = random() < 0.6 ? 'static' : 'blank';
      }

      active = true;
      multiplier = multiplierFor(effect);
      count = saveBetrayalCount(count + 1, storage);

      if (opts.onStart) {
        opts.onStart({
          effect: effect,
          visual: visual,
          duration: duration,
          count: count
        });
      }
      if (opts.onCount) { opts.onCount(count); }

      if (endTimer) { clearTimeout(endTimer); }
      endTimer = setTimeout(endGlitch, duration);

      return { effect: effect, visual: visual, duration: duration, count: count };
    }

    function endGlitch() {
      active = false;
      multiplier = 1; /* baseline resumes untouched */
      if (opts.onEnd) { opts.onEnd(); }
      if (running) { schedule(); }
    }

    function schedule() {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(function () {
        if (!running) { return; }
        triggerGlitch();
      }, between(minDelay, maxDelay));
    }

    function start() {
      if (running) { return; }
      running = true;
      schedule();
    }

    function stop() {
      running = false;
      active = false;
      multiplier = 1;
      if (timer) { clearTimeout(timer); timer = null; }
      if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    }

    return {
      start: start,
      stop: stop,
      triggerGlitch: triggerGlitch,
      endGlitch: endGlitch,
      getMultiplier: function () { return multiplier; },
      isActive: function () { return active; },
      getCount: function () { return count; }
    };
  }

  /* ---------- page wiring ---------- */

  function init(doc, win) {
    var d = doc || global.document;
    var w = win || global;

    var stage = d.getElementById('stage');
    var linesEl = d.getElementById('lines');
    var countdownEl = d.getElementById('countdown');
    var emptyEl = d.getElementById('empty-message');
    var staticEl = d.getElementById('static-overlay');
    var blankEl = d.getElementById('blank-overlay');
    var counterEl = d.getElementById('betrayal-value');
    if (!linesEl) { return null; }

    /* show the running total straight away, even before anything scrolls */
    if (counterEl) { counterEl.textContent = String(loadBetrayalCount()); }

    var lines = splitLines(loadScriptText());

    if (!lines.length) {
      if (emptyEl) { emptyEl.hidden = false; }
      if (countdownEl) { countdownEl.hidden = true; }
      return { started: false, reason: 'empty' };
    }

    /* build the line elements */
    var nodes = lines.map(function (text) {
      var el = d.createElement('div');
      el.className = 'line';
      el.textContent = text;
      linesEl.appendChild(el);
      return el;
    });

    var viewH = w.innerHeight || 800;
    var zoneCentre = viewH / 2;
    var falloff = Math.max(160, viewH * 0.34);

    /* measure once, after the nodes are in the document */
    var tops = [];
    var cursor = 0;
    nodes.forEach(function (el) {
      tops.push(cursor);
      cursor += (el.offsetHeight || FALLBACK_LINE_HEIGHT) + 16;
    });
    var totalHeight = cursor;

    var offset = 0;
    var startY = viewH * 0.9; /* first line begins just below the fold */
    var lastTs = null;
    var finished = false;

    /* no single glitch may drag the script more than this far */
    var maxBurstTravel = viewH * MAX_BURST_TRAVEL_RATIO;
    var burstTravel = 0;

    var engine = createGlitchEngine({
      onStart: function (info) {
        if (stage) { stage.classList.add('glitching'); }
        if (info.visual === 'static' || info.effect === 'static') {
          if (staticEl) { staticEl.classList.add('active'); }
        }
        if (info.visual === 'blank' || info.effect === 'blank') {
          if (blankEl) { blankEl.classList.add('active'); }
        }
        jitterStatic();
      },
      onEnd: function () {
        burstTravel = 0; /* each glitch gets its own travel budget */
        if (stage) { stage.classList.remove('glitching'); }
        if (staticEl) { staticEl.classList.remove('active'); }
        if (blankEl) { blankEl.classList.remove('active'); }
      },
      onCount: function (n) {
        if (counterEl) { counterEl.textContent = String(n); }
      }
    });

    /* Generated once, not per frame. Empty where canvas is unavailable,
       in which case the stylesheet's gradient fallback stays. */
    var noiseTiles = makeNoiseTiles(d, NOISE_TILE_SIZE, NOISE_TILE_COUNT);
    var tileCursor = 0;
    var jitterTick = 0;

    if (noiseTiles.length && staticEl) {
      staticEl.style.backgroundSize = NOISE_TILE_SIZE + 'px ' + NOISE_TILE_SIZE + 'px';
      /* bind one immediately so the very first glitch is already grainy
         rather than showing the gradient fallback for a few frames */
      staticEl.style.backgroundImage = 'url(' + noiseTiles[0] + ')';
    }

    /* Runs every frame a glitch is live. Repositioning is cheap, so it
       happens every frame; swapping the tile is throttled because it
       forces a new image to be bound. */
    function jitterStatic() {
      if (!staticEl) { return; }

      staticEl.style.backgroundPosition =
        Math.floor(Math.random() * NOISE_TILE_SIZE) + 'px ' +
        Math.floor(Math.random() * NOISE_TILE_SIZE) + 'px';

      if (!noiseTiles.length) { return; }
      jitterTick++;
      if (jitterTick % 3 === 0) {
        tileCursor = (tileCursor + 1 + Math.floor(Math.random() * (noiseTiles.length - 1))) %
          noiseTiles.length;
        staticEl.style.backgroundImage = 'url(' + noiseTiles[tileCursor] + ')';
      }
    }

    function render() {
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var h = el.offsetHeight || FALLBACK_LINE_HEIGHT;
        var y = startY + tops[i] - offset;

        /* drop lines that have scrolled off the top */
        if (y + h < -40 || y > viewH + 40) {
          el.style.visibility = 'hidden';
          continue;
        }
        el.style.visibility = 'visible';

        var centre = y + h / 2;
        var brightness = computeBrightness(centre - zoneCentre, falloff);

        el.style.transform = 'translate(-50%, ' + y + 'px)';
        el.style.opacity = String(brightness);
      }
    }

    function frame(ts) {
      if (finished) { return; }
      if (lastTs === null) { lastTs = ts; }
      var dt = Math.min(0.05, (ts - lastTs) / 1000);
      lastTs = ts;

      /* baseline * sabotage multiplier - the baseline is never rewritten */
      var delta = BASE_SPEED * engine.getMultiplier() * dt;

      /* Hard ceiling on how far any one glitch may drag the script.
         Tuning alone is not enough: a fast burst that runs slightly long
         can otherwise skip past everything the reader had left. */
      if (engine.isActive() && delta > 0) {
        var remaining = maxBurstTravel - burstTravel;
        if (delta > remaining) { delta = remaining > 0 ? remaining : 0; }
        burstTravel += delta;
      }

      offset += delta;
      if (offset < 0) { offset = 0; }

      if (engine.isActive()) { jitterStatic(); }

      if (offset > totalHeight + startY) {
        finish();
        return;
      }

      render();
      w.requestAnimationFrame(frame);
    }

    function finish() {
      finished = true;
      engine.stop();
      if (stage) { stage.classList.remove('glitching'); }
      if (staticEl) { staticEl.classList.remove('active'); }
      if (blankEl) { blankEl.classList.remove('active'); }

      var end = d.createElement('div');
      end.id = 'empty-message';
      end.innerHTML =
        '<h2>END OF SCRIPT</h2>' +
        '<p>You survived. The counter above is permanent.</p>' +
        '<a href="index.html">&larr; BACK TO SETUP</a>';
      if (stage) { stage.appendChild(end); }
    }

    function begin() {
      render();
      engine.start();
      if (w.requestAnimationFrame) { w.requestAnimationFrame(frame); }
    }

    /* 3 - 2 - 1, then go */
    function runCountdown(done) {
      if (!countdownEl) { done(); return; }
      var n = 3;
      countdownEl.hidden = false;
      countdownEl.textContent = String(n);
      var tick = setInterval(function () {
        n -= 1;
        if (n <= 0) {
          clearInterval(tick);
          countdownEl.hidden = true;
          done();
          return;
        }
        countdownEl.textContent = String(n);
      }, 1000);
    }

    runCountdown(begin);

    return {
      started: true,
      engine: engine,
      lineCount: nodes.length,
      getOffset: function () { return offset; },
      /* jump the scroll to a given pixel offset and repaint once */
      seek: function (px) {
        offset = Math.max(0, px);
        render();
        return offset;
      },
      render: render
    };
  }

  global.Prompter = {
    SCRIPT_KEY: SCRIPT_KEY,
    BETRAYAL_KEY: BETRAYAL_KEY,
    BASE_SPEED: BASE_SPEED,
    MIN_BRIGHTNESS: MIN_BRIGHTNESS,
    MAX_BRIGHTNESS: MAX_BRIGHTNESS,
    GLITCH_EFFECTS: GLITCH_EFFECTS,
    GLITCH_WEIGHTS: GLITCH_WEIGHTS,
    GLITCH_DEFAULTS: GLITCH_DEFAULTS,
    MAX_BURST_TRAVEL_RATIO: MAX_BURST_TRAVEL_RATIO,
    NOISE_TILE_SIZE: NOISE_TILE_SIZE,
    NOISE_TILE_COUNT: NOISE_TILE_COUNT,
    makeNoiseTiles: makeNoiseTiles,
    computeBrightness: computeBrightness,
    createGlitchEngine: createGlitchEngine,
    loadBetrayalCount: loadBetrayalCount,
    saveBetrayalCount: saveBetrayalCount,
    loadScriptText: loadScriptText,
    splitLines: splitLines,
    init: init
  };

  /* the live instance is parked on the export so it can be poked from
     the console (or a test) without waiting out the countdown */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        global.Prompter.instance = init(document, global);
      });
    } else {
      global.Prompter.instance = init(document, global);
    }
  }
})(typeof window !== 'undefined' ? window : this);
