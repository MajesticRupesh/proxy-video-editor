const MIN_PX = 8;
const MIN_DUR = 0.05;
const SNAP_PX = 9;
const HIST_MAX = 100;

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

function parseFps(v) {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  const s = String(v).trim();
  if (!s) return 0;
  if (s.includes("/")) {
    const [a, b] = s.split("/").map(Number);
    if (a > 0 && b > 0) return a / b;
    return 0;
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function fmtTc(sec, fps) {
  sec = Math.max(0, Number(sec) || 0);
  fps = fps > 0 ? fps : 30;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * fps + 1e-4);
  return `${m}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

function parseTc(str, fps) {
  if (str == null) return NaN;
  const s = String(str).trim().replace(",", ".");
  if (!s) return NaN;
  if (/^[\d.]+$/.test(s)) return Number.parseFloat(s);
  const parts = s.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return NaN;
  fps = fps > 0 ? fps : 30;
  if (parts.length === 3) {
    return parts[0] * 60 + parts[1] + parts[2] / fps;
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return NaN;
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

function assetFps(asset) {
  return parseFps(asset?.meta?.fps) || 30;
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
  const snapGuide = document.getElementById("snap-guide");
  const dropCue = document.getElementById("drop-cue");
  const trimTip = document.getElementById("trim-tip");
  const clipMenu = document.getElementById("clip-menu");
  const saveState = document.getElementById("save-state");
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  const snapBtn = document.getElementById("btn-snap");
  const followBtn = document.getElementById("btn-follow");

  let assets = [];
  let clips = [];
  let selected = -1;
  let seqTime = 0;
  let playing = false;
  let shuttle = 0;
  let pxPerSec = 48;
  let previewId = null;
  let blobs = new Map();
  let localIds = new Set();
  let saveTimer = 0;
  let prompted = false;
  let raf = 0;
  let lastTick = 0;
  let drag = null;
  let loadGen = 0;
  let lastTrimEdge = "out";
  let trimPreviewQueued = false;

  // ---- undo / redo ----
  let hist = [];
  let fut = [];
  const snapClips = () => JSON.parse(JSON.stringify(clips));

  function paintUndo() {
    if (undoBtn) undoBtn.disabled = !hist.length;
    if (redoBtn) redoBtn.disabled = !fut.length;
    if (undoBtn) undoBtn.style.opacity = hist.length ? "1" : "0.4";
    if (redoBtn) redoBtn.style.opacity = fut.length ? "1" : "0.4";
  }

  function pushHist() {
    hist.push(snapClips());
    if (hist.length > HIST_MAX) hist.shift();
    fut = [];
    paintUndo();
  }

  function restore(list) {
    clips = JSON.parse(JSON.stringify(list));
    ensureStarts();
    selected = Math.min(selected, clips.length - 1);
    if (!clips.length) selected = -1;
    seqTime = Math.max(0, Math.min(seqTime, Math.max(0, seqDur())));
    persist();
    paintClips();
    loadAt(seqTime);
  }

  function undo() {
    if (!hist.length) return;
    fut.push(snapClips());
    restore(hist.pop());
    paintUndo();
  }

  function redo() {
    if (!fut.length) return;
    hist.push(snapClips());
    restore(fut.pop());
    paintUndo();
  }

  // ---- prefs ----
  const PREF = (k, d) => {
    try {
      const v = localStorage.getItem(`tl:${projectId}:${k}`);
      return v == null ? d : v;
    } catch {
      return d;
    }
  };
  const SETPREF = (k, v) => {
    try {
      localStorage.setItem(`tl:${projectId}:${k}`, v);
    } catch {
      /* ignore */
    }
  };
  let snapOn = PREF("snap", "1") !== "0";
  let followOn = PREF("follow", "1") !== "0";
  try {
    const z = Number(PREF("zoom", ""));
    if (Number.isFinite(z) && z >= 12 && z <= 480) pxPerSec = z;
  } catch {
    /* ignore */
  }

  function paintToggles() {
    snapBtn?.classList.toggle("is-on", snapOn);
    followBtn?.classList.toggle("is-on", followOn);
  }

  function timelineFps() {
    const c = clips[selected] || clips[0];
    const a = c && byId(c.assetId);
    if (a) return assetFps(a);
    const p = proxies()[0];
    if (p) return assetFps(p);
    return 30;
  }

  function proxies() {
    return assets.filter((a) => a.kind === "proxy");
  }

  function byId(id) {
    return assets.find((a) => a.id === id);
  }

  function durOf(c) {
    return Math.max(0, c.out - c.in);
  }

  function sortClips() {
    clips.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }

  // Backfill `start` for timelines saved before gaps existed (pack contiguously).
  function ensureStarts() {
    let cursor = 0;
    const tagged = clips.map((c) => ({ c, placed: Number.isFinite(Number(c.start)) }));
    tagged.sort((a, b) => (a.placed ? a.c.start : Infinity) - (b.placed ? b.c.start : Infinity));
    for (const { c, placed } of tagged) {
      if (!placed) {
        c.start = Math.round(cursor * 1000) / 1000;
      } else {
        c.start = Math.max(0, Math.round(Number(c.start) * 1000) / 1000);
        if (c.start < cursor) c.start = Math.round(cursor * 1000) / 1000;
      }
      cursor = c.start + durOf(c);
    }
    sortClips();
  }

  function seqDur() {
    let end = 0;
    for (const c of clips) end = Math.max(end, (c.start ?? 0) + durOf(c));
    return end;
  }

  function clipEnd(c) {
    return (c.start ?? 0) + durOf(c);
  }

  // All snap targets: 0, every clip edge, and the timeline end.
  function allEdges(skipVal = null) {
    const out = [0];
    for (const c of clips) {
      out.push(c.start ?? 0, clipEnd(c));
    }
    out.push(seqDur());
    if (skipVal == null) return out;
    return out.filter((t) => Math.abs(t - skipVal) > 1e-6);
  }

  function clipAt(t) {
    for (let i = 0; i < clips.length; i += 1) {
      const c = clips[i];
      const s = c.start ?? 0;
      const d = durOf(c);
      if (t >= s - 1e-6 && t < s + d - 1e-4) {
        return { i, c, start: s, local: c.in + Math.min(Math.max(0, t - s), d) };
      }
    }
    return null;
  }

  function isGapTime(t) {
    return t < seqDur() - 1e-6 && !clipAt(t);
  }

  // Push a wanted start forward until it no longer overlaps (ignoring clip `ignore`).
  function freeSlot(want, dur, ignore = -1) {
    let t = Math.max(0, want);
    for (let k = 0; k <= clips.length; k += 1) {
      let moved = false;
      for (let i = 0; i < clips.length; i += 1) {
        if (i === ignore) continue;
        const c = clips[i];
        const s = c.start ?? 0;
        const e = s + durOf(c);
        if (t < e - 1e-6 && t + dur > s + 1e-6) {
          t = e;
          moved = true;
        }
      }
      if (!moved) return t;
    }
    return t;
  }

  function snapTime(t, skipSeq = null) {
    if (!snapOn) return { t, snapped: false };
    const tol = SNAP_PX / pxPerSec;
    let best = null;
    for (const edge of allEdges(skipSeq)) {
      const d = Math.abs(edge - t);
      if (d <= tol && (best == null || d < best.d)) best = { t: edge, d };
    }
    // also snap to playhead
    const dp = Math.abs(seqTime - t);
    if (dp <= tol && (best == null || dp < best.d)) best = { t: seqTime, d: dp };
    if (best) return { t: best.t, snapped: true };
    return { t, snapped: false };
  }

  function showSnap(at) {
    if (!snapGuide || at == null) {
      if (snapGuide) snapGuide.hidden = true;
      return;
    }
    snapGuide.hidden = false;
    snapGuide.style.left = `${at * pxPerSec}px`;
  }

  function hideSnap() {
    if (snapGuide) snapGuide.hidden = true;
  }

  // ---- cache / pool (unchanged behaviour) ----
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
    if (cacheLabel) cacheLabel.textContent = `Local cache ${fmtBytes(await cacheBytes())}`;
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
      if (cacheLabel) cacheLabel.textContent = `Loading ${n} / ${list.length}`;
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
      if (cacheLabel) cacheLabel.textContent = "Could not store locally";
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
    loadGen += 1;
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
      if (still.src !== url) still.src = url;
      return;
    }
    still.hidden = true;
    still.removeAttribute("src");
    video.hidden = false;
    if (video.getAttribute("src") !== url) video.src = url;
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
      try {
        video.currentTime = 0;
      } catch {
        /* ignore */
      }
    }
  }

  async function loadAt(t) {
    const gen = ++loadGen;
    if (isGapTime(t)) {
      video.pause();
      video.removeAttribute("src");
      video.hidden = true;
      still.hidden = true;
      still.removeAttribute("src");
      empty.textContent = "Gap — no clip here";
      empty.hidden = false;
      return;
    }
    const hit = clipAt(t);
    if (!hit) {
      clearMonitor(clips.length ? "End" : "Drop proxies on the timeline");
      return;
    }
    const asset = byId(hit.c.assetId);
    if (!asset) return;
    previewId = null;
    if (!localIds.has(asset.id)) {
      clearMonitor("Not synced — click Sync");
      paintPool();
      return;
    }
    const url = await blobFor(asset);
    if (gen !== loadGen) return;
    if (!url) {
      clearMonitor("Not synced — click Sync");
      return;
    }
    showMedia(asset.media_type, url);
    if (asset.media_type !== "image") {
      const target = Math.min(Math.max(hit.local, 0), Math.max(0, srcDur(asset) - 0.04));
      try {
        if (Math.abs(video.currentTime - target) > 0.08) video.currentTime = target;
      } catch {
        /* ignore */
      }
    }
  }

  function paintTc() {
    const fps = timelineFps();
    if (tc) tc.textContent = `${fmtTc(seqTime, fps)} / ${fmtTc(seqDur(), fps)}`;
  }

  function labelStep() {
    if (pxPerSec >= 160) return 1;
    if (pxPerSec >= 80) return 2;
    if (pxPerSec >= 40) return 5;
    if (pxPerSec >= 20) return 10;
    return 30;
  }

  function paintRuler() {
    if (!ruler) return;
    const dur = Math.max(seqDur() + 4, 8);
    const step = labelStep();
    const fps = timelineFps();
    const frameDur = 1 / fps;
    const framePx = frameDur * pxPerSec;
    let html = "";
    for (let t = 0; t <= dur + 1e-6; t += step) {
      html += `<span style="left:${t * pxPerSec}px">${fmtTime(t)}</span><i class="tick major" style="left:${t * pxPerSec}px;height:12px"></i>`;
      // 1s minor ticks between majors
      const minorN = Math.min(step, 10);
      for (let k = 1; k < step; k += 1) {
        if (k % Math.max(1, Math.round(step / minorN)) !== 0) continue;
        const mt = t + k;
        if (mt > dur) break;
        html += `<i class="tick minor" style="left:${mt * pxPerSec}px"></i>`;
      }
    }
    // per-frame dotted ticks when zoomed in (DaVinci-style)
    if (framePx >= 7) {
      let every = 1;
      const count = Math.ceil(dur / frameDur);
      if (count > 3000) every = Math.ceil(count / 3000);
      for (let f = 0; f <= count; f += every) {
        const ft = f * frameDur * every;
        if (ft > dur) break;
        // skip ones colliding with a label tick
        html += `<i class="tick frame" style="left:${ft * pxPerSec}px"></i>`;
      }
    }
    ruler.innerHTML = html;
    const w = dur * pxPerSec + 80;
    if (main) main.style.width = `${w}px`;
    if (body) body.style.minWidth = `${w + 36}px`;
    // frame grid on the track itself
    if (track) {
      if (framePx >= 7) {
        track.style.backgroundImage =
          "linear-gradient(90deg, rgba(255,255,255,0.09) 1px, transparent 1px)";
        track.style.backgroundSize = `${framePx}px 100%`;
      } else {
        track.style.backgroundImage = "";
        track.style.backgroundSize = "";
      }
    }
  }

  function paintClips() {
    sortClips();
    if (selected >= clips.length) selected = clips.length - 1;
    if (!clips.length) selected = -1;
    let html = "";
    let cursor = 0;
    clips.forEach((c, i) => {
      const s = c.start ?? 0;
      // visible gap block between cursor and this clip
      if (s > cursor + 1e-6) {
        const gw = (s - cursor) * pxPerSec;
        if (gw >= 14) {
          html += `<div class="tl-gap" data-gap="${i}" style="left:${cursor * pxPerSec}px;width:${gw}px" title="Gap ${fmtTime(s - cursor)} — double-click to close">${esc(fmtTime(s - cursor))}</div>`;
        }
      }
      const w = Math.max(MIN_PX, durOf(c) * pxPerSec);
      const left = s * pxPerSec;
      cursor = Math.max(cursor, s + durOf(c));
      const name = esc(c.filename || byId(c.assetId)?.filename || "clip");
      const on = i === selected ? " is-on" : "";
      const kind = c.media_type || byId(c.assetId)?.media_type || "video";
      const off = localIds.has(c.assetId) ? "" : " is-off";
      const sub = `${fmtTime(c.in)}→${fmtTime(c.out)} · ${fmtTime(durOf(c))}`;
      html += `<div class="tl-clip kind-${kind}${on}${off}" data-i="${i}" style="left:${left}px;width:${w}px" title="${name} · src ${sub} · @ ${fmtTime(s)}">
          <i class="h left" data-edge="in" title="Trim start (drag)"></i>
          <b>${name}</b><small>${esc(sub)}</small>
          <i class="h right" data-edge="out" title="Trim end (drag)"></i>
        </div>`;
    });
    track.innerHTML = html;
    // re-apply live drag class (repaint wipes it)
    if (drag && (drag.mode === "trim" || drag.mode === "move")) {
      track.querySelector(`[data-i="${drag.i}"]`)?.classList.add(
        drag.mode === "trim" ? "is-trim" : "is-move",
      );
    }
    paintRuler();
    paintHead();
  }

  function paintHead() {
    playhead.style.left = `${seqTime * pxPerSec}px`;
    paintTc();
  }

  function ensureVisible() {
    if (!followOn || !scroll) return;
    const x = seqTime * pxPerSec;
    const vw = scroll.clientWidth - 60;
    if (x < scroll.scrollLeft + 24) {
      scroll.scrollLeft = Math.max(0, x - 80);
    } else if (x > scroll.scrollLeft + vw) {
      scroll.scrollLeft = Math.max(0, x - 80);
    }
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
        return `<li class="pool-item${on}" draggable="true" data-id="${a.id}" title="Click preview · double-click appends to end · drag anywhere onto the timeline">
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

  function markDirty() {
    if (saveState) {
      saveState.textContent = "Saving…";
      saveState.classList.add("is-dirty");
    }
  }

  function markSaved() {
    if (saveState) {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      saveState.textContent = `Saved ${hh}:${mm}:${ss}`;
      saveState.classList.remove("is-dirty");
    }
  }

  function persist() {
    markDirty();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await fetch(`/api/projects/${projectId}/timeline`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clips: clips.map((c) => ({ assetId: c.assetId, in: c.in, out: c.out, start: c.start ?? 0 })),
          }),
        });
      } catch {
        if (saveState) saveState.textContent = "Save failed";
        return;
      }
      markSaved();
    }, 400);
  }

  function mutate(fn) {
    pushHist();
    fn();
    persist();
    paintClips();
  }

  function makeClip(asset, start) {
    const dur = srcDur(asset);
    return {
      assetId: asset.id,
      in: 0,
      out: dur,
      start: Math.max(0, Math.round(start * 1000) / 1000),
      filename: asset.filename,
      media_type: asset.media_type,
      duration_sec: dur,
      size_bytes: asset.size_bytes,
    };
  }

  // Double-click pool: append after everything.
  function addClip(asset) {
    const clip = makeClip(asset, seqDur());
    mutate(() => {
      clips.push(clip);
      sortClips();
      selected = clips.indexOf(clip);
    });
  }

  // Drop from pool: free-place at the drop time (snapped, pushed past overlaps).
  function placeClipAt(asset, t) {
    const dur = srcDur(asset);
    const sn = snapTime(Math.max(0, t));
    const at = freeSlot(sn.snapped ? sn.t : Math.max(0, t), dur);
    const clip = makeClip(asset, at);
    mutate(() => {
      clips.push(clip);
      sortClips();
      selected = clips.indexOf(clip);
    });
    hideGhost();
  }

  // Lift: remove selected but leave a gap (DaVinci-style).
  function lift() {
    if (selected < 0 || !clips[selected]) return;
    mutate(() => {
      clips.splice(selected, 1);
      selected = Math.min(selected, clips.length - 1);
      if (!clips.length) selected = -1;
    });
    loadAt(seqTime);
  }

  // Ripple delete: remove selected and close the gap.
  function rippleDelete() {
    if (selected < 0 || !clips[selected]) return;
    const removed = clips[selected];
    const gap = durOf(removed);
    const end = clipEnd(removed);
    mutate(() => {
      clips.splice(selected, 1);
      for (const c of clips) {
        if ((c.start ?? 0) >= end - 1e-6) {
          c.start = Math.max(0, Math.round(((c.start ?? 0) - gap) * 1000) / 1000);
        }
      }
      sortClips();
      selected = Math.min(selected, clips.length - 1);
      if (!clips.length) selected = -1;
    });
    loadAt(seqTime);
  }

  // Double-click a gap block: pull everything after it left.
  function closeGapAt(t) {
    let gapStart = 0;
    let gapEnd = 0;
    let cursor = 0;
    for (const c of clips) {
      const s = c.start ?? 0;
      if (t >= cursor - 1e-6 && t < s - 1e-6) {
        gapStart = cursor;
        gapEnd = s;
        break;
      }
      cursor = Math.max(cursor, s + durOf(c));
    }
    const gap = gapEnd - gapStart;
    if (gap <= 1e-6) return;
    mutate(() => {
      for (const c of clips) {
        if ((c.start ?? 0) >= gapEnd - 1e-6) {
          c.start = Math.max(0, Math.round(((c.start ?? 0) - gap) * 1000) / 1000);
        }
      }
      sortClips();
    });
  }

  function cutAt() {
    const hit = clipAt(seqTime);
    if (!hit) return;
    const local = hit.local;
    if (local - hit.c.in < MIN_DUR || hit.c.out - local < MIN_DUR) return;
    mutate(() => {
      const right = { ...hit.c, in: local, start: Math.round(seqTime * 1000) / 1000 };
      hit.c.out = local;
      clips.splice(hit.i + 1, 0, right);
      sortClips();
      selected = clips.indexOf(right);
    });
    paintHead();
    loadAt(seqTime);
  }

  function joinAt() {
    if (selected < 0 || selected >= clips.length - 1) return;
    const a = clips[selected];
    const b = clips[selected + 1];
    if (a.assetId !== b.assetId) return;
    if (Math.abs(a.out - b.in) > 0.05) return;
    // must be adjacent on the timeline (no gap between them)
    if (Math.abs(clipEnd(a) - (b.start ?? 0)) > 0.05) return;
    mutate(() => {
      a.out = b.out;
      clips.splice(selected + 1, 1);
    });
  }

  function trimEdgeToPlayhead(edge) {
    if (selected < 0 || !clips[selected]) return;
    const c = clips[selected];
    const asset = byId(c.assetId);
    const max = asset ? srcDur(asset) : c.out + 60;
    const t = seqTime;
    if (edge === "in") {
      const target = Math.min(Math.max(t - (c.start ?? 0) + c.in, 0), c.out - MIN_DUR);
      if (Math.abs(target - c.in) < 1e-4) return;
      const prevEnd = selected > 0 ? clipEnd(clips[selected - 1]) : 0;
      const newStart = (c.start ?? 0) + (target - c.in);
      if (newStart < prevEnd - 1e-6) return; // would overlap previous clip
      mutate(() => {
        c.in = target;
        c.start = Math.round(newStart * 1000) / 1000;
      });
    } else {
      const target = Math.min(Math.max(t - (c.start ?? 0) + c.in, c.in + MIN_DUR), max);
      if (Math.abs(target - c.out) < 1e-4) return;
      const nextStart = selected < clips.length - 1 ? (clips[selected + 1].start ?? Infinity) : Infinity;
      if ((c.start ?? 0) + (target - c.in) > nextStart + 1e-6) return; // would overlap next clip
      mutate(() => {
        c.out = target;
      });
    }
    lastTrimEdge = edge;
    loadAt(seqTime);
  }

  function nudgeEdge(edge, frames) {
    if (selected < 0 || !clips[selected]) return;
    const fps = timelineFps();
    const dt = frames / fps;
    const c = clips[selected];
    const asset = byId(c.assetId);
    const max = asset ? srcDur(asset) : c.out + 60;
    if (edge === "in") {
      const prevEnd = selected > 0 ? clipEnd(clips[selected - 1]) : 0;
      const lo = Math.max(0, c.in + (prevEnd - (c.start ?? 0)));
      const v = Math.min(c.out - MIN_DUR, Math.max(lo, c.in + dt));
      if (Math.abs(v - c.in) < 1e-6) return;
      mutate(() => {
        c.start = Math.max(0, Math.round(((c.start ?? 0) + (v - c.in)) * 1000) / 1000);
        c.in = v;
      });
    } else {
      const nextStart = selected < clips.length - 1 ? (clips[selected + 1].start ?? Infinity) : Infinity;
      const hi = Math.min(max, c.in + (nextStart - (c.start ?? 0)));
      const v = Math.max(c.in + MIN_DUR, Math.min(hi, c.out + dt));
      if (Math.abs(v - c.out) < 1e-6) return;
      mutate(() => {
        c.out = v;
      });
    }
    lastTrimEdge = edge;
  }

  // ---- playback / shuttle ----
  function stopLoop() {
    playing = false;
    shuttle = 0;
    cancelAnimationFrame(raf);
    playBtn.textContent = "Play";
  }

  async function togglePlay() {
    if (!clips.length) return;
    if (playing) {
      stopLoop();
      video.pause();
      return;
    }
    playing = true;
    shuttle = 1;
    playBtn.textContent = "Stop";
    lastTick = performance.now();
    await loadAt(seqTime);
    const hit = clipAt(seqTime);
    const asset = hit && byId(hit.c.assetId);
    if (asset && asset.media_type !== "image" && localIds.has(asset.id)) {
      try {
        video.playbackRate = 1;
        await video.play();
      } catch {
        stopLoop();
        return;
      }
    }
    loop();
  }

  function shuttlePlay(speed) {
    if (!clips.length) return;
    playing = true;
    shuttle = speed;
    playBtn.textContent = "Stop";
    lastTick = performance.now();
    video.pause();
    if (speed === 1) {
      loadAt(seqTime).then(() => {
        const hit = clipAt(seqTime);
        const asset = hit && byId(hit.c.assetId);
        if (asset && asset.media_type !== "image" && localIds.has(asset.id)) {
          video.playbackRate = 1;
          video.play().catch(() => stopLoop());
        }
      });
    }
    cancelAnimationFrame(raf);
    loop();
  }

  function loop() {
    cancelAnimationFrame(raf);
    if (!playing) return;
    raf = requestAnimationFrame(async (now) => {
      const dt = Math.min(0.08, (now - lastTick) / 1000);
      lastTick = now;
      const speed = shuttle || 1;
      const total = seqDur();
      const hit = clipAt(seqTime);
      if (!hit) {
        if (seqTime >= total - 1e-3 && speed > 0) {
          stopLoop();
          video.pause();
          paintHead();
          return;
        }
        // gap (or before start while shuttling back): drift through it
        if (speed < 0 && seqTime <= 0) {
          stopLoop();
          paintHead();
          loadAt(0);
          return;
        }
        video.pause();
        seqTime += dt * speed;
        seqTime = Math.max(0, Math.min(total, seqTime));
        // landed inside a clip? load it so playback continues seamlessly
        if (clipAt(seqTime)) {
          await loadAt(seqTime);
          const nh = clipAt(seqTime);
          const na = nh && byId(nh.c.assetId);
          if (speed === 1 && na && na.media_type !== "image" && localIds.has(na.id)) {
            try {
              video.playbackRate = 1;
              await video.play();
            } catch {
              stopLoop();
              return;
            }
          }
          lastTick = performance.now();
        }
        paintHead();
        ensureVisible();
        loop();
        return;
      }
      const asset = byId(hit.c.assetId);
      const videoDriven =
        speed === 1 && asset && asset.media_type !== "image" && !video.paused && localIds.has(asset.id);
      if (videoDriven) {
        seqTime = hit.start + (video.currentTime - hit.c.in);
      } else {
        seqTime += dt * speed;
        if (asset && asset.media_type !== "image" && localIds.has(asset.id) && !video.hidden) {
          try {
            const target = hit.c.in + Math.min(Math.max(0, seqTime - hit.start), hit.c.out - hit.c.in);
            if (Math.abs(video.currentTime - target) > 0.12) video.currentTime = target;
          } catch {
            /* ignore */
          }
        }
      }
      if (seqTime < 0) {
        seqTime = 0;
        if (speed < 0) {
          stopLoop();
          paintHead();
          loadAt(seqTime);
          return;
        }
      }
      if (seqTime >= hit.start + (hit.c.out - hit.c.in) - 0.02 && speed > 0) {
        seqTime = hit.start + (hit.c.out - hit.c.in);
        if (hit.i >= clips.length - 1) {
          if (seqTime >= seqDur() - 1e-3) {
            stopLoop();
            video.pause();
            paintHead();
            return;
          }
        }
        seqTime += 0.001;
        await loadAt(seqTime);
        const next = clipAt(seqTime);
        const na = next && byId(next.c.assetId);
        if (speed === 1 && na && na.media_type !== "image" && localIds.has(na.id)) {
          try {
            video.playbackRate = 1;
            await video.play();
          } catch {
            stopLoop();
            return;
          }
        }
      } else if (speed < 0 && seqTime <= hit.start + 0.02 && hit.i > 0) {
        seqTime = Math.max(0, hit.start - 0.001);
        await loadAt(seqTime);
      }
      paintHead();
      ensureVisible();
      loop();
    });
  }

  function seekTo(t, opts = {}) {
    const snapped = opts.snap === true ? snapTime(t) : { t, snapped: false };
    seqTime = Math.max(0, Math.min(seqDur(), snapped.t));
    showSnap(snapped.snapped ? seqTime : null);
    setTimeout(hideSnap, 350);
    stopLoop();
    video.pause();
    loadAt(seqTime);
    paintHead();
    ensureVisible();
  }

  function seekPx(x, snap = true) {
    const rect = track.getBoundingClientRect();
    seekTo((x - rect.left) / pxPerSec, { snap });
  }

  function stepFrame(dir, big = false) {
    const fps = timelineFps();
    seekTo(seqTime + dir * (big ? 1 : 1 / fps), { snap: false });
  }

  function gotoEdit(dir) {
    const edges = [...new Set(allEdges().map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
    if (dir > 0) {
      for (const t of edges) {
        if (t > seqTime + 0.03) {
          seekTo(t, { snap: false });
          return;
        }
      }
      seekTo(seqDur(), { snap: false });
    } else {
      for (let i = edges.length - 1; i >= 0; i -= 1) {
        if (edges[i] < seqTime - 0.03) {
          seekTo(edges[i], { snap: false });
          return;
        }
      }
      seekTo(0, { snap: false });
    }
  }

  function zoomAt(clientX, factor) {
    const rect = track.getBoundingClientRect();
    const t = clientX != null ? (clientX - rect.left) / pxPerSec : (scroll.scrollLeft + scroll.clientWidth / 2) / pxPerSec;
    pxPerSec = Math.max(12, Math.min(480, pxPerSec * factor));
    SETPREF("zoom", String(Math.round(pxPerSec)));
    paintClips();
    scroll.scrollLeft = Math.max(0, t * pxPerSec - (clientX != null ? clientX - rect.left : scroll.clientWidth / 2));
  }

  function zoomFit() {
    const dur = Math.max(seqDur(), 1);
    const avail = Math.max(200, scroll.clientWidth - 60);
    pxPerSec = Math.max(12, Math.min(480, avail / dur));
    SETPREF("zoom", String(Math.round(pxPerSec)));
    paintClips();
    scroll.scrollLeft = 0;
  }

  // ---- trim tooltip + live preview ----
  function showTrimTip(x, y, text) {
    if (!trimTip || !timelineEl) return;
    trimTip.hidden = false;
    trimTip.textContent = text;
    const r = timelineEl.getBoundingClientRect();
    trimTip.style.left = `${Math.min(Math.max(8, x - r.left + 16), r.width - 180)}px`;
    trimTip.style.top = `${Math.max(8, y - r.top - 70)}px`;
  }

  function hideTrimTip() {
    if (trimTip) trimTip.hidden = true;
  }

  // Floating ghost that follows the cursor while moving / placing a clip.
  let ghost = null;
  function ghostEl() {
    if (ghost) return ghost;
    ghost = document.createElement("div");
    ghost.className = "tl-ghost";
    ghost.hidden = true;
    main?.appendChild(ghost);
    return ghost;
  }

  function showGhost(clip, start, opts = {}) {
    const g = ghostEl();
    const w = Math.max(MIN_PX, durOf(clip) * pxPerSec);
    const kind = clip.media_type || byId(clip.assetId)?.media_type || "video";
    g.className = `tl-ghost kind-${kind}${opts.bad ? " is-bad" : ""}`;
    g.hidden = false;
    g.style.left = `${start * pxPerSec}px`;
    g.style.top = "34px";
    g.style.width = `${w}px`;
    const name = esc(clip.filename || byId(clip.assetId)?.filename || "clip");
    g.innerHTML = `<b>${name}</b><small>${esc(fmtTime(start))} · ${esc(fmtTime(durOf(clip)))}</small>`;
  }

  function hideGhost() {
    if (ghost) ghost.hidden = true;
  }

  function queueTrimPreview(i, edge) {
    if (trimPreviewQueued) return;
    trimPreviewQueued = true;
    requestAnimationFrame(async () => {
      trimPreviewQueued = false;
      const c = clips[i];
      if (!c) return;
      const asset = byId(c.assetId);
      if (!asset || asset.media_type === "image" || !localIds.has(asset.id)) return;
      const url = await blobFor(asset);
      if (!url || !drag) return;
      showMedia(asset.media_type, url);
      try {
        video.currentTime = Math.min(Math.max(edge === "in" ? c.in : c.out - 0.04, 0), Math.max(0, srcDur(asset) - 0.04));
        if (video.paused) await video.play().then(() => video.pause()).catch(() => {});
      } catch {
        /* ignore */
      }
    });
  }

  // ---- events ----
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
    poolDragId = Number(item.dataset.id);
    event.dataTransfer.setData("text/asset", item.dataset.id);
    event.dataTransfer.effectAllowed = "copy";
  });

  poolList?.addEventListener("dragend", () => {
    poolDragId = null;
    hideGhost();
    hideSnap();
    if (dropCue) dropCue.hidden = true;
    track?.classList.remove("is-drop");
  });

  let poolDragId = null;

  track?.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    track.classList.add("is-drop");
    const t = xToTime(event.clientX);
    const sn = snapTime(Math.max(0, t));
    const at = Math.max(0, sn.snapped ? sn.t : t);
    showSnap(sn.snapped ? at : null);
    if (dropCue) {
      dropCue.hidden = false;
      dropCue.style.left = `${at * pxPerSec}px`;
    }
    const asset = poolDragId != null ? byId(poolDragId) : null;
    if (asset) {
      showGhost(
        { assetId: asset.id, in: 0, out: srcDur(asset), filename: asset.filename, media_type: asset.media_type },
        at,
      );
    }
  });

  track?.addEventListener("dragleave", () => {
    track.classList.remove("is-drop");
    if (dropCue) dropCue.hidden = true;
    hideSnap();
    hideGhost();
  });

  track?.addEventListener("drop", (event) => {
    event.preventDefault();
    track.classList.remove("is-drop");
    if (dropCue) dropCue.hidden = true;
    hideSnap();
    hideGhost();
    const id = Number(event.dataTransfer.getData("text/asset")) || poolDragId;
    poolDragId = null;
    const asset = byId(id);
    if (!asset) return;
    placeClipAt(asset, xToTime(event.clientX));
  });

  // double-click a gap block to close it
  track?.addEventListener("dblclick", (event) => {
    if (event.target.closest(".tl-gap")) {
      closeGapAt(xToTime(event.clientX));
    }
  });

  function xToTime(clientX) {
    const rect = track.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / pxPerSec);
  }

  track?.addEventListener("mousedown", (event) => {
    hideClipMenu();
    if (event.button === 2) return;
    const handle = event.target.closest(".h");
    const clipEl = event.target.closest(".tl-clip");
    if (handle && clipEl) {
      const i = Number(clipEl.dataset.i);
      selected = i;
      lastTrimEdge = handle.dataset.edge;
      pushHist();
      drag = {
        mode: "trim",
        i,
        edge: handle.dataset.edge,
        startX: event.clientX,
        in: clips[i].in,
        out: clips[i].out,
        start0: clips[i].start ?? 0,
      };
      event.preventDefault();
      paintClips();
      return;
    }
    if (clipEl) {
      const i = Number(clipEl.dataset.i);
      selected = i;
      paintClips();
      const c = clips[i];
      drag = {
        mode: "maybe-move",
        i,
        startX: event.clientX,
        startY: event.clientY,
        seekX: event.clientX,
        grabOff: xToTime(event.clientX) - (c?.start ?? 0),
        at: c?.start ?? 0,
      };
      event.preventDefault();
      return;
    }
    drag = { mode: "seek" };
    seekPx(event.clientX);
  });

  window.addEventListener("mousemove", (event) => {
    if (!drag) return;
    if (drag.mode === "maybe-move") {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      pushHist();
      drag.mode = "move";
    }
    if (drag.mode === "trim") {
      const dt = (event.clientX - drag.startX) / pxPerSec;
      const c = clips[drag.i];
      if (!c) return;
      const asset = byId(c.assetId);
      const max = asset ? srcDur(asset) : c.out + 60;
      const prevEnd = drag.i > 0 ? clipEnd(clips[drag.i - 1]) : 0;
      const nextStart = drag.i < clips.length - 1 ? (clips[drag.i + 1].start ?? Infinity) : Infinity;
      if (drag.edge === "in") {
        let v = drag.in + dt;
        // snap the edge's sequence time (skip own start while it moves)
        const edgeSeq = drag.start0 + (v - drag.in);
        const sn = snapTime(edgeSeq, drag.start0);
        if (sn.snapped) {
          v = drag.in + (sn.t - drag.start0);
          showSnap(sn.t);
        } else hideSnap();
        const lo = Math.max(0, drag.in + (prevEnd - drag.start0));
        c.in = Math.min(c.out - MIN_DUR, Math.max(lo, v));
        c.start = Math.max(0, Math.round((drag.start0 + (c.in - drag.in)) * 1000) / 1000);
        seqTime = c.start ?? 0;
      } else {
        let v = drag.out + dt;
        const edgeSeq = drag.start0 + durOf({ in: drag.in, out: drag.out }) + (v - drag.out);
        const ownEnd = drag.start0 + (drag.out - drag.in);
        const sn = snapTime(edgeSeq, ownEnd);
        if (sn.snapped) {
          v = drag.out + (sn.t - edgeSeq);
          showSnap(sn.t);
        } else hideSnap();
        const hi = Math.min(max, drag.in + (nextStart - drag.start0));
        c.out = Math.max(c.in + MIN_DUR, Math.min(hi, v));
        seqTime = (c.start ?? 0) + durOf(c);
      }
      const fps = timelineFps();
      const delta = (drag.edge === "in" ? c.in - drag.in : c.out - drag.out);
      showTrimTip(
        event.clientX,
        event.clientY,
        `${drag.edge === "in" ? "IN" : "OUT"}  ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}s\nsrc ${fmtTc(c.in, fps)} → ${fmtTc(c.out, fps)}\nlen ${fmtTime(c.out - c.in)}`,
      );
      paintClips();
      paintHead();
      queueTrimPreview(drag.i, drag.edge);
      return;
    }
    if (drag.mode === "move") {
      const c = clips[drag.i];
      if (!c) return;
      const t = xToTime(event.clientX) - (drag.grabOff || 0);
      const sn = snapTime(Math.max(0, t), c.start ?? 0);
      const at = Math.max(0, sn.snapped ? sn.t : t);
      showSnap(sn.snapped ? at : null);
      drag.at = at;
      if (dropCue) {
        dropCue.hidden = false;
        dropCue.style.left = `${at * pxPerSec}px`;
      }
      showGhost(c, at);
      return;
    }
    if (drag.mode === "seek") {
      seekPx(event.clientX);
    }
  });

  window.addEventListener("mouseup", (event) => {
    if (!drag) return;
    if (drag.mode === "maybe-move") {
      // simple click: select + seek where clicked
      seekPx(drag.seekX);
      drag = null;
      return;
    }
    if (drag.mode === "trim") {
      drag = null;
      hideSnap();
      hideTrimTip();
      video.pause();
      persist();
      paintClips();
      loadAt(seqTime);
      return;
    }
    if (drag.mode === "move") {
      const from = drag.i;
      const moved = clips[from];
      const at = Math.max(0, drag.at ?? moved?.start ?? 0);
      const unchanged = moved && Math.abs(at - (moved.start ?? 0)) < 1e-6;
      drag = null;
      hideSnap();
      hideGhost();
      if (dropCue) dropCue.hidden = true;
      if (!moved) {
        paintClips();
        return;
      }
      if (unchanged) {
        // plain click-drag that went nowhere: drop the pushed history entry
        hist.pop();
        paintUndo();
        paintClips();
        return;
      }
      // hist was already pushed when the drag started; just commit
      moved.start = Math.round(freeSlot(at, durOf(moved), clips.indexOf(moved)) * 1000) / 1000;
      sortClips();
      // cascade: push any overlapping followers forward
      let cursor = 0;
      for (const c of clips) {
        if ((c.start ?? 0) < cursor - 1e-6) {
          c.start = Math.round(cursor * 1000) / 1000;
        }
        cursor = Math.max(cursor, (c.start ?? 0) + durOf(c));
      }
      sortClips();
      selected = clips.indexOf(moved);
      persist();
      paintClips();
      loadAt(seqTime);
      return;
    }
    drag = null;
  });

  // ruler scrub (drag across timecodes)
  let rulerScrub = false;
  ruler?.addEventListener("pointerdown", (event) => {
    rulerScrub = true;
    ruler.setPointerCapture?.(event.pointerId);
    seekPx(event.clientX);
  });
  ruler?.addEventListener("pointermove", (event) => {
    if (rulerScrub) seekPx(event.clientX);
  });
  ruler?.addEventListener("pointerup", () => {
    rulerScrub = false;
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

  // wheel: horizontal scroll pans, ctrl+wheel zooms
  scroll?.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomAt(event.clientX, event.deltaY < 0 ? 1.15 : 1 / 1.15);
      }
    },
    { passive: false },
  );

  // context menu
  function hideClipMenu() {
    if (clipMenu) clipMenu.hidden = true;
  }

  track?.addEventListener("contextmenu", (event) => {
    const clipEl = event.target.closest(".tl-clip");
    if (!clipEl || !clipMenu || !timelineEl) return;
    event.preventDefault();
    selected = Number(clipEl.dataset.i);
    paintClips();
    clipMenu.innerHTML = [
      ["split", "Split at playhead (S)"],
      ["tin", "Trim start to playhead ( [ )"],
      ["tout", "Trim end to playhead ( ] )"],
      ["ripple", "Ripple delete, close gap (Shift+Backspace)"],
      ["del", "Lift, leave gap (Backspace)"],
    ]
      .map(([v, l]) => `<button type="button" data-m="${v}">${esc(l)}</button>`)
      .join("");
    clipMenu.hidden = false;
    const r = timelineEl.getBoundingClientRect();
    clipMenu.style.left = `${Math.min(event.clientX - r.left, r.width - 210)}px`;
    clipMenu.style.top = `${event.clientY - r.top + 4}px`;
  });

  clipMenu?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-m]");
    if (!btn) return;
    const m = btn.dataset.m;
    hideClipMenu();
    if (m === "split") cutAt();
    else if (m === "tin") trimEdgeToPlayhead("in");
    else if (m === "tout") trimEdgeToPlayhead("out");
    else if (m === "ripple") rippleDelete();
    else if (m === "del") lift();
  });

  document.addEventListener("click", (event) => {
    if (clipMenu && !clipMenu.hidden && !event.target.closest("#clip-menu")) hideClipMenu();
  });

  // toolbar
  playBtn?.addEventListener("click", () => togglePlay());
  document.getElementById("btn-cut")?.addEventListener("click", cutAt);
  document.getElementById("btn-join")?.addEventListener("click", joinAt);
  document.getElementById("btn-lift")?.addEventListener("click", lift);
  document.getElementById("btn-prev")?.addEventListener("click", () => gotoEdit(-1));
  document.getElementById("btn-next")?.addEventListener("click", () => gotoEdit(1));
  document.getElementById("btn-fback")?.addEventListener("click", () => stepFrame(-1));
  document.getElementById("btn-ffwd")?.addEventListener("click", () => stepFrame(1));
  undoBtn?.addEventListener("click", undo);
  redoBtn?.addEventListener("click", redo);
  snapBtn?.addEventListener("click", () => {
    snapOn = !snapOn;
    SETPREF("snap", snapOn ? "1" : "0");
    paintToggles();
  });
  followBtn?.addEventListener("click", () => {
    followOn = !followOn;
    SETPREF("follow", followOn ? "1" : "0");
    paintToggles();
    if (followOn) ensureVisible();
  });
  document.getElementById("btn-fit")?.addEventListener("click", zoomFit);
  document.getElementById("zoom-in")?.addEventListener("click", (e) => zoomAt(e.clientX, 1.25));
  document.getElementById("zoom-out")?.addEventListener("click", (e) => zoomAt(e.clientX, 1 / 1.25));
  document.getElementById("btn-keys")?.addEventListener("click", () => {
    document.getElementById("keys-dialog")?.showModal();
  });
  document.getElementById("keys-close")?.addEventListener("click", () => {
    document.getElementById("keys-dialog")?.close();
  });

  // click timecode to type
  tc?.addEventListener("click", () => {
    if (tc.querySelector("input")) return;
    const fps = timelineFps();
    const input = document.createElement("input");
    input.className = "tc-edit";
    input.value = fmtTc(seqTime, fps);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const v = parseTc(input.value, fps);
        if (Number.isFinite(v)) seekTo(v, { snap: false });
        paintTc();
      } else if (e.key === "Escape") {
        paintTc();
      }
    });
    input.addEventListener("blur", paintTc);
    tc.textContent = "";
    tc.appendChild(input);
    input.focus();
    input.select();
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
      if (cacheLabel) cacheLabel.textContent = "Already loaded";
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
    if (clipMenu && !clipMenu.hidden && event.key === "Escape") {
      hideClipMenu();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (mod) return;
    if (event.code === "Space" || event.key.toLowerCase() === "k") {
      event.preventDefault();
      togglePlay();
    } else if (event.key.toLowerCase() === "j") {
      event.preventDefault();
      shuttlePlay(shuttle >= 0 ? -1 : Math.max(-4, shuttle * 2));
    } else if (event.key.toLowerCase() === "l") {
      event.preventDefault();
      if (!playing || shuttle <= 0) shuttlePlay(1);
      else if (shuttle < 4) shuttlePlay(shuttle * 2);
      else shuttlePlay(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepFrame(-1, event.shiftKey);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepFrame(1, event.shiftKey);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (event.altKey) {
        if (selected > 0) {
          selected -= 1;
          paintClips();
        }
      } else gotoEdit(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (event.altKey) {
        if (selected < clips.length - 1) {
          selected += 1;
          paintClips();
        }
      } else gotoEdit(1);
    } else if (event.key === "Home") {
      event.preventDefault();
      seekTo(0, { snap: false });
    } else if (event.key === "End") {
      event.preventDefault();
      seekTo(seqDur(), { snap: false });
    } else if (event.key === "c" || event.key === "C" || event.key === "s" || event.key === "S") {
      cutAt();
    } else if (event.key === "[") {
      trimEdgeToPlayhead("in");
    } else if (event.key === "]") {
      trimEdgeToPlayhead("out");
    } else if (event.key === ",") {
      nudgeEdge(lastTrimEdge, event.shiftKey ? -5 : -1);
    } else if (event.key === ".") {
      nudgeEdge(lastTrimEdge, event.shiftKey ? 5 : 1);
    } else if (event.key === "n" || event.key === "N") {
      snapOn = !snapOn;
      SETPREF("snap", snapOn ? "1" : "0");
      paintToggles();
    } else if (event.key === "Z" && event.shiftKey) {
      zoomFit();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (event.shiftKey) rippleDelete();
      else lift();
    } else if (event.key === "Escape") {
      selected = -1;
      hideClipMenu();
      paintClips();
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
    paintToggles();
    paintUndo();
    markSaved();
    paintClips();
    await paintCache();
    if (!clips.length) {
      const res = await fetch(`/api/projects/${projectId}/timeline`);
      if (res.ok) {
        const data = await res.json();
        clips = data.clips || [];
        ensureStarts();
        hist = [];
        fut = [];
        paintUndo();
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
