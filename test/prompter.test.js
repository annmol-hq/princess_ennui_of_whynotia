/* ============================================================
   jsdom test harness for the glitch teleprompter.
   Run with:  npm test
   No framework - plain assertions, plain node.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

/* jsdom has no canvas backend, so the noise-tile generator's degraded
   path logs a known jsdomError. Silence that one message only - every
   other error still surfaces, so a real page fault is not hidden. */
function quietConsole() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    if (/Not implemented: HTMLCanvasElement/.test(err.message)) { return; }
    console.error('  jsdom error: ' + err.message);
  });
  return vc;
}

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

/* Tests are queued and run sequentially, because loading a page means
   waiting for jsdom to fire DOMContentLoaded before its scripts init. */
const queue = [];

function section(title) {
  queue.push({ section: title });
}

function check(name, fn) {
  queue.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) { throw new Error(msg || 'assertion failed'); }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'values differ') + ' | expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A localStorage that survives across the "reloads" we simulate, so we
   can assert real persistence rather than in-memory state. */
function makeStorage(seed) {
  const data = Object.assign({}, seed || {});
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
    clear() { Object.keys(data).forEach((k) => delete data[k]); },
    _data: data
  };
}

/* Loads a real page from disk. The pages pull their JS via <script src>,
   which jsdom will not fetch without a resource loader, so the real file
   contents are inlined instead. Resolves once the page's own
   DOMContentLoaded init has actually run. */
async function loadPage(file, storage, scripts) {
  let html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  scripts.forEach((s) => {
    const code = fs.readFileSync(path.join(ROOT, s), 'utf8');
    const tag = '<script src="' + s + '"></script>';
    assert(html.indexOf(tag) !== -1, file + ' should load ' + s);
    html = html.replace(tag, '<script>' + code + '</script>');
  });

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/' + file,
    pretendToBeVisual: true,
    virtualConsole: quietConsole(),
    beforeParse(window) {
      Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
    }
  });

  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => {
      dom.window.document.addEventListener('DOMContentLoaded', resolve);
    });
  }
  await wait(0);
  return dom;
}

const setupPage = (storage) => loadPage('index.html', storage, ['script.js']);
const prompterPage = (storage) => loadPage('prompter.html', storage, ['teleprompter.js']);

/* ------------------------------------------------------------------
   Page 1: setup
   ------------------------------------------------------------------ */
section('page 1 - setup');

check('typed text persists to localStorage', async () => {
  const storage = makeStorage();
  const dom = await setupPage(storage);
  const input = dom.window.document.getElementById('script-input');

  input.value = 'hello booth';
  input.dispatchEvent(new dom.window.Event('input'));

  assertEqual(storage.getItem('prompter-script'), 'hello booth',
    'script should be written to localStorage on input');
  dom.window.close();
});

check('saved text survives a reload (pre-fills the textarea)', async () => {
  const storage = makeStorage();
  const first = await setupPage(storage);
  const input = first.window.document.getElementById('script-input');
  input.value = 'line one\nline two';
  input.dispatchEvent(new first.window.Event('input'));
  first.window.close();

  /* same storage, brand new document = a reload */
  const second = await setupPage(storage);
  const reloaded = second.window.document.getElementById('script-input');
  assertEqual(reloaded.value, 'line one\nline two',
    'textarea should pre-fill from localStorage after reload');
  second.window.close();
});

check('topic generator lands on a real topic from the bank', async () => {
  const dom = await setupPage(makeStorage());
  const api = dom.window.PrompterSetup;

  assert(api.TOPICS.length >= 25,
    'topic bank should hold at least 25 topics, has ' + api.TOPICS.length);

  for (let i = 0; i < 50; i++) {
    const topic = api.pickTopic();
    assert(typeof topic === 'string' && topic.trim().length > 0, 'topic must be non-empty');
    assert(api.TOPICS.indexOf(topic) !== -1, 'topic must come from the bank: ' + topic);
  }
  dom.window.close();
});

check('rolling a topic settles the display on a real topic', async () => {
  const dom = await setupPage(makeStorage());
  const doc = dom.window.document;
  const api = dom.window.PrompterSetup;
  const display = doc.getElementById('topic-display');
  const formatRow = doc.getElementById('format-row');

  assertEqual(formatRow.hidden, true, 'format buttons should be hidden before a topic is rolled');

  doc.getElementById('roll-topic')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  /* the scramble runs on a timer - let it finish */
  await wait(1800);

  assert(api.TOPICS.indexOf(display.textContent) !== -1,
    'display should settle on a real topic, got: ' + display.textContent);
  assertEqual(formatRow.hidden, false, 'format buttons should appear once a topic lands');
  dom.window.close();
});

check('scramble settles from noise into the exact topic text', async () => {
  const dom = await setupPage(makeStorage());
  const api = dom.window.PrompterSetup;
  const target = 'an apology to a houseplant';

  const early = api.scrambleFrame(target, 0);
  const done = api.scrambleFrame(target, 1);

  assertEqual(done, target, 'progress 1 should be fully settled');
  assertEqual(early.length, target.length, 'scramble keeps the string length stable');
  assert(early !== target, 'progress 0 should still be scrambled');
  dom.window.close();
});

