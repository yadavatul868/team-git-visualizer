# Team Git Visualizer — Final v1 Plan

## 1. Requirements analysis

### What the user asked for
| # | Requirement | Source |
|---|---|---|
| R1 | Enter any GitHub repo URL (personal or company org) and load it | "pass on the GitHub link and it should fetch" |
| R2 | Authenticate with `GITHUB_PAT` from a `.env` file in the app's working directory | "have a .env file … github pat" |
| R3 | **Refresh** button pulls the latest snapshot of the remote repo; the app only ever shows the latest snapshot | "whenever I hit refresh it should be pulling the recent snapshot" |
| R4 | Nothing hard-coded: no branch names, not even the integration or default branch | "I don't want to hard code the branch names" |
| R5 | Show all branches, what branched off what, who merged into what, and who made how many commits | "who pulls from what, who merged into what, who made how many commits" |
| R6 | Two-panel layout: graph panel and details panel | "two big boxes" |
| R7 | Graph: nodes = commits labelled with short hash, date and time; branches stacked vertically; time flows horizontally; scroll, zoom in/out; looks polished | "very nicely looking visual … zoom in zoom out" |
| R8 | Click a node → who made the commit, when, the message, files changed | original brief |
| R9 | Click an edge → edge information (Claude proposes the fields; user refines after testing) | "if I click on an edge I should get all the information about that edge" |
| R10 | Bare-minimum v1 first, then iterate | "very bare minimum version first" |

### Explicitly out of scope for v1
- Deployment tracking (which branch is on which server)
- Protocol checks and fix instructions for the team (planned for **v2**, after the user reviews v1)
- Multi-repo dashboard, PR/review data, diff viewer, hosting, login

### Engineering constraints
- Never commit to `main`. Work on feature branches off `dev`, open PRs into `dev`; the user merges to `main`.
- Python: type hints on all signatures, ruff, pytest, f-strings. Frontend: TypeScript.
- The PAT has read **and write** access, but the **app only ever reads**: it runs `git clone`/`git fetch` and never pushes or calls any GitHub write API.

### Decisions derived from the requirements (please review)
| # | Decision | Why |
|---|---|---|
| D1 | **Lane inference:** git doesn't record which branch a commit was made on. The default branch (read from GitHub, not hard-coded) claims its first-parent chain first. Other branches claim theirs, most recently active first. | Only way to draw "branches as lanes" from raw git data |
| D2 | **Deleted branches:** commits that only survive through a merge get their own lane, named from the merge message (`Merge pull request #12 from org/feat-x` → `feat-x`, marked *(deleted)*) | Covers "merged and deleted" branches, which are very common with PRs |
| D3 | **Horizontal axis = commit order, not a real time scale.** A date ruler along the top marks day boundaries. | A true time scale bunches bursts of commits on top of each other and leaves long empty gaps over weekends |
| D4 | **Node colour = author; edge/lane colour = branch.** The legend shows each author's colour and commit count. | "Who did what" is the main question you want answered |
| D5 | **Merge direction is shown, not judged**, e.g. "`dev` → `feat/login`" (a sync) vs "`feat/login` → `dev`" (a merge back) | Satisfies R4 without knowing which branch is the integration branch |
| D6 | **Squash merges** show up as ordinary commits with no merge edge. If the message contains `(#123)`, the details show "squash-merged from PR #123". | A limitation of git data; flagged so it isn't a surprise |
| D7 | Authors are identified by email, and display names come from the latest commit | Simple for v1; `.mailmap` support can come later |
| D8 | Default window: last 30 days (7 / 30 / 90 / all). Capped at 2,000 commits, with a warning. | Keeps the graph readable and fast |
| D9 | Only `https://github.com/<owner>/<repo>` URLs are accepted; anything else is rejected | Stops the backend being pointed at arbitrary hosts or local paths |
| D10 | The token is passed to git through environment config (`GIT_CONFIG_*` / `http.extraHeader`). It is never put in URLs or command-line arguments, never written into the clone's config, and never logged or returned by the API. | It's a read/write token, so it must not leak |

---

## 2. Architecture
```
Browser ── React + Vite + TS + React Flow (@xyflow/react)
   │  /api (Vite dev proxy)
   ▼
FastAPI (Python 3.12+, uv) ── git CLI ──▶ .cache/repos/<owner>__<repo>.git  (bare clone)
   ▲                                  └── fetch --prune +refs/heads/*  (on Load / Refresh)
   └── reads GITHUB_PAT from .env
```
Toolchain verified on this machine: node 25, npm 11, uv 0.10, Python 3.14, git 2.50.

