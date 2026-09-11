/*
  Royal Duties, the bureaucratic gauntlet for checking off one task.

  The CAPTCHA is worth explaining: every tile looks identical, an
  identical crown, so there is no correct set to select, tapping is
  just theatre. Pass or fail is decided on verify, independent of
  what was tapped, same "effort doesn't change the outcome" rule the
  teleprompter and decree challenge already run on. Wrong answers on
  the trivia step send you back to the very start, not one step back.
*/

const TASKS = [
  "Water the ornamental cactus",
  "Reply to a strongly worded letter from the Duke of Drowsyshire",
  "Approve this week's official nap schedule",
  "Retrieve the crown from wherever it rolled",
  "Formally acknowledge the castle cat's existence"
];

const BLOCKCHAIN_STATUS_LINES = [
  "Consulting the Royal Ledger...",
  "Mining Approval Tokens...",
  "Validating via Council Consensus...",
  "Awaiting the Castle Cat's Signature...",
  "Recalculating Royal Gas Fees..."
];

const taskLabel = document.getElementById("todo-task-label");
const timerEl = document.getElementById("todo-timer");
const beginBtn = document.getElementById("todo-begin-btn");

const stepEls = {
  captcha: document.getElementById("todo-step-captcha"),
  terms: document.getElementById("todo-step-terms"),
  blockchain: document.getElementById("todo-step-blockchain"),
  trivia: document.getElementById("todo-step-trivia"),
  done: document.getElementById("todo-step-done")
};

function showStep(name) {
  Object.entries(stepEls).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
}

function hideAllSteps() {
  Object.values(stepEls).forEach((el) => {
    el.hidden = true;
  });
}

// ---------- timer ----------

let timerInterval = null;
let timerStart = null;

function startTimer() {
  timerStart = Date.now();
  timerEl.hidden = false;
  updateTimer();
  timerInterval = setInterval(updateTimer, 200);
}

function updateTimer() {
  const elapsed = Date.now() - timerStart;
  const totalSeconds = Math.floor(elapsed / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  timerEl.textContent = `time spent completing 1 task: ${mins}:${String(secs).padStart(2, "0")}`;
}

function stopTimer() {
  clearInterval(timerInterval);
}

// ---------- step 1: captcha ----------

const captchaGrid = document.getElementById("captcha-grid");
const captchaFeedback = document.getElementById("captcha-feedback");
const captchaVerifyBtn = document.getElementById("captcha-verify-btn");

const CAPTCHA_SIZE = 6;
const CAPTCHA_PASS_CHANCE = 0.6;

function setupCaptcha() {
  captchaGrid.innerHTML = "";
  captchaFeedback.textContent = "";
  for (let i = 0; i < CAPTCHA_SIZE; i++) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "captcha-tile";
    tile.textContent = "\u{1F451}";
    tile.addEventListener("click", () => {
      tile.classList.toggle("is-selected");
    });
    captchaGrid.appendChild(tile);
  }
}

captchaVerifyBtn.addEventListener("click", () => {
  const pass = Math.random() < CAPTCHA_PASS_CHANCE;
  if (pass) {
    showStep("terms");
    setupTerms();
  } else {
    captchaFeedback.textContent = "one of those was, on reflection, a party hat. try again.";
    setupCaptcha();
  }
});

// ---------- step 2: terms ----------

const termsScroll = document.getElementById("terms-scroll");
const termsAgreeBtn = document.getElementById("terms-agree-btn");

function setupTerms() {
  termsAgreeBtn.disabled = true;
  termsScroll.scrollTop = 0;
}

termsScroll.addEventListener("scroll", () => {
  const atBottom = termsScroll.scrollTop + termsScroll.clientHeight >= termsScroll.scrollHeight - 4;
  if (atBottom) termsAgreeBtn.disabled = false;
});

termsAgreeBtn.addEventListener("click", () => {
  if (termsAgreeBtn.disabled) return;
  showStep("blockchain");
  runBlockchainStep();
});

// ---------- step 3: blockchain ----------

function runBlockchainStep() {
  const statusEl = document.getElementById("blockchain-status");
  let i = 0;
  statusEl.textContent = BLOCKCHAIN_STATUS_LINES[0];
  const interval = setInterval(() => {
    i = (i + 1) % BLOCKCHAIN_STATUS_LINES.length;
    statusEl.textContent = BLOCKCHAIN_STATUS_LINES[i];
  }, 1800);

  setTimeout(() => {
    clearInterval(interval);
    showStep("trivia");
    setupTrivia();
  }, 9000);
}

// ---------- step 4: trivia ----------

const triviaOptions = document.getElementById("trivia-options");
const triviaFeedback = document.getElementById("trivia-feedback");

function setupTrivia() {
  triviaFeedback.textContent = "";
}

triviaOptions.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const correct = btn.dataset.correct === "true";
  if (correct) {
    finishDuty();
  } else {
    triviaFeedback.textContent = "incorrect. back to the beginning.";
    setTimeout(() => {
      showStep("captcha");
      setupCaptcha();
    }, 1200);
  }
});

// ---------- step 5: done ----------

function finishDuty() {
  stopTimer();
  showStep("done");
}

document.getElementById("todo-again-btn").addEventListener("click", () => {
  beginBtn.hidden = false;
  taskLabel.textContent = "press begin to receive today's duty";
  timerEl.hidden = true;
  hideAllSteps();
});

// ---------- begin ----------

beginBtn.addEventListener("click", () => {
  const task = TASKS[Math.floor(Math.random() * TASKS.length)];
  taskLabel.textContent = `today's duty: ${task}`;
  beginBtn.hidden = true;
  startTimer();
  showStep("captcha");
  setupCaptcha();
});
