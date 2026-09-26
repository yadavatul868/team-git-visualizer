# Team Git Visualizer

See what your team is doing in git. Paste a GitHub repo URL, press **Load**, and every branch,
commit, branch-off and merge appears as a zoomable graph. Click any commit or connection for
details.

- **Lanes:** one horizontal lane per branch, with time running left to right. Branches that were
  merged and then deleted get their own lane, named from the merge message.
- **Commits:** dots coloured by author, with initials inside. Each shows its short hash and
  date/time; branch tips are labelled.
- **Connections:** continue, branch-off and merge. Merges are dashed.
- **Commit details:** author, time, full message, branches containing it, parents, PR number, and
  files changed (added/modified/deleted/renamed, with +/− lines).
- **Connection details:** what kind of connection it is and which branches it joins. Merges also
  show who merged, the PR, the commits brought in, and the files changed.
- **Refresh** pulls the latest snapshot from GitHub. New branches appear and deleted ones
  disappear.
- **One name per person**, however many git identities they used (see below).

## Setup

Requirements: [uv](https://docs.astral.sh/uv/), Node 25+, git.

1. Create `.env` in the repo root (see `.env.example`):
   ```
   GITHUB_PAT=<a GitHub token with read access to the repos you want to view>
   ```
   A fine-grained token with **Contents: Read** and **Metadata: Read** is enough. Only the backend
   reads it; it's never sent to the browser, written to disk or logged.
2. Optional: list your repositories in `repos.json` so the search box suggests them (copy
   `repos.example.json`). Each entry has a friendly name and a GitHub URL:
   ```json
   [
     { "name": "Payments API", "url": "https://github.com/your-org/payments-api" },
     { "name": "Web app", "url": "https://github.com/your-org/web-app" }
   ]
   ```
   `repos.json` is git-ignored because it may list private or company repos. Edits show up on
   the next page reload.
3. Start everything:
   ```bash
   ./dev.sh
   ```
4. Open http://localhost:5173.

## Using it

| Control | What it does |
|---|---|
| Search box | Type part of a repo's name or URL to pick one from `repos.json` (↑/↓, Enter), or paste any GitHub URL |
| **Load** / **Refresh** | Fetch the latest branches and commits from GitHub |
| **Window** | Last 7, 14 or 30 days (default 30), or **All history**. Capped at the newest 2,000 commits. |
| **Show deleted** | Off by default. Deleted branches in the graph are always merged-then-deleted (a branch deleted without merging has no reachable commits, so it's never shown), so their work is already in the branch they merged into. Tick to show them anyway. |
| **Layout** / **Show merged** | Centered on default (default) or Top-down; show or fold merged branches. Both are remembered in the browser. |
| **Branch priority** | Optional, e.g. `main, stage, dev`. These branches come first (each followed by the branches made from it) and "own" shared commits. Use it if a commit shows up in an unexpected lane. It's remembered per repo. |
| Author chips | Click to highlight one person's commits |
| ☾ Dark / ☀ Light | Theme switch, top left. The app always opens light; your choice is remembered in the browser. |
| Graph | Scroll (or drag) to move through branches; pinch, ⌘ + scroll or +/− to zoom; click a dot or a line for details |
| **⌂ main** / branch names | In the branch column: jump to the default branch, or click any branch name to bring its lane to the top with its latest commit centred |
| Fit view (⤢) | Zooms to show everything, but never smaller than about 7 branches tall. In bigger repos it shows the newest commits and the lanes around them. |

## How branches are ordered

The branch column is arranged like a family tree. Each branch sits next to the branch it was
branched off from. **The most active branches sit closest:** work still in progress comes first,
and branches already merged back move further away, each group ordered by most recent activity.
Integration branches such as `dev` count as active. In the centered layout, the busiest branches
therefore surround the default branch. Branches of branches nest under
their own parent. Under each branch name, a second line says where it came from, e.g.
"↓ from main": the arrow points to that branch's row (hidden when zoomed far out; in the Top-down
layout names are also indented by level). The branch priority list and then the default branch come
first; branches whose starting point is older than the time window come last.

**Merged branches fold away.** A branch that's already merged (merged and deleted, or fully merged
into another branch) is folded into one hatched "N merged branches" row at the top. Its commits
are still shown there, smaller. Click that row or tick **Show merged** to expand them. These never
fold:
- the default branch and your priority branches
- branches that receive merges from other branches (like `dev`)
- anything not merged yet, however old: those are the branches to notice

**Layout.** By default the graph is **centered on the default branch**: `main` sits in the middle,
with its branch families alternating above and below it (newest nearest). The first view and Fit
view keep `main` mid-screen. **Top-down** (default branch first, families stacked below) is available
in the Layout selector.

## Zooming the time axis

When you zoom out, **straight stretches of commits collapse into blobs** (e.g. "● 12") and the time
axis shrinks with them. Zoom back in and they expand into individual commits again. It happens
gradually:

| Zoom | What collapses |
|---|---|
| Close | Nothing, every commit is shown |
| A bit out | Stretches of 8+ commits |
| Further out | Stretches of 4+ |
| Far out | Stretches of 2+ |

Only commits that don't affect the graph's shape collapse. These always stay visible:
- where a branch starts or ends
- any branch-off or merge
- branch tips
- commits whose parent is outside the window
- the selected commit

A blob holds only one person's consecutive commits on one branch, so colours still show who did
what. The same commit stays under the centre of the screen as blobs open and close. **Click a blob**
to zoom in just far enough to open it; the details panel lists its commits.

## One name per person

People often commit under several identities without meaning to. Examples: a work email, a
personal email, a laptop with git's default "Your Name", or the private
`…@users.noreply.github.com` address GitHub uses for merges made on its website. The app shows
each person once. Two identities count as the same person if any of these links them:

1. **The same GitHub account.** On each sync the app asks GitHub which account each new email
   belongs to (one batched lookup, cached in `.cache/identities/`).
2. **The same email.**
3. **The same full name**, meaning at least two words. Placeholders like "Your Name" are ignored.
4. **A manual merge** under **People…** in the app, for anyone still showing up twice.

Links chain together: if an identity shares any of these with another, they merge. The name shown
is the person's GitHub profile name, or their most-used real name if the profile has none.

## How lanes are inferred

Git doesn't record which branch a commit was made on. Each branch claims the commits along its
first-parent chain, and shared history goes to whichever branch claims it first. The claim order
is:

1. your branch priority
2. the default branch
3. branches with the most merge commits, since integration branches collect merges

## Development

```bash
cd backend && uv run pytest && uv run ruff check .    # backend tests + lint
cd frontend && npm test && npm run build && npm run lint   # unit tests, type-check, build, lint
```

- `backend/` is a FastAPI app. It keeps bare repo clones and GitHub identity lookups in
  `~/.cache/team-git-visualizer/`, outside the project, so cloud-synced folders like OneDrive don't
  upload them. Override with `CACHE_DIR` / `IDENTITY_DIR`.
- `frontend/` is React + Vite + React Flow. Vite proxies `/api` to the backend on :8000.
