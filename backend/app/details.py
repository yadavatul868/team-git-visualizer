"""Details for a single commit (node) or a single parent → child connection (edge)."""

import re
from datetime import datetime
from pathlib import Path

from app.git_runner import GitError, run_git
from app.gitlog import FIELD_SEP, find_pr_number, parse_merge_message, read_log, to_commit_ref
from app.models import CommitDetails, CommitRef, EdgeDetails, FileChange
from app.sync import RepoRef

SHA_RE = re.compile(r"^[0-9a-fA-F]{4,40}$")
MAX_FILES = 500
MAX_BROUGHT_IN = 50
DETAIL_FORMAT = "%x1f".join(["%H", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%B"])


class CommitNotFoundError(LookupError):
    """No such commit in the synced repo."""


class EdgeNotFoundError(LookupError):
    """The two commits aren't directly connected (source isn't a parent of target)."""


def resolve_commit(path: Path, sha: str) -> str:
    if not SHA_RE.match(sha):
        raise CommitNotFoundError(f"'{sha}' is not a commit hash")
    try:
        return run_git(["rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}"], cwd=path).strip()
    except GitError:
        raise CommitNotFoundError(f"Commit {sha} not found. Try Refresh.") from None


def read_commit_refs(path: Path, shas: list[str]) -> list[CommitRef]:
    if not shas:
        return []
    return [to_commit_ref(commit) for commit in read_log(path, ["--no-walk=unsorted", *shas])]


def _parse_name_status(output: str) -> list[tuple[str, str | None, str]]:
    """`--name-status -z` → [(status letter, old path for renames/copies, path)]."""
    tokens = output.split("\0")
    changes = []
    i = 0
    while i < len(tokens) and tokens[i]:
        status = tokens[i][0]
        if status in "RC":
            changes.append((status, tokens[i + 1], tokens[i + 2]))
            i += 3
        else:
            changes.append((status, None, tokens[i + 1]))
            i += 2
    return changes


def _to_count(value: str) -> int | None:
    return None if value == "-" else int(value)  # "-" marks binary files


def _parse_numstat(output: str) -> dict[str, tuple[int | None, int | None]]:
    """`--numstat -z` → {path: (additions, deletions)}."""
    tokens = output.split("\0")
    counts = {}
    i = 0
    while i < len(tokens) and tokens[i]:
        added, deleted, path = tokens[i].split("\t", 2)
        if path:
            i += 1
        else:  # rename/copy: the old and new paths follow as separate tokens
            path = tokens[i + 2]
            i += 3
        counts[path] = (_to_count(added), _to_count(deleted))
    return counts


def diff_files(path: Path, base: str | None, target: str) -> tuple[list[FileChange], bool]:
    """Files changed from `base` to `target` (from the empty tree when base is None)."""
    revs = [base, target] if base else ["--root", target]
    common = ["diff-tree", "-r", "-M", "-z", "--no-commit-id"]
    statuses = _parse_name_status(run_git([*common, "--name-status", *revs], cwd=path))
    counts = _parse_numstat(run_git([*common, "--numstat", *revs], cwd=path))
    files = [
        FileChange(
            path=new_path,
            old_path=old_path,
            status=status,
            additions=counts.get(new_path, (None, None))[0],
            deletions=counts.get(new_path, (None, None))[1],
        )
        for status, old_path, new_path in statuses
    ]
    return files[:MAX_FILES], len(files) > MAX_FILES


def _parents_of(path: Path, sha: str) -> list[str]:
    return run_git(["rev-list", "--parents", "--max-count=1", sha], cwd=path).split()[1:]


def commit_details(path: Path, ref: RepoRef, sha: str) -> CommitDetails:
    """Everything about one commit. For merges, files are compared to the first parent."""
    full_sha = resolve_commit(path, sha)
    output = run_git(["show", "--no-patch", f"--format={DETAIL_FORMAT}", full_sha], cwd=path)
    (_, parents, author_name, author_email, authored_at, committer_name, committer_email,
     committed_at, message) = output.split(FIELD_SEP, 8)  # fmt: skip
    message = message.strip()
    parent_shas = parents.split()
    subject = message.split("\n", 1)[0]
    is_merge = len(parent_shas) > 1
    files, files_truncated = diff_files(path, parent_shas[0] if parent_shas else None, full_sha)
    branches = run_git(
        ["for-each-ref", f"--contains={full_sha}", "--format=%(refname:short)", "refs/heads"],
        cwd=path,
    ).split()

    return CommitDetails(
        sha=full_sha,
        short_sha=full_sha[:7],
        author_name=author_name,
        author_email=author_email,
        authored_at=authored_at,
        committer_name=committer_name,
        committer_email=committer_email,
        committed_at=committed_at,
        message=message,
        parents=read_commit_refs(path, parent_shas),
        branches=branches,
        is_merge=is_merge,
        merged_branch=parse_merge_message(subject)[0] if is_merge else None,
        pr_number=find_pr_number(subject),
        files=files,
        files_truncated=files_truncated,
        url=f"{ref.web_url}/commit/{full_sha}",
    )


def edge_details(path: Path, ref: RepoRef, source: str, target: str) -> EdgeDetails:
    """Details of the connection from parent `source` to child `target`.

    For a merge edge (source is a non-first parent), also reports who merged, how many
    commits the merge brought in, and the files it changed on the receiving branch.
    """
    source_sha = resolve_commit(path, source)
    target_sha = resolve_commit(path, target)
    target_parents = _parents_of(path, target_sha)
    if source_sha not in target_parents:
        raise EdgeNotFoundError(f"{source_sha[:7]} is not a parent of {target_sha[:7]}")
    parent_index = target_parents.index(source_sha)
    source_ref, target_ref = read_commit_refs(path, [source_sha, target_sha])
    time_gap = datetime.fromisoformat(target_ref.committed_at) - datetime.fromisoformat(
        source_ref.committed_at
    )

    is_merge = parent_index > 0
    merged_branch = pr_number = commits_brought_in = None
    brought_in: list[CommitRef] = []
    if is_merge:
        first_parent = target_parents[0]
        merged_branch, pr_number = parse_merge_message(target_ref.subject)
        commit_range = f"{first_parent}..{source_sha}"
        commits_brought_in = int(run_git(["rev-list", "--count", commit_range], cwd=path))
        brought_in = [
            to_commit_ref(commit)
            for commit in read_log(path, [f"--max-count={MAX_BROUGHT_IN}", commit_range])
        ]
        files, files_truncated = diff_files(path, first_parent, target_sha)
    else:
        files, files_truncated = diff_files(path, source_sha, target_sha)

    return EdgeDetails(
        source=source_ref,
        target=target_ref,
        parent_index=parent_index,
        is_merge=is_merge,
        time_gap_seconds=int(time_gap.total_seconds()),
        merged_by_name=target_ref.author_name if is_merge else None,
        merged_by_email=target_ref.author_email if is_merge else None,
        merged_branch=merged_branch,
        pr_number=pr_number,
        commits_brought_in=commits_brought_in,
        brought_in=brought_in,
        files=files,
        files_truncated=files_truncated,
        url=f"{ref.web_url}/commit/{target_sha}",
    )
