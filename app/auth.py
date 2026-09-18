from __future__ import annotations

import secrets
from collections.abc import Callable

from fastapi import Request
from fastapi.responses import RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from app.config import PASSWORD

SESSION_KEY = "authed"


def is_authed(request: Request) -> bool:
    return bool(request.session.get(SESSION_KEY))


def login(request: Request, password: str) -> bool:
    if not PASSWORD or not secrets.compare_digest(password, PASSWORD):
        return False
    request.session[SESSION_KEY] = True
    return True


def logout(request: Request) -> None:
    request.session.clear()


class AuthGate(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        path = request.url.path
        if path == "/login" or path.startswith("/static/"):
            return await call_next(request)
        if not is_authed(request):
            if path.startswith("/api/"):
                return Response(status_code=401)
            return RedirectResponse("/login", status_code=303)
        return await call_next(request)
