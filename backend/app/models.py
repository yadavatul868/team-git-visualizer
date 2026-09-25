"""API request and response models."""

from typing import Literal

from pydantic import BaseModel

LaneKind = Literal["default", "branch", "deleted", "unlabelled"]
EdgeKind = Literal["continue", "branch-off", "merge"]


class SyncRequest(BaseModel):
    url: str


class RepoSuggestion(BaseModel):
    """A repository offered as a suggestion in the search box (from repos.json)."""

    name: str
    url: str


class BranchInfo(BaseModel):
    name: str
    tip_sha: str
    last_commit_at: str
    last_author_name: str


class RepoSnapshot(BaseModel):
    repo: str
    url: str
    default_branch: str | None
    fetched_at: str | None
    branches: list[BranchInfo]


class PersonRef(BaseModel):
    """One real person, however many git identities they used."""

    key: str
    name: str
    login: str | None


class Identity(BaseModel):
    name: str
    email: str
    commit_count: int


class Person(PersonRef):
    commit_count: int
    manually_linked: bool
    identities: list[Identity]


class LinkRequest(BaseModel):
    repo: str
    email: str
    target_email: str


class UnlinkRequest(BaseModel):
    repo: str
    key: str


class CommitRef(BaseModel):
    sha: str
    short_sha: str
    author: PersonRef
    author_name: str
    author_email: str
    authored_at: str
    committed_at: str
    subject: str


class Lane(BaseModel):
    id: int
    name: str
    kind: LaneKind
    commit_count: int


class GraphNode(BaseModel):
    sha: str
    short_sha: str
    lane: int
    x: int
    author: PersonRef
    author_name: str
    author_email: str
    authored_at: str
    committed_at: str
    subject: str
    is_merge: bool
    refs: list[str]
    hidden_parent_count: int


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    kind: EdgeKind
    parent_index: int


class AuthorStat(PersonRef):
    commit_count: int


class GraphSummary(BaseModel):
    commit_count: int
    merge_count: int
    branch_count: int
    lane_count: int


class Graph(BaseModel):
    repo: str
    default_branch: str | None
    fetched_at: str | None
    days: int | None
    truncated: bool
    lanes: list[Lane]
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    authors: list[AuthorStat]
    summary: GraphSummary


class FileChange(BaseModel):
    path: str
    old_path: str | None
    status: str
    additions: int | None
    deletions: int | None


class CommitDetails(BaseModel):
    sha: str
    short_sha: str
    author: PersonRef
    author_name: str
    author_email: str
    authored_at: str
    committer_name: str
    committer_email: str
    committed_at: str
    message: str
    parents: list[CommitRef]
    branches: list[str]
    is_merge: bool
    merged_branch: str | None
    pr_number: int | None
    files: list[FileChange]
    files_truncated: bool
    url: str


class EdgeDetails(BaseModel):
    source: CommitRef
    target: CommitRef
    parent_index: int
    is_merge: bool
    time_gap_seconds: int
    merged_by: PersonRef | None
    merged_branch: str | None
    pr_number: int | None
    commits_brought_in: int | None
    brought_in: list[CommitRef]
    files: list[FileChange]
    files_truncated: bool
    url: str
