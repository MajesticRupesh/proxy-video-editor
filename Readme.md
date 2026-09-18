# Proxy NLE

`.env` only needs `password`. Data lives in `data/`.

```bash
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

Open http://127.0.0.1:8080