check('each format button produces non-empty generated text', async () => {
  const storage = makeStorage();
  const dom = await setupPage(storage);
  const doc = dom.window.document;
  const api = dom.window.PrompterSetup;
  const input = doc.getElementById('script-input');
  const topicDisplay = doc.getElementById('topic-display');

  ['speech', 'note', 'paragraph'].forEach((format) => {
    /* direct generator check */
    const text = api.generateText(format, 'the correct number of pillows');
    assert(text && text.trim().length > 20, format + ' should generate real text, got: ' + text);
    assert(text.indexOf('{topic}') === -1, format + ' left an unfilled {topic} placeholder');
    assert(text.indexOf('the correct number of pillows') !== -1,
      format + ' should slot the topic into the output');

    /* and the actual button click path */
    input.value = '';
    topicDisplay.textContent = 'the correct number of pillows';
    const btn = doc.querySelector('.format-btn[data-format="' + format + '"]');
    assert(btn, 'missing button for ' + format);
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    assert(input.value.trim().length > 20, format + ' button should fill the textarea');
    assertEqual(storage.getItem('prompter-script'), input.value,
      format + ' button should save the generated text');
  });
  dom.window.close();
});

check('generated text appends rather than destroying existing script', async () => {
  const dom = await setupPage(makeStorage());
  const doc = dom.window.document;
  const input = doc.getElementById('script-input');

  input.value = 'MY ORIGINAL LINE';
  doc.getElementById('topic-display').textContent = 'why pigeons walk like that';
  doc.querySelector('.format-btn[data-format="note"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert(input.value.indexOf('MY ORIGINAL LINE') === 0,
    'existing text must be preserved at the top');
  assert(input.value.length > 'MY ORIGINAL LINE'.length + 20,
    'generated text should have been appended');
  dom.window.close();
});

check('generator is randomized across repeat presses', async () => {
  const dom = await setupPage(makeStorage());
  const api = dom.window.PrompterSetup;
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    seen.add(api.generateText('speech', 'a eulogy for a lost sock'));
  }
  assert(seen.size > 1, 'repeat presses should not always produce identical text');
  dom.window.close();
});

check('proceed navigates to prompter.html with the script saved', async () => {
  const storage = makeStorage();
  const dom = await setupPage(storage);
  const doc = dom.window.document;
  const input = doc.getElementById('script-input');

  /* jsdom does not implement navigation, so stub the exported hook */
  let navigatedTo = null;
  dom.window.PrompterSetup.navigate = (url) => { navigatedTo = url; };

  input.value = 'the script I will fail to read';
  doc.getElementById('proceed').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assertEqual(navigatedTo, 'prompter.html', 'proceed should navigate to the prompter');
  assertEqual(storage.getItem('prompter-script'), 'the script I will fail to read',
    'proceed should save the current textarea content first');
  dom.window.close();
});

/* ------------------------------------------------------------------
   Page 2: the prompter
   ------------------------------------------------------------------ */
section('page 2 - prompter');

check('empty saved script shows the go-back message, not a blank screen', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': '' }));
  const doc = dom.window.document;

  const empty = doc.getElementById('empty-message');
  assert(empty, 'empty-message element should exist');
  assertEqual(empty.hidden, false, 'empty-message must be visible when there is no script');
  assert(empty.textContent.toLowerCase().indexOf('setup') !== -1,
    'message should point the user back to setup');
  assertEqual(doc.querySelectorAll('.line').length, 0,
    'no lines should render for an empty script');
  dom.window.close();
});

check('a completely unset script also shows the go-back message', async () => {
  const dom = await prompterPage(makeStorage());
  assertEqual(dom.window.document.getElementById('empty-message').hidden, false,
    'never-visited-setup should still explain itself');
  dom.window.close();
});

check('whitespace-only script counts as empty', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': '   \n\n  \n' }));
  assertEqual(dom.window.document.getElementById('empty-message').hidden, false,
    'whitespace-only script should trigger the go-back message');
  dom.window.close();
});

check('a real script renders one line element per line and hides the message', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'alpha\nbravo\ncharlie' }));
  const doc = dom.window.document;

  const lines = doc.querySelectorAll('.line');
  assertEqual(lines.length, 3, 'should render three lines');
  assertEqual(lines[0].textContent, 'alpha', 'first line text should match the script');
  assertEqual(doc.getElementById('empty-message').hidden, true,
    'empty message should stay hidden when a script exists');
  dom.window.close();
});

check('fake calibration runs first, then the 3-2-1 countdown', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'alpha\nbravo' }));
  const doc = dom.window.document;
  const calibration = doc.getElementById('calibration');
  const countdown = doc.getElementById('countdown');

  assertEqual(calibration.hidden, false, 'calibration should show immediately on load');
  assertEqual(countdown.hidden, true, 'countdown should wait for calibration to finish');

  /* the bar should actually advance rather than sitting at zero */
  await wait(700);
  const width = parseFloat(doc.getElementById('calibration-bar').style.width) || 0;
  assert(width > 0, 'calibration bar should progress, got ' + width + '%');

  await wait(1700);
  assertEqual(calibration.hidden, true, 'calibration should finish and hide');
  assertEqual(countdown.hidden, false, 'countdown should then take over');
  assertEqual(countdown.textContent, '3', 'countdown should start at 3');
  dom.window.close();
});

