from __future__ import annotations

import json
import logging
import queue
import shutil
import subprocess
import threading
import time
from fractions import Fraction
from pathlib import Path

from app import db

log = logging.getLogger("media")
ROOT = Path(__file__).resolve().parent.parent
DATA = db.DATA
INBOX = DATA / "inbox"
TUS_PORT = "1080"
TUS_BASE = "/files/"
JOB_WORKERS = 2
STILL_CODECS = {
    "png",
    "mjpeg",
    "jpeg",
    "jpeg2000",
    "webp",
    "tiff",
    "bmp",
    "gif",
    "svg",
}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".heic"}
AUDIO_EXTS = {".wav", ".mp3", ".aac", ".flac", ".aiff", ".aif", ".m4a", ".ogg", ".opus", ".wma"}
HDR_TRC = {
    "smpte2084": "HDR PQ",
    "arib-std-b67": "HDR HLG",
    "smpte428": "HDR",
}

_job_q: queue.Queue[int] = queue.Queue()
_tusd_proc: subprocess.Popen | None = None
_tusd_log = None


def fmt_bitrate(bps: float | int | None) -> str:
    if not bps:
        return "—"
    bps = float(bps)
    if bps >= 1_000_000:
        return f"{bps / 1_000_000:.1f} Mbps"
    return f"{bps / 1000:.0f} kbps"


def fmt_duration(seconds: float | None) -> str:
    if not seconds:
        return "—"
    seconds = float(seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    if h:
        return f"{h}:{m:02d}:{s:05.2f}"
    return f"{m}:{s:05.2f}"


def _fps(stream: dict) -> str:
    raw = stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/0"
    try:
        val = float(Fraction(raw))
    except (ZeroDivisionError, ValueError):
        return "—"
    if val <= 0:
        return "—"
    return f"{val:.3f}".rstrip("0").rstrip(".")


def _bit_depth(stream: dict) -> str:
    pix = stream.get("pix_fmt") or ""
    raw = str(stream.get("bits_per_raw_sample") or stream.get("bits_per_sample") or "")
    if "p16" in pix or raw == "16":
        return "16-bit"
    if "p12" in pix or raw == "12":
        return "12-bit"
    if "p10" in pix or "10le" in pix or "10be" in pix or raw == "10":
        return "10-bit"
    if raw == "8" or pix:
        return "8-bit"
    return "—"


def _color_label(stream: dict) -> str:
    depth = _bit_depth(stream)
    trc = (stream.get("color_transfer") or "").lower()
    space = stream.get("color_space") or stream.get("color_primaries") or ""
    hdr = HDR_TRC.get(trc)
    if not hdr and "bt2020" in space.lower():
        hdr = "BT.2020"
    parts = [p for p in (depth, hdr, space if not hdr else "") if p and p != "—"]
    return " ".join(parts) if parts else "—"


def probe(path: Path) -> dict:
    meta = {
        "media_type": "unknown",
        "codec": "—",
        "width": None,
        "height": None,
        "resolution": "—",
        "fps": "—",
        "bitrate": "—",
        "color": "—",
        "duration": "—",
        "sample_rate": "—",
        "channels": "—",
        "bit_depth": "—",
        "duration_sec": 0.0,
    }
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return meta
    try:
        raw = subprocess.check_output(
            [
                ffprobe,
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(path),
            ],
            timeout=30,
        )
        info = json.loads(raw)
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError) as exc:
        log.warning("ffprobe failed for %s: %s", path, exc)
        return meta

    fmt = info.get("format") or {}
    streams = info.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = float(fmt.get("duration") or (video or {}).get("duration") or 0)
    ext = path.suffix.lower()
    still = bool(video) and (
        ext in IMAGE_EXTS
        or (video.get("codec_name") in STILL_CODECS and duration < 0.5)
    )

    if video and not still:
        media_type = "video"
    elif video or ext in IMAGE_EXTS:
        media_type = "image"
    elif audio or ext in AUDIO_EXTS:
        media_type = "audio"
    else:
        media_type = "unknown"

    meta["media_type"] = media_type
    meta["has_audio"] = bool(audio)
    meta["duration_sec"] = duration
    meta["duration"] = fmt_duration(duration)
    meta["bitrate"] = fmt_bitrate(fmt.get("bit_rate") or (video or audio or {}).get("bit_rate"))

    if video:
        w, h = video.get("width"), video.get("height")
        meta["width"], meta["height"] = w, h
        meta["resolution"] = f"{w}×{h}" if w and h else "—"
        meta["codec"] = video.get("codec_name") or "—"
        if media_type == "video":
            meta["fps"] = _fps(video)
            meta["color"] = _color_label(video)
        elif media_type == "image":
            meta["color"] = _bit_depth(video)
    if audio:
        if media_type == "audio":
            meta["codec"] = audio.get("codec_name") or meta["codec"]
        rate = audio.get("sample_rate")
        meta["sample_rate"] = f"{int(rate) / 1000:.1f} kHz".replace(".0 ", " ") if rate else "—"
        ch = audio.get("channels")
        layout = audio.get("channel_layout") or ""
        meta["channels"] = f"{ch} ({layout})" if ch and layout else (str(ch) if ch else "—")
        bits = audio.get("bits_per_sample") or audio.get("bits_per_raw_sample")
        meta["bit_depth"] = f"{bits}-bit" if bits else "—"
        if media_type == "audio" and not fmt.get("bit_rate"):
            meta["bitrate"] = fmt_bitrate(audio.get("bit_rate"))
    return meta


