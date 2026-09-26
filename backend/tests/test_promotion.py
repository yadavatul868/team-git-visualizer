from pathlib import Path
from typing import Any

import pytest

from app import promotion
from app.promotion import (
    Flow,
    load_pull_request_flows,
    message_flows,
    refresh_pull_requests,
    spine_order,
)

LIVE = {"main", "stage", "dev", "feat/a", "feat/b", "feat/c", "hotfix"}


def flows(*pairs: str) -> list[Flow]:
    return [Flow(*pair.split(">")) for pair in pairs]


def test_promotion_chain_without_names() -> None:
    history = flows(
        "feat/a>dev", "feat/b>dev", "feat/c>dev",  # dev collects features
        "dev>stage", "dev>stage",  # promotions
        "stage>main",
        "dev>feat/b",  # a sync from dev: not a promotion
    )  # fmt: skip
    assert spine_order(history, LIVE, "main", []) == ["main", "stage", "dev"]


def test_a_feature_that_syncs_and_merges_back_is_not_long_lived() -> None:
    history = flows("feat/a>dev", "feat/b>dev", "dev>feat/a", "dev>feat/a", "feat/a>dev")
    assert "feat/a" not in spine_order(history, LIVE, "main", [])


def test_a_branch_collecting_stacked_prs_but_never_merging_on_is_not_long_lived() -> None:
    history = flows(
        "feat/a>feat/big", "feat/b>feat/big", "main>feat/big", "dev>stage", "stage>main"
    )
    assert "feat/big" not in spine_order(history, LIVE | {"feat/big"}, "main", [])


def test_priority_order_comes_first() -> None:
    history = flows("feat/a>dev", "feat/b>dev", "dev>stage", "stage>main")
    assert spine_order(history, LIVE, "main", ["dev"]) == ["dev", "main", "stage"]


def test_chain_is_found_even_with_little_evidence() -> None:
    # One promotion each way and a single feature merge: still main ← stage ← dev.
    assert spine_order(flows("feat/a>dev", "dev>stage", "stage>main"), LIVE, "main", []) == [
        "main",
        "stage",
        "dev",
    ]


def test_unconnected_branches_are_ignored() -> None:
    assert spine_order(flows("feat/a>feat/b"), LIVE, "main", []) == ["main"]


def test_message_flows_read_both_names(cached_repo: Path) -> None:
    found = {(f.source, f.target) for f in message_flows(cached_repo).values()}
    assert ("dev", "stage") in found and ("stage", "main") in found
    assert ("feat/login", "dev") in found
    assert not any(target == "" for _, target in found)


class FakeResponse:
    def __init__(self, payload: list[dict[str, Any]]) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self) -> list[dict[str, Any]]:
        return self.payload


def pull(number: int, head: str, base: str, merged: bool = True) -> dict[str, Any]:
    return {
        "number": number,
        "merged_at": "2026-09-01T00:00:00Z" if merged else None,
        "head": {"ref": head},
        "base": {"ref": base},
        "merge_commit_sha": f"sha{number}",
    }


def test_pull_requests_are_fetched_cached_and_incremental(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo_path = tmp_path / "acme__demo.git"
    pages: list[list[dict[str, Any]]] = [
        [pull(3, "feat/x", "dev"), pull(2, "dev", "stage"), pull(1, "wip", "dev", merged=False)]
    ]
    calls: list[int] = []

    def fake_get(url: str, params: dict[str, Any], headers: dict[str, str], timeout: int) -> Any:
        calls.append(params["page"])
        assert headers["Authorization"] == "Bearer ghp_x"
        return FakeResponse(pages[0] if params["page"] == 1 else [])

    monkeypatch.setattr(promotion.httpx, "get", fake_get)
    refresh_pull_requests(repo_path, "acme", "demo", "ghp_x")
    assert load_pull_request_flows(repo_path) == {
        "sha3": Flow("feat/x", "dev"),
        "sha2": Flow("dev", "stage"),
    }  # the unmerged PR is ignored
    refresh_pull_requests(repo_path, "acme", "demo", None)  # no token: nothing fetched
    assert calls == [1]


def test_pull_request_errors_never_fail_a_sync(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def failing_get(*args: Any, **kwargs: Any) -> Any:
        raise promotion.httpx.ConnectError("offline")

    monkeypatch.setattr(promotion.httpx, "get", failing_get)
    refresh_pull_requests(tmp_path / "x.git", "acme", "demo", "ghp_x")
    assert load_pull_request_flows(tmp_path / "x.git") == {}
