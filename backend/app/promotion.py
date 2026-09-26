"""Find the long-lived branches (the "spine", e.g. main ← stage ← dev) and their promotion
order, without hard-coding any branch names.

Evidence of "branch X merges into branch Y" comes from three places, strongest first:
1. Merged pull requests from the GitHub API (head → base), fetched at sync time and cached.
2. Merge commit messages naming both sides, e.g. "Merge branch 'dev' into stage", across all
   history.
3. Merges inside the time window, whose target is the lane the merge commit sits on.

A live branch is long-lived when it is:
- the default branch, or in the user's branch priority list; or
- a promotion step: it merges into a long-lived branch *and* receives merges from some other
  branch (stage: dev → stage → main; then dev: features → dev → stage).
Not long-lived:
- a feature branch that only syncs from its base and merges back into it (it gives to and
  takes from the same branch);
- a big feature branch that collects stacked PRs but never merges onward into the chain.
Promotion order follows the merges: main ← stage ← dev puts stage one step from main and dev
two steps.
"""

import json
import logging
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.git_runner import run_git

log = logging.getLogger(__name__)

PR_PAGES = 10  # up to 1,000 merged PRs on the first sync; later syncs stop at known ones
TARGETED_MERGE_RE = re.compile(
    r"^Merge (?:remote-tracking )?branch '(?P<source>[^']+)'(?: of \S+)? into (?P<target>\S+)"
)


@dataclass(frozen=True)
class Flow:
    """One merge: work from `source` landed on `target`."""

    source: str
    target: str


# ---------- evidence 1: merged pull requests (GitHub API) ----------


def pull_request_file(repo_path: Path) -> Path:
    """Cached merged-PR flows, stored next to the repo clone."""
    return repo_path.with_name(repo_path.name.removesuffix(".git") + ".pull-requests.json")


def load_pull_request_flows(repo_path: Path) -> dict[str, Flow]:
    """Merge commit sha → flow, from the cached PR list (empty if never fetched)."""
    try:
        raw = json.loads(pull_request_file(repo_path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return {
        entry["merge_sha"]: Flow(entry["head"], entry["base"])
        for entry in raw.values()
        if entry.get("merge_sha")
    }


def refresh_pull_requests(repo_path: Path, owner: str, name: str, token: str | None) -> None:
    """Fetch merged PRs (newest first) until one page brings nothing new. Never fails a sync."""
    if not token:
        return
    path = pull_request_file(repo_path)
    try:
        known: dict[str, dict[str, str]] = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        known = {}
    had_any = bool(known)
    try:
        for page in range(1, PR_PAGES + 1):
            response = httpx.get(
                f"https://api.github.com/repos/{owner}/{name}/pulls",
                params={
                    "state": "closed",
                    "sort": "updated",
                    "direction": "desc",
                    "per_page": 100,
                    "page": page,
                },
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                },
                timeout=30,
            )
            response.raise_for_status()
            pulls = response.json()
            new = 0
            for pull in pulls:
                number = str(pull["number"])
                if pull.get("merged_at") and number not in known:
                    known[number] = {
                        "head": pull["head"]["ref"],
                        "base": pull["base"]["ref"],
                        "merge_sha": pull.get("merge_commit_sha") or "",
                    }
                    new += 1
            if len(pulls) < 100 or (had_any and new == 0):
                break
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        log.warning("Pull request lookup failed for %s/%s: %s", owner, name, type(exc).__name__)
    path.write_text(json.dumps(known, indent=1, sort_keys=True))


# ---------- evidence 2: merge messages naming both branches ----------


def message_flows(repo_path: Path) -> dict[str, Flow]:
    """Merge commit sha → flow, for merges whose message names source and target."""
    output = run_git(["log", "--branches", "--merges", "--format=%H%x1f%s"], cwd=repo_path)
    flows: dict[str, Flow] = {}
    for line in output.splitlines():
        sha, _, subject = line.partition("\x1f")
        if match := TARGETED_MERGE_RE.match(subject):
            source = match["source"].removeprefix("origin/")
            flows[sha] = Flow(source, match["target"])
    return flows


# ---------- deciding the spine ----------


def spine_order(
    flows: list[Flow],
    live: set[str],
    default_branch: str | None,
    priority: list[str],
) -> list[str]:
    """Long-lived branches, in display order: priority list first (as given), then the default
    branch, then the rest by promotion distance from the default branch."""
    incoming: dict[str, Counter[str]] = {}
    outgoing: dict[str, Counter[str]] = {}
    for flow in flows:
        if flow.source == flow.target:
            continue
        incoming.setdefault(flow.target, Counter())[flow.source] += 1
        outgoing.setdefault(flow.source, Counter())[flow.target] += 1

    long_lived = {name for name in [default_branch, *priority] if name in live}
    changed = True
    while changed:
        changed = False
        for branch in sorted(live - long_lived):
            sources = incoming.get(branch, Counter())
            targets = outgoing.get(branch, Counter())
            promotes = any(
                source != target for target in targets if target in long_lived for source in sources
            )
            if promotes:
                long_lived.add(branch)
                changed = True

    # Promotion distance: how many merge steps a branch's work takes to reach the default branch.
    distance: dict[str, int] = {}
    frontier = [default_branch] if default_branch in long_lived else []
    for name in frontier:
        distance[name] = 0
    while frontier:
        next_frontier = []
        for target in frontier:
            for source in incoming.get(target, Counter()):
                if source in long_lived and source not in distance:
                    distance[source] = distance[target] + 1
                    next_frontier.append(source)
        frontier = next_frontier

    pinned = [name for name in dict.fromkeys(priority) if name in long_lived]
    rest = sorted(
        (name for name in long_lived if name not in pinned),
        key=lambda name: (name != default_branch, distance.get(name, 1_000), name),
    )
    return pinned + rest


# ---------- where a branch came from when that's older than the time window ----------


def first_parents(repo_path: Path) -> dict[str, str]:
    """Commit sha → first parent, across all branches' full history."""
    output = run_git(["log", "--branches", "--format=%H %P"], cwd=repo_path)
    parents: dict[str, str] = {}
    for line in output.splitlines():
        sha, *rest = line.split()
        if rest:
            parents[sha] = rest[0]
    return parents


def chain_owners(
    spine: list[str], tips: dict[str, str], parents: dict[str, str], limit: int = 20_000
) -> dict[str, str]:
    """Commit sha → the spine branch whose first-parent history it's on (earlier spine wins)."""
    owner: dict[str, str] = {}
    for name in spine:
        sha: str | None = tips.get(name)
        steps = 0
        while sha and sha not in owner and steps < limit:
            owner[sha] = name
            sha = parents.get(sha)
            steps += 1
    return owner


def base_branch(
    start: str, parents: dict[str, str], owners: dict[str, str], limit: int = 20_000
) -> str | None:
    """Walk back from `start` along first parents to the first commit on a spine branch."""
    sha: str | None = start
    steps = 0
    while sha and steps < limit:
        if sha in owners:
            return owners[sha]
        sha = parents.get(sha)
        steps += 1
    return None
