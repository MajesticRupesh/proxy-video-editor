const modal = document.getElementById("new-project-modal");
const openBtn = document.getElementById("new-project-btn");
const cancelBtn = document.getElementById("cancel-project-btn");
const nameInput = document.getElementById("project-name");

openBtn?.addEventListener("click", () => {
  modal?.showModal();
  nameInput?.focus();
});

cancelBtn?.addEventListener("click", () => modal?.close());

document.querySelectorAll("button[data-confirm]").forEach((button) => {
  button.addEventListener("click", (event) => {
    if (!window.confirm(button.dataset.confirm)) {
      event.preventDefault();
    }
  });
});
