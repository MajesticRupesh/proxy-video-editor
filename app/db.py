import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "app.sqlite"
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


@contextmanager
def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
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
    return [dict(row) for row in rows]


def create_project(name: str) -> None:
    now = utc_now()
    with db() as conn:
        conn.execute(
            "INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)",
            (name, now, now),
        )


def delete_project(project_id: int) -> None:
    with db() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
