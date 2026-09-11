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

  /* Where the first line sits when the countdown ends, as a fraction of
     viewport height. 0.5 drops it straight into the reading zone, so
     there is no free run-up: at 0.9 the script rose from below the fold
     and handed the reader several unhindered seconds before the dimming
     even started. */
  var START_Y_RATIO = 0.5;

  /* When a glitch ends, the line that was sitting in the reading zone is
     shoved up to this fraction of viewport height - near the top, on its
     way out. The reader comes back from a blackout to find the line they
     were on already leaving, never getting a settled moment with it.
     The next line lands in the dim zone, so there is no comfortable
     position anywhere on screen. */
  var POST_GLITCH_LAND_RATIO = 0.18;

  /* Ceiling on that shove, so it can never fling the script forward the
     way an unbounded speed burst once did. */
  var MAX_POST_GLITCH_SKIP_RATIO = 0.4;

  /* ---------- canvas grain ---------- */

  /* A handful of small noise tiles, rendered once at startup and then
     cycled during a glitch. Repeating one tile across the viewport is
     vastly cheaper than painting every screen pixel per frame, and
     swapping which tile is showing hides the fact that it repeats. */
  var NOISE_TILE_SIZE = 128;
  var NOISE_TILE_COUNT = 6;

  /* Only a faint magenta cast. Pushed near neutral on purpose: a heavy
     tint reads as a coloured veil, whereas real signal-loss snow is
     close to grey. */
  var NOISE_GREEN_BIAS = 0.86;

  /* Fraction of pixels left fully transparent. Zero: this is meant to
     be total signal loss, so the tile is fully opaque and the text
     behind it disappears completely for the length of the glitch. */
  var NOISE_SPARSITY = 0;

  /* Full black-to-white range. Clamping the floor up made the field
     uniformly mid-bright, which the stage's glitch filter then pushed
     into a flat pastel wash. Real snow needs its blacks. */
  var NOISE_MIN_LUMA = 0;

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
          var v = NOISE_MIN_LUMA + ((random() * (255 - NOISE_MIN_LUMA)) | 0);
          data[i] = v;
          data[i + 1] = (v * NOISE_GREEN_BIAS) | 0;
          data[i + 2] = v;
          /* Fully opaque: total signal loss, nothing shows through. */
          data[i + 3] = random() < NOISE_SPARSITY ? 0 : 255;
        }
        ctx.putImageData(img, 0, 0);
        tiles.push(canvas.toDataURL('image/png'));
      } catch (e) {
        return [];
      }
    }
    return tiles;
  }

  /* ---------- the report card ---------- */

  var VERDICTS = [
    /* worst first; the first entry whose threshold the score clears wins */
    { at: 90, text: 'Suspiciously competent. The machine will try harder next time.' },
    { at: 70, text: 'Adequate. Nobody will remember it, which is its own kind of mercy.' },
    { at: 50, text: 'A performance. Technically. Some words were definitely said.' },
    { at: 30, text: 'The audience has questions. None of them are about your topic.' },
    { at: 15, text: 'Whatever that was, it was not a speech. Areas for improvement: everything.' },
    { at: 0, text: 'Total communication failure. Genuinely impressive in its own way.' }
  ];

  /* Pure so the numbers can be tested without running a real scroll.
     None of this is a real measurement of the reader - it is the tool
     grading you for a mess it created, which is the joke. */
  function buildReport(stats) {
    var glitches = stats.glitches || 0;
    var readable = stats.readableMs || 0;
    var obscured = stats.obscuredMs || 0;
    var total = readable + obscured;

    var readPercent = total > 0 ? Math.round((readable / total) * 100) : 0;

    /* confidence falls off with both interruption count and lost time */
    var confidence = Math.max(0, Math.min(99,
      Math.round(readPercent - glitches * 3.5)));

    var verdict = VERDICTS[VERDICTS.length - 1].text;
    for (var i = 0; i < VERDICTS.length; i++) {
      if (confidence >= VERDICTS[i].at) { verdict = VERDICTS[i].text; break; }
    }

    return {
      glitches: glitches,
      readPercent: readPercent,
      obscuredSeconds: Math.round(obscured / 100) / 10,
      confidence: confidence,
      allTime: stats.allTime || 0,
      verdict: verdict
    };
  }

  /* ---------- glitch audio ---------- */

  /* White noise synthesised in WebAudio rather than shipped as a file,
     so this stays a zero-asset, zero-network page. Returns a no-op
     shim wherever WebAudio is missing or blocked, so a silent browser
     never breaks the prompter. */
  function createGlitchAudio(win) {
    var w = win || global;
    var Ctx = w.AudioContext || w.webkitAudioContext;
    var silent = { burst: function () {}, resume: function () {}, ok: false };
    if (!Ctx) { return silent; }

    var ctx;
    try { ctx = new Ctx(); } catch (e) { return silent; }

    /* one second of noise, reused for every burst */
    var buffer;
    try {
      var frames = ctx.sampleRate;
      buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      var chan = buffer.getChannelData(0);
      for (var i = 0; i < frames; i++) { chan[i] = Math.random() * 2 - 1; }
    } catch (e) { return silent; }

    function burst(effect, durationMs) {
      if (!ctx || ctx.state === 'closed') { return; }
      try {
        var now = ctx.currentTime;
        var dur = Math.min(1.2, Math.max(0.05, (durationMs || 300) / 1000));

        var src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;

        /* Different textures per effect: hiss for the visual failures,
           a duller thud for the ones that move the script. */
        var filter = ctx.createBiquadFilter();
        if (effect === 'static' || effect === 'blank') {
          filter.type = 'highpass';
          filter.frequency.value = 1400;
        } else if (effect === 'freeze' || effect === 'reverse') {
          filter.type = 'lowpass';
          filter.frequency.value = 320;
        } else {
          filter.type = 'bandpass';
          filter.frequency.value = 800;
        }

        var gain = ctx.createGain();
        var peak = (effect === 'static' || effect === 'blank') ? 0.16 : 0.1;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(peak, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

        src.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        src.start(now);
        src.stop(now + dur + 0.05);
      } catch (e) { /* never let audio break the read */ }
    }

    return {
      burst: burst,
      /* browsers start the context suspended until a user gesture */
      resume: function () {
        try { if (ctx.state === 'suspended') { ctx.resume(); } } catch (e) { /* ignore */ }
      },
      ok: true
    };
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

  var GLITCH_EFFECTS = ['speed', 'freeze', 'reverse', 'static', 'blank', 'swap', 'mirror'];

  /* Not uniform. Speed and blank are the two that actually break a
     reader's place, so they carry the most weight. */
  /* Heavily skewed toward the three effects a reader cannot miss.
     freeze, reverse, swap and mirror are all quiet - if you are not
     looking for them, the shake and the filter are the only evidence a
     glitch happened at all. At 39% combined they were swallowing most
     of the budget and the prompter read as "a bit shaky". Kept as
     garnish only. */
  var GLITCH_WEIGHTS = {
    blank: 27, static: 27, speed: 24,
    freeze: 8, reverse: 7, swap: 5, mirror: 2
  };

  /* Substitutions for the word-swap glitch. The joke only lands if the
     replacement is plausible enough to be read aloud before the reader
     notices, so these are ordinary words, not nonsense. */
  var SWAP_WORDS = [
    'feelings', 'pigeons', 'moisture', 'regret', 'trousers', 'lasagne',
    'bees', 'paperwork', 'gravy', 'betrayal', 'hamsters', 'legally',
    'damp', 'goblins', 'enthusiasm', 'yoghurt', 'sincerely', 'haunted',
    'committee', 'nonsense', 'jazz', 'unwell', 'forbidden', 'soup'
  ];

  /* The delay is measured from the END of one glitch to the START of
     the next, so minDelay is a guaranteed floor of undisturbed reading.
     Keep it at or above 2s: a build with sub-second gaps and violent
     speed bursts chewed through an entire script in the first three
     seconds and then sat at the end with nothing left to scroll.

     Glitches still need to bite, so duration stays long relative to the
     gap - this lands near a 20% duty cycle, roughly one interruption
     every three to five seconds. */
  var GLITCH_DEFAULTS = {
    minDelay: 2000,
    maxDelay: 2700,
    minDuration: 1900,
    maxDuration: 5000
  };

  /* Per-effect duration scaling. Speed and blank are punchier short, so
     they run well under the nominal range - which means the effective
     duty cycle is lower than the raw min/maxDuration imply. Anything
     reasoning about how much of the script stays readable has to weight
     by these, not by the nominal average. */
  var DURATION_SCALE = { speed: 0.5, blank: 0.5 };

  /* Expected share of a run that stays readable, given a tuning. This
     is what the report card's "script you actually got to read" figure
     converges on, so it is the number to reason about when deciding how
     hostile the prompter should be. Weighted by effect probability and
     by each effect's duration scaling. */
  function expectedReadableShare(defaults, weights, scales) {
    var d = defaults || GLITCH_DEFAULTS;
    var w = weights || GLITCH_WEIGHTS;
    var s = scales || DURATION_SCALE;

    var totalWeight = 0;
    var scaleSum = 0;
    for (var i = 0; i < GLITCH_EFFECTS.length; i++) {
      var effect = GLITCH_EFFECTS[i];
      var weight = w[effect] || 0;
      totalWeight += weight;
      scaleSum += weight * (s[effect] || 1);
    }
    if (!totalWeight) { return 1; }

    var avgGap = (d.minDelay + d.maxDelay) / 2;
    var avgDuration = ((d.minDuration + d.maxDuration) / 2) * (scaleSum / totalWeight);
    return avgGap / (avgGap + avgDuration);
  }

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
      if (effect === 'speed') { return between(6, 11); }
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
      return d * (DURATION_SCALE[effect] || 1);
    }

    /* Fires one glitch event. The betrayal counter increments exactly
       once here - per event, never per frame. */
    function triggerGlitch(forcedEffect, forcedDuration) {
      var effect = forcedEffect || pickEffect();
      var duration = forcedDuration || durationFor(effect);

      /* Nearly always stack a visual on the motion effects, so a speed
         burst blinds you as well as moving. Without this, freeze and
         reverse in particular pass unnoticed. swap and mirror are
         deliberately excluded: both only land if the reader can
         actually see the text. */
      var visual = null;
      if ((effect === 'speed' || effect === 'freeze' || effect === 'reverse') && random() < 0.85) {
        visual = random() < 0.5 ? 'static' : 'blank';
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
    var calibrationEl = d.getElementById('calibration');
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
    var startY = viewH * START_Y_RATIO;
    var lastTs = null;
    var finished = false;

    /* no single glitch may drag the script more than this far */
    var maxBurstTravel = viewH * MAX_BURST_TRAVEL_RATIO;
    var burstTravel = 0;

    var audio = createGlitchAudio(w);

    /* session tallies for the report card */
    var sessionGlitches = 0;
    var obscuredMs = 0;
    var readableMs = 0;

    /* word-swap bookkeeping: which node was altered, and its real text */
    var swappedNode = null;
    var swappedOriginal = null;

    /* Swaps one word in a line the reader has not reached yet, so they
       read it aloud before noticing. Picks from the lines below the
       reading zone; if none qualify, does nothing rather than mangling
       a line already being read. */
    function applyWordSwap() {
      var candidates = [];
      for (var i = 0; i < nodes.length; i++) {
        var y = startY + tops[i] - offset;
        if (y > zoneCentre + 40 && y < viewH + 200) { candidates.push(nodes[i]); }
      }
      if (!candidates.length) { return; }

      var node = candidates[Math.floor(Math.random() * candidates.length)];
      var text = node.textContent;
      var words = text.split(/(\s+)/);
      var idx = [];
      for (var j = 0; j < words.length; j++) {
        if (/^[A-Za-z]{4,}$/.test(words[j])) { idx.push(j); }
      }
      if (!idx.length) { return; }

      var pick = idx[Math.floor(Math.random() * idx.length)];
      swappedNode = node;
      swappedOriginal = text;
      words[pick] = SWAP_WORDS[Math.floor(Math.random() * SWAP_WORDS.length)];
      node.textContent = words.join('');
    }

    /* Called the instant a glitch ends. Finds whichever line is sitting
       closest to the reading zone and pushes it up near the top of the
       screen, so it is already on its way out by the time the reader can
       see again. Only ever moves the script forward. */
    function skipPastReadingLine() {
      var bestIdx = -1;
      var bestDist = Infinity;

      for (var i = 0; i < nodes.length; i++) {
        var h = nodes[i].offsetHeight || FALLBACK_LINE_HEIGHT;
        var centre = startY + tops[i] - offset + h / 2;
        var dist = Math.abs(centre - zoneCentre);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) { return; }

      var bh = nodes[bestIdx].offsetHeight || FALLBACK_LINE_HEIGHT;
      var currentCentre = startY + tops[bestIdx] - offset + bh / 2;
      var target = viewH * POST_GLITCH_LAND_RATIO;
      var shove = currentCentre - target;

      if (shove <= 0) { return; } /* already past it, leave it alone */
      offset += Math.min(shove, viewH * MAX_POST_GLITCH_SKIP_RATIO);
    }

    function undoWordSwap() {
      if (swappedNode && swappedOriginal !== null) {
        swappedNode.textContent = swappedOriginal;
      }
      swappedNode = null;
      swappedOriginal = null;
    }

    var engine = createGlitchEngine({
      onStart: function (info) {
        sessionGlitches++;
        audio.burst(info.effect, info.duration);

        if (stage) { stage.classList.add('glitching'); }
        if (info.visual === 'static' || info.effect === 'static') {
          if (staticEl) { staticEl.classList.add('active'); }
        }
        if (info.visual === 'blank' || info.effect === 'blank') {
          if (blankEl) { blankEl.classList.add('active'); }
        }
        if (info.effect === 'swap') { applyWordSwap(); }
        if (info.effect === 'mirror' && linesEl) { linesEl.classList.add('mirrored'); }
        jitterStatic();
      },
      onEnd: function () {
        burstTravel = 0; /* each glitch gets its own travel budget */
        skipPastReadingLine();
        undoWordSwap();
        if (linesEl) { linesEl.classList.remove('mirrored'); }
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
      if (jitterTick % 2 === 0) {
        tileCursor = (tileCursor + 1 + Math.floor(Math.random() * (noiseTiles.length - 1))) %
          noiseTiles.length;
        staticEl.style.backgroundImage = 'url(' + noiseTiles[tileCursor] + ')';
      }
    }

    function onScreen(y, h) {
      return !(y + h < -40 || y > viewH + 40);
    }

    function render() {
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var h = el.offsetHeight || FALLBACK_LINE_HEIGHT;
        var y = startY + tops[i] - offset;

        /* Once the scroll has run backwards past the start, the script
           becomes a loop: the tail rolls down into view from above
           instead of the screen emptying out, so a reverse dumps you
           into ...9, 10, 1, 2... and you have to find your place again.

           Gated on a negative offset. Wrapping while still moving
           forward would put the tail above line 1 from the very first
           frame and the run would never reach its end. */
        if (offset < 0 && totalHeight > 0) {
          while (y > viewH + 40) { y -= totalHeight; }
          while (y + h < -40) { y += totalHeight; }
        }

        if (!onScreen(y, h)) {
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
      /* Reverse may now run past the start - that is what lets the tail
         wrap down from the top. Bounded to one script length so a run of
         reverses cannot strand the reader arbitrarily far behind. */
      if (offset < -totalHeight) { offset = -totalHeight; }

      /* Split the run into time the reader could actually use and time
         the tool took away from them. Feeds the report card. */
      if (engine.isActive()) {
        obscuredMs += dt * 1000;
        jitterStatic();
      } else {
        readableMs += dt * 1000;
      }

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

      undoWordSwap();
      if (linesEl) { linesEl.classList.remove('mirrored'); }

      var card = buildReport({
        glitches: sessionGlitches,
        readableMs: readableMs,
        obscuredMs: obscuredMs,
        allTime: engine.getCount()
      });

      var end = d.createElement('div');
      end.id = 'report-card';
      end.innerHTML =
        '<h2>END OF SCRIPT</h2>' +
        '<dl>' +
        '<div><dt>Betrayals this session</dt><dd>' + card.glitches + '</dd></div>' +
        '<div><dt>Script you actually got to read</dt><dd>' + card.readPercent + '%</dd></div>' +
        '<div><dt>Time spent obstructed</dt><dd>' + card.obscuredSeconds + 's</dd></div>' +
        '<div><dt>Estimated audience confidence</dt><dd>' + card.confidence + '%</dd></div>' +
        '<div><dt>Betrayals all-time on this device</dt><dd>' + card.allTime + '</dd></div>' +
        '</dl>' +
        '<p class="verdict">' + card.verdict + '</p>' +
        '<a href="index.html">&larr; BACK TO SETUP</a>';
      if (stage) { stage.appendChild(end); }
      return card;
    }

    function begin() {
      audio.resume();
      render();
      engine.start();
      if (w.requestAnimationFrame) { w.requestAnimationFrame(frame); }
    }

    /* Pure theatre. It measures nothing, adapts nothing, and the result
       is discarded - the glitch schedule is random and was always going
       to be. Every real teleprompter implies it is working with you;
       this one only implies it. */
    function runCalibration(done) {
      if (!calibrationEl) { done(); return; }
      calibrationEl.hidden = false;

      var bar = d.getElementById('calibration-bar');
      var note = d.getElementById('calibration-note');
      var notes = [
        'measuring your natural reading pace',
        'sampling syllable rate',
        'adapting scroll speed to you',
        'building your reader profile'
      ];
      var step = 0;

      var tick = setInterval(function () {
        step++;
        if (bar) { bar.style.width = Math.min(100, step * 9) + '%'; }
        if (note && step % 4 === 0) {
          note.textContent = notes[Math.min(notes.length - 1, Math.floor(step / 4))];
        }
        if (step >= 11) {
          clearInterval(tick);
          if (note) { note.textContent = 'calibration complete'; }
          setTimeout(function () {
            calibrationEl.hidden = true;
            done();
          }, 420);
        }
      }, 130);
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

    runCalibration(function () { runCountdown(begin); });

    return {
      started: true,
      engine: engine,
      lineCount: nodes.length,
      getOffset: function () { return offset; },
      /* end the run now and show the report card, without waiting out
         the whole script */
      finish: function () { return finish(); },
      /* jump the scroll to a given pixel offset and repaint once */
      seek: function (px) {
        offset = Math.max(-totalHeight, px);
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
    SWAP_WORDS: SWAP_WORDS,
    VERDICTS: VERDICTS,
    buildReport: buildReport,
    createGlitchAudio: createGlitchAudio,
    GLITCH_DEFAULTS: GLITCH_DEFAULTS,
    DURATION_SCALE: DURATION_SCALE,
    expectedReadableShare: expectedReadableShare,
    MAX_BURST_TRAVEL_RATIO: MAX_BURST_TRAVEL_RATIO,
    START_Y_RATIO: START_Y_RATIO,
    POST_GLITCH_LAND_RATIO: POST_GLITCH_LAND_RATIO,
    MAX_POST_GLITCH_SKIP_RATIO: MAX_POST_GLITCH_SKIP_RATIO,
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
