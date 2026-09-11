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

  /* A scheduler that fires at random intervals. It never touches the
     baseline speed value itself - it only exposes a multiplier that the
     render loop applies on top, so when a glitch ends the baseline
     resumes exactly as it was. */
  function createGlitchEngine(options) {
    var opts = options || {};
    var random = opts.random || Math.random;
    var minDelay = opts.minDelay || 3500;
    var maxDelay = opts.maxDelay || 9000;
    var minDuration = opts.minDuration || 260;
    var maxDuration = opts.maxDuration || 1100;
    var storage = opts.storage;

    var count = loadBetrayalCount(storage);
    var multiplier = 1;
    var active = false;
    var timer = null;
    var endTimer = null;
    var running = false;

    function between(lo, hi) { return lo + random() * (hi - lo); }

    function multiplierFor(effect) {
      if (effect === 'speed') { return between(3.5, 6.5); }
      if (effect === 'freeze') { return 0; }
      if (effect === 'reverse') { return -between(0.8, 1.8); }
      return 1; /* static and blank are visual only */
    }

    /* Fires one glitch event. The betrayal counter increments exactly
       once here - per event, never per frame. */
    function triggerGlitch(forcedEffect, forcedDuration) {
      var effect = forcedEffect || GLITCH_EFFECTS[Math.floor(random() * GLITCH_EFFECTS.length)];
      var duration = forcedDuration || between(minDuration, maxDuration);

      /* sometimes stack a visual effect on top of a motion effect */
      var visual = null;
      if ((effect === 'speed' || effect === 'freeze' || effect === 'reverse') && random() < 0.45) {
        visual = random() < 0.75 ? 'static' : 'blank';
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
        if (stage) { stage.classList.remove('glitching'); }
        if (staticEl) { staticEl.classList.remove('active'); }
        if (blankEl) { blankEl.classList.remove('active'); }
      },
      onCount: function (n) {
        if (counterEl) { counterEl.textContent = String(n); }
      }
    });

    /* cheap CSS-only grain: nudge the gradient origin every frame the
       glitch is live, which reads as static without a canvas */
    function jitterStatic() {
      if (!staticEl) { return; }
      staticEl.style.backgroundPosition =
        Math.floor(Math.random() * 40) + 'px ' + Math.floor(Math.random() * 40) + 'px';
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
      offset += BASE_SPEED * engine.getMultiplier() * dt;
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
