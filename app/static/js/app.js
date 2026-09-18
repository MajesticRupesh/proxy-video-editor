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

function fmtBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  n = Number(n) || 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return i === 0 ? `${n.toFixed(0)} B` : `${n.toFixed(1)} ${units[i]}`;
}

function fmtRate(n) {
  return `${fmtBytes(n)}/s`;
}

const statusbar = document.getElementById("statusbar");
if (statusbar) {
  const cpuEl = document.getElementById("stat-cpu");
  const ramEl = document.getElementById("stat-ram");
  const diskEl = document.getElementById("stat-disk");
  const netEl = document.getElementById("stat-net");

  async function tick() {
    const res = await fetch("/api/stats");
    if (!res.ok) return;
    const s = await res.json();
    cpuEl.textContent = `${s.cpu.toFixed(0)}%`;
    ramEl.textContent = `${fmtBytes(s.ram_used)} / ${fmtBytes(s.ram_total)}`;
    diskEl.textContent = `${fmtBytes(s.disk_used)} / ${fmtBytes(s.disk_total)}`;
    netEl.textContent = `↓ ${fmtRate(s.net_down)}  ↑ ${fmtRate(s.net_up)}`;
  }

  tick();
  setInterval(tick, 1000);
}
