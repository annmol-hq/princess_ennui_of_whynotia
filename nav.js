const navButtons = document.querySelectorAll(".nav-btn[data-target]");
const screens = document.querySelectorAll(".screen");

function showScreen(id) {
  screens.forEach((s) => {
    s.hidden = s.id !== id;
  });
  navButtons.forEach((b) => {
    b.classList.toggle("is-active", b.dataset.target === id);
  });
}

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.target));
});
