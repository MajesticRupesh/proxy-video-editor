# Architecture

Personal proxy NLE: record on a PC, upload to a home/OCI box, edit from a browser (including on vacation). Not a SaaS. No Docker (extra layer, extra CPU/IO for FFmpeg). No test sprawl.

UI is a **simple** tool with a **DaVinci Resolve–like** look: dark skin, media pool, viewer, timeline, page tabs (Edit / Render). Features stay tiny: scrub, cut, trim, join.

## Stack

- **API / pages:** FastAPI + Jinja2 + plain JS/CSS (no React, no EJS).
- **Auth:** one password in `.env`. The UI asks for it and sends it on requests. No user table.
- **DB:** SQLite (projects, assets, timeline JSON, jobs).
- **Media:** FFmpeg CLI only (`subprocess`). Never wrap it in MoviePy-style layers.
- **Uploads:** [Uppy](https://uppy.io) + [tus](https://tus.io) in the browser → **[tusd](https://github.com/tus/tusd)** on disk. 4K/8K originals can be tens of GB; Python must not buffer the whole file.
- **HTTPS:** optional, user’s reverse proxy. App binds HTTP locally.
- **Data dir:** `DATA_DIR` in `.env` so originals/proxies/renders can live on a large volume, not the boot disk.

Target machine: OCI free tier (4 OCPU, 24 GB, no GPU). Cap concurrent FFmpeg jobs (1–2). GPU encode can be a later optional detect, not a requirement.

## Runtime layout

```
data/
  originals/   # never mutated
  proxies/     # 360p ~1 Mbps H.264 +faststart
  renders/
  app.sqlite
```

tusd and FastAPI are two processes on the host. FastAPI owns projects/jobs; tusd owns the byte pipe.

## Edit vs render

Opening a clip **downloads the proxy once** and plays it locally (blob URL). Scrubbing does not hit the server. Timeline is an EDL: ordered `{ assetId, in, out }` on a project.

Edit cache: first visit to Edit tab prompts to download all proxies for the project (count + total MB). Store bytes in OPFS per project (`proxies/{projectId}/`), never in localStorage (flags/manifest only). Playback via blob URLs created from OPFS files. Edit tab shows local cache usage distinctly with an Unload button to delete it. Survives reload; re-validate by proxy asset id/size.

Export (Render tab), user picks:

- **Stream copy:** `-c copy` cut/join. Fast, keyframe-ish in/out, same codec/resolution as the original (8K in → 8K out).
- **Re-encode:** real FFmpeg knobs (codec, preset, CRF/bitrate, scale, audio). Accurate cuts; slow on CPU.

Proxy generation (upload complete): `libx264` `medium`, `scale=-2:360`, ~0.8 Mbps, AAC. 8K → 360p on CPU can take a long time; the UI shows job status.

## Out of scope

HLS/DASH for the editor, server-side scrubbing, in-browser FFmpeg for final export, Redis/S3/K8s, Docker, multi-user accounts.

we need to make sure our log files have size limits so that they dont cause unnecessary trouble later