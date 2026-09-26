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


def lane_bases(
    lanes: list[LaneAssignment],
    x_of: dict[str, int],
    lane_of: dict[str, int],
    by_sha: dict[str, RawCommit],
) -> tuple[dict[int, int], dict[int, int]]:
    """For each lane: the lane it was branched off from (the lane holding the parent of its
    oldest commit) and where (the x of that parent commit). Lanes whose base is outside the
    time window are absent."""
    base: dict[int, int] = {}
    branched_at: dict[int, int] = {}
    for index, lane in enumerate(lanes):
        if not lane.shas:
            continue  # a long-lived branch with no commits in the window
        oldest = min(lane.shas, key=x_of.__getitem__)
        parents = by_sha[oldest].parents
        if parents and lane_of.get(parents[0], index) != index:
            base[index] = lane_of[parents[0]]
            branched_at[index] = x_of[parents[0]]
    return base, branched_at


def merged_lanes(
    lanes: list[LaneAssignment], tips: dict[str, str], commits: list[RawCommit]
) -> set[int]:
    """Lanes whose work has been merged into another branch (or merged and deleted).

    Merged means the branch tip is reachable from another branch *through a merge*; a branch
    that was merely branched off from (its tip is on the other branch's first-parent chain)
    doesn't count.
    """
    by_sha = {commit.sha: commit for commit in commits}
    ancestors = {name: _ancestors(tip, by_sha) for name, tip in tips.items()}
    first_parents = {name: set(first_parent_chain(tip, by_sha)) for name, tip in tips.items()}
    merged: set[int] = set()
    for index, lane in enumerate(lanes):
        tip = tips.get(lane.name)
        if lane.kind in ("deleted", "unlabelled") or (
            lane.kind == "branch"
            and tip in by_sha
            and any(
                tip in ancestors[other] and tip not in first_parents[other]
                for other in tips
                if other != lane.name
            )
        ):
            merged.add(index)
    return merged


def integration_lanes(
    lanes: list[LaneAssignment],
    base: dict[int, int],
    commits: list[RawCommit],
    lane_of: dict[str, int],
) -> set[int]:
    """Lanes that receive merges from anything other than the branch they came from (e.g. dev
    collecting feature branches). Syncing from your own base doesn't count."""
    by_sha = {commit.sha: commit for commit in commits}
    return {
        index
        for index, lane in enumerate(lanes)
        if any(
            lane_of.get(merged_parent) not in (None, base.get(index), index)
            for sha in lane.shas
            for merged_parent in by_sha[sha].parents[1:]
        )
    }


def display_order(
    lanes: list[LaneAssignment],
    x_of: dict[str, int],
    spine: list[int],
    base: dict[int, int],
    branched_at: dict[int, int],
    settled: set[int],
) -> tuple[list[int], dict[int, int]]:
    """Lane indices top to bottom, plus each nested lane's parent.

    The `spine` (long-lived branches, in promotion order) comes first as one block, so those
    branches always sit together. Then each spine branch's family: branches made from it, with
    the most active closest (in progress before `settled` merged-back ones, each group most
    recently active first); branches of branches nest under their own parent. Branches with no
    known base come last (again active first).
    """
    last_x = {
        index: max((x_of[sha] for sha in lane.shas), default=-1) for index, lane in enumerate(lanes)
    }

    def activity(index: int) -> tuple[bool, int, int]:
        return (index in settled, -last_x[index], -branched_at.get(index, -1))

    fixed_roots = list(dict.fromkeys(spine))

    children: dict[int, list[int]] = {}
    for index, parent_index in base.items():
        if index not in fixed_roots:
            children.setdefault(parent_index, []).append(index)
    for siblings in children.values():
        siblings.sort(key=activity)
    other_roots = sorted(
        (i for i in range(len(lanes)) if i not in fixed_roots and i not in base), key=activity
    )

    tree_parent = {i: p for i, p in base.items() if i not in fixed_roots}
    order: list[int] = list(fixed_roots)  # the spine, as one block
    placed: set[int] = set(fixed_roots)
    # Then each family, depth first (iteratively; repos can have hundreds of lanes).
    family_roots = [child for root in fixed_roots for child in children.get(root, [])]
    for root in [*family_roots, *other_roots, *range(len(lanes))]:
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
    order: list[int],
    tree_parent: dict[int, int],
    merged: set[int],
    integrating: set[int],
    protected: set[int],
) -> set[int]:
    """Lanes whose work is done and can be folded away: merged, not an integration branch
    themselves, and with only finished sub-branches. Unmerged branches are never finished,
    however old: they are the ones to notice. `protected` lanes (default and priority
    branches) are never finished."""
    children: dict[int, list[int]] = {}
    for index, parent_index in tree_parent.items():
        children.setdefault(parent_index, []).append(index)
    finished: set[int] = set()
    for index in reversed(order):  # children come after parents in `order`
        if (
            index not in protected
            and index in merged
            and index not in integrating
            and all(child in finished for child in children.get(index, []))
        ):
            finished.add(index)
    return finished
