# Team Git Visualizer — v1 Plan

## Goal
Paste a GitHub repo URL → hit Refresh → see the latest snapshot of **every branch, commit,
branch-off and merge** as a zoomable graph. Click any node (commit) or edge for details.
Nothing about the repo (branch names, integration branch, team) is hard-coded.

## Scope
**In v1**
- Input box for a GitHub repo URL + **Load** and **Refresh** buttons
- Auth via `GITHUB_PAT` in a `.env` file in the app's working directory
- Graph panel (left): one horizontal lane per branch, time flows left → right,
  nodes show short hash + date/time, coloured by author; pan, zoom, minimap
- Details panel (right): node details or edge details on click
- Summary strip: #branches, #commits and #commits per author in the current window
- Time window selector (7 / 30 / 90 days / all), default 30 days

**Not in v1:** protocol/rule checks, deployment tracking, PR/review data, diff viewer,
multi-repo dashboard, login/hosting, auto-refresh.

## Architecture
```
React (Vite + TS + React Flow)  ──HTTP──▶  FastAPI (Python)  ──git CLI──▶  local bare clone cache
                                                                  ▲
                                                     GITHUB_PAT from .env (never sent to browser)
```

### Backend (Python, FastAPI, uv, ruff, pytest)
- **Repo sync** — `POST /api/repo/sync {url}`
  - Accept only `https://github.com/<owner>/<repo>` (validated; no arbitrary URLs/paths)
  - First time: bare clone into `.cache/repos/<owner>__<repo>.git`; afterwards `git fetch --prune`
    of all branches (`+refs/heads/*`) so deleted branches disappear and new ones appear
  - PAT is passed to git via environment config (`GIT_CONFIG_COUNT` / `http.extraHeader`),
    never written to disk, the clone's config, URLs, or logs
  - Returns: default branch, branch list with tip commit + last activity, fetched-at timestamp
- **Graph** — `GET /api/graph?repo=<owner/repo>&days=30`
  - `git log --branches --date-order` → commits with parents, author, email, timestamp, subject, refs
  - Lane assignment (git doesn't record which branch a commit was made on):
    1. Default branch claims its first-parent chain first
    2. Other branches claim their first-parent chains in order of most-recent activity
    3. Commits reachable only via a merge's 2nd parent (branch merged then deleted) get their own
       lane, named from the merge message (`Merge branch 'x'` / `Merge pull request #N from y`)
       or `(deleted branch)`
  - Edge types: `continue` (same lane), `branch-off` (child in a new lane), `merge` (2nd parent)
  - Response: `{ lanes[], nodes[], edges[], authors[], summary }`
- **Commit details** — `GET /api/commit/{sha}`: full message, author/committer, branches that
  contain it, files with status (A/M/D/R) and +/- line counts
- **Edge details** — `GET /api/edge?from=&to=`: edge type, from/to lanes, time gap;
  for merges: who merged, number of commits brought in, files touched by the merge

### Frontend (React + Vite + TypeScript + React Flow)
- Top bar: repo URL input, Load, Refresh (with "last fetched" time), time-window selector
- Summary strip: branches, commits, per-author commit counts (legend doubles as author colours)
- Graph panel: custom commit node (short hash + date/time), custom edges (straight within a lane,
  curved for branch-off/merge), sticky lane labels on the left, zoom/pan/fit/minimap
- Details panel: node view and edge view (fields listed above); empty state when nothing selected

### Repo layout
```
backend/   app/ (main.py, git_sync.py, graph.py, models.py), tests/, pyproject.toml
frontend/  src/ (components/GraphPanel, DetailsPanel, TopBar, SummaryStrip; api.ts), package.json
.env.example   .gitignore (.env, .cache/, node_modules, .venv)   README.md
```

## Testing & verification
- pytest fixture that **builds a synthetic repo** (3 fake authors, dev/stage/main, feature
  branches, merges, a merged-then-deleted branch, a stale unmerged branch) — used for unit tests
  of lane assignment, edge types, commit/edge details
- Manual run against one real repo of yours; screenshots of graph + both detail views
- ruff clean; no PAT in logs, API responses, or `.cache` git config

## Milestones (each = feature branch off `dev` → PR into `dev`)
- [ ] M1 `feature/backend-sync-graph` — scaffold, `.env` handling, sync, graph API, tests
- [ ] M2 `feature/frontend-graph` — scaffold, top bar, graph panel with lanes/zoom/pan
- [ ] M3 `feature/details-panel` — commit + edge detail endpoints and panel, summary strip
- [ ] M4 `feature/polish` — styling, empty/error states, README with setup steps
- [ ] Review with user → collect missing fields → plan v2 (protocol checks)

## Assumptions (tell me if any are wrong)
- PAT is fine-grained, read-only: **Contents: Read** + **Metadata: Read** on the target repos
  (your org may need to approve fine-grained tokens)
- Runs locally only (`localhost`), single user
- Very large repos: graph capped at ~2,000 commits in the window, with a warning

## Review
_(to be filled in after implementation)_