def ingest_upload(payload: dict) -> None:
    upload = (payload.get("Event") or {}).get("Upload") or payload.get("Upload") or {}
    meta = upload.get("MetaData") or upload.get("metaData") or {}
    storage = upload.get("Storage") or {}
    src = Path(storage.get("Path") or "")
    try:
        project_id = int(meta.get("project_id") or meta.get("projectId") or 0)
    except (TypeError, ValueError):
        project_id = 0
    filename = meta.get("filename") or meta.get("name") or src.name or "upload.bin"
    if not src.exists() or not db.get_project(project_id):
        log.warning("ingest skipped project=%s src=%s", project_id, src)
        return

    db.ensure_project_dirs(project_id)
    dest = db.unique_path(db.media_dir("originals", project_id), filename)
    shutil.move(str(src), dest)
    info = Path(storage.get("InfoPath") or str(src) + ".info")
    if info.exists():
        info.unlink(missing_ok=True)

    probed = probe(dest)
    size = dest.stat().st_size
    rel = str(dest.relative_to(DATA))
    asset_id = db.add_asset(
        project_id,
        "original",
        probed["media_type"],
        dest.name,
        rel,
        size,
        probed,
    )
    if probed["media_type"] in {"video", "image"}:
        queue_proxy(asset_id)
    log.info("ingested %s as asset %s", dest.name, asset_id)


def queue_proxy(asset_id: int) -> str | None:
    asset = db.get_asset(asset_id)
    if not asset or asset["kind"] != "original" or asset["media_type"] not in {"video", "image"}:
        return "not a video or image original"
    if db.active_proxy_job(asset_id):
        return "proxy already running"
    job_id = db.add_job(asset["project_id"], asset_id, "proxy")
    _job_q.put(job_id)
    return None


def _run_ffmpeg(cmd: list[str], dest: Path, duration_sec: float = 0, on_progress=None) -> None:
    err_file = dest.with_suffix(dest.suffix + ".ffmpeg.err")
    with err_file.open("wb") as errf:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=errf,
            text=True,
            bufsize=1,
        )
        last = 0.0
        speed = ""
        pct = 0.0
        assert proc.stdout is not None
        for line in proc.stdout:
            key, _, val = line.strip().partition("=")
            if key == "speed":
                speed = val.strip()
            elif key in {"out_time_ms", "out_time_us"}:
                try:
                    raw = float(val)
                except ValueError:
                    continue
                seconds = raw / 1_000_000
                if duration_sec > 0:
                    pct = max(0.0, min(99.0, 100.0 * seconds / duration_sec))
            elif key == "progress" and on_progress:
                now = time.monotonic()
                if now - last >= 0.4 or val == "end":
                    on_progress(pct if val != "end" else 100.0, speed)
                    last = now
        code = proc.wait()
    if code != 0:
        detail = err_file.read_text(errors="ignore")[-400:]
        err_file.unlink(missing_ok=True)
        raise RuntimeError(detail or "ffmpeg failed")
    err_file.unlink(missing_ok=True)


