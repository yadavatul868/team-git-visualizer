from pathlib import Path

import pytest

from app.gitlog import find_pr_number, parse_merge_message
from app.graph import build_graph
from app.identity import PeopleIndex
from app.models import Graph
from tests.conftest import RepoBuilder


def lane_subjects(graph: Graph) -> dict[str, list[str]]:
    """Lane name → subjects of its commits, oldest first."""
    names = {lane.id: lane.name for lane in graph.lanes}
    result: dict[str, list[str]] = {name: [] for name in names.values()}
    for node in graph.nodes:
        result[names[node.lane]].append(node.subject)
    return result


@pytest.fixture(scope="module")
def graph(cached_repo: Path, people: PeopleIndex) -> Graph:
    return build_graph(cached_repo, "acme/demo", None, 2000, priority=[], people=people)


@pytest.mark.parametrize(
    ("subject", "expected"),
    [
        ("Merge pull request #7 from acme/feat-old", ("feat-old", 7)),
        ("Merge pull request #12 from acme/feature/deep/name", ("feature/deep/name", 12)),
        ("Merge branch 'feat/login' into dev", ("feat/login", None)),
        ("Merge remote-tracking branch 'origin/dev' into feat/x", ("dev", None)),
        ("Merge branch 'hotfix'", ("hotfix", None)),
        ("Add search", (None, None)),
    ],
)
def test_parse_merge_message(subject: str, expected: tuple[str | None, int | None]) -> None:
    assert parse_merge_message(subject) == expected


def test_find_pr_number_handles_squash_merges() -> None:
    assert find_pr_number("Add report export (#12)") == 12
    assert find_pr_number("Merge pull request #7 from acme/feat-old") == 7
    assert find_pr_number("Fix issue #3 in parser") is None


def test_default_heuristic_puts_each_commit_on_its_branch(graph: Graph) -> None:
    assert lane_subjects(graph) == {
        "main": ["Initial commit", "Merge branch 'stage' into main"],
        "dev": [
            "Set up dev config",
            "Update config",
            "Merge branch 'feat/login' into dev",
            "Merge pull request #7 from acme/feat-old",
            "Add report export (#12)",
        ],
        "feat/login": ["Add login form", "Add login validation", "Move login into auth package"],
        "feat/search": ["Add search", "Merge branch 'dev' into feat/search", "Improve search"],
        "feat-old": ["Add old export", "Tweak export"],
        "stage": ["Merge branch 'dev' into stage"],
    }


def test_lanes_are_ordered_as_a_family_tree(graph: Graph) -> None:
    # main's children: stage (branched later) above dev; dev's children most recent first:
    # feat-old (from the login merge), then feat/search and feat/login (both from "Set up dev
    # config"; search's own work started later).
    assert [lane.name for lane in graph.lanes] == [
        "main", "stage", "dev", "feat-old", "feat/search", "feat/login"
    ]  # fmt: skip
    kinds = {lane.name: lane.kind for lane in graph.lanes}
    assert kinds["main"] == "default"
    assert kinds["feat-old"] == "deleted"
    assert kinds["dev"] == "branch"


def test_edge_kinds(graph: Graph, team_repo: RepoBuilder) -> None:
    kinds = {(edge.source, edge.target): edge.kind for edge in graph.edges}
    sha = team_repo.sha_of
    assert kinds[(sha("Initial commit"), sha("Set up dev config"))] == "branch-off"
    assert kinds[(sha("Set up dev config"), sha("Update config"))] == "continue"
    assert kinds[(sha("Tweak export"), sha("Merge pull request #7 from acme/feat-old"))] == "merge"
    assert kinds[(sha("Add report export (#12)"), sha("Merge branch 'dev' into feat/search"))] == (
        "merge"
    )
    assert len(graph.edges) == sum(len(node_parents) for node_parents in _parents(team_repo))


def _parents(team_repo: RepoBuilder) -> list[list[str]]:
    output = team_repo.git("log", "--all", "--format=%P")
    return [line.split() for line in output.splitlines()]


def test_nodes_are_positioned_oldest_to_newest(graph: Graph) -> None:
    assert [node.x for node in graph.nodes] == list(range(16))
    assert graph.nodes[0].subject == "Initial commit"
    assert graph.nodes[-1].subject == "Merge branch 'stage' into main"


def test_branch_tips_are_labelled(graph: Graph) -> None:
    refs = {node.subject: node.refs for node in graph.nodes if node.refs}
    assert refs == {
        "Merge branch 'stage' into main": ["main"],
        "Merge branch 'dev' into stage": ["stage"],
        "Improve search": ["feat/search"],
        "Add report export (#12)": ["dev"],
        "Move login into auth package": ["feat/login"],
    }


def test_summary_and_author_counts(graph: Graph) -> None:
    assert graph.summary.commit_count == 16
    assert graph.summary.merge_count == 5
    assert graph.summary.branch_count == 5
    assert graph.default_branch == "main"
    # People, not identities: Bob's home email and Carol's web merge are folded in.
    assert [(author.name, author.commit_count) for author in graph.authors] == [
        ("Alice Admin", 7),
        ("Bob Builder", 4),
        ("Carol Coder", 4),
        ("Your Name", 1),
    ]
    merge = next(node for node in graph.nodes if node.subject.startswith("Merge pull request #7"))
    assert (merge.author.name, merge.author.key) == ("Carol Coder", "gh:carol-c")
    assert merge.author_name == "carol-c"  # the raw git identity is still available


def test_priority_overrides_who_owns_shared_history(cached_repo: Path, people: PeopleIndex) -> None:
    graph = build_graph(cached_repo, "acme/demo", None, 2000, ["feat/search"], people)
    lanes = lane_subjects(graph)
    assert graph.lanes[0].name == "feat/search"
    assert "Set up dev config" in lanes["feat/search"]


def test_truncation_keeps_the_newest_commits(cached_repo: Path, people: PeopleIndex) -> None:
    graph = build_graph(cached_repo, "acme/demo", None, 5, [], people)
    assert graph.truncated
    assert graph.summary.commit_count == 5
    assert graph.nodes[-1].subject == "Merge branch 'stage' into main"
    assert all(edge.source in {n.sha for n in graph.nodes} for edge in graph.edges)


def test_branches_sit_under_their_parent_most_recent_first() -> None:
    """dev ← feat-a (early) ← sub-a, and dev ← feat-b (later)."""
    from app.gitlog import RawCommit
    from app.lanes import assign_lanes, display_order

    def commit(sha: str, *parents: str) -> RawCommit:
        return RawCommit(sha, parents, "A", "a@x.com", "", "", sha)

    commits = [  # newest first, as git log returns
        commit("b1", "d2"),
        commit("s1", "a1"),
        commit("d2", "d1"),
        commit("a1", "d1"),
        commit("d1", "m0"),
        commit("m0"),
    ]
    tips = {"main": "m0", "dev": "d2", "feat-a": "a1", "feat-b": "b1", "sub-a": "s1"}
    lanes, lane_of = assign_lanes(commits, tips, "main", [])
    x_of = {c.sha: len(commits) - 1 - rank for rank, c in enumerate(commits)}
    by_sha = {c.sha: c for c in commits}
    order = display_order(lanes, x_of, [], lane_of, by_sha)
    assert [lanes[i].name for i in order] == ["main", "dev", "feat-b", "feat-a", "sub-a"]

    # A priority branch stays pinned at the top, with its own family below it.
    order = display_order(lanes, x_of, ["feat-a"], lane_of, by_sha)
    assert [lanes[i].name for i in order] == ["feat-a", "sub-a", "main", "dev", "feat-b"]
