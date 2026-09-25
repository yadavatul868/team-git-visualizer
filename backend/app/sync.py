"""Validate GitHub repo URLs and keep a local bare clone of each repo up to date."""

import re
import shutil
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.git_runner import GitError, run_git
from app.models import BranchInfo, RepoSnapshot

FETCH_TIMEOUT_S = 600.0
_OWNER = r"[A-Za-z0-9][A-Za-z0-9-]{0,38}"
_NAME = r"[A-Za-z0-9._-]{1,100}"
GITHUB_URL_RE = re.compile(
    rf"^https://github\.com/(?P<owner>{_OWNER})/(?P<name>{_NAME}?)(?:\.git)?/?$"
)
REPO_KEY_RE = re.compile(rf"^(?P<owner>{_OWNER})/(?P<name>{_NAME})$")
ACCESS_DENIED_HINTS = (
    "Authentication failed",
    "could not read Username",
    "Repository not found",
    "terminal prompts disabled",
    "The requested URL returned error: 403",
)
BRANCH_FORMAT = "%1f".join(
    ["%(refname:short)", "%(objectname)", "%(committerdate:iso-strict)", "%(authorname)"]
)


class InvalidRepoError(ValueError):
    """The URL or repo key isn't a valid GitHub repository reference."""


class RepoNotLoadedError(LookupError):
    """The repo hasn't been synced yet."""


class RepoAccessError(PermissionError):
    """GitHub refused access to the repo (bad token or no permission)."""


@dataclass(frozen=True)
class RepoRef:
    owner: str
    name: str

    @property
    def key(self) -> str:
        return f"{self.owner}/{self.name}"

    @property
    def web_url(self) -> str:
        return f"https://github.com/{self.key}"

    @property
    def remote_url(self) -> str:
        return f"{self.web_url}.git"

    def cache_path(self, cache_dir: Path) -> Path:
        return cache_dir / f"{self.owner.lower()}__{self.name.lower()}.git"


def _to_ref(match: re.Match[str] | None) -> RepoRef:
    if not match or match["name"] in {".", ".."}:
        raise InvalidRepoError("Enter a GitHub repo URL like https://github.com/owner/repo")
    return RepoRef(match["owner"], match["name"])


def parse_github_url(url: str) -> RepoRef:
    return _to_ref(GITHUB_URL_RE.match(url.strip()))


def parse_repo_key(key: str) -> RepoRef:
    return _to_ref(REPO_KEY_RE.match(key.strip()))


_locks: dict[Path, threading.Lock] = {}
_locks_guard = threading.Lock()


def _repo_lock(path: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(path, threading.Lock())


def _remote_default_branch(path: Path, token: str | None) -> str | None:
    output = run_git(["ls-remote", "--symref", "origin", "HEAD"], cwd=path, token=token)
    for line in output.splitlines():
        if line.startswith("ref: refs/heads/") and line.endswith("\tHEAD"):
            return line.removeprefix("ref: refs/heads/").removesuffix("\tHEAD")
    return None


def fetch_repo(path: Path, remote_url: str, token: str | None) -> None:
    """Create (first time) or update a bare copy of every branch of the remote at `path`.

    `--prune` drops branches deleted on the remote, so the copy is always a current snapshot.
    """
    is_new = not (path / "HEAD").exists()
    if is_new:
        path.parent.mkdir(parents=True, exist_ok=True)
        run_git(["init", "--bare", "--quiet", str(path)])
        run_git(["remote", "add", "origin", remote_url], cwd=path)
        # Mirror remote branches straight into refs/heads (no refs/remotes/origin/* copies).
        run_git(["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], cwd=path)
    try:
        run_git(
            ["fetch", "--prune", "--no-tags", "--quiet", "origin"],
            cwd=path,
            token=token,
            timeout=FETCH_TIMEOUT_S,
        )
        default_branch = _remote_default_branch(path, token)
    except GitError:
        if is_new:
            shutil.rmtree(path, ignore_errors=True)
        raise
    if default_branch:
        run_git(["symbolic-ref", "HEAD", f"refs/heads/{default_branch}"], cwd=path)
    fetched_at = datetime.now(UTC).isoformat(timespec="seconds")
    run_git(["config", "tgv.fetchedAt", fetched_at], cwd=path)


def list_branches(path: Path) -> list[BranchInfo]:
    """All branches, most recently committed first."""
    output = run_git(
        ["for-each-ref", "--sort=-committerdate", f"--format={BRANCH_FORMAT}", "refs/heads"],
        cwd=path,
    )
    branches = []
    for line in output.splitlines():
        name, tip_sha, last_commit_at, last_author_name = line.split("\x1f")
        branches.append(
            BranchInfo(
                name=name,
                tip_sha=tip_sha,
                last_commit_at=last_commit_at,
                last_author_name=last_author_name,
            )
        )
    return branches


def read_default_branch(path: Path, branches: list[BranchInfo]) -> str | None:
    try:
        name = run_git(["symbolic-ref", "--short", "HEAD"], cwd=path).strip()
    except GitError:
        return None
    return name if any(branch.name == name for branch in branches) else None


def read_fetched_at(path: Path) -> str | None:
    try:
        return run_git(["config", "--get", "tgv.fetchedAt"], cwd=path).strip() or None
    except GitError:
        return None


def read_snapshot(ref: RepoRef, path: Path) -> RepoSnapshot:
    branches = list_branches(path)
    return RepoSnapshot(
        repo=ref.key,
        url=ref.web_url,
        default_branch=read_default_branch(path, branches),
        fetched_at=read_fetched_at(path),
        branches=branches,
    )


def sync_repo(url: str, cache_dir: Path, token: str | None) -> RepoSnapshot:
    """Clone or refresh the repo at `url` and return its current branches."""
    ref = parse_github_url(url)
    path = ref.cache_path(cache_dir)
    with _repo_lock(path):
        try:
            fetch_repo(path, ref.remote_url, token)
        except GitError as exc:
            if any(hint in str(exc) for hint in ACCESS_DENIED_HINTS):
                raise RepoAccessError(
                    f"Couldn't access {ref.key}: it doesn't exist, or GITHUB_PAT in .env "
                    "isn't set or can't read it."
                ) from exc
            raise
        return read_snapshot(ref, path)


def open_cached_repo(key: str, cache_dir: Path) -> tuple[RepoRef, Path]:
    """Locate an already-synced repo by `owner/repo`."""
    ref = parse_repo_key(key)
    path = ref.cache_path(cache_dir)
    if not (path / "HEAD").exists():
        raise RepoNotLoadedError(f"{ref.key} hasn't been loaded yet. Load it first.")
    return ref, path