check('calibration is theatre: it changes nothing about the schedule', async () => {
  /* The premise of the whole tool is that failure is on a random timer
     and never responds to the reader. If calibration ever fed into the
     engine, that premise would be broken. */
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'alpha' }));
  const src = fs.readFileSync(path.join(ROOT, 'teleprompter.js'), 'utf8');

  const calStart = src.indexOf('function runCalibration');
  const calEnd = src.indexOf('\n    }', calStart);
  const body = src.slice(calStart, calEnd);

  assert(body.indexOf('engine.') === -1,
    'calibration must not touch the glitch engine');
  assert(body.indexOf('BASE_SPEED') === -1,
    'calibration must not alter the baseline scroll speed');
  dom.window.close();
});

check('report card grades the reader for the mess it made', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'alpha' }));
  const build = dom.window.Prompter.buildReport;

  const clean = build({ glitches: 0, readableMs: 10000, obscuredMs: 0, allTime: 3 });
  assertEqual(clean.readPercent, 100, 'an uninterrupted run should read 100%');
  assertEqual(clean.confidence, 99, 'confidence caps below certainty');

  const mauled = build({ glitches: 20, readableMs: 4000, obscuredMs: 6000, allTime: 99 });
  assertEqual(mauled.readPercent, 40, 'readable share should be 40%');
  assert(mauled.confidence < clean.confidence, 'more glitches must lower confidence');
  assertEqual(mauled.obscuredSeconds, 6, 'obscured time reported in seconds');
  assertEqual(mauled.allTime, 99, 'all-time counter carried through');

  /* verdict must degrade with the score, and always be non-empty */
  assert(clean.verdict !== mauled.verdict, 'verdict should differ with score');
  dom.window.Prompter.VERDICTS.forEach((v) => {
    assert(v.text && v.text.length > 10, 'every verdict should be real copy');
  });

  /* never divide by zero on a run that produced no frames */
  const empty = build({});
  assertEqual(empty.readPercent, 0, 'a zero-length run should not produce NaN');
  assert(empty.verdict, 'a zero-length run should still get a verdict');
  dom.window.close();
});

check('word swap uses plausible words and is reversible', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'alpha' }));
  const api = dom.window.Prompter;

  assert(api.SWAP_WORDS.length >= 15, 'swap bank should have some variety');
  api.SWAP_WORDS.forEach((word) => {
    assert(/^[a-z]+$/.test(word),
      'swap words should be ordinary lowercase words so they read aloud ' +
      'naturally before the reader notices, got: ' + word);
  });
  assert(api.GLITCH_EFFECTS.indexOf('swap') !== -1, 'swap should be a real effect');
  assert(api.GLITCH_EFFECTS.indexOf('mirror') !== -1, 'mirror should be a real effect');
  dom.window.close();
});

check('glitch audio degrades to a silent shim without WebAudio', async () => {
  /* jsdom has no WebAudio, which is exactly the case that must not
     throw - a silent browser should still get a working prompter. */
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'alpha\nbravo' }));
  const audio = dom.window.Prompter.createGlitchAudio(dom.window);

  assertEqual(audio.ok, false, 'no WebAudio available in jsdom');
  audio.burst('static', 300);
  audio.resume();

  /* and the page itself still ran */
  assert(dom.window.Prompter.instance.started, 'prompter should run without audio');
  dom.window.close();
});

/* --- the one most likely to get built backwards --- */
section('page 2 - the inverted brightness rule');

check('BRIGHTNESS IS INVERTED: reading zone is dimmer than far away', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'x' }));
  const api = dom.window.Prompter;
  const falloff = 300;

  const atZoneCentre = api.computeBrightness(0, falloff);
  const nearZone = api.computeBrightness(30, falloff);
  const farAway = api.computeBrightness(400, falloff);

  assert(atZoneCentre < farAway,
    'line AT the reading zone must be DIMMER than a line far from it ' +
    '(centre=' + atZoneCentre + ', far=' + farAway + ') - this is the core joke; ' +
    'if this fails the brightness mapping was built the normal way round');
  assert(nearZone < farAway, 'brightness must increase with distance from the zone');
  assert(atZoneCentre < nearZone, 'brightness must be monotonic increasing with distance');
  dom.window.close();
});

check('brightness is monotonic and clamped to its bounds', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'x' }));
  const api = dom.window.Prompter;
  const falloff = 300;

  let prev = -Infinity;
  for (let dist = 0; dist <= 600; dist += 25) {
    const b = api.computeBrightness(dist, falloff);
    assert(b >= prev, 'brightness must never decrease as distance grows (at ' + dist + ')');
    assert(b >= api.MIN_BRIGHTNESS - 1e-9 && b <= api.MAX_BRIGHTNESS + 1e-9,
      'brightness out of bounds at ' + dist + ': ' + b);
    prev = b;
  }
  assertEqual(api.computeBrightness(0, falloff), api.MIN_BRIGHTNESS,
    'dead centre of the reading zone should be at minimum brightness');
  assertEqual(api.computeBrightness(99999, falloff), api.MAX_BRIGHTNESS,
    'far away should saturate at maximum brightness');

  /* direction must not matter - above and below the zone are both bright */
  assertEqual(api.computeBrightness(-250, falloff), api.computeBrightness(250, falloff),
    'lines above and below the zone should be equally bright');
  dom.window.close();
});

