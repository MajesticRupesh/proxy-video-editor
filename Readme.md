# Proxy NLE

Personal proxy editor: unlock with the studio password, then manage projects in the browser.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Copy `.env.example` to `.env` (or keep the existing `.env`) and set:

- `password` — the only login secret
- `SECRET_KEY` — signs the session cookie
- `DATA_DIR` — SQLite, originals, proxies, renders, rotating logs

## Run

```bash
source .venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

Open http://127.0.0.1:8080 — login, then create/list/delete projects.
