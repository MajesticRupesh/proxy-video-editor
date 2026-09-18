import hashlib
import logging
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

import psutil
from fastapi import FastAPI, Form, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

from app import db, media

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def _load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_env()
PASSWORD = os.environ.get("password", "")
if not PASSWORD:
    raise RuntimeError("Set password in .env")

DATA.mkdir(parents=True, exist_ok=True)
(DATA / "logs").mkdir(exist_ok=True)
log = logging.getLogger()
if not log.handlers:
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    file_handler = RotatingFileHandler(
        DATA / "logs" / "app.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(fmt)
    stream = logging.StreamHandler()
    stream.setFormatter(fmt)
    log.addHandler(file_handler)
    log.addHandler(stream)

db.init_db()
templates = Jinja2Templates(directory=str(ROOT / "app" / "templates"))
PUBLIC = {"/login", "/api/stats", "/api/tus-hook"}


class AuthGate(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if path in PUBLIC or path.startswith("/static/"):
            return await call_next(request)
        if not request.session.get("authed"):
            if path.startswith("/api/"):
                return JSONResponse({"error": "auth"}, status_code=401)
            return RedirectResponse("/login", status_code=303)
        return await call_next(request)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    media.start_workers()
    media.start_tusd()
    yield
    media.stop_tusd()


app = FastAPI(title="Proxy NLE", lifespan=lifespan)
app.add_middleware(AuthGate)
app.add_middleware(
    SessionMiddleware,
    secret_key=hashlib.sha256(PASSWORD.encode()).hexdigest(),
    same_site="lax",
)
app.mount("/static", StaticFiles(directory=str(ROOT / "app" / "static")), name="static")

psutil.cpu_percent(interval=None)
_net = psutil.net_io_counters()
_net_t = time.monotonic()


@app.get("/api/stats")
def machine_stats():
    global _net, _net_t
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage(DATA)
    now = time.monotonic()
    net = psutil.net_io_counters()
    dt = max(now - _net_t, 1e-6)
    down = (net.bytes_recv - _net.bytes_recv) / dt
    up = (net.bytes_sent - _net.bytes_sent) / dt
    _net, _net_t = net, now
    return {
        "cpu": psutil.cpu_percent(interval=None),
        "ram_used": ram.used,
        "ram_total": ram.total,
        "disk_used": disk.used,
        "disk_total": disk.total,
        "net_down": down,
        "net_up": up,
    }


@app.post("/api/tus-hook")
async def tus_hook(request: Request):
    host = request.client.host if request.client else ""
    if host not in {"127.0.0.1", "::1"}:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    payload = await request.json()
    name = payload.get("Type") or request.headers.get("Hook-Name") or ""
    if name == "post-finish":
        threading.Thread(target=media.ingest_upload, args=(payload,), daemon=True).start()
    return JSONResponse({})


@app.get("/api/projects/{project_id}/jobs")
def project_jobs(project_id: int):
    if not db.get_project(project_id):
        return JSONResponse({"error": "missing"}, status_code=404)
    return {"jobs": db.list_jobs(project_id)}


@app.get("/api/projects/{project_id}/assets")
def project_assets(project_id: int):
    if not db.get_project(project_id):
        return JSONResponse({"error": "missing"}, status_code=404)
    return {"assets": db.list_assets(project_id), "storage": db.storage_for(project_id)}


def _asset_in_project(project_id: int, asset_id: int) -> dict | None:
    asset = db.get_asset(asset_id)
    if not asset or asset["project_id"] != project_id:
        return None
    return asset


@app.get("/api/projects/{project_id}/assets/{asset_id}/file")
def asset_file(project_id: int, asset_id: int, download: int = 0):
    asset = _asset_in_project(project_id, asset_id)
    if not asset:
        return JSONResponse({"error": "missing"}, status_code=404)
    path = (DATA / asset["rel_path"]).resolve()
    if not path.is_file() or not str(path).startswith(str(DATA.resolve())):
        return JSONResponse({"error": "missing"}, status_code=404)
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{asset["filename"]}"'
    return FileResponse(path, filename=asset["filename"] if download else None, headers=headers)


@app.post("/api/projects/{project_id}/assets/{asset_id}/delete")
def asset_delete(project_id: int, asset_id: int):
    asset = _asset_in_project(project_id, asset_id)
    if not asset:
        return JSONResponse({"error": "missing"}, status_code=404)
    db.delete_asset(asset_id)
    return {"ok": True}


@app.post("/api/projects/{project_id}/assets/{asset_id}/rename")
async def asset_rename(project_id: int, asset_id: int, request: Request):
    asset = _asset_in_project(project_id, asset_id)
    if not asset:
        return JSONResponse({"error": "missing"}, status_code=404)
    body = await request.json()
    name = str(body.get("name") or "").strip()
    updated = db.rename_asset(asset_id, name)
    if not updated:
        return JSONResponse({"error": "bad name"}, status_code=400)
    return {"asset": updated}


@app.post("/api/projects/{project_id}/assets/{asset_id}/proxy")
def asset_proxy(project_id: int, asset_id: int):
    asset = _asset_in_project(project_id, asset_id)
    if not asset:
        return JSONResponse({"error": "missing"}, status_code=404)
    err = media.queue_proxy(asset_id)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    return {"ok": True}


@app.get("/")
def home():
    return RedirectResponse("/projects", status_code=303)


@app.get("/login")
def login_page(request: Request):
    if request.session.get("authed"):
        return RedirectResponse("/projects", status_code=303)
    return templates.TemplateResponse(request, "login.html", {"error": None})


@app.post("/login")
def login_submit(request: Request, password: str = Form(...)):
    if secrets.compare_digest(password, PASSWORD):
        request.session["authed"] = True
        return RedirectResponse("/projects", status_code=303)
    return templates.TemplateResponse(
        request, "login.html", {"error": "Wrong password."}, status_code=401
    )


@app.post("/logout")
def logout_submit(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/projects")
def projects_page(request: Request):
    return templates.TemplateResponse(
        request, "projects.html", {"projects": db.list_projects(), "error": None}
    )


@app.post("/projects")
def create_project(name: str = Form(...)):
    name = name.strip()
    if name:
        db.create_project(name)
    return RedirectResponse("/projects", status_code=303)


@app.get("/projects/{project_id}")
def project_page(request: Request, project_id: int):
    project = db.get_project(project_id)
    if not project:
        return RedirectResponse("/projects", status_code=303)
    return templates.TemplateResponse(
        request,
        "project.html",
        {
            "project": project,
            "assets": db.list_assets(project_id),
            "tus_endpoint": f"http://127.0.0.1:{media.TUS_PORT}{media.TUS_BASE}",
        },
    )


@app.post("/projects/{project_id}/delete")
def remove_project(project_id: int):
    db.delete_project(project_id)
    return RedirectResponse("/projects", status_code=303)