check('rendered lines really are dimmest at the reading zone', async () => {
  /* end-to-end version of the rule: render actual lines at actual
     positions and compare the opacity the render loop assigned */
  const script = new Array(40).fill(0).map((_, i) => 'line ' + i).join('\n');
  const dom = await prompterPage(makeStorage({ 'prompter-script': script }));
  const doc = dom.window.document;
  const viewH = dom.window.innerHeight;
  const zoneCentre = viewH / 2;

  /* skip the countdown and paint one frame from mid-scroll, so the
     screen is actually full of lines rather than still filling up */
  const instance = dom.window.Prompter.instance;
  assert(instance && instance.started, 'prompter should have started with a real script');
  instance.seek(viewH);

  const visible = Array.prototype.filter.call(
    doc.querySelectorAll('.line'),
    (el) => el.style.visibility !== 'hidden' && el.style.opacity !== ''
  );
  assert(visible.length >= 3, 'expected several visible lines, got ' + visible.length);

  /* jsdom reports zero heights, so derive each line's y from its transform */
  const rows = visible.map((el) => {
    const m = /translate\(-50%,\s*(-?[\d.]+)px\)/.exec(el.style.transform);
    assert(m, 'line should have been positioned, got: ' + el.style.transform);
    return { dist: Math.abs(parseFloat(m[1]) - zoneCentre), opacity: parseFloat(el.style.opacity) };
  });

  const closest = rows.reduce((a, b) => (a.dist <= b.dist ? a : b));
  const furthest = rows.reduce((a, b) => (a.dist >= b.dist ? a : b));

  assert(closest.opacity < furthest.opacity,
    'the line nearest the reading zone must render dimmer than the furthest one ' +
    '(near=' + closest.opacity + ' at ' + Math.round(closest.dist) + 'px, ' +
    'far=' + furthest.opacity + ' at ' + Math.round(furthest.dist) + 'px)');
  dom.window.close();
});

/* --- betrayal counter --- */
section('page 2 - betrayal counter');

check('betrayal counter increments once per glitch event, not per frame', async () => {
  const storage = makeStorage();
  const dom = await prompterPage(storage);
  const api = dom.window.Prompter;

  const engine = api.createGlitchEngine({ storage });
  assertEqual(engine.getCount(), 0, 'counter should start at zero');

  engine.triggerGlitch('speed', 500);
  assertEqual(engine.getCount(), 1, 'one glitch event should increment by exactly one');
  assertEqual(storage.getItem('prompter-betrayal-count'), '1', 'counter should be persisted');

  /* a glitch stays active over many frames - that must not re-count */
  assert(engine.isActive(), 'glitch should still be active');
  for (let i = 0; i < 100; i++) { engine.getMultiplier(); }
  assertEqual(engine.getCount(), 1, 'reading the multiplier each frame must not increment');

  engine.triggerGlitch('freeze', 500);
  assertEqual(engine.getCount(), 2, 'second event should increment to two');
  engine.stop();
  dom.window.close();
});

check('betrayal counter persists across a reload', async () => {
  const storage = makeStorage();
  const first = await prompterPage(storage);
  const engineA = first.window.Prompter.createGlitchEngine({ storage });
  engineA.triggerGlitch('speed', 100);
  engineA.triggerGlitch('blank', 100);
  engineA.triggerGlitch('reverse', 100);
  engineA.stop();
  assertEqual(engineA.getCount(), 3, 'three glitches fired');
  first.window.close();

  /* reload: new document, same device storage */
  const second = await prompterPage(storage);
  const api = second.window.Prompter;
  assertEqual(api.loadBetrayalCount(storage), 3, 'count should survive the reload');

  const engineB = api.createGlitchEngine({ storage });
  assertEqual(engineB.getCount(), 3, 'a fresh engine should resume from the stored total');
  engineB.triggerGlitch('static', 100);
  assertEqual(engineB.getCount(), 4, 'it should keep counting up from there');
  engineB.stop();
  second.window.close();
});

check('stored betrayal total is displayed on the page at load', async () => {
  const storage = makeStorage({ 'prompter-script': 'alpha\nbravo', 'prompter-betrayal-count': '7' });
  const dom = await prompterPage(storage);
  const valueEl = dom.window.document.getElementById('betrayal-value');

  assert(valueEl, 'counter element should exist on the page');
  assertEqual(valueEl.textContent, '7', 'stored total should be shown on load');
  dom.window.close();
});

/* --- the sabotage layer --- */
section('page 2 - sabotage layer');

