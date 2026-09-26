"""Decide which lane (branch) each commit is drawn in.

Git doesn't record which branch a commit was made on, so it's inferred:

1. Branches claim the commits along their first-parent chains, one branch at a time.
   A commit shared by several branches goes to whichever claims it first.
2. Commits that are only reachable through a merge (typically from a branch that was
   merged and then deleted) get a lane named from the merge message.
"""

from dataclasses import dataclass, field

from app.gitlog import RawCommit, parse_merge_message
from app.models import LaneKind


@dataclass
class LaneAssignment:
    name: str
    kind: LaneKind
    shas: list[str] = field(default_factory=list)


def first_parent_chain(tip: str, by_sha: dict[str, RawCommit]) -> list[str]:
    chain = []
    sha: str | None = tip
    while sha is not None and sha in by_sha:
        chain.append(sha)
        parents = by_sha[sha].parents
        sha = parents[0] if parents else None
    return chain


def _ancestors(tip: str, by_sha: dict[str, RawCommit]) -> set[str]:
    seen: set[str] = set()
    stack = [tip]
    while stack:
        sha = stack.pop()
        if sha in seen or sha not in by_sha:
            continue
        seen.add(sha)
        stack.extend(by_sha[sha].parents)
    return seen


def claim_order(
    commits: list[RawCommit],
    tips: dict[str, str],
    default_branch: str | None,
    priority: list[str],
) -> list[str]:
    """Order in which branches claim shared history; earlier branches win.

    The user's priority list comes first, then the default branch. The rest are ranked by:
    most merge commits on their first-parent chain (integration branches collect merges),
    then how many other branches contain their tip, then most recent tip.
    """
    by_sha = {commit.sha: commit for commit in commits}
    newest_rank = {commit.sha: rank for rank, commit in enumerate(commits)}
    ancestors = {name: _ancestors(tip, by_sha) for name, tip in tips.items()}

    head = [name for name in dict.fromkeys(priority) if name in tips]
    if default_branch in tips and default_branch not in head:
        head.append(default_branch)

    def rank(name: str) -> tuple[int, int, int]:
        tip = tips[name]
        merges = sum(1 for sha in first_parent_chain(tip, by_sha) if by_sha[sha].is_merge)
        contained_in = sum(1 for other in tips if other != name and tip in ancestors[other])
        return (-merges, -contained_in, newest_rank.get(tip, len(commits)))

    rest = sorted((name for name in tips if name not in head), key=rank)
    return head + rest


def assign_lanes(
    commits: list[RawCommit],
    tips: dict[str, str],
    default_branch: str | None,
    priority: list[str],
) -> tuple[list[LaneAssignment], dict[str, int]]:
    """Assign every commit to a lane. `commits` must be newest first (as `git log` returns)."""
    by_sha = {commit.sha: commit for commit in commits}
    lanes: list[LaneAssignment] = []
    lane_of: dict[str, int] = {}
    lane_by_name: dict[str, int] = {}

    def open_lane(name: str, kind: LaneKind) -> int:
        lanes.append(LaneAssignment(name=name, kind=kind))
        return len(lanes) - 1

    def claim(tip: str, lane_id: int) -> None:
        for sha in first_parent_chain(tip, by_sha):
            if sha in lane_of:
                break
            lane_of[sha] = lane_id
            lanes[lane_id].shas.append(sha)

    for name in claim_order(commits, tips, default_branch, priority):
        tip = tips[name]
        if tip in by_sha and tip not in lane_of:
            lane_by_name[name] = open_lane(name, "default" if name == default_branch else "branch")
            claim(tip, lane_by_name[name])

    # Newest first, so each merge is handled before the commits it brought in.
    for commit in commits:
        if commit.sha not in lane_of:
            claim(commit.sha, open_lane("(unnamed branch)", "unlabelled"))
        merged_branch, _ = parse_merge_message(commit.subject)
        for parent in commit.parents[1:]:
            if parent not in by_sha or parent in lane_of:
                continue
            if merged_branch is None:
                lane_id = open_lane("(unnamed branch)", "unlabelled")
            elif merged_branch in lane_by_name:
                lane_id = lane_by_name[merged_branch]
            else:
                kind: LaneKind = "branch" if merged_branch in tips else "deleted"
                lane_id = lane_by_name[merged_branch] = open_lane(merged_branch, kind)
            claim(parent, lane_id)

    return lanes, lane_of