def make_proxy(src: Path, dest: Path, has_audio: bool, duration_sec: float = 0, on_progress=None) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not on PATH")
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-i",
        str(src),
        "-vf",
        "scale=-2:360",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        "1000k",
        "-maxrate",
        "1200k",
        "-bufsize",
        "2000k",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
    ]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", "96k"]
    else:
        cmd += ["-an"]
    cmd.append(str(dest))
    _run_ffmpeg(cmd, dest, duration_sec, on_progress)


def make_image_proxy(src: Path, dest: Path, on_progress=None) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not on PATH")
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-i",
        str(src),
        "-vf",
        "scale=-2:360",
        "-q:v",
        "4",
        str(dest),
    ]
    _run_ffmpeg(cmd, dest, 0, on_progress)


def _run_job(job_id: int) -> None:
    job = db.get_job(job_id)
    if not job:
        return
    db.set_job(job_id, "running", "", 0)
    asset = db.get_asset(job["asset_id"])
    if not asset:
        db.set_job(job_id, "error", "asset missing")
        return
    src = DATA / asset["rel_path"]
    for child in db.child_assets(asset["id"], "proxy"):
        db.delete_asset(child["id"])
    is_image = asset["media_type"] == "image"
    dest = db.unique_path(
        db.media_dir("proxies", asset["project_id"]),
        f"{Path(asset['filename']).stem}_proxy.{'jpg' if is_image else 'mp4'}",
    )
    duration = float((asset.get("meta") or {}).get("duration_sec") or 0)

    def on_progress(pct: float, speed: str) -> None:
        db.set_job(job_id, "running", speed, pct)

    try:
        if is_image:
            make_image_proxy(src, dest, on_progress)
        else:
            make_proxy(
                src,
                dest,
                bool(asset.get("meta", {}).get("has_audio")),
                duration,
                on_progress,
            )
        probed = probe(dest)
        db.add_asset(
            asset["project_id"],
            "proxy",
            probed["media_type"],
            dest.name,
            str(dest.relative_to(DATA)),
            dest.stat().st_size,
            probed,
            parent_id=asset["id"],
        )
        db.set_job(job_id, "done", "", 100)
    except Exception as exc:
        db.set_job(job_id, "error", str(exc)[-400:])
        log.exception("proxy job %s failed", job_id)


def _worker() -> None:
    while True:
        job_id = _job_q.get()
        try:
            _run_job(job_id)
        finally:
            _job_q.task_done()


def start_workers() -> None:
    for _ in range(JOB_WORKERS):
        threading.Thread(target=_worker, daemon=True).start()
    for job_id in db.queued_job_ids():
        _job_q.put(job_id)


def _tusd_bin() -> Path | None:
    which = shutil.which("tusd")
    if which:
        return Path(which)
    local = ROOT / "bin" / "tusd"
    return local if local.exists() else None


def start_tusd() -> None:
    global _tusd_proc, _tusd_log
    binary = _tusd_bin()
    if not binary:
        log.error("tusd not found; put it on PATH or in bin/tusd")
        return
    INBOX.mkdir(parents=True, exist_ok=True)
    (DATA / "logs").mkdir(parents=True, exist_ok=True)
    log_path = DATA / "logs" / "tusd.log"
    if log_path.exists() and log_path.stat().st_size > 5 * 1024 * 1024:
        log_path.replace(DATA / "logs" / "tusd.log.1")
    _tusd_log = open(log_path, "a", encoding="utf-8")
    cmd = [
        str(binary),
        "-host",
        "127.0.0.1",
        "-port",
        TUS_PORT,
        "-base-path",
        TUS_BASE,
        "-upload-dir",
        str(INBOX),
        "-hooks-http",
        "http://127.0.0.1:8080/api/tus-hook",
        "-hooks-enabled-events",
        "post-finish",
        "-hooks-http-timeout",
        "30s",
        "-disable-download",
    ]
    _tusd_proc = subprocess.Popen(cmd, stdout=_tusd_log, stderr=_tusd_log)
    time.sleep(0.4)
    if _tusd_proc.poll() is not None:
        log.error("tusd exited immediately (code %s)", _tusd_proc.returncode)
        return
    log.info("tusd on 127.0.0.1:%s (pid %s)", TUS_PORT, _tusd_proc.pid)


def stop_tusd() -> None:
    global _tusd_proc, _tusd_log
    if _tusd_proc and _tusd_proc.poll() is None:
        _tusd_proc.terminate()
        try:
            _tusd_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _tusd_proc.kill()
    _tusd_proc = None
    if _tusd_log:
        _tusd_log.close()
        _tusd_log = None
