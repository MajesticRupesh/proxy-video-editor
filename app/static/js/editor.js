const MIN_PX = 8;
const MIN_DUR = 0.05;

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

function fmtTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function srcDur(asset) {
  const s = Number(asset.duration_sec ?? asset.meta?.duration_sec) || 0;
  if (asset.media_type === "image") return s > 0.05 ? s : 5;
  return Math.max(s, 0.1);
}

export function setupEditor(projectId) {
  const poolList = document.getElementById("pool-list");
  const cacheLabel = document.getElementById("cache-label");
  const cacheDialog = document.getElementById("cache-dialog");
  const cacheCopy = document.getElementById("cache-copy");
  const cacheForm = document.getElementById("cache-form");
  const video = document.getElementById("edit-video");
  const still = document.getElementById("edit-still");
  const empty = document.getElementById("monitor-empty");
  const playBtn = document.getElementById("btn-play");
  const tc = document.getElementById("tc");
  const track = document.getElementById("tl-track");
  const ruler = document.getElementById("tl-ruler");
  const body = document.getElementById("tl-body");
  const main = document.getElementById("tl-main");
  const playhead = document.getElementById("playhead");
  const scroll = document.getElementById("tl-scroll");
  const timelineEl = document.getElementById("timeline");
  const editorPanel = document.querySelector('.tab-panel[data-panel="editor"]');
  const resizer = document.getElementById("tl-resizer");

  let assets = [];
  let clips = [];
  let selected = -1;
  let seqTime = 0;
  let playing = false;
  let pxPerSec = 48;
  let previewId = null;
  let blobs = new Map();
  let localIds = new Set();
  let saveTimer = 0;
  let prompted = false;
  let raf = 0;
  let lastTick = 0;
  let drag = null;

  function proxies() {
    return assets.filter((a) => a.kind === "proxy");
  }

  function byId(id) {
    return assets.find((a) => a.id === id);
  }

  function seqDur() {
    return clips.reduce((s, c) => s + (c.out - c.in), 0);
  }

  function clipAt(t) {
    let t0 = 0;
    for (let i = 0; i < clips.length; i += 1) {
      const c = clips[i];
      const d = c.out - c.in;
      if (t < t0 + d - 1e-4 || i === clips.length - 1) {
        return { i, c, start: t0, local: c.in + Math.min(Math.max(0, t - t0), d) };
      }
      t0 += d;
    }
    return null;
  }

  async function dirHandle() {
    if (!navigator.storage?.getDirectory) throw new Error("no opfs");
    const root = await navigator.storage.getDirectory();
    const proxiesDir = await root.getDirectoryHandle("proxies", { create: true });
    return proxiesDir.getDirectoryHandle(String(projectId), { create: true });
  }

  async function cachedSize(asset) {
    try {
      const dir = await dirHandle();
      const fh = await dir.getFileHandle(String(asset.id));
      const file = await fh.getFile();
      return file.size === asset.size_bytes ? file.size : 0;
    } catch {
      return 0;
    }
  }

  async function cacheBytes() {
    let total = 0;
    for (const a of proxies()) total += await cachedSize(a);
    return total;
  }

  async function putCache(asset, blob) {
    const dir = await dirHandle();
    const fh = await dir.getFileHandle(String(asset.id), { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  async function blobFor(asset) {
    const hit = blobs.get(asset.id);
    if (hit) return hit;
    if (!localIds.has(asset.id)) return null;
    try {
      const dir = await dirHandle();
      const file = await (await dir.getFileHandle(String(asset.id))).getFile();
      if (file.size !== asset.size_bytes) return null;
      const url = URL.createObjectURL(file);
      blobs.set(asset.id, url);
      return url;
    } catch {
      return null;
    }
  }

  function dropBlob(id) {
    const url = blobs.get(id);
    if (url) URL.revokeObjectURL(url);
    blobs.delete(id);
  }

  async function refreshLocal() {
    localIds = new Set();
    for (const a of proxies()) {
      if (await cachedSize(a)) localIds.add(a.id);
    }
  }

  async function paintCache() {
    cacheLabel.textContent = `Local cache ${fmtBytes(await cacheBytes())}`;
  }

  async function missing() {
    const out = [];
    for (const a of proxies()) {
      if (!(await cachedSize(a))) out.push(a);
    }
    return out;
  }

  async function downloadAll(list) {
    let n = 0;
    for (const a of list) {
      n += 1;
      cacheLabel.textContent = `Loading ${n} / ${list.length}`;
      if (cacheDialog?.open) cacheCopy.textContent = `Downloading ${n} / ${list.length} · ${a.filename}`;
      await downloadOne(a, false);
    }
    await refreshLocal();
    await paintCache();
    paintPool();
  }

  async function downloadOne(asset, refresh = true) {
    const res = await fetch(`/api/projects/${projectId}/assets/${asset.id}/file`);
    if (!res.ok) return;
    try {
      await putCache(asset, await res.blob());
      localIds.add(asset.id);
    } catch {
      cacheLabel.textContent = "Could not store locally";
      return;
    }
    if (refresh) {
      await paintCache();
      paintPool();
      paintClips();
    }
  }

  async function removeOne(asset) {
    dropBlob(asset.id);
    localIds.delete(asset.id);
    try {
      const dir = await dirHandle();
      await dir.removeEntry(String(asset.id));
    } catch {
      /* already gone */
    }
    await paintCache();
    paintPool();
    paintClips();
    if (previewId === asset.id) clearMonitor("Not synced — click Sync");
  }

  function clearMonitor(msg) {
    video.pause();
    video.removeAttribute("src");
    video.hidden = true;
    still.hidden = true;
    still.removeAttribute("src");
    empty.textContent = msg;
    empty.hidden = false;
  }

  function showMedia(kind, url) {
    empty.hidden = true;
    if (kind === "image") {
      video.pause();
      video.removeAttribute("src");
      video.hidden = true;
      still.hidden = false;
      still.src = url;
      return;
    }
    still.hidden = true;
    still.removeAttribute("src");
    video.hidden = false;
    if (video.src !== url) video.src = url;
  }

  async function previewAsset(asset) {
    previewId = asset.id;
    paintPool();
    if (!localIds.has(asset.id)) {
      clearMonitor("Not synced — click Sync");
      return;
    }
    empty.textContent = "Loading…";
    empty.hidden = false;
    const url = await blobFor(asset);
    if (previewId !== asset.id) return;
    if (!url) {
      clearMonitor("Not synced — click Sync");
      return;
    }
    showMedia(asset.media_type, url);
    if (asset.media_type !== "image") {
      video.currentTime = 0;
    }
  }

  async function loadAt(t) {
    const hit = clipAt(t);
    if (!hit) {
      clearMonitor(clips.length ? "End" : "Drop proxies on the timeline");
      return;
    }
    const asset = byId(hit.c.assetId);
    if (!asset) return;
    previewId = null;
    selected = hit.i;
    paintClips();
    if (!localIds.has(asset.id)) {
      clearMonitor("Not synced — click Sync");
      return;
    }
    const url = await blobFor(asset);
    if (!url) {
      clearMonitor("Not synced — click Sync");
      return;
    }
    showMedia(asset.media_type, url);
    if (asset.media_type !== "image") {
      video.currentTime = hit.local;
    }
  }

  function paintTc() {
    tc.textContent = `${fmtTime(seqTime)} / ${fmtTime(seqDur())}`;
  }

  function paintRuler() {
    const dur = Math.max(seqDur() + 4, 8);
    const step = pxPerSec >= 80 ? 1 : pxPerSec >= 40 ? 2 : 5;
    let html = "";
    for (let t = 0; t <= dur; t += step) {
      html += `<span style="left:${t * pxPerSec}px">${fmtTime(t)}</span>`;
    }
    ruler.innerHTML = html;
    if (main) main.style.width = `${dur * pxPerSec + 80}px`;
    if (body) body.style.minWidth = `${dur * pxPerSec + 116}px`;
  }

  function paintClips() {
    let t0 = 0;
    track.innerHTML = clips
      .map((c, i) => {
        const w = Math.max(MIN_PX, (c.out - c.in) * pxPerSec);
        const left = t0 * pxPerSec;
        t0 += c.out - c.in;
        const name = esc(c.filename || byId(c.assetId)?.filename || "clip");
        const on = i === selected ? " is-on" : "";
        const kind = c.media_type || byId(c.assetId)?.media_type || "video";
        const off = localIds.has(c.assetId) ? "" : " is-off";
        return `<div class="tl-clip kind-${kind}${on}${off}" data-i="${i}" style="left:${left}px;width:${w}px">
          <i class="h left" data-edge="in"></i>
          <b>${name}</b>
          <i class="h right" data-edge="out"></i>
        </div>`;
      })
      .join("");
    paintRuler();
    paintHead();
  }

  function paintHead() {
    playhead.style.left = `${seqTime * pxPerSec}px`;
    paintTc();
  }

  function paintPool() {
    const list = proxies();
    if (!list.length) {
      poolList.innerHTML = `<li class="empty-row">No proxies yet. Generate them on Uploads.</li>`;
      return;
    }
    poolList.innerHTML = list
      .map((a) => {
        const on = a.id === previewId ? " is-on" : "";
        const local = localIds.has(a.id);
        const act = local
          ? `<button type="button" class="btn btn-local" data-act="remove" data-id="${a.id}">Remove</button>`
          : `<button type="button" class="btn btn-sync" data-act="sync" data-id="${a.id}">Sync</button>`;
        return `<li class="pool-item${on}" draggable="true" data-id="${a.id}">
          <i class="dot${local ? " is-on" : ""}" title="${local ? "Synced" : "Not on this computer"}"></i>
          <div class="meta">
            <b>${esc(a.filename)}</b>
            <span>${esc(a.media_type)} · ${fmtTime(srcDur(a))} · ${esc(a.size)}</span>
          </div>
          ${act}
        </li>`;
      })
      .join("");
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await fetch(`/api/projects/${projectId}/timeline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clips: clips.map((c) => ({ assetId: c.assetId, in: c.in, out: c.out })),
        }),
      });
    }, 400);
  }

  function addClip(asset, at) {
    const dur = srcDur(asset);
    const clip = {
      assetId: asset.id,
      in: 0,
      out: dur,
      filename: asset.filename,
      media_type: asset.media_type,
      duration_sec: dur,
      size_bytes: asset.size_bytes,
    };
    if (at == null || at >= clips.length) clips.push(clip);
    else clips.splice(at, 0, clip);
    selected = at == null ? clips.length - 1 : at;
    persist();
    paintClips();
  }

  function lift() {
    if (selected < 0) return;
    clips.splice(selected, 1);
    selected = Math.min(selected, clips.length - 1);
    persist();
    paintClips();
    loadAt(seqTime);
  }

  function cutAt() {
    const hit = clipAt(seqTime);
    if (!hit) return;
    const local = hit.local;
    if (local - hit.c.in < MIN_DUR || hit.c.out - local < MIN_DUR) return;
    const right = { ...hit.c, in: local };
    hit.c.out = local;
    clips.splice(hit.i + 1, 0, right);
    selected = hit.i;
    persist();
    paintClips();
  }

  function joinAt() {
    if (selected < 0 || selected >= clips.length - 1) return;
    const a = clips[selected];
    const b = clips[selected + 1];
    if (a.assetId !== b.assetId) return;
    if (Math.abs(a.out - b.in) > 0.05) return;
    a.out = b.out;
    clips.splice(selected + 1, 1);
    persist();
    paintClips();
  }

  async function togglePlay() {
    if (!clips.length) return;
    playing = !playing;
    playBtn.textContent = playing ? "Stop" : "Play";
    lastTick = performance.now();
    if (playing) {
      await loadAt(seqTime);
      const hit = clipAt(seqTime);
      const asset = hit && byId(hit.c.assetId);
      if (asset && asset.media_type !== "image" && localIds.has(asset.id)) {
        try {
          await video.play();
        } catch {
          playing = false;
          playBtn.textContent = "Play";
        }
      }
      loop();
    } else {
      video.pause();
    }
  }

  function loop() {
    cancelAnimationFrame(raf);
    if (!playing) return;
    raf = requestAnimationFrame(async (now) => {
      const dt = Math.min(0.08, (now - lastTick) / 1000);
      lastTick = now;
      const hit = clipAt(seqTime);
      if (!hit) {
        playing = false;
        playBtn.textContent = "Play";
        video.pause();
        paintHead();
        return;
      }
      const asset = byId(hit.c.assetId);
      if (asset && asset.media_type !== "image" && !video.paused && localIds.has(asset.id)) {
        seqTime = hit.start + (video.currentTime - hit.c.in);
      } else {
        seqTime += dt;
      }
      if (seqTime >= hit.start + (hit.c.out - hit.c.in) - 0.02) {
        seqTime = hit.start + (hit.c.out - hit.c.in);
        if (hit.i >= clips.length - 1) {
          playing = false;
          playBtn.textContent = "Play";
          video.pause();
          paintHead();
          return;
        }
        seqTime += 0.001;
        await loadAt(seqTime);
        const next = clipAt(seqTime);
        const na = next && byId(next.c.assetId);
        if (na && na.media_type !== "image" && localIds.has(na.id)) {
          try {
            await video.play();
          } catch {
            playing = false;
          }
        }
      }
      paintHead();
      loop();
    });
  }

  function seekPx(x) {
    const rect = track.getBoundingClientRect();
    seqTime = Math.max(0, Math.min(seqDur(), (x - rect.left) / pxPerSec));
    playing = false;
    playBtn.textContent = "Play";
    video.pause();
    loadAt(seqTime);
    paintHead();
  }

  poolList?.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]");
    if (act) {
      event.preventDefault();
      event.stopPropagation();
      const asset = byId(Number(act.dataset.id));
      if (!asset) return;
      if (act.dataset.act === "sync") {
        act.disabled = true;
        act.textContent = "…";
        downloadOne(asset);
      } else if (act.dataset.act === "remove") {
        removeOne(asset);
      }
      return;
    }
    const item = event.target.closest(".pool-item");
    if (!item) return;
    const asset = byId(Number(item.dataset.id));
    if (asset) previewAsset(asset);
  });

  poolList?.addEventListener("dblclick", (event) => {
    if (event.target.closest("[data-act]")) return;
    const item = event.target.closest(".pool-item");
    if (!item) return;
    const asset = byId(Number(item.dataset.id));
    if (asset) addClip(asset);
  });

  poolList?.addEventListener("dragstart", (event) => {
    const item = event.target.closest(".pool-item");
    if (!item) return;
    event.dataTransfer.setData("text/asset", item.dataset.id);
    event.dataTransfer.effectAllowed = "copy";
  });

  track?.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });

  track?.addEventListener("drop", (event) => {
    event.preventDefault();
    const id = Number(event.dataTransfer.getData("text/asset"));
    const asset = byId(id);
    if (asset) addClip(asset);
  });

  track?.addEventListener("mousedown", (event) => {
    const handle = event.target.closest(".h");
    const clipEl = event.target.closest(".tl-clip");
    if (handle && clipEl) {
      const i = Number(clipEl.dataset.i);
      selected = i;
      drag = { i, edge: handle.dataset.edge, startX: event.clientX, in: clips[i].in, out: clips[i].out };
      event.preventDefault();
      paintClips();
      return;
    }
    if (clipEl) {
      selected = Number(clipEl.dataset.i);
      paintClips();
      seekPx(event.clientX);
      return;
    }
    seekPx(event.clientX);
  });

  window.addEventListener("mousemove", (event) => {
    if (!drag) return;
    const dt = (event.clientX - drag.startX) / pxPerSec;
    const c = clips[drag.i];
    const asset = byId(c.assetId);
    const max = asset ? srcDur(asset) : c.out + 60;
    if (drag.edge === "in") {
      c.in = Math.min(c.out - MIN_DUR, Math.max(0, drag.in + dt));
    } else {
      c.out = Math.max(c.in + MIN_DUR, Math.min(max, drag.out + dt));
    }
    paintClips();
  });

  window.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    persist();
  });

  scroll?.addEventListener("click", (event) => {
    if (event.target.closest(".tl-clip")) return;
    if (event.target.id === "tl-ruler" || event.target.closest(".tl-ruler") || event.target === playhead) {
      seekPx(event.clientX);
    }
  });

  playhead?.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const move = (e) => seekPx(e.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  playBtn?.addEventListener("click", () => togglePlay());
  document.getElementById("btn-cut")?.addEventListener("click", cutAt);
  document.getElementById("btn-join")?.addEventListener("click", joinAt);
  document.getElementById("btn-lift")?.addEventListener("click", lift);
  document.getElementById("zoom-in")?.addEventListener("click", () => {
    pxPerSec = Math.min(160, pxPerSec * 1.25);
    paintClips();
  });
  document.getElementById("zoom-out")?.addEventListener("click", () => {
    pxPerSec = Math.max(12, pxPerSec / 1.25);
    paintClips();
  });

  const TL_H_KEY = `tl-height:${projectId}`;
  const TL_H_DEFAULT = 230;
  const TL_H_MIN = 120;
  function clampTlHeight(px) {
    const panelH = editorPanel?.clientHeight || window.innerHeight;
    const max = Math.max(TL_H_MIN + 40, panelH - 140);
    return Math.max(TL_H_MIN, Math.min(max, Math.round(px)));
  }
  function applyTlHeight(px, save = true) {
    if (!editorPanel) return;
    const h = clampTlHeight(px);
    editorPanel.style.setProperty("--tl-h", `${h}px`);
    if (save) {
      try {
        localStorage.setItem(TL_H_KEY, String(h));
      } catch {
        /* ignore */
      }
    }
  }
  try {
    const saved = Number(localStorage.getItem(TL_H_KEY));
    if (Number.isFinite(saved) && saved >= TL_H_MIN) applyTlHeight(saved, false);
  } catch {
    /* ignore */
  }
  if (resizer && editorPanel && timelineEl) {
    let resizing = null;
    resizer.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      resizing = { startY: event.clientY, startH: timelineEl.offsetHeight };
      resizer.classList.add("is-drag");
      resizer.setPointerCapture?.(event.pointerId);
    });
    resizer.addEventListener("pointermove", (event) => {
      if (!resizing) return;
      applyTlHeight(resizing.startH + (resizing.startY - event.clientY), false);
    });
    const endResize = (event) => {
      if (!resizing) return;
      applyTlHeight(resizing.startH + (resizing.startY - event.clientY), true);
      resizing = null;
      resizer.classList.remove("is-drag");
    };
    resizer.addEventListener("pointerup", endResize);
    resizer.addEventListener("pointercancel", () => {
      resizing = null;
      resizer.classList.remove("is-drag");
    });
    resizer.addEventListener("dblclick", () => applyTlHeight(TL_H_DEFAULT, true));
    window.addEventListener("resize", () => {
      const cur = timelineEl.offsetHeight;
      if (cur) applyTlHeight(cur, false);
    });
  }

  document.getElementById("cache-load")?.addEventListener("click", async () => {
    const need = await missing().catch(() => []);
    if (!need.length) {
      cacheLabel.textContent = "Already loaded";
      await paintCache();
      return;
    }
    await downloadAll(need);
  });

  document.getElementById("cache-unload")?.addEventListener("click", async () => {
    for (const url of blobs.values()) URL.revokeObjectURL(url);
    blobs.clear();
    localIds = new Set();
    try {
      const root = await navigator.storage.getDirectory();
      const proxiesDir = await root.getDirectoryHandle("proxies", { create: true });
      await proxiesDir.removeEntry(String(projectId), { recursive: true });
    } catch {
      /* empty */
    }
    await paintCache();
    paintPool();
    paintClips();
    clearMonitor("Select a proxy");
  });

  document.addEventListener("keydown", (event) => {
    const panel = document.querySelector('.tab-panel[data-panel="editor"]');
    if (!panel || panel.hidden) return;
    if (event.target.closest("input, textarea")) return;
    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "c" || event.key === "C") {
      cutAt();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      lift();
    }
  });

  async function maybePrompt() {
    const panel = document.querySelector('.tab-panel[data-panel="editor"]');
    if (!panel || panel.hidden || prompted || !cacheDialog) return;
    const need = await missing().catch(() => []);
    if (!need.length) return;
    prompted = true;
    const mb = fmtBytes(need.reduce((s, a) => s + (a.size_bytes || 0), 0));
    cacheCopy.textContent = `Download ${need.length} prox${need.length === 1 ? "y" : "ies"} (${mb}) to this browser? Playback stays local after that.`;
    cacheDialog.showModal();
  }

  async function show() {
    await refreshLocal();
    paintPool();
    paintClips();
    await paintCache();
    if (!clips.length) {
      const res = await fetch(`/api/projects/${projectId}/timeline`);
      if (res.ok) {
        const data = await res.json();
        clips = data.clips || [];
        paintClips();
      }
    }
    await maybePrompt();
  }

  cacheForm?.querySelectorAll("button[value]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const val = btn.value;
      cacheDialog?.close();
      if (val === "ok") {
        cacheCopy.textContent = "Downloading…";
        cacheDialog?.showModal();
        await downloadAll(await missing().catch(() => []));
        cacheDialog?.close();
      }
    });
  });

  async function sync(list) {
    assets = list;
    if (!document.querySelector('.tab-panel[data-panel="editor"]')?.hidden) {
      await refreshLocal();
      paintPool();
      paintClips();
      await paintCache();
      maybePrompt();
    }
  }

  return { show, sync };
}
