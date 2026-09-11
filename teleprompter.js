/*
  The Royal Address Helper + Read The Decree challenge.

  Both share one rule: failure runs on a random timer, never tied to
  performance. Reading perfectly does not save you, hesitating does
  not doom you. That's the joke, and it's also why this is simpler
  and more reliable than anything built on detecting hesitation or
  mic volume, there is nothing to calibrate and nothing that can
  misfire on a noisy floor.
*/

const BETRAYAL_LINES = [
  "the words have abandoned you.",
  "even the parchment gave up on you.",
  "the teleprompter has lost faith in you.",
  "royal signal lost. try feelings instead."
];

const GLITCH_CHARS = "▓▒░#%&?*";

function scrambleText(text) {
  return text
    .split("")
    .map((c) => (c === " " ? " " : GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)]))
    .join("");
}

// ---------- shared glitch engine ----------

function createGlitchEngine(el, opts = {}) {
  const {
    minDelay = 4000,
    maxDelay = 9000,
    chance = 0.5,
    minDuration = 1200,
    maxDuration = 2800,
    onFire = null
  } = opts;

  let timer = null;
  let active = false;

  function schedule() {
    const delay = minDelay + Math.random() * (maxDelay - minDelay);
    timer = setTimeout(() => {
      if (!active) return;
      if (Math.random() < chance) fire();
      schedule();
    }, delay);
  }

  function fire() {
    if (onFire) onFire();
    const original = el.textContent;
    const useBetrayalLine = Math.random() < 0.3;
    el.classList.add("glitching");
    el.textContent = useBetrayalLine
      ? BETRAYAL_LINES[Math.floor(Math.random() * BETRAYAL_LINES.length)]
      : scrambleText(original);

    const duration = minDuration + Math.random() * (maxDuration - minDuration);
    setTimeout(() => {
      el.classList.remove("glitching");
      el.textContent = original;
    }, duration);
  }

  return {
    start() {
      active = true;
      schedule();
    },
    stop() {
      active = false;
      clearTimeout(timer);
      el.classList.remove("glitching");
    }
  };
}

// ---------- royal address helper ----------
// Short, repeatable pitch lines for real 1-2 minute walk-up explanations,
// not the full ceremonial narration, that one's for the recorded video.

const PITCH_LINES = [
  "This is Princess Ennui of Whynotia. Her one royal gift: achieving nothing, with maximum effort.",
  "Everything on this table is a piece of her day, from sunrise to sunset.",
  "Ask her anything. She'll dodge a real question and answer a fake one instead.",
  "Her council debates for ages, then decides everything with a coin flip.",
  "Checking one to-do item takes a CAPTCHA, a wall of terms, a blockchain spinner, and a trivia question.",
  "She's been questing forever, on purpose. The quest was never meant to end.",
  "This teleprompter is helping me tell you all this. It will betray me at some point. That's also the point."
];

const prompterLine = document.getElementById("prompter-line");
const startBtn = document.getElementById("prompter-start");
const nextBtn = document.getElementById("prompter-next");

let pitchIndex = -1;
let addressGlitch = null;

function showPitchLine(i) {
  prompterLine.textContent = PITCH_LINES[i];
}

startBtn.addEventListener("click", () => {
  pitchIndex = 0;
  showPitchLine(pitchIndex);
  if (addressGlitch) addressGlitch.stop();
  addressGlitch = createGlitchEngine(prompterLine, {
    minDelay: 4000,
    maxDelay: 9000,
    chance: 0.5
  });
  addressGlitch.start();
});

nextBtn.addEventListener("click", () => {
  if (pitchIndex === -1) return;
  pitchIndex = (pitchIndex + 1) % PITCH_LINES.length;
  showPitchLine(pitchIndex);
});

// ---------- read the decree (visitor challenge) ----------

