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
2. Start everything:
   ```bash
   ./dev.sh
   ```
3. Open http://localhost:5173.

## Using it

| Control | What it does |
|---|---|
| **Load** / **Refresh** | Fetch the latest branches and commits from GitHub |
| **Window** | Last 7 / 30 / 90 days, or all history (capped at the newest 2,000 commits) |
| **Branch priority** | Optional, e.g. `main, stage, dev`. These branches get the top lanes and "own" shared commits. Use it if a commit shows up in an unexpected lane. It's remembered per repo. |
| Author chips | Click to highlight one person's commits |
| Graph | Scroll to zoom, drag to pan, click a dot or a line for details |

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
cd frontend && npm run build && npm run lint          # type-check, build, lint
```

- `backend/` is a FastAPI app. It keeps bare clones in `.cache/repos/` (git-ignored).
- `frontend/` is React + Vite + React Flow. Vite proxies `/api` to the backend on :8000.
- The plan and progress are in `tasks/todo.md`.
