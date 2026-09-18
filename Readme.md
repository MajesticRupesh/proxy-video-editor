# Proxy NLE

`.env` only needs `password`. Data lives in `data/`. Needs **ffmpeg/ffprobe** and **tusd**.

```bash
# tusd binary (darwin arm64 example)
mkdir -p bin
curl -sSL -o /tmp/tusd.zip https://github.com/tus/tusd/releases/download/v2.10.1/tusd_darwin_arm64.zip
unzip -o /tmp/tusd.zip -d /tmp/tusd && cp /tmp/tusd/*/tusd bin/tusd && chmod +x bin/tusd

uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

Open http://127.0.0.1:8080 — FastAPI also starts tusd on port 1080.