def display_order(
    lanes: list[LaneAssignment],
    x_of: dict[str, int],
    priority: list[str],
    lane_of: dict[str, int],
    by_sha: dict[str, RawCommit],
) -> tuple[list[int], dict[int, int]]:
    """Lane indices top to bottom, arranged as a family tree, plus each nested lane's parent.

    Each branch sits directly below the branch it was branched off from (the lane holding the
    parent of its oldest commit), most recently branched first, so new work stays next to its
    base. Branches of branches nest under their own parent. Roots, in order: the user's
    priority branches, the default branch, then branches whose base is outside the time
    window (oldest first).
    """
    first_x = {index: min(x_of[sha] for sha in lane.shas) for index, lane in enumerate(lanes)}
    parent: dict[int, int] = {}
    branched_at: dict[int, int] = {}
    for index, lane in enumerate(lanes):
        oldest = min(lane.shas, key=x_of.__getitem__)
        parents = by_sha[oldest].parents
        if parents and lane_of.get(parents[0], index) != index:
            parent[index] = lane_of[parents[0]]
            branched_at[index] = x_of[parents[0]]

    pinned = [
        index
        for name in dict.fromkeys(priority)
        for index, lane in enumerate(lanes)
        if lane.name == name and lane.kind in ("default", "branch")
    ]
    defaults = [i for i, lane in enumerate(lanes) if lane.kind == "default" and i not in pinned]
    fixed_roots = pinned + defaults

    children: dict[int, list[int]] = {}
    for index, parent_index in parent.items():
        if index not in fixed_roots:
            children.setdefault(parent_index, []).append(index)
    for siblings in children.values():
        siblings.sort(key=lambda i: (-branched_at[i], -first_x[i]))  # most recent first
    other_roots = sorted(
        (i for i in range(len(lanes)) if i not in fixed_roots and i not in parent),
        key=first_x.__getitem__,
    )

    tree_parent = {i: p for i, p in parent.items() if i not in fixed_roots}
    order: list[int] = []
    placed: set[int] = set()
    # Iterative depth-first walk (repos can have hundreds of lanes); every lane is placed once.
    for root in [*fixed_roots, *other_roots, *range(len(lanes))]:
        stack = [root]
        while stack:
            index = stack.pop()
            if index in placed:
                continue
            placed.add(index)
            order.append(index)
            stack.extend(reversed(children.get(index, [])))
    return order, tree_parent


def finished_lanes(
    lanes: list[LaneAssignment],
    order: list[int],
    tree_parent: dict[int, int],
    tips: dict[str, str],
    commits: list[RawCommit],
    lane_of: dict[str, int],
    protected: set[int],
) -> set[int]:
    """Lanes whose work is done and can be folded away: merged into another branch (or merged
    and deleted), not an integration branch themselves, and with only finished sub-branches.

    Merged means the branch tip is reachable from another branch *through a merge*; a branch
    that was merely branched off from (its tip is on the other branch's first-parent chain)
    doesn't count. Unmerged branches are never finished, however old: they are the ones to
    notice. `protected` lanes (default and priority branches) are never finished.
    """
    by_sha = {commit.sha: commit for commit in commits}
    ancestors = {name: _ancestors(tip, by_sha) for name, tip in tips.items()}
    first_parents = {name: set(first_parent_chain(tip, by_sha)) for name, tip in tips.items()}

    def merged(index: int) -> bool:
        lane = lanes[index]
        if lane.kind in ("deleted", "unlabelled"):
            return True
        tip = tips.get(lane.name)
        if lane.kind != "branch" or tip not in by_sha:
            return False
        return any(
            tip in ancestors[other] and tip not in first_parents[other]
            for other in tips
            if other != lane.name
        )

    def integrates(index: int) -> bool:
        """Receives merges from anything other than the branch it came from (e.g. dev)."""
        base = tree_parent.get(index)
        return any(
            lane_of.get(merged_parent) not in (None, base, index)
            for sha in lanes[index].shas
            for merged_parent in by_sha[sha].parents[1:]
        )

    children: dict[int, list[int]] = {}
    for index, parent_index in tree_parent.items():
        children.setdefault(parent_index, []).append(index)
    finished: set[int] = set()
    for index in reversed(order):  # children come after parents in `order`
        if (
            index not in protected
            and merged(index)
            and not integrates(index)
            and all(child in finished for child in children.get(index, []))
        ):
            finished.add(index)
    return finished
