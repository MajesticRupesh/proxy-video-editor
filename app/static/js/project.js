import { Tus, Uppy } from "https://releases.transloadit.com/uppy/v4.15.0/uppy.min.mjs";
import { setupEditor } from "./editor.js";

const root = document.getElementById("project-root");
if (!root) {
  throw new Error("project root missing");
}

const projectId = root.dataset.id;
const tusEndpoint = root.dataset.tus;
const editor = setupEditor(projectId);

document.querySelectorAll(".page-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    document.querySelectorAll(".page-tabs .tab").forEach((el) => el.classList.toggle("is-on", el === tab));
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      const on = panel.dataset.panel === name;
      panel.classList.toggle("is-on", on);
      panel.hidden = !on;
    });
    if (name === "editor") editor.show();
  });
});

const uppy = new Uppy({
  autoProceed: true,
  restrictions: { maxNumberOfFiles: 40 },
  meta: { project_id: projectId },
});

uppy.use(Tus, {
  endpoint: tusEndpoint,
  chunkSize: 50 * 1024 * 1024,
});

const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const uploadStatus = document.getElementById("upload-status");
const drop = document.getElementById("uppy");
const uploadList = document.getElementById("upload-list");
const proxyList = document.getElementById("proxy-list");
const uploads = new Map();
const speedAt = new Map();

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

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function jobRow(name, meta, pct, wait, err) {
  const width = wait ? "" : `style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"`;
  const barClass = err ? "bar is-err" : wait ? "bar is-wait" : "bar";
  return `<div class="job">
    <div class="job-head"><b>${esc(name)}</b><span>${esc(meta)}</span></div>
    <div class="${barClass}"><i ${width}></i></div>
  </div>`;
}

function renderUploads() {
  const items = [...uploads.values()];
  if (!items.length) {
    uploadList.innerHTML = `<p class="empty-row">No transfers yet.</p>`;
    return;
  }
  uploadList.innerHTML = items
    .map((item) => {
      const pct = item.total ? (100 * item.bytes) / item.total : 0;
      const wait = item.state === "waiting";
      const err = item.state === "error";
      const meta = err
        ? "failed"
        : item.state === "done"
          ? `100% · ${fmtBytes(item.total)}`
          : `${pct.toFixed(0)}% · ${fmtBytes(item.bytes)} / ${fmtBytes(item.total)} · ${fmtBytes(item.speed)}/s`;
      return jobRow(item.name, meta, item.state === "done" ? 100 : pct, wait, err);
    })
    .join("");
}

function addFiles(fileList) {
  for (const file of fileList || []) {
    try {
      uppy.addFile({ name: file.name, type: file.type, data: file, source: "local" });
    } catch (err) {
      uploadStatus.textContent = err.message || "Could not add file";
    }
  }
}

uppy.on("file-added", (file) => {
  uploads.set(file.id, {
    name: file.name,
    bytes: 0,
    total: file.size || 0,
    speed: 0,
    state: "waiting",
  });
  renderUploads();
});

uppy.on("upload-progress", (file, progress) => {
  const bytes = progress.bytesUploaded || 0;
  const total = progress.bytesTotal || file.size || 0;
  const now = performance.now();
  const prev = speedAt.get(file.id) || { t: now, bytes: 0 };
  const dt = (now - prev.t) / 1000;
  const speed = dt > 0.2 ? (bytes - prev.bytes) / dt : uploads.get(file.id)?.speed || 0;
  if (dt > 0.2) speedAt.set(file.id, { t: now, bytes });
  uploads.set(file.id, { name: file.name, bytes, total, speed, state: "uploading" });
  renderUploads();
});

uppy.on("upload-success", (file) => {
  const item = uploads.get(file.id);
  uploads.set(file.id, {
    name: file.name,
    bytes: item?.total || file.size || 0,
    total: item?.total || file.size || 0,
    speed: 0,
    state: "done",
  });
  renderUploads();
});

uppy.on("upload-error", (file) => {
  const item = uploads.get(file.id) || { bytes: 0, total: file.size || 0 };
  uploads.set(file.id, { name: file.name, bytes: item.bytes, total: item.total, speed: 0, state: "error" });
  renderUploads();
});

uploadBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

drop?.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("is-over");
});
drop?.addEventListener("dragleave", () => drop.classList.remove("is-over"));
drop?.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("is-over");
  addFiles(event.dataTransfer?.files);
});
drop?.addEventListener("click", () => fileInput?.click());

uppy.on("upload", () => {
  uploadStatus.textContent = "Uploading…";
});
uppy.on("complete", (result) => {
  const n = result.successful?.length || 0;
  const f = result.failed?.length || 0;
  uploadStatus.textContent = f
    ? `Uploaded ${n}, failed ${f}`
    : n
      ? `Uploaded ${n} file${n === 1 ? "" : "s"}`
      : "Video, image, or audio.";
  for (const [id, item] of [...uploads.entries()]) {
    if (item.state === "done") uploads.delete(id);
  }
  renderUploads();
  setTimeout(refreshAssets, 800);
  setTimeout(refreshJobs, 800);
});

function details(asset) {
  const m = asset.meta || {};
  if (asset.media_type === "audio") {
    return [m.codec, m.sample_rate, m.channels, m.bit_depth].filter(Boolean).join(" · ");
  }
  return m.color || "—";
}

function needsProxy(asset) {
  return asset.kind === "original" && ["video", "image", "audio"].includes(asset.media_type);
}

function status(asset) {
  if (needsProxy(asset)) {
    return asset.proxy_status || "—";
  }
  return "—";
}

function actions(asset) {
  const proxy = needsProxy(asset)
    ? `<button type="button" class="btn btn-ghost" data-act="proxy" data-id="${asset.id}">Proxy</button>`
    : "";
  return `<td class="row-actions">
    <button type="button" class="btn btn-ghost" data-act="view" data-id="${asset.id}" data-type="${esc(asset.media_type)}" data-name="${esc(asset.filename)}">View</button>
    <a class="btn btn-ghost" href="/api/projects/${projectId}/assets/${asset.id}/file?download=1">Download</a>
    <button type="button" class="btn btn-ghost" data-act="rename" data-id="${asset.id}" data-name="${esc(asset.filename)}">Rename</button>
    ${proxy}
    <button type="button" class="btn btn-ghost danger" data-act="delete" data-id="${asset.id}" data-name="${esc(asset.filename)}">Delete</button>
  </td>`;
}

function row(asset) {
  const m = asset.meta || {};
  const fps = asset.media_type === "video" ? m.fps || "—" : "—";
  const rate = asset.media_type === "image" ? "—" : m.bitrate || "—";
  const dur = asset.media_type === "image" ? "—" : m.duration || "—";
  return `<tr>
    <td>${esc(asset.filename)}</td>
    <td>${esc(asset.media_type)}</td>
    <td>${esc(m.resolution || "—")}</td>
    <td>${esc(fps)}</td>
    <td>${esc(rate)}</td>
    <td>${esc(details(asset))}</td>
    <td>${esc(dur)}</td>
    <td>${esc(asset.size)}</td>
    <td>${esc(status(asset))}</td>
    ${actions(asset)}
  </tr>`;
}

async function refreshJobs() {
  const res = await fetch(`/api/projects/${projectId}/jobs`);
  if (!res.ok) return;
  const data = await res.json();
  const jobs = data.jobs || [];
  if (!jobs.length) {
    proxyList.innerHTML = `<p class="empty-row">No proxy jobs yet.</p>`;
    return;
  }
  proxyList.innerHTML = jobs
    .map((job) => {
      const pct = Number(job.progress) || 0;
      const wait = job.status === "queued";
      const speed = job.status === "running" && job.detail ? ` · ${job.detail}` : "";
      const meta = wait ? "queued" : `${pct.toFixed(0)}%${speed}`;
      return jobRow(job.filename || "clip", meta, pct, wait, false);
    })
    .join("");
}

function rowSig(list) {
  return list
    .map(
      (a) =>
        `${a.id}:${a.filename}:${a.size_bytes}:${a.proxy_status || ""}:${a.meta?.duration || ""}`,
    )
    .join("|");
}