const DECREES = {
  novice: [
    "By royal decree, naps are now mandatory before noon.",
    "The kingdom hereby declares all socks single by default.",
    "Let it be known: the royal cat outranks the royal council."
  ],
  court: [
    "The Duke of Drowsyshire demands a formal apology from the Sock of Sorrow.",
    "Whynotia's Wardrobe Council washes woolen waistcoats weekly, whenever whimsy allows.",
    "Mercury is, once again, allegedly in retrograde, and the treasury refuses to comment."
  ],
  royal: [
    "The Brainrot Index has officially exceeded the Rizz Reserve, and the Delulu Department declines all further questioning, technologiaaa notwithstanding.",
    "Let the record show the Royal Herald hereby heralds the hereditary heralding of the Hereditary Herald's heraldry.",
    "By the power vested in absolutely no one, the Sixth Seventh Ministry of Uwu Affairs stands, sits, and remains gloriously undecided."
  ]
};

const SUCCESS_LINES = {
  novice: "The decree stands. The kingdom is mildly impressed.",
  court: "Flawless. Whynotia trembles with unnecessary respect.",
  royal: "Impossible. The Royal Archives are updating themselves as we speak."
};

const FAILURE_LINES = ["The words have abandoned you.", "Even the parchment gave up on you."];

// Higher tiers glitch more often, purely for pacing, not as a fairness
// mechanic, the outcome is still decided by chance either way.
const CHANCE_BY_TIER = { novice: 0.25, court: 0.4, royal: 0.6 };

const tierRow = document.getElementById("tier-row");
const decreeBox = document.getElementById("decree-box");
const decreeLine = document.getElementById("decree-line");
const decreeDoneBtn = document.getElementById("decree-done");
const decreeResult = document.getElementById("decree-result");

const TALLY_KEY = "whynotia-decree-tally";

function loadTally() {
  const blank = {
    novice: { survived: 0, lost: 0 },
    court: { survived: 0, lost: 0 },
    royal: { survived: 0, lost: 0 }
  };
  try {
    const saved = JSON.parse(localStorage.getItem(TALLY_KEY));
    return saved || blank;
  } catch (e) {
    return blank;
  }
}

function saveTally(tally) {
  try {
    localStorage.setItem(TALLY_KEY, JSON.stringify(tally));
  } catch (e) {
    /* fine, the tally just won't persist between visitors this time */
  }
}

function renderTally() {
  const tally = loadTally();
  ["novice", "court", "royal"].forEach((tier) => {
    const el = document.getElementById(`tally-${tier}`);
    if (el) el.textContent = `${tally[tier].survived} / ${tally[tier].lost}`;
  });
}

let challengeGlitch = null;
let glitchFiredThisAttempt = false;

function pickDecree(tier) {
  const list = DECREES[tier];
  return list[Math.floor(Math.random() * list.length)];
}

tierRow.addEventListener("click", (e) => {
  const btn = e.target.closest(".tier-btn");
  if (!btn) return;
  const tier = btn.dataset.tier;

  decreeResult.textContent = "";
  decreeLine.textContent = pickDecree(tier);
  decreeBox.hidden = false;
  decreeDoneBtn.hidden = false;
  decreeDoneBtn.dataset.tier = tier;

  glitchFiredThisAttempt = false;
  if (challengeGlitch) challengeGlitch.stop();

  challengeGlitch = createGlitchEngine(decreeLine, {
    minDelay: 1500,
    maxDelay: 4000,
    chance: CHANCE_BY_TIER[tier],
    minDuration: 900,
    maxDuration: 1800,
    onFire: () => {
      glitchFiredThisAttempt = true;
    }
  });
  challengeGlitch.start();
});

decreeDoneBtn.addEventListener("click", () => {
  const tier = decreeDoneBtn.dataset.tier;
  if (challengeGlitch) challengeGlitch.stop();

  const tally = loadTally();
  if (glitchFiredThisAttempt) {
    tally[tier].lost += 1;
    decreeResult.textContent = FAILURE_LINES[Math.floor(Math.random() * FAILURE_LINES.length)];
  } else {
    tally[tier].survived += 1;
    decreeResult.textContent = SUCCESS_LINES[tier];
  }
  saveTally(tally);
  renderTally();

  decreeBox.hidden = true;
  decreeDoneBtn.hidden = true;
});

renderTally();
