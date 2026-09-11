/*
  Princess Ennui — idle-mode Q&A engine.

  How it decides genuine vs gibberish, and why it's built this way:
  A heavy model judging coherence live is more failure points than a booth
  needs. This is a simple, fast, fully offline word-list check: if enough
  of the typed words are recognisable English words, treat it as a genuine
  question. Otherwise treat it as gibberish. No network calls, nothing that
  can lag or choke in front of someone waiting for a reaction.

  If you want to chase the "best use of local LLMs" side quest specifically,
  swap COMMON_WORDS + classify() for an actual small local model (e.g. via
  WebLLM/transformers.js) and keep everything else — the response banks and
  the wiring below — exactly as is.
*/

const COMMON_WORDS = new Set([
  "a","an","the","is","are","was","were","am","be","been","being",
  "i","you","he","she","it","we","they","me","him","her","us","them",
  "my","your","his","its","our","their","mine","yours","hers","ours","theirs",
  "what","when","where","why","who","whom","which","how",
  "do","does","did","can","could","will","would","shall","should","may","might","must",
  "have","has","had","this","that","these","those",
  "of","in","on","at","to","for","with","from","by","about","as","into",
  "like","through","after","over","between","out","against","during",
  "without","before","under","around","among","and","but","or","if",
  "because","so","than","then","too","very","just","not","no","yes",
  "ok","okay","please","thanks","thank","sorry",
  "favorite","favourite","color","colour","name","today","tomorrow",
  "time","day","night","year","week","month",
  "food","music","movie","film","book","song",
  "like","love","hate","want","need","think","know","feel","see","hear",
  "good","bad","best","worst","old","young","new","big","small",
  "happy","sad","angry","tired","bored","excited","funny","weird",
  "real","true","false","right","wrong",
  "help","tell","say","said","ask","answer","question",
  "princess","prince","kingdom","royal","castle","crown","king","queen",
  "cat","dog","animal","pet",
  "school","college","work","job","friend","family","people","person",
  "water","fire","earth","air","sky","sun","moon","star",
  "sleep","eat","drink","walk","run","play","game","fun","cool","nice","great","awesome",
  "hello","hi","hey","bye","goodbye","wear","wearing","dress","outfit",
  "wake","woke","morning","evening","afternoon","today","live","lives"
]);

const GENUINE_RESPONSES = [
  "idk", "uwu", "phaaaa", "six sevennn", "technologiaaa",
  "hmm no", "and I oop", "no thoughts, head empty", "????",
  "royally unbothered", "the audacity of this question",
  "next question please", "no comment, very demure", "skibidi",
  "that's classified, I just don't know", "ask the cat",
  "rizz levels too low to answer", "giving... nothing",
  "the council will discuss this never", "bestie no",
  "mother is not present right now", "I plead the royal fifth",
  "brainrot activated, please hold", "mercury's in retrograde, can't be held responsible"
];

const GIBBERISH_RESPONSES = [
  "By royal decree of biology: octopuses have three hearts, and two of them stop beating when it swims.",
  "The Crown wishes it known that honey never spoils, archaeologists have found 3,000 year old honey still edible.",
  "Let the record show that a group of flamingos is called a flamboyance.",
  "The royal astronomers report that a day on Venus is longer than its year.",
  "It is hereby proclaimed that bananas are botanically berries, but strawberries are not.",
  "The treasury confirms the shortest war in recorded history lasted about 38 minutes, between Britain and Zanzibar.",
  "Royal naturalists note that wombats produce cube-shaped droppings.",
  "It is known throughout the land that sharks predate trees by tens of millions of years.",
  "The court physicians report your stomach gets an entirely new lining every few days, so it doesn't digest itself.",
  "The royal linguists confirm the dot over a lowercase i or j has a name, a tittle.",
  "The kingdom's cartographers note Russia's land area is close to the surface area of Pluto.",
  "The royal chefs report that Worcestershire sauce contains fermented anchovies, and most people have no idea.",
  "The court entomologists confirm a single ant colony can hold millions of individuals working as one organism.",
  "The royal record keepers note that Oxford University is older than the Aztec Empire.",
  "It is proclaimed that a bolt of lightning is roughly five times hotter than the surface of the sun.",
  "The royal veterinarians confirm a shrimp's heart is located in its head.",
  "The court historians note Cleopatra lived closer in time to the moon landing than to the building of the Great Pyramid.",
  "The kingdom's zoologists report koala fingerprints are nearly indistinguishable from a human's.",
  "The royal geographers confirm Antarctica is technically the world's largest desert.",
  "The treasury notes the inventor of the Pringles can is buried in one, per his own request.",
  "The court botanists report bamboo can grow nearly a meter in a single day.",
  "The royal physicists confirm light from the sun takes about eight minutes to reach us.",
  "It is known that a hummingbird's heart can beat over a thousand times per minute.",
  "The royal archivists note the first known written recipe in history was for beer.",
  "The court declares polar bears have black skin underneath all that white fur.",
  "The kingdom's mathematicians confirm zero was not used as a number for most of recorded history.",
  "The royal biologists report some jellyfish are biologically immortal.",
  "The court notes the frisbee and the hula hoop were both made popular by the same toy company.",
  "The treasury confirms Scotland's official national animal is the unicorn.",
  "The royal apiarists report that honeybees can recognize individual human faces."
];

let lastGenuineIndex = -1;
let lastGibberishIndex = -1;

function pickFrom(list, lastIndexRef) {
  if (list.length === 1) return list[0];
  let idx;
  do {
    idx = Math.floor(Math.random() * list.length);
  } while (idx === lastIndexRef.value);
  lastIndexRef.value = idx;
  return list[idx];
}

const lastGenuine = { value: -1 };
const lastGibberish = { value: -1 };

function classify(text) {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z']+/i)
    .filter(Boolean);

  if (tokens.length === 0) return "genuine";

  const matches = tokens.filter((t) => COMMON_WORDS.has(t)).length;
  const ratio = matches / tokens.length;

  return ratio >= 0.4 ? "genuine" : "gibberish";
}

function respondTo(text) {
  const kind = classify(text);
  if (kind === "genuine") {
    return { text: pickFrom(GENUINE_RESPONSES, lastGenuine), isFact: false };
  }
  return { text: pickFrom(GIBBERISH_RESPONSES, lastGibberish), isFact: true };
}

const form = document.getElementById("ask-form");
const input = document.getElementById("ask-input");
const line = document.getElementById("dialogue-line");

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value) return;

  const { text, isFact } = respondTo(value);

  line.classList.toggle("is-fact", isFact);
  line.textContent = text;

  input.value = "";
  input.focus();
});
