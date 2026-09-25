"""Build the commit graph for the frontend: lanes, positioned commit nodes and edges."""

from pathlib import Path

from app.gitlog import RawCommit, read_log
from app.lanes import assign_lanes, display_order
from app.models import (
    AuthorStat,
    EdgeKind,
    Graph,
    GraphEdge,
    GraphNode,
    GraphSummary,
    Lane,
)
from app.sync import list_branches, read_default_branch, read_fetched_at


def author_stats(commits: list[RawCommit]) -> tuple[list[AuthorStat], dict[str, int]]:
    """Commit count per author (by email), most active first, plus email → index lookup."""
    stats: dict[str, AuthorStat] = {}
    for commit in commits:  # newest first, so the display name is the most recent one
        key = commit.author_email.lower()
        if key not in stats:
            stats[key] = AuthorStat(
                name=commit.author_name, email=commit.author_email, commit_count=0
            )
        stats[key].commit_count += 1
    ordered = sorted(stats.items(), key=lambda item: (-item[1].commit_count, item[1].name.lower()))
    index_of = {key: index for index, (key, _) in enumerate(ordered)}
    return [stat for _, stat in ordered], index_of


def build_edges(commits: list[RawCommit], lane_of: dict[str, int]) -> list[GraphEdge]:
    edges = []
    for commit in commits:
        for parent_index, parent in enumerate(commit.parents):
            if parent not in lane_of:
                continue  # parent is outside the time window
            kind: EdgeKind
            if parent_index > 0:
                kind = "merge"
            elif lane_of[parent] == lane_of[commit.sha]:
                kind = "continue"
            else:
                kind = "branch-off"
            edges.append(
                GraphEdge(
                    id=f"{parent}-{commit.sha}",
                    source=parent,
                    target=commit.sha,
                    kind=kind,
                    parent_index=parent_index,
                )
            )
    return edges


def build_graph(
    path: Path,
    repo_key: str,
    days: int | None,
    max_commits: int,
    priority: list[str],
) -> Graph:
    """Graph of all branches' commits in the last `days` days (None = all history)."""
    branches = list_branches(path)
    default_branch = read_default_branch(path, branches)
    commits: list[RawCommit] = []
    if branches:
        args = ["--branches", "--date-order", f"--max-count={max_commits + 1}"]
        if days:
            args.append(f"--since={days}.days.ago")
        commits = read_log(path, args)
    truncated = len(commits) > max_commits
    commits = commits[:max_commits]

    tips = {branch.name: branch.tip_sha for branch in branches}
    assignments, lane_index = assign_lanes(commits, tips, default_branch, priority)
    x_of = {commit.sha: len(commits) - 1 - rank for rank, commit in enumerate(commits)}
    order = display_order(assignments, x_of, priority)
    lane_id = {index: position for position, index in enumerate(order)}
    lane_of = {sha: lane_id[index] for sha, index in lane_index.items()}

    refs: dict[str, list[str]] = {}
    for branch in branches:
        refs.setdefault(branch.tip_sha, []).append(branch.name)
    authors, author_index = author_stats(commits)

    nodes = [
        GraphNode(
            sha=commit.sha,
            short_sha=commit.sha[:7],
            lane=lane_of[commit.sha],
            x=x_of[commit.sha],
            author_index=author_index[commit.author_email.lower()],
            author_name=commit.author_name,
            author_email=commit.author_email,
            authored_at=commit.authored_at,
            committed_at=commit.committed_at,
            subject=commit.subject,
            is_merge=commit.is_merge,
            refs=refs.get(commit.sha, []),
            hidden_parent_count=sum(1 for parent in commit.parents if parent not in lane_of),
        )
        for commit in reversed(commits)
    ]
    lanes = [
        Lane(
            id=lane_id[index],
            name=assignments[index].name,
            kind=assignments[index].kind,
            commit_count=len(assignments[index].shas),
        )
        for index in order
    ]
    edges = build_edges(commits, lane_of)

    return Graph(
        repo=repo_key,
        default_branch=default_branch,
        fetched_at=read_fetched_at(path),
        days=days,
        truncated=truncated,
        lanes=lanes,
        nodes=nodes,
        edges=edges,
        authors=authors,
        summary=GraphSummary(
            commit_count=len(commits),
            merge_count=sum(1 for commit in commits if commit.is_merge),
            branch_count=len(branches),
            lane_count=len(lanes),
        ),
    )
