/* ============================================================
   Glitch Teleprompter - setup page (index.html)
   Vanilla JS, no build step. Everything runs offline: the topic
   generator is a local bank + local templates, never an API call.
   ============================================================ */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'prompter-script';

  /* ---------- character scramble effect ---------- */

  var SCRAMBLE_CHARS = '!<>-_\\/[]{}=+*^?#$%&@0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /* Pure frame renderer: given the target text and a 0..1 progress,
     return the partially-settled string. Characters lock in from the
     left; spaces are never scrambled so word shape stays readable. */
  function scrambleFrame(finalText, progress, rand) {
    var random = rand || Math.random;
    var clamped = progress < 0 ? 0 : (progress > 1 ? 1 : progress);
    var revealed = Math.floor(finalText.length * clamped);
    var out = '';
    for (var i = 0; i < finalText.length; i++) {
      var ch = finalText.charAt(i);
      if (i < revealed || ch === ' ') {
        out += ch;
      } else {
        out += SCRAMBLE_CHARS.charAt(Math.floor(random() * SCRAMBLE_CHARS.length));
      }
    }
    return out;
  }

  /* Animates an element from noise into finalText over a duration in ms. */
  function scrambleText(el, finalText, options) {
    var opts = options || {};
    var duration = opts.duration || 1500;
    var frameMs = opts.frameMs || 45;
    var onDone = opts.onDone;
    var started = Date.now();

    var timer = setInterval(function () {
      var progress = (Date.now() - started) / duration;
      if (progress >= 1) {
        clearInterval(timer);
        el.textContent = finalText;
        if (onDone) { onDone(finalText); }
        return;
      }
      el.textContent = scrambleFrame(finalText, progress);
    }, frameMs);

    return function cancel() { clearInterval(timer); };
  }

  /* ---------- local topic bank ---------- */

  var TOPICS = [
    'the correct way to eat a sandwich',
    'why the office printer hates you',
    'an apology to a houseplant',
    'the ethics of the last slice of pizza',
    'why your phone charger is always in the other room',
    'a eulogy for a lost sock',
    'the secret life of shopping trolleys',
    'how to lose an argument with a toddler',
    'why Monday deserves a formal warning',
    'the politics of the shared office fridge',
    'a defence of the snooze button',
    'why doors marked PUSH are a conspiracy',
    'the correct number of pillows',
    'an open letter to autocorrect',
    'why pigeons walk like that',
    'the untapped potential of the humble spoon',
    'how to nap professionally',
    'why the WiFi knows when you are busy',
    'a history of the tangled headphone cable',
    'the case against small talk in lifts',
    'why you own eleven tote bags',
    'the hidden agenda of motion-sensor taps',
    'how to argue with a self-checkout machine',
    'why cables multiply in the drawer',
    'an ode to the last chip in the packet',
    'the psychology of pretending to read a menu you already know',
    'why alarm clocks are fundamentally untrustworthy',
    'the correct temperature for absolutely anything',
    'a strongly worded complaint about gravity',
    'why every remote control has one useful button'
  ];

  function pick(list, rand) {
    var random = rand || Math.random;
    return list[Math.floor(random() * list.length)];
  }

  function pickDistinct(list, count, rand) {
    var random = rand || Math.random;
    var pool = list.slice();
    var out = [];
    while (out.length < count && pool.length) {
      out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
    }
    return out;
  }

  function pickTopic(rand) {
    return pick(TOPICS, rand);
  }

  /* ---------- Mad-libs template system (one shape per format) ---------- */

  var TEMPLATES = {
    speech: {
      openers: [
        'Friends, colleagues, reluctant attendees. We need to talk about {topic}.',
        'Thank you all for coming. I have been asked to speak on {topic}, and I will not be brief.',
        'They said it could not be done. They said nobody would stand here and address {topic}. They were wrong.',
        'I want you to picture something. Picture {topic}. Now hold that thought for the next nine minutes.'
      ],
      middles: [
        'For too long we have accepted the status quo around {topic}. That ends today.',
        'Studies I have not read suggest {topic} costs the average person four hours a week.',
        'My grandmother warned me about {topic}. I did not listen. I am listening now.',
        'Let us be honest with ourselves: not one person in this room has a coherent position on {topic}.',
        'There are those who say {topic} is trivial. To them I say: come outside.',
        'History will judge us by exactly one metric, and that metric is {topic}.',
        'I have consulted experts. I have consulted amateurs. I have consulted a man at a bus stop. All agree on {topic}.'
      ],
      closers: [
        'So I ask you today: stand with me on {topic}. Or at least stop standing against it.',
        'In conclusion, {topic} is not a problem. It is an opportunity wearing a problem costume. Thank you.',
        'Go forth. Tell your friends. Tell your enemies. The era of {topic} has begun.',
        'And if I am remembered for nothing else, let it be this: I said something about {topic}, out loud, in public.'
      ]
    },
    note: {
      openers: [
        'NOTES - {topic}',
        're: {topic} (do not circulate)',
        'Thinking out loud about {topic}:',
        'Scratch notes, {topic}, revisit later:'
      ],
      middles: [
        '- main point: {topic} is worse than reported',
        '- counterpoint: possibly fine, unclear',
        '- ask someone about {topic} before the meeting',
        '- follow up on {topic} - nobody owns this',
        '- action item: stop thinking about {topic} at 2am',
        '- unresolved: who signed off on {topic}',
        '- budget implications of {topic}: unknown, probably large',
        '- flag {topic} at standup, brace for silence'
      ],
      closers: [
        '- decision: park {topic} until someone else cares',
        '- next step: none. that is the step.',
        '- summary: {topic} remains an open question and always will',
        '- TODO: delete this note before anyone reads it'
      ]
    },
    paragraph: {
      openers: [
        'There is a quiet dignity to {topic} that goes largely unremarked.',
        'Nobody sets out to think seriously about {topic}, and yet here we are.',
        'It began, as these things do, with {topic}.',
        'Consider {topic}, if only because nobody else will.'
      ],
      middles: [
        'It sits at the exact intersection of the mundane and the unforgivable.',
        'Most people encounter it daily and choose, wisely, to say nothing.',
        'The experts are divided, largely because the experts do not exist.',
        'What began as a minor irritation has calcified into a worldview.',
        'You can trace almost any modern failure back to it, if you are sufficiently unwell.',
        'It rewards the patient and punishes absolutely everybody else.',
        'There is no correct approach, only a long ranked list of wrong ones.'
      ],
      closers: [
        'And so {topic} endures, unexamined, undefeated.',
        'Perhaps that is the point of {topic}. Perhaps there is no point. Perhaps that is also the point.',
        'We will not solve {topic} today. We will simply agree to stop pretending we could.',
        'In the end, {topic} asks nothing of us, which is precisely the problem.'
      ]
    }
  };

  function fill(template, topic) {
    return template.replace(/\{topic\}/g, topic);
  }

  /* Builds a fresh block of text for a format about a topic.
     Randomized on every call so repeat presses give different copy. */
  function generateText(format, topic, rand) {
    var spec = TEMPLATES[format];
    if (!spec || !topic) { return ''; }
    var random = rand || Math.random;
    var bodyCount = format === 'note' ? 4 : 3;
    var parts = [fill(pick(spec.openers, random), topic)];
    pickDistinct(spec.middles, bodyCount, random).forEach(function (line) {
      parts.push(fill(line, topic));
    });
    parts.push(fill(pick(spec.closers, random), topic));

    /* Speech and note read as separate prompter lines; a paragraph is
       one flowing block that the prompter will wrap on its own. */
    return format === 'paragraph' ? parts.join(' ') : parts.join('\n');
  }

  /* ---------- persistence ---------- */

  function loadScript(storage) {
    var store = storage || global.localStorage;
    try { return store.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }

  function saveScript(text, storage) {
    var store = storage || global.localStorage;
    try { store.setItem(STORAGE_KEY, text); } catch (e) { /* private mode */ }
  }

  /* ---------- DOM wiring ---------- */

  function init(doc) {
    var d = doc || global.document;
    var input = d.getElementById('script-input');
    var topicDisplay = d.getElementById('topic-display');
    var rollBtn = d.getElementById('roll-topic');
    var formatRow = d.getElementById('format-row');
    var proceed = d.getElementById('proceed');
    var saveState = d.getElementById('save-state');
    if (!input) { return null; }

    var currentTopic = '';

    /* pre-fill from a previous session */
    var saved = loadScript();
    if (saved) {
      input.value = saved;
      if (saveState) { saveState.textContent = 'restored from last session'; }
    }

    input.addEventListener('input', function () {
      saveScript(input.value);
      if (saveState) { saveState.textContent = 'saved'; }
    });

    if (rollBtn) {
      rollBtn.addEventListener('click', function () {
        rollBtn.disabled = true;
        if (formatRow) { formatRow.hidden = true; }
        var topic = pickTopic();
        scrambleText(topicDisplay, topic, {
          onDone: function (settled) {
            currentTopic = settled;
            rollBtn.disabled = false;
            rollBtn.textContent = 'ROLL AGAIN';
            if (formatRow) { formatRow.hidden = false; }
          }
        });
      });
    }

    var buttons = d.querySelectorAll('.format-btn');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        var topic = currentTopic || topicDisplay.textContent.trim();
        var block = generateText(btn.getAttribute('data-format'), topic);
        if (!block) { return; }
        /* append, never overwrite what the user already wrote */
        input.value = input.value.trim() ? input.value.replace(/\s*$/, '') + '\n\n' + block : block;
        saveScript(input.value);
        if (saveState) { saveState.textContent = 'generated + saved'; }
      });
    });

    if (proceed) {
      proceed.addEventListener('click', function () {
        saveScript(input.value);
        /* routed through the exported API so it can be stubbed in tests */
        global.PrompterSetup.navigate('prompter.html');
      });
    }

    return { getTopic: function () { return currentTopic; } };
  }

  global.PrompterSetup = {
    STORAGE_KEY: STORAGE_KEY,
    SCRAMBLE_CHARS: SCRAMBLE_CHARS,
    TOPICS: TOPICS,
    TEMPLATES: TEMPLATES,
    scrambleFrame: scrambleFrame,
    scrambleText: scrambleText,
    pickTopic: pickTopic,
    generateText: generateText,
    loadScript: loadScript,
    saveScript: saveScript,
    navigate: function (url) { global.location.href = url; },
    init: init
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(document); });
    } else {
      init(document);
    }
  }
})(typeof window !== 'undefined' ? window : this);
