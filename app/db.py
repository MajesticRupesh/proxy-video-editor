import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA / "app.sqlite"
MEDIA_KINDS = ("originals", "proxies", "renders")
SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    timeline_json TEXT NOT NULL DEFAULT '[]'
);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def fmt_bytes(n: int | float) -> str:
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return "0 B"


def media_dir(kind: str, project_id: int) -> Path:
    return DATA / kind / str(project_id)


def dir_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def ensure_project_dirs(project_id: int) -> None:
    for kind in MEDIA_KINDS:
        media_dir(kind, project_id).mkdir(parents=True, exist_ok=True)


def storage_for(project_id: int) -> dict:
    sizes = {kind: dir_bytes(media_dir(kind, project_id)) for kind in MEDIA_KINDS}
    return {
        "original": fmt_bytes(sizes["originals"]),
        "proxy": fmt_bytes(sizes["proxies"]),
        "render": fmt_bytes(sizes["renders"]),
    }


@contextmanager
def db():
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)


def list_projects() -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC"
        ).fetchall()
    projects = []
    for row in rows:
        item = dict(row)
        item["storage"] = storage_for(item["id"])
        projects.append(item)
    return projects


def create_project(name: str) -> None:
    now = utc_now()
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)",
            (name, now, now),
        )
        project_id = cur.lastrowid
    ensure_project_dirs(project_id)


def delete_project(project_id: int) -> None:
    with db() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    for kind in MEDIA_KINDS:
        shutil.rmtree(media_dir(kind, project_id), ignore_errors=True)