check('glitch layer modifies the multiplier then restores the baseline cleanly', async () => {
  const storage = makeStorage();
  const dom = await prompterPage(storage);
  const api = dom.window.Prompter;
  const engine = api.createGlitchEngine({ storage });

  assertEqual(engine.getMultiplier(), 1, 'baseline multiplier is 1 when idle');

  engine.triggerGlitch('speed', 5000);
  assert(engine.getMultiplier() > 1, 'speed glitch should multiply scroll speed up');
  engine.endGlitch();
  assertEqual(engine.getMultiplier(), 1, 'baseline must resume exactly after a speed glitch');

  engine.triggerGlitch('freeze', 5000);
  assertEqual(engine.getMultiplier(), 0, 'freeze glitch should stop the scroll');
  engine.endGlitch();
  assertEqual(engine.getMultiplier(), 1, 'baseline must resume after a freeze');

  engine.triggerGlitch('reverse', 5000);
  assert(engine.getMultiplier() < 0, 'reverse glitch should invert scroll direction');
  engine.endGlitch();
  assertEqual(engine.getMultiplier(), 1, 'baseline must resume after a reverse');

  engine.triggerGlitch('static', 5000);
  assertEqual(engine.getMultiplier(), 1, 'static is visual only and must not alter scroll speed');
  engine.endGlitch();

  engine.stop();
  dom.window.close();
});

check('every declared glitch effect is reachable and safe to fire', async () => {
  const storage = makeStorage();
  const dom = await prompterPage(storage);
  const api = dom.window.Prompter;
  const engine = api.createGlitchEngine({ storage });

  assertEqual(api.GLITCH_EFFECTS.length, 7, 'expected seven effect types');
  api.GLITCH_EFFECTS.forEach((effect) => {
    const info = engine.triggerGlitch(effect, 50);
    assertEqual(info.effect, effect, 'engine should report the effect it fired');
    assert(typeof engine.getMultiplier() === 'number' && !isNaN(engine.getMultiplier()),
      effect + ' produced a non-numeric multiplier');
    engine.endGlitch();
  });
  assertEqual(engine.getCount(), 7, 'each fired effect counted once');
  engine.stop();
  dom.window.close();
});

check('every glitch is followed by a real stretch of normal reading', async () => {
  /* Two failure modes bracket this. Too sparse (an early build averaged
     a 6.25s gap against a 680ms glitch) and a whole paragraph reads
     comfortably. Too dense (sub-second gaps) and there is never a calm
     moment to be interrupted from - the reader just sees chaos. */
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'x' }));
  const d = dom.window.Prompter.GLITCH_DEFAULTS;

  assert(d.minDelay >= 2000,
    'there must be a guaranteed floor of >=2s of undisturbed reading ' +
    'between glitches, got ' + d.minDelay + 'ms');

  const avgGap = (d.minDelay + d.maxDelay) / 2;
  assert(avgGap >= 2300 && avgGap <= 5000,
    'average calm stretch should sit between 2.3s and 5s, got ' + avgGap + 'ms');
  dom.window.close();
});

check('less than half the script stays readable', async () => {
  /* This is the headline number on the report card and the one the
     tuning is actually judged on. A real read-through measured 83%
     readable, which is a working teleprompter with occasional hiccups
     rather than a hostile one. Weighted by effect probability and by
     per-effect duration scaling, because speed and blank run short and
     a naive average of min/maxDuration overstates the duty cycle. */
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'x' }));
  const api = dom.window.Prompter;
  const share = api.expectedReadableShare();

  assert(share < 0.5,
    'under half the run should be readable, got ' + (share * 100).toFixed(1) + '%');
  assert(share > 0.3,
    'but not so little that there is nothing to read at all, got ' +
    (share * 100).toFixed(1) + '%');

  /* the helper must actually respond to the tuning, not return a constant */
  const gentle = api.expectedReadableShare(
    { minDelay: 8000, maxDelay: 9000, minDuration: 100, maxDuration: 200 },
    api.GLITCH_WEIGHTS, api.DURATION_SCALE);
  assert(gentle > 0.9, 'a gentle tuning should compute as mostly readable');
  dom.window.close();
});

check('a speed burst cannot outrun the whole script', async () => {
  /* The bug this pins: at 9-22x for up to 1.75s a single burst travelled
     ~2000px, more than an entire short script, so the prompter hit the
     end within seconds of starting. */
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'x' }));
  const api = dom.window.Prompter;
  const engine = api.createGlitchEngine({ storage: makeStorage() });

  let minMult = Infinity;
  let maxMult = -Infinity;
  let maxTravel = 0;
  for (let i = 0; i < 400; i++) {
    const info = engine.triggerGlitch('speed');
    const m = engine.getMultiplier();
    minMult = Math.min(minMult, m);
    maxMult = Math.max(maxMult, m);
    maxTravel = Math.max(maxTravel, api.BASE_SPEED * m * (info.duration / 1000));
    engine.endGlitch();
  }

  assert(minMult >= 4,
    'a speed burst should still be clearly faster than normal, got ' +
    minMult.toFixed(1) + 'x');
  assert(maxMult <= 12,
    'speed bursts must stay bounded, got ' + maxMult.toFixed(1) + 'x');

  /* Raw travel now exceeds a screen on the longest bursts, so the hard
     ceiling in the render loop is what actually holds the line rather
     than the duration tuning. Assert the capped figure, since that is
     what a reader experiences. */
  assert(api.MAX_BURST_TRAVEL_RATIO > 0 && api.MAX_BURST_TRAVEL_RATIO <= 0.75,
    'per-glitch travel cap should be a sane fraction of the viewport, got ' +
    api.MAX_BURST_TRAVEL_RATIO);

  const referenceViewport = 800;
  const cap = referenceViewport * api.MAX_BURST_TRAVEL_RATIO;
  const effective = Math.min(maxTravel, cap);
  assert(effective <= cap,
    'the cap must bound worst-case travel; raw was ' + maxTravel.toFixed(0) +
    'px, cap is ' + cap.toFixed(0) + 'px');
  assert(effective < referenceViewport * 0.7,
    'no single glitch should move the script most of a screen, got ' +
    effective.toFixed(0) + 'px');
  engine.stop();
  dom.window.close();
});

