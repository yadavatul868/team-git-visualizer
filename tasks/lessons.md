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

## Browser preview can't launch servers from OneDrive
- **What happened:** the browser pane's launcher got "Operation not permitted" running `dev.sh`,
  because macOS privacy protection blocks it from reading `~/Library/CloudStorage`.
- **Rule:** start `./dev.sh` from the shell in the background, and point `.claude/launch.json`
  (in the session root, `10.AGENTICAI/`) at `{"url": "http://localhost:5173"}` with no command.
