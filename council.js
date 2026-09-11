/*
  The Council of Seven.

  No live model, no API call, same reliability principle as everything
  else in this booth: fully local and deterministic. Three matters of
  state have complete, hand-written debates. Anything else typed in
  gets a debate built from small per-persona templates instead, so it's
  never a blank response, just a less specific one.

  The verdict never actually follows from the debate, that's the joke.
  If the question has an "X or Y" shape, a coin flip picks one, done.
  Otherwise a generic royal non-answer closes it out. Either way the
  seven lines of deliberation above it were theatre.
*/

const PERSONAS = [
  "Sir Overthinks-a-Lot",
  "Lady Whataboutism",
  "The Reluctant Advisor",
  "Baron Vibe Check",
  "The Court Historian",
  "Dame Overcaution",
  "The Castle Cat"
];

const PRESET_QUESTIONS = [
  "left crown, or right crown today?",
  "should the royal cat be granted a formal title?",
  "what should today's royal snack be?"
];

const PRESET_DEBATES = [
  // 0: left crown, or right crown today?
  [
    "Per Article 12 of the Treaty of Whynotia, crown-side selection on a Tuesday defaults to the left, unless mercury is in retrograde, in which case precedent is, regrettably, silent.",
    "Sure, but what about the incident with the left crown in the spring of the Third Ennui? Nobody wants to talk about that.",
    "[sighs] Right crown. I don't know why I said that. Please don't ask me again.",
    "Left crown is giving delulu energy today, ngl. Right crown is more skibidi. I'm going right.",
    "In the Second Age of Whynotia, King Ennui the Elder wore only the right crown, and the kingdom prospered for eleven whole minutes.",
    "If we choose wrong, the crops will fail, the moat will dry up, and we shall all be forced into normal, useful lives. I urge extreme caution.",
    "[meow]"
  ],
  // 1: should the royal cat be granted a formal title?
  [
    "Per the Treaty of Whynotia, Article 4, subsection feline sovereignty, this matter requires a formal inquest lasting no fewer than three sittings.",
    "Sure, but what about the dog? Nobody ever asks about the dog.",
    "[sighs] Give the cat the title. Give the cat everything. Please stop asking me things.",
    "The cat's aura has been royal since birth, ngl. This is just paperwork catching up to reality.",
    "In the Third Age of Whynotia, a cat once held the title of Duke for eleven minutes before losing interest.",
    "If we grant this title carelessly, every barn animal in the kingdom will demand the same, and then where are we? Overrun with dukes.",
    "[stares directly at the crown, says nothing, wins anyway]"
  ],
  // 2: what should today's royal snack be?
  [
    "By precedent dating to the founding charter, snack selection on a day ending in 'y' defaults to whatever is already open.",
    "Sure, but what about lunch? We never even discussed lunch.",
    "[sighs] Crackers. It's crackers. It was always going to be crackers.",
    "Crackers are mid, honestly. Where's the rizz. Where's the flavor arc.",
    "In the Age of Slightly Fewer Crowns, a snack dispute once delayed a coronation by forty minutes.",
    "If we choose the wrong snack, morale collapses, and morale is the only thing holding this kingdom together.",
    "[meow] [meow] [meow]"
  ]
];

// ---------- template generator for custom topics ----------

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function generateCustomDebate(topic) {
  const t = topic.replace(/[?.!]+$/, "").trim();

  const durations = ["six generations", "two fortnights", "the length of a royal nap", "until further notice"];
  const unrelated = [
    "the wardrobe budget",
    "the incident with the left crown",
    "the moat's ongoing silence",
    "whoever ate the last scone",
    "the Duke's unpaid tab"
  ];
  const shortVerdicts = ["Left. Right. Whatever.", "I don't care, truly.", "Pick the one that's closer."];
  const vibeWords = ["delulu", "mid", "unserious", "cursed", "surprisingly rizz-pilled"];
  const eras = ["Second", "Third", "Slightly Fewer Crowns", "Pre-Technologiaaa"];
  const feudDurations = ["four afternoons", "eleven minutes", "a fiscal quarter", "one very long Tuesday"];
  const catLines = ["[meow]", "[meow] [meow]", "[stares, says nothing, wins anyway]"];

  return [
    `Per the Treaty of Whynotia, this matter, ${t}, requires formal deliberation not to exceed ${pick(durations)}.`,
    `Sure, but what about ${pick(unrelated)}? Nobody wants to talk about ${pick(unrelated)}.`,
    `[sighs] ${pick(shortVerdicts)} Please don't ask me again.`,
    `Honestly, ${t} is giving ${pick(vibeWords)} energy today. I'm deciding on vibes alone.`,
    `In the ${pick(eras)} Age of Whynotia, this exact dilemma ended a feud lasting ${pick(feudDurations)}.`,
    `If we get ${t} wrong, the crops will fail, the moat will dry up, and we shall all be forced into normal, useful lives.`,
    pick(catLines)
  ];
}

// ---------- verdict ----------

const GENERIC_VERDICTS = [
  "Yes. Also no. Mostly yes.",
  "The matter is resolved, though nobody present could say how.",
  "Approved, pending a formality that will never arrive.",
  "The council has decided, in the sense that time has simply passed."
];

function resolveVerdict(topic) {
  const match = topic.match(/^(.*?)\bor\b(.*)$/i);
  if (match) {
    const optA = match[1].replace(/[,?.!]+$/, "").trim();
    const optB = match[2].replace(/[,?.!]+$/, "").trim();
    if (optA && optB) {
      const chosen = Math.random() < 0.5 ? optA : optB;
      return `${chosen}. As decided by physics, not wisdom.`;
    }
  }
  return pick(GENERIC_VERDICTS);
}

// ---------- run + reveal ----------

const presetsEl = document.getElementById("council-presets");
const customForm = document.getElementById("council-custom-form");
const customInput = document.getElementById("council-custom-input");
const logEl = document.getElementById("council-log");
const verdictEl = document.getElementById("council-verdict");

let convening = false;

function runCouncil(topic, debateLines) {
  if (convening) return;
  convening = true;

  logEl.innerHTML = "";
  verdictEl.textContent = "";

  const heading = document.createElement("p");
  heading.className = "council-topic";
  heading.textContent = `today's matter of state: ${topic}`;
  logEl.appendChild(heading);

  debateLines.forEach((line, i) => {
    setTimeout(() => {
      const entry = document.createElement("p");
      entry.className = "council-line";
      entry.innerHTML = `<span class="council-name">${PERSONAS[i]}:</span> ${line}`;
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;

      if (i === debateLines.length - 1) {
        setTimeout(() => {
          verdictEl.textContent = "The council has concluded. The verdict rests, as it always has, on the Royal Coin...";
          setTimeout(() => {
            verdictEl.textContent = resolveVerdict(topic);
            convening = false;
          }, 1400);
        }, 900);
      }
    }, i * 1400);
  });
}

presetsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".council-preset-btn");
  if (!btn) return;
  const idx = Number(btn.dataset.preset);
  runCouncil(PRESET_QUESTIONS[idx], PRESET_DEBATES[idx]);
});

customForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const topic = customInput.value.trim();
  if (!topic) return;
  runCouncil(topic, generateCustomDebate(topic));
  customInput.value = "";
});
