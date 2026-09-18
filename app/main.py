from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from app import db
from app.auth import AuthGate, is_authed, login, logout
from app.config import PASSWORD, ROOT_DIR, SECRET_KEY, configure_logging, ensure_data_dirs

configure_logging()
ensure_data_dirs()
db.init_db()

templates = Jinja2Templates(directory=str(ROOT_DIR / "app" / "templates"))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not PASSWORD:
        raise RuntimeError("Set PASSWORD (or password) in .env before starting.")
    yield


app = FastAPI(title="Proxy NLE", lifespan=lifespan)
app.add_middleware(AuthGate)
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, same_site="lax")
app.mount("/static", StaticFiles(directory=str(ROOT_DIR / "app" / "static")), name="static")


@app.get("/", response_class=HTMLResponse)
def home():
    return RedirectResponse("/projects", status_code=303)


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if is_authed(request):
        return RedirectResponse("/projects", status_code=303)
    return templates.TemplateResponse(
        request,
        "login.html",
        {"error": None},
    )


@app.post("/login", response_class=HTMLResponse)
def login_submit(request: Request, password: str = Form(...)):
    if login(request, password):
        return RedirectResponse("/projects", status_code=303)
    return templates.TemplateResponse(
        request,
        "login.html",
        {"error": "Wrong password."},
        status_code=401,
    )


@app.post("/logout")
def logout_submit(request: Request):
    logout(request)
    return RedirectResponse("/login", status_code=303)


@app.get("/projects", response_class=HTMLResponse)
def projects_page(request: Request):
    return templates.TemplateResponse(
        request,
        "projects.html",
        {"projects": db.list_projects(), "error": None},
    )


@app.post("/projects", response_class=HTMLResponse)
def create_project(request: Request, name: str = Form(...)):
    name = name.strip()
    if not name:
        return templates.TemplateResponse(
            request,
            "projects.html",
            {"projects": db.list_projects(), "error": "Name a project before creating it."},
            status_code=400,
        )
    db.create_project(name)
    return RedirectResponse("/projects", status_code=303)


@app.post("/projects/{project_id}/delete")
def remove_project(project_id: int):
    db.delete_project(project_id)
    return RedirectResponse("/projects", status_code=303)
