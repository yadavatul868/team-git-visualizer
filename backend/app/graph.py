"""Build the commit graph for the frontend: lanes, positioned commit nodes and edges."""

from pathlib import Path

from app.gitlog import RawCommit, parse_merge_message, read_log
from app.identity import PeopleIndex
from app.lanes import (
    LaneAssignment,
    assign_lanes,
    display_order,
    finished_lanes,
    integration_lanes,
    lane_bases,
    merged_lanes,
)
from app.models import (
    AuthorStat,
    EdgeKind,
    Graph,
    GraphEdge,
    GraphNode,
    GraphSummary,
    Lane,
    LaneKind,
)
from app.promotion import (
    Flow,
    base_branch,
    chain_owners,
    first_parents,
    load_pull_request_flows,
    message_flows,
    spine_order,
)
from app.sync import list_branches, read_default_branch, read_fetched_at

_history_cache: dict[tuple[Path, str | None], tuple[dict[str, str], dict[str, Flow]]] = {}


def load_history(path: Path, fetched_at: str | None) -> tuple[dict[str, str], dict[str, Flow]]:
    """Full-history first parents and merge-message flows, cached until the next sync."""
    key = (path, fetched_at)
    if key not in _history_cache:
        for stale in [k for k in _history_cache if k[0] == path]:
            del _history_cache[stale]
        _history_cache[key] = (first_parents(path), message_flows(path))
    return _history_cache[key]


def window_flows(
    commits: list[RawCommit], lanes: list[LaneAssignment], lane_index: dict[str, int]
) -> dict[str, Flow]:
    """Merges inside the window: the target is the lane the merge commit sits on."""
    flows: dict[str, Flow] = {}
    for commit in commits:
        if not commit.is_merge or commit.sha not in lane_index:
            continue
        target = lanes[lane_index[commit.sha]]
        if target.kind not in ("default", "branch"):
            continue
        merged_name, _ = parse_merge_message(commit.subject)
        for parent in commit.parents[1:]:
            source = merged_name or (
                lanes[lane_index[parent]].name if parent in lane_index else None
            )
            if source:
                flows[commit.sha] = Flow(source, target.name)
    return flows


def author_stats(commits: list[RawCommit], people: PeopleIndex) -> list[AuthorStat]:
    """Commit count per person (not per git identity), most active first."""
    stats: dict[str, AuthorStat] = {}
    for commit in commits:
        person = people.ref(commit.author_name, commit.author_email)
        if person.key not in stats:
            stats[person.key] = AuthorStat(**person.model_dump(), commit_count=0)
        stats[person.key].commit_count += 1
    return sorted(stats.values(), key=lambda stat: (-stat.commit_count, stat.name.lower()))


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
    people: PeopleIndex,
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
    x_of = {commit.sha: len(commits) - 1 - rank for rank, commit in enumerate(commits)}
    by_sha = {commit.sha: commit for commit in commits}

    # Long-lived branches (the spine), from merge evidence across history (see promotion.py).
    # A first lane pass gives the merges inside the window; then the spine claims history first.
    parents_full, history_flows = load_history(path, read_fetched_at(path))
    first_pass, first_index = assign_lanes(commits, tips, default_branch, priority)
    flows = {
        **history_flows,
        **window_flows(commits, first_pass, first_index),
        **load_pull_request_flows(path),
    }
    spine_names = spine_order(list(flows.values()), set(tips), default_branch, priority)
    assignments, lane_index = assign_lanes(commits, tips, default_branch, spine_names)
    # Spine branches always get a lane, even with no commits in the window.
    named = {lane.name for lane in assignments if lane.kind in ("default", "branch")}
    for name in spine_names:
        if name not in named:
            kind: LaneKind = "default" if name == default_branch else "branch"
            assignments.append(LaneAssignment(name=name, kind=kind))
    spine = [
        index
        for name in spine_names
        for index, lane in enumerate(assignments)
        if lane.name == name and lane.kind in ("default", "branch")
    ]

    base, branched_at = lane_bases(assignments, x_of, lane_index, by_sha)
    # Branches that started before the window: follow full history back to the spine branch
    # they came from.
    owners = chain_owners(spine_names, tips, parents_full)
    spine_index = {assignments[index].name: index for index in spine}
    for index, lane in enumerate(assignments):
        if index in base or index in spine or not lane.shas:
            continue
        oldest = min(lane.shas, key=x_of.__getitem__)
        start = parents_full.get(oldest)
        origin = base_branch(start, parents_full, owners) if start else None
        if origin in spine_index:
            base[index] = spine_index[origin]

    merged = merged_lanes(assignments, tips, commits)
    integrating = integration_lanes(assignments, base, commits, lane_index)
    # Merged-back branches move away from their parent; active work stays closest.
    order, tree_parent = display_order(
        assignments, x_of, spine, base, branched_at, settled=merged - integrating
    )
    lane_id = {index: position for position, index in enumerate(order)}
    finished = finished_lanes(order, tree_parent, merged, integrating, protected=set(spine))
    last_commit_at = {branch.name: branch.last_commit_at for branch in branches}

    def depth(index: int) -> int:
        level = 0
        while index in tree_parent:
            index = tree_parent[index]
            level += 1
        return level

    lane_of = {sha: lane_id[index] for sha, index in lane_index.items()}

    refs: dict[str, list[str]] = {}
    for branch in branches:
        refs.setdefault(branch.tip_sha, []).append(branch.name)
    authors = author_stats(commits, people)

    nodes = [
        GraphNode(
            sha=commit.sha,
            short_sha=commit.sha[:7],
            lane=lane_of[commit.sha],
            x=x_of[commit.sha],
            author=people.ref(commit.author_name, commit.author_email),
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
            parent=lane_id[tree_parent[index]] if index in tree_parent else None,
            depth=depth(index),
            finished=index in finished,
            long_lived=index in spine,
            last_commit_at=(
                last_commit_at.get(assignments[index].name)
                if assignments[index].kind in ("default", "branch")
                else None
            ),
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
