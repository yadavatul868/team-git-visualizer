# Lessons

## uv projects nested under another uv workspace
- **What happened:** `uv init` in `backend/` silently added it as a member of the parent
  `10.AGENTICAI` uv workspace. It edited the parent `pyproject.toml` and `uv.lock`, and installed
  packages into the parent `.venv`.
- **Rule:** before `uv init` inside any existing folder, check the parent folders for a
  `pyproject.toml` containing `[tool.uv.workspace]`. If found, use `uv init --no-workspace`.
  After setup, confirm `uv run python -c "import sys; print(sys.prefix)"` points at the
  project's own `.venv`.

## Parallel shell calls share the working directory
- **What happened:** a `cd backend` in one Bash call carried over to the next, so the Vite
  scaffold landed in `backend/frontend`.
- **Rule:** use absolute paths, or run `cd` inside a subshell `( … )`, when scaffolding.
