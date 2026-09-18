import json
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
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    media_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    parent_id INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES assets(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    progress REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
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


def unique_path(folder: Path, filename: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    name = Path(filename).name or "upload.bin"
    dest = folder / name
    stem, suffix = dest.stem, dest.suffix
    n = 2
    while dest.exists():
        dest = folder / f"{stem}_{n}{suffix}"
        n += 1
    return dest


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
    (DATA / "inbox").mkdir(parents=True, exist_ok=True)


def storage_for(project_id: int) -> dict:
    sizes = {kind: dir_bytes(media_dir(kind, project_id)) for kind in MEDIA_KINDS}
    total = sum(sizes.values())
    return {
        "original": fmt_bytes(sizes["originals"]),
        "proxy": fmt_bytes(sizes["proxies"]),
        "render": fmt_bytes(sizes["renders"]),
        "total": fmt_bytes(total),
        "original_bytes": sizes["originals"],
        "proxy_bytes": sizes["proxies"],
        "render_bytes": sizes["renders"],
        "total_bytes": total,
    }


@contextmanager
def db():
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
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
        cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
        if "progress" not in cols:
            conn.execute(
                "ALTER TABLE jobs ADD COLUMN progress REAL NOT NULL DEFAULT 0"
            )


def _row(row) -> dict | None:
    return dict(row) if row is not None else None


def list_projects() -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC"
        ).fetchall()
    return [{**dict(row), "storage": storage_for(row["id"])} for row in rows]


def get_project(project_id: int) -> dict | None:
    with db() as conn:
        row = conn.execute(
            "SELECT id, name, created_at, updated_at FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
    if not row:
        return None
    item = dict(row)
    item["storage"] = storage_for(project_id)
    return item


def touch_project(project_id: int) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE projects SET updated_at = ? WHERE id = ?",
            (utc_now(), project_id),
        )


def create_project(name: str) -> int:
    now = utc_now()
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)",
            (name, now, now),
        )
        project_id = int(cur.lastrowid)
    ensure_project_dirs(project_id)
    return project_id


def delete_project(project_id: int) -> None:
    with db() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    for kind in MEDIA_KINDS:
        shutil.rmtree(media_dir(kind, project_id), ignore_errors=True)


def add_asset(
    project_id: int,
    kind: str,
    media_type: str,
    filename: str,
    rel_path: str,
    size_bytes: int,
    meta: dict,
    parent_id: int | None = None,
) -> int:
    with db() as conn:
        cur = conn.execute(
            """INSERT INTO assets
               (project_id, kind, media_type, filename, rel_path, size_bytes, meta_json, parent_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                project_id,
                kind,
                media_type,
                filename,
                rel_path,
                size_bytes,
                json.dumps(meta),
                parent_id,
                utc_now(),
            ),
        )
        asset_id = int(cur.lastrowid)
    touch_project(project_id)
    return asset_id


def get_asset(asset_id: int) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    return _decorate_asset(_row(row)) if row else None


def list_assets(project_id: int) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            """SELECT a.*,
                      (SELECT status FROM jobs j
                       WHERE j.asset_id = a.id AND j.kind = 'proxy'
                       ORDER BY j.id DESC LIMIT 1) AS proxy_status,
                      (SELECT detail FROM jobs j
                       WHERE j.asset_id = a.id AND j.kind = 'proxy'
                       ORDER BY j.id DESC LIMIT 1) AS proxy_detail
               FROM assets a
               WHERE a.project_id = ?
               ORDER BY a.created_at DESC, a.id DESC""",
            (project_id,),
        ).fetchall()
    return [_decorate_asset(dict(row)) for row in rows]


def _decorate_asset(item: dict | None) -> dict | None:
    if not item:
        return None
    meta = item.get("meta_json")
    if isinstance(meta, str):
        try:
            item["meta"] = json.loads(meta)
        except json.JSONDecodeError:
            item["meta"] = {}
    else:
        item["meta"] = meta or {}
    item["size"] = fmt_bytes(item.get("size_bytes") or 0)
    return item


def add_job(project_id: int, asset_id: int, kind: str) -> int:
    now = utc_now()
    with db() as conn:
        cur = conn.execute(
            """INSERT INTO jobs (project_id, asset_id, kind, status, detail, progress, created_at, updated_at)
               VALUES (?, ?, ?, 'queued', '', 0, ?, ?)""",
            (project_id, asset_id, kind, now, now),
        )
        return int(cur.lastrowid)


def get_job(job_id: int) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return _row(row)


def set_job(
    job_id: int,
    status: str | None = None,
    detail: str | None = None,
    progress: float | None = None,
) -> None:
    job = get_job(job_id)
    if not job:
        return
    with db() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, detail = ?, progress = ?, updated_at = ? WHERE id = ?",
            (
                status if status is not None else job["status"],
                detail if detail is not None else job["detail"],
                progress if progress is not None else job.get("progress") or 0,
                utc_now(),
                job_id,
            ),
        )


def list_jobs(project_id: int) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            """SELECT j.*, a.filename
               FROM jobs j
               JOIN assets a ON a.id = j.asset_id
               WHERE j.project_id = ? AND j.status IN ('queued', 'running')
               ORDER BY j.id DESC""",
            (project_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def active_proxy_job(asset_id: int) -> dict | None:
    with db() as conn:
        row = conn.execute(
            """SELECT * FROM jobs
               WHERE asset_id = ? AND kind = 'proxy' AND status IN ('queued', 'running')
               ORDER BY id DESC LIMIT 1""",
            (asset_id,),
        ).fetchone()
    return _row(row)


def child_assets(parent_id: int, kind: str | None = None) -> list[dict]:
    sql = "SELECT * FROM assets WHERE parent_id = ?"
    args: list = [parent_id]
    if kind:
        sql += " AND kind = ?"
        args.append(kind)
    with db() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [_decorate_asset(dict(row)) for row in rows]


def delete_asset(asset_id: int) -> bool:
    asset = get_asset(asset_id)
    if not asset:
        return False
    for child in child_assets(asset_id):
        delete_asset(child["id"])
    path = DATA / asset["rel_path"]
    if path.exists() and path.is_file():
        path.unlink()
    with db() as conn:
        conn.execute("DELETE FROM jobs WHERE asset_id = ?", (asset_id,))
        conn.execute("DELETE FROM assets WHERE id = ?", (asset_id,))
    touch_project(asset["project_id"])
    return True


def rename_asset(asset_id: int, new_name: str) -> dict | None:
    asset = get_asset(asset_id)
    if not asset:
        return None
    name = Path(new_name).name.strip()
    if not name:
        return None
    if not Path(name).suffix:
        name += Path(asset["filename"]).suffix
    src = DATA / asset["rel_path"]
    dest = src.parent / name
    if dest.resolve() != src.resolve():
        dest = unique_path(src.parent, name)
        if src.exists():
            src.rename(dest)
    rel = str(dest.relative_to(DATA))
    with db() as conn:
        conn.execute(
            "UPDATE assets SET filename = ?, rel_path = ? WHERE id = ?",
            (dest.name, rel, asset_id),
        )
    touch_project(asset["project_id"])
    return get_asset(asset_id)


def queued_job_ids() -> list[int]:
    with db() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'queued', detail = 'requeued' WHERE status = 'running'"
        )
        rows = conn.execute(
            "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id"
        ).fetchall()
    return [row["id"] for row in rows]
