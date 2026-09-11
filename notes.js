/*
  The Royal Notebook.

  Everything underneath is real: notes actually save, search actually
  searches, summarize actually reads the text and produces something
  derived from it, reminders actually get "set". None of that matters,
  because everything is rendered through the same handwriting scrawl,
  the one nobody, including its owner, has ever been able to read back.

  Rendering approach: rather than one static "messy" font, which just
  looks like neat handwriting, each character gets wrapped in its own
  span with a small random rotation and vertical jitter. That's what
  actually produces the cramped, uneven, barely-segmented look in the
  reference photo, a font alone doesn't get you there.
*/

function renderScrawl(el, text) {
  el.innerHTML = "";
  if (!text) return;
  const frag = document.createDocumentFragment();
  text.split("").forEach((ch) => {
    if (ch === " ") {
      frag.appendChild(document.createTextNode(" "));
      return;
    }
    const span = document.createElement("span");
    span.className = "scrawl-char";
    span.textContent = ch;
    const rot = (Math.random() * 16 - 8).toFixed(1);
    const dy = (Math.random() * 7 - 3.5).toFixed(1);
    const overlap = (Math.random() * 2 + 1).toFixed(1);
    span.style.transform = `rotate(${rot}deg) translateY(${dy}px)`;
    span.style.marginRight = `-${overlap}px`;
    frag.appendChild(span);
  });
  el.appendChild(frag);
}

// ---------- fake summarizer ----------
// Deterministic and genuinely derived from the real text, every third
// word, capped, so it's not a random line, it's an actual (useless)
// extractive summary. Swap this for a real local model, WebLLM or
// similar, if chasing the "best use of local LLMs" side quest, the
// twist is stronger if the summary is genuinely accurate underneath
// and only the rendering makes it useless.

function fakeSummarize(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "there is nothing to summarize, which feels accurate";
  const picked = words.filter((_, i) => i % 3 === 0).slice(0, 14);
  if (picked.length === 0) return words[0];
  return picked.join(" ") + ".";
}

const REMINDER_LINES = [
  "reminder set for: whenever the cat allows it.",
  "reminder set for: three minutes after you've already forgotten.",
  "reminder set for: some tuesday, probably.",
  "reminder set for: the exact moment it stops mattering.",
  "reminder set for: mercury's next retrograde.",
  "reminder set for: right after you needed it."
];

// ---------- storage ----------

const NOTES_KEY = "whynotia-royal-notes";

function loadNotes() {
  try {
    return JSON.parse(localStorage.getItem(NOTES_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveNotes(notes) {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch (e) {
    /* fine, notes just live for this session only */
  }
}

// ---------- elements ----------

const titleInput = document.getElementById("note-title-input");
const bodyInput = document.getElementById("note-body-input");
const preview = document.getElementById("notes-scrawl-preview");
const saveBtn = document.getElementById("note-save-btn");
const summarizeBtn = document.getElementById("note-summarize-btn");
const remindBtn = document.getElementById("note-remind-btn");
const feedback = document.getElementById("notes-feedback");
const searchInput = document.getElementById("note-search-input");
const notesList = document.getElementById("notes-list");

function currentFullText() {
  return `${titleInput.value}\n${bodyInput.value}`;
}

function updatePreview() {
  renderScrawl(preview, bodyInput.value || titleInput.value);
}

bodyInput.addEventListener("input", updatePreview);
titleInput.addEventListener("input", updatePreview);

saveBtn.addEventListener("click", () => {
  const title = titleInput.value.trim();
  const body = bodyInput.value.trim();
  if (!title && !body) {
    feedback.textContent = "nothing to save. royally consistent with the rest of this.";
    return;
  }
  const notes = loadNotes();
  notes.unshift({
    id: Date.now(),
    title: title || "(untitled scrawl)",
    body,
    createdAt: new Date().toISOString()
  });
  saveNotes(notes);
  feedback.textContent = "saved. good luck reading it later.";
  renderNotesList();
});

summarizeBtn.addEventListener("click", () => {
  const summary = fakeSummarize(bodyInput.value);
  feedback.textContent = "";
  renderScrawl(preview, summary);
});

remindBtn.addEventListener("click", () => {
  const line = REMINDER_LINES[Math.floor(Math.random() * REMINDER_LINES.length)];
  feedback.textContent = "";
  renderScrawl(preview, line);
});

// ---------- search + list ----------

function renderNotesList(filter = "") {
  const notes = loadNotes();
  const q = filter.trim().toLowerCase();
  const matches = q
    ? notes.filter(
        (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
      )
    : notes;

  notesList.innerHTML = "";

  if (matches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "notes-empty";
    renderScrawl(empty, q ? "no results, obviously" : "no notes yet");
    notesList.appendChild(empty);
    return;
  }

  matches.forEach((note) => {
    const item = document.createElement("button");
    item.className = "note-list-item";
    item.type = "button";
    renderScrawl(item, note.title);
    item.addEventListener("click", () => {
      titleInput.value = note.title === "(untitled scrawl)" ? "" : note.title;
      bodyInput.value = note.body;
      updatePreview();
      feedback.textContent = "";
    });
    notesList.appendChild(item);
  });
}

searchInput.addEventListener("input", () => renderNotesList(searchInput.value));

renderNotesList();