check('weighted picker favours the disorienting effects', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'x' }));
  const api = dom.window.Prompter;
  const engine = api.createGlitchEngine({ storage: makeStorage() });

  const seen = {};
  for (let i = 0; i < 3000; i++) {
    const info = engine.triggerGlitch();
    seen[info.effect] = (seen[info.effect] || 0) + 1;
    engine.endGlitch();
  }
  api.GLITCH_EFFECTS.forEach((e) => {
    assert(seen[e] > 0, e + ' should still be reachable from the weighted picker');
  });
  assert(seen.speed > seen.reverse,
    'speed should out-fire reverse, got speed=' + seen.speed + ' reverse=' + seen.reverse);
  assert(seen.blank / 3000 > 0.12,
    'blank should fire on >12% of events, got ' + ((seen.blank / 3000) * 100).toFixed(1) + '%');
  engine.stop();
  dom.window.close();
});

check('the reading line is shoved away the moment a glitch ends', async () => {
  const script = new Array(30).fill(0).map((_, i) => 'line ' + i).join('\n');
  const dom = await prompterPage(makeStorage({ 'prompter-script': script }));
  const inst = dom.window.Prompter.instance;
  const viewH = dom.window.innerHeight;
  const zoneCentre = viewH / 2;
  const api = dom.window.Prompter;

  inst.engine.stop();
  inst.seek(viewH);

  const nearestToZone = () => {
    const rows = Array.prototype.map.call(
      dom.window.document.querySelectorAll('.line'),
      (el) => {
        const m = /translate\(-50%,\s*(-?[\d.]+)px\)/.exec(el.style.transform);
        if (!m || el.style.visibility === 'hidden') { return null; }
        return { text: el.textContent, centre: parseFloat(m[1]) + 31 };
      }
    ).filter(Boolean);
    return rows.reduce((a, b) =>
      Math.abs(a.centre - zoneCentre) <= Math.abs(b.centre - zoneCentre) ? a : b);
  };

  const before = nearestToZone();
  const offsetBefore = inst.getOffset();

  inst.engine.triggerGlitch('blank', 20);
  inst.engine.endGlitch();
  inst.render();

  const offsetAfter = inst.getOffset();
  assert(offsetAfter > offsetBefore,
    'ending a glitch should push the script forward, not leave it in place');

  /* the line that was being read must now be near the top, on its way out */
  const moved = Array.prototype.map.call(
    dom.window.document.querySelectorAll('.line'),
    (el) => {
      const m = /translate\(-50%,\s*(-?[\d.]+)px\)/.exec(el.style.transform);
      return m && el.textContent === before.text
        ? parseFloat(m[1]) + 31 : null;
    }
  ).filter((v) => v !== null)[0];

  assert(moved !== undefined, 'the previously-read line should still be tracked');
  assert(moved < zoneCentre,
    'the line being read should end up above the reading zone, got ' +
    moved.toFixed(0) + 'px vs zone ' + zoneCentre);
  assert(moved <= viewH * api.POST_GLITCH_LAND_RATIO + 60,
    'it should land near the top of the screen, got ' + moved.toFixed(0) + 'px');

  /* and the shove is bounded, so it cannot fling the script away */
  assert(offsetAfter - offsetBefore <= viewH * api.MAX_POST_GLITCH_SKIP_RATIO + 1,
    'the shove must respect its ceiling, moved ' +
    (offsetAfter - offsetBefore).toFixed(0) + 'px');
  dom.window.close();
});

check('the shove only ever moves forward, never backward', async () => {
  const script = new Array(30).fill(0).map((_, i) => 'line ' + i).join('\n');
  const dom = await prompterPage(makeStorage({ 'prompter-script': script }));
  const inst = dom.window.Prompter.instance;
  inst.engine.stop();

  /* fire repeatedly from the very start, where the reading line is
     already above the landing point and the shove should do nothing */
  inst.seek(0);
  for (let i = 0; i < 5; i++) {
    const before = inst.getOffset();
    inst.engine.triggerGlitch('static', 20);
    inst.engine.endGlitch();
    assert(inst.getOffset() >= before,
      'offset must never go backwards on glitch end');
  }
  dom.window.close();
});

