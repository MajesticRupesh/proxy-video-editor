import hashlib
import logging
import os
import secrets
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import FastAPI, Form, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

from app import db

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


class AuthGate(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if path == "/login" or path.startswith("/static/"):
            return await call_next(request)
        if not request.session.get("authed"):
            return RedirectResponse("/login", status_code=303)
        return await call_next(request)


app = FastAPI(title="Proxy NLE")
app.add_middleware(AuthGate)
app.add_middleware(
    SessionMiddleware,
    secret_key=hashlib.sha256(PASSWORD.encode()).hexdigest(),
    same_site="lax",
)
app.mount("/static", StaticFiles(directory=str(ROOT / "app" / "static")), name="static")


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


@app.post("/projects/{project_id}/delete")
def remove_project(project_id: int):
    db.delete_project(project_id)
    return RedirectResponse("/projects", status_code=303)