## 3. Backend API
| Endpoint | Does | Returns |
|---|---|---|
| `POST /api/repo/sync` `{url}` | First call: bare clone; later calls: `fetch --prune` of all branches. One lock per repo so two refreshes can't overlap. | default branch, branches (name, tip, last commit time, author), `fetched_at` |
| `GET /api/graph?repo=owner/repo&days=30` | `git log --branches` with parents → lanes, nodes, edges (D1–D6) | `{lanes[], nodes[], edges[], authors[], summary, truncated}` |
| `GET /api/commit/{sha}?repo=` | Commit details | full message, author and committer (name, email, time), parents, branches containing the commit, files `[{path, status A/M/D/R, additions, deletions}]` |
| `GET /api/edge?repo=&from=&to=` | Edge details | see section 4 |

Modules: `config.py` (loads `.env`), `git_runner.py` (safe subprocess wrapper with token handling), `sync.py`, `graph.py` (lanes and edges, pure functions), `details.py`, `models.py` (Pydantic), `main.py`.

## 4. Frontend
**Top bar:** repo URL input · **Load** · **Refresh** (spinner, "fetched 2 min ago") · time-window selector

**Summary strip:** number of branches and commits in the window, plus author chips (colour + name + commit count). Clicking a chip highlights that author's commits.

**Graph panel (left, ~70% width):**
- Lane labels stay fixed on the left while you scroll; the date ruler runs along the top
- Commit node: coloured dot plus a label with short hash and `25 Sep 14:32`; merge commits use a distinct shape
- Edges: straight within a lane; curved for branch-offs and merges, with an arrow showing direction
- Pan (drag / trackpad), zoom (wheel / pinch / ± buttons), fit-to-view, minimap
- The selected node or edge is highlighted, and hovering shows a quick tooltip

**Details panel (right, ~30% width):**
- **Node:** hash (copy button, link to GitHub), author and email, date and time with relative age ("3 days ago"), full message, branches containing the commit, parent commits (clickable), and the list of changed files with A/M/D/R badges and +/- counts plus a total
- **Edge:**
  - type: `continue` · `branch-off` · `merge`
  - source commit → target commit, and source lane → target lane
  - time between them, and the author of each end
  - branch-off only: the name of the new branch
  - merge only: who merged, PR number (if it came from a GitHub PR), number of commits brought in, files the merge changed
- **Empty state:** "Click a commit or a connection to see details"

**Styling:** clean dark/light-aware theme and an author palette that's easy to tell apart.

## 5. Repo layout
```
backend/   pyproject.toml, app/{main,config,git_runner,sync,graph,details,models}.py, tests/
frontend/  package.json, vite.config.ts, src/{App.tsx, api.ts, types.ts,
           components/{TopBar,SummaryStrip,GraphPanel,CommitNode,DetailsPanel}.tsx, lib/layout.ts}
.env (git-ignored) · .env.example · .gitignore · README.md · tasks/
```

## 6. Testing & verification
- A **synthetic repo fixture** (pytest) built with 3 fake authors and branches `main`/`stage`/`dev`, plus:
  - two feature branches merged back
  - one sync from `dev` into a feature branch
  - one branch that was merged and then deleted
  - one stale branch that was never merged
  - one squash-style commit
- Unit tests: lane assignment, edge types, merge-message parsing, commit and edge details, URL validation, and a check that the token never appears in any output
- Manual end-to-end: load one real repo from your account, then screenshot the graph, a node's details and an edge's details
- `ruff check` + `ruff format` clean; `npm run build` passes with no type errors

## 7. Milestones (each: feature branch off `dev` → PR into `dev`)
- [ ] **M1 `feature/backend`** — scaffold, config, safe git runner, sync, graph, commit and edge endpoints, fixture and tests
- [ ] **M2 `feature/frontend-graph`** — Vite scaffold, top bar, summary strip, graph panel with lanes, zoom and pan
- [ ] **M3 `feature/details-panel`** — node and edge detail views wired to the API
- [ ] **M4 `feature/polish`** — styling, loading/empty/error states, README (setup + run), screenshots
- [ ] **Review with user** → collect missing fields → plan **v2 (protocol checks + fix instructions)**

## Review
_(to be filled in after implementation)_