check('reversing rolls the tail of the script in from the top', async () => {
  /* Scrolling back past the start used to empty the screen. It should
     instead wrap, so the end of the script comes down from above and
     the reader has to find their place all over again. */
  const script = new Array(10).fill(0).map((_, i) => 'line ' + (i + 1)).join('\n');
  const dom = await prompterPage(makeStorage({ 'prompter-script': script }));
  const inst = dom.window.Prompter.instance;
  inst.engine.stop();

  const visibleTexts = () => Array.prototype.filter.call(
    dom.window.document.querySelectorAll('.line'),
    (el) => el.style.visibility === 'visible'
  ).map((el) => el.textContent);

  /* run backwards past the beginning */
  inst.seek(0);
  inst.render();
  const atStart = visibleTexts();
  assert(atStart.length > 0, 'lines should be visible at the start');

  inst.seek(-400);
  inst.render();
  const afterReverse = visibleTexts();

  assert(afterReverse.length > 0,
    'reversing past the start must not empty the screen');

  /* the tail of the script should have wrapped into view */
  const hasTail = afterReverse.some(
    (t) => t === 'line 9' || t === 'line 10' || t === 'line 8');
  assert(hasTail,
    'the end of the script should roll in from the top, saw: ' +
    afterReverse.join(', '));
  dom.window.close();
});

check('wrapping never loops the script during forward scrolling', async () => {
  /* Only the copy above the script is considered. A copy below would
     make line 1 reappear from the bottom during ordinary scrolling and
     the run would never reach its end. */
  /* Long enough that the whole script cannot fit on screen at once,
     otherwise seeing the first and last line together proves nothing. */
  const script = new Array(40).fill(0).map((_, i) => 'line ' + (i + 1)).join('\n');
  const dom = await prompterPage(makeStorage({ 'prompter-script': script }));
  const inst = dom.window.Prompter.instance;
  inst.engine.stop();

  for (let px = 0; px <= 1800; px += 120) {
    inst.seek(px);
    inst.render();
    const indices = Array.prototype.filter.call(
      dom.window.document.querySelectorAll('.line'),
      (el) => el.style.visibility === 'visible'
    ).map((el) => parseInt(el.textContent.replace('line ', ''), 10)).sort((a, b) => a - b);

    if (indices.length < 2) { continue; }
    assert(indices.length < 40,
      'the whole script should not be on screen at once at offset ' + px);

    /* A contiguous run means no wrap. A gap means the tail has looped
       around to sit alongside the head. */
    const span = indices[indices.length - 1] - indices[0] + 1;
    assertEqual(span, indices.length,
      'visible lines should stay contiguous during forward scroll; at offset ' +
      px + ' saw ' + indices.join(','));
  }
  dom.window.close();
});

check('most glitches produce an unmistakable full-screen event', async () => {
  /* The regression this guards: freeze, reverse, swap and mirror are all
     quiet. Adding swap and mirror pushed the quiet share to 39%, and a
     real read-through came back as "only a shaking effect" because the
     stage shake was the sole evidence most glitches left behind. */
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'x' }));
  const api = dom.window.Prompter;
  const engine = api.createGlitchEngine({ storage: makeStorage() });

  let loud = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const info = engine.triggerGlitch();
    const shows = info.effect === 'blank' || info.effect === 'static' ||
      info.visual === 'blank' || info.visual === 'static';
    if (shows) { loud++; }
    engine.endGlitch();
  }
  const share = loud / N;

  assert(share > 0.78,
    'at least ~80% of glitches should blank or snow the screen, got ' +
    (share * 100).toFixed(1) + '%');
  engine.stop();
  dom.window.close();
});

check('grain is full signal-loss static, not a translucent veil', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'x' }));
  const api = dom.window.Prompter;

  let captured = null;
  const fakeDoc = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        createImageData: (x, y) => ({ data: new Uint8ClampedArray(x * y * 4) }),
        putImageData(img) { captured = img; }
      }),
      toDataURL: () => 'data:image/png;base64,X'
    })
  };
  api.makeNoiseTiles(fakeDoc, 32, 1);

  const data = captured.data;
  let opaque = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total++;
    if (data[i + 3] > 120) { opaque++; }
  }
  /* Deliberately total. The overlay is meant to read as a television
     losing signal, so nothing shows through for the length of the
     glitch - an earlier translucent version merely tinted the glow. */
  const coverage = opaque / total;
  assertEqual(coverage, 1, 'every grain pixel should be fully opaque');

  /* Full dynamic range, centred. Television snow is high-contrast
     black-to-white; clamping the floor up produced a uniformly
     mid-bright field that the glitch filter washed out to pastel. */
  let lumaSum = 0;
  let darkest = 255;
  let brightest = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    lumaSum += data[i];
    darkest = Math.min(darkest, data[i]);
    brightest = Math.max(brightest, data[i]);
    n++;
  }
  const meanLuma = lumaSum / n;
  assert(meanLuma > 100 && meanLuma < 165,
    'snow should sit mid-range, mean luminance was ' + meanLuma.toFixed(0));
  assert(darkest < 30, 'snow needs near-black pixels, darkest was ' + darkest);
  assert(brightest > 225, 'snow needs near-white pixels, brightest was ' + brightest);
  dom.window.close();
});

