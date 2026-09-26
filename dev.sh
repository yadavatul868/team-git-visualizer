#!/usr/bin/env bash
# Start the backend (FastAPI on :8000) and the frontend (Vite on :5173) together.
# Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")"

[ -d frontend/node_modules ] || (cd frontend && npm install)
(cd backend && uv sync --quiet)

trap 'kill 0' EXIT
(cd backend && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload) &
(cd frontend && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort) &
wait
