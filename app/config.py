from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT_DIR = Path(__file__).resolve().parent.parent
PASSWORD = os.getenv("PASSWORD") or os.getenv("password") or ""
SECRET_KEY = os.getenv("SECRET_KEY") or "dev-secret-change-me"
DATA_DIR = Path(os.getenv("DATA_DIR") or ROOT_DIR / "data").resolve()

ORIGINALS_DIR = DATA_DIR / "originals"
PROXIES_DIR = DATA_DIR / "proxies"
RENDERS_DIR = DATA_DIR / "renders"
LOGS_DIR = DATA_DIR / "logs"
DB_PATH = DATA_DIR / "app.sqlite"


def ensure_data_dirs() -> None:
    for path in (DATA_DIR, ORIGINALS_DIR, PROXIES_DIR, RENDERS_DIR, LOGS_DIR):
        path.mkdir(parents=True, exist_ok=True)


def configure_logging() -> None:
    ensure_data_dirs()
    root = logging.getLogger()
    if root.handlers:
        return
    root.setLevel(logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    file_handler = RotatingFileHandler(
        LOGS_DIR / "app.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    root.addHandler(file_handler)
    root.addHandler(stream_handler)