check('noise tiles degrade to the CSS fallback where canvas is missing', async () => {
  /* jsdom has no canvas backend, which is exactly the degraded case the
     generator has to survive without throwing */
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'alpha\nbravo' }));
  const api = dom.window.Prompter;

  const tiles = api.makeNoiseTiles(dom.window.document, 8, 2);
  assert(Array.isArray(tiles), 'makeNoiseTiles must always return an array');
  assertEqual(tiles.length, 0, 'no canvas backend should yield no tiles, not a crash');

  /* the page must still have started and still glitch normally */
  const instance = dom.window.Prompter.instance;
  assert(instance && instance.started, 'prompter should still run without canvas');
  instance.engine.triggerGlitch('static', 50);
  assertEqual(dom.window.document.getElementById('static-overlay').classList.contains('active'),
    true, 'static glitch should still activate the overlay via the CSS fallback');
  instance.engine.endGlitch();
  instance.engine.stop();
  dom.window.close();
});

check('noise tile generator produces distinct tiles when canvas works', async () => {
  /* drive the pure generator with a stubbed canvas so the real pixel
     loop is exercised without needing a canvas backend */
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'alpha' }));
  const api = dom.window.Prompter;

  let created = 0;
  const fakeDoc = {
    createElement() {
      created++;
      let w = 0, h = 0;
      return {
        set width(v) { w = v; }, get width() { return w; },
        set height(v) { h = v; }, get height() { return h; },
        getContext() {
          return {
            createImageData: (x, y) => ({ data: new Uint8ClampedArray(x * y * 4) }),
            putImageData(img) { this._last = img; }
          };
        },
        toDataURL: () => 'data:image/png;base64,TILE' + created
      };
    }
  };

  const tiles = api.makeNoiseTiles(fakeDoc, 4, 3);
  assertEqual(tiles.length, 3, 'should produce the requested number of tiles');
  assertEqual(new Set(tiles).size, 3, 'tiles should be distinct from one another');
  tiles.forEach((t) => assert(t.indexOf('data:image/png') === 0,
    'tile should be a png data URI, got: ' + t));
  dom.window.close();
});

check('noise pixels are actually randomized, not a flat fill', async () => {
  const dom = await prompterPage(makeStorage({ 'prompter-script': 'alpha' }));
  const api = dom.window.Prompter;

  let captured = null;
  const fakeDoc = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        createImageData: (x, y) => ({ data: new Uint8ClampedArray(x * y * 4) }),
        putImageData(img) { captured = img; }
      }),
      toDataURL: () => 'data:image/png;base64,X'
    })
  };

  api.makeNoiseTiles(fakeDoc, 16, 1);
  assert(captured, 'putImageData should have been called with pixel data');

  const data = captured.data;
  const reds = new Set();
  let neighbourDiff = 0;
  let prev = null;
  for (let i = 0; i < data.length; i += 4) {
    reds.add(data[i]);
    if (prev !== null) { neighbourDiff += Math.abs(data[i] - prev); }
    prev = data[i];
  }
  assert(reds.size > 20, 'luminance should take many distinct values, got ' + reds.size);

  /* Adjacent pixels must differ sharply. A smooth gradient would also
     produce many distinct values while looking nothing like snow. */
  const avgNeighbourDiff = neighbourDiff / (data.length / 4 - 1);
  assert(avgNeighbourDiff > 30,
    'adjacent pixels should differ sharply to read as snow, average delta ' +
    avgNeighbourDiff.toFixed(1));
  dom.window.close();
});

check('glitch scheduler fires on its own over time', async () => {
  const storage = makeStorage();
  const dom = await prompterPage(storage);
  const api = dom.window.Prompter;

  /* stubbed random + very short delays so the scheduler actually fires
     within the test instead of waiting seconds */
  let fired = 0;
  const engine = api.createGlitchEngine({
    storage,
    random: () => 0.5,
    minDelay: 1, maxDelay: 1,
    minDuration: 1, maxDuration: 1,
    onStart: () => { fired++; }
  });

  engine.start();
  try {
    await wait(150);
    engine.stop();
    assert(fired > 0, 'scheduler should have fired at least one glitch on its own');
    assertEqual(engine.getCount(), fired, 'counter should match the number of events fired');
    assertEqual(Number(storage.getItem('prompter-betrayal-count')), fired,
      'every scheduled glitch should have been persisted');
  } finally {
    engine.stop();
    dom.window.close();
  }
});

/* ------------------------------------------------------------------ */

(async function run() {
  console.log('\nGLITCH TELEPROMPTER TESTS');
  for (const item of queue) {
    if (item.section) {
      console.log('\n' + item.section);
      continue;
    }
    try {
      await item.fn();
      passed++;
      console.log('  PASS  ' + item.name);
    } catch (err) {
      failed++;
      console.log('  FAIL  ' + item.name);
      console.log('        ' + err.message);
    }
  }

  console.log('\n' + '-'.repeat(50));
  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  console.log('-'.repeat(50) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