let tableSig = { original: "", proxy: "", render: "" };
let holdRefresh = false;

async function refreshAssets(force = false) {
  if (holdRefresh && !force) return;
  const res = await fetch(`/api/projects/${projectId}/assets`);
  if (!res.ok) return;
  const data = await res.json();
  const byKind = { original: [], proxy: [], render: [] };
  for (const asset of data.assets || []) {
    (byKind[asset.kind] || []).push(asset);
  }
  for (const [kind, list] of Object.entries(byKind)) {
    const tbody = document.querySelector(`[data-kind="${kind}"] tbody`);
    if (!tbody) continue;
    const sig = rowSig(list);
    if (!force && sig === tableSig[kind]) continue;
    tableSig[kind] = sig;
    tbody.innerHTML = list.length
      ? list.map(row).join("")
      : `<tr class="empty-row"><td colspan="10">Nothing here yet.</td></tr>`;
  }
  const st = data.storage;
  if (st) {
    document.getElementById("use-total").textContent = st.total;
    document.getElementById("use-orig").textContent = st.original;
    document.getElementById("use-proxy").textContent = st.proxy;
    document.getElementById("use-render").textContent = st.render;
    const total = Number(st.total_bytes) || 0;
    const pct = (n) => (total ? `${(100 * n) / total}%` : "0%");
    document.getElementById("use-orig-bar").style.width = pct(st.original_bytes);
    document.getElementById("use-proxy-bar").style.width = pct(st.proxy_bytes);
    document.getElementById("use-render-bar").style.width = pct(st.render_bytes);
  }
  editor.sync(data.assets || []);
}

setInterval(refreshAssets, 2000);
setInterval(refreshJobs, 1000);
refreshJobs();
refreshAssets();

const viewer = document.getElementById("viewer");
const viewerBody = document.getElementById("viewer-body");
const viewerTitle = document.getElementById("viewer-title");
const viewerDownload = document.getElementById("viewer-download");

function closeViewer() {
  viewerBody.innerHTML = "";
  viewer?.close();
}

document.getElementById("viewer-close")?.addEventListener("click", closeViewer);
viewer?.addEventListener("click", (event) => {
  if (event.target === viewer) closeViewer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && viewer?.open) closeViewer();
});

function askDelete(name) {
  const dialog = document.getElementById("confirm-dialog");
  const copy = document.getElementById("confirm-copy");
  const yes = document.getElementById("confirm-yes");
  const no = document.getElementById("confirm-no");
  if (!dialog || !yes || !no) return Promise.resolve(window.confirm(`Delete ${name}?`));
  copy.textContent = `Delete “${name}”? This cannot be undone.`;
  holdRefresh = true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
      holdRefresh = false;
      dialog.close();
      resolve(ok);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
    dialog.addEventListener("close", () => finish(false), { once: true });
    dialog.showModal();
  });
}

document.getElementById("asset-boards")?.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  const url = `/api/projects/${projectId}/assets/${id}`;
  if (act === "view") {
    const src = `${url}/file`;
    const type = btn.dataset.type;
    const name = btn.dataset.name || "Media";
    viewerTitle.textContent = name;
    viewerDownload.href = `${src}?download=1`;
    viewerBody.innerHTML =
      type === "image"
        ? `<img src="${src}" alt="${esc(name)}">`
        : type === "audio"
          ? `<audio src="${src}" controls autoplay></audio>`
          : `<video src="${src}" controls autoplay></video>`;
    viewer?.showModal();
    return;
  }
  if (act === "rename") {
    holdRefresh = true;
    const name = window.prompt("New name", btn.dataset.name || "");
    holdRefresh = false;
    if (!name) return;
    await fetch(`${url}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    refreshAssets(true);
    return;
  }
  if (act === "delete") {
    const ok = await askDelete(btn.dataset.name || "this file");
    if (!ok) return;
    await fetch(`${url}/delete`, { method: "POST" });
    refreshAssets(true);
    return;
  }
  if (act === "proxy") {
    const res = await fetch(`${url}/proxy`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      uploadStatus.textContent = data.error || "Could not queue proxy";
    }
    refreshJobs();
  }
});
