"""Read commits from `git log` and parse merge-commit messages."""

import re
from dataclasses import dataclass
from pathlib import Path

from app.git_runner import run_git
from app.identity import PeopleIndex
from app.models import CommitRef

FIELD_SEP = "\x1f"
RECORD_SEP = "\x1e"
LOG_FORMAT = "%x1f".join(["%H", "%P", "%an", "%ae", "%aI", "%cI", "%s"]) + "%x1e"

PR_MERGE_RE = re.compile(r"^Merge pull request #(?P<pr>\d+) from [^/\s]+/(?P<branch>\S+)")
BRANCH_MERGE_RE = re.compile(r"^Merge (?:remote-tracking )?branch '(?P<branch>[^']+)'")
SQUASH_PR_RE = re.compile(r"\(#(?P<pr>\d+)\)\s*$")


@dataclass(frozen=True)
class RawCommit:
    sha: str
    parents: tuple[str, ...]
    author_name: str
    author_email: str
    authored_at: str
    committed_at: str
    subject: str

    @property
    def is_merge(self) -> bool:
        return len(self.parents) > 1


def parse_log(output: str) -> list[RawCommit]:
    commits = []
    for record in output.split(RECORD_SEP):
        record = record.strip("\n")
        if not record:
            continue
        sha, parents, author_name, author_email, authored_at, committed_at, subject = record.split(
            FIELD_SEP, 6
        )
        commits.append(
            RawCommit(
                sha=sha,
                parents=tuple(parents.split()),
                author_name=author_name,
                author_email=author_email,
                authored_at=authored_at,
                committed_at=committed_at,
                subject=subject,
            )
        )
    return commits


def read_log(path: Path, args: list[str]) -> list[RawCommit]:
    return parse_log(run_git(["log", f"--format={LOG_FORMAT}", *args], cwd=path))


def to_commit_ref(commit: RawCommit, people: PeopleIndex) -> CommitRef:
    return CommitRef(
        sha=commit.sha,
        short_sha=commit.sha[:7],
        author=people.ref(commit.author_name, commit.author_email),
        author_name=commit.author_name,
        author_email=commit.author_email,
        authored_at=commit.authored_at,
        committed_at=commit.committed_at,
        subject=commit.subject,
    )


def parse_merge_message(subject: str) -> tuple[str | None, int | None]:
    """Return (merged branch name, PR number) from a merge commit's subject, when present."""
    if match := PR_MERGE_RE.match(subject):
        return match["branch"], int(match["pr"])
    if match := BRANCH_MERGE_RE.match(subject):
        return match["branch"].removeprefix("origin/"), None
    return None, None


def find_pr_number(subject: str) -> int | None:
    """PR number from a GitHub merge message or a squash-merge subject like `Fix (#12)`."""
    _, pr_number = parse_merge_message(subject)
    if pr_number is None and (match := SQUASH_PR_RE.search(subject)):
        pr_number = int(match["pr"])
    return pr_number
