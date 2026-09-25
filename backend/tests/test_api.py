from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings, get_settings
from app.main import app
from tests.conftest import RepoBuilder


@pytest.fixture
def client(cache_dir: Path) -> Iterator[TestClient]:
    settings = Settings(_env_file=None, github_pat=SecretStr(""), cache_dir=cache_dir)
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_health_reports_missing_token(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok", "token_configured": False}


def test_sync_rejects_non_github_urls(client: TestClient) -> None:
    response = client.post("/api/repo/sync", json={"url": "https://example.com/a/b"})
    assert response.status_code == 400


def test_graph_requires_a_loaded_repo(client: TestClient) -> None:
    assert client.get("/api/graph", params={"repo": "acme/unknown"}).status_code == 404


def test_graph(client: TestClient) -> None:
    response = client.get("/api/graph", params={"repo": "acme/demo", "days": 0})
    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["commit_count"] == 16
    assert body["lanes"][0]["name"] == "main"


def test_graph_priority_param(client: TestClient) -> None:
    params = {"repo": "acme/demo", "days": 0, "priority": " dev , main "}
    lanes = client.get("/api/graph", params=params).json()["lanes"]
    assert [lane["name"] for lane in lanes[:2]] == ["dev", "main"]


def test_commit_details_with_rename(client: TestClient, team_repo: RepoBuilder) -> None:
    sha = team_repo.sha_of("Move login into auth package")
    body = client.get(f"/api/commit/{sha[:10]}", params={"repo": "acme/demo"}).json()
    assert body["sha"] == sha
    assert body["author_name"] == "Bob Builder"
    assert body["files"] == [
        {
            "path": "auth/login.py",
            "old_path": "login.py",
            "status": "R",
            "additions": 0,
            "deletions": 0,
        }
    ]
    assert set(body["branches"]) == {"main", "stage", "dev", "feat/login", "feat/search"}
    assert body["url"] == f"https://github.com/acme/demo/commit/{sha}"


def test_commit_details_for_root_and_delete(client: TestClient, team_repo: RepoBuilder) -> None:
    root = client.get(
        f"/api/commit/{team_repo.sha_of('Initial commit')}", params={"repo": "acme/demo"}
    ).json()
    assert root["parents"] == []
    assert root["files"][0] == {
        "path": "README.md", "old_path": None, "status": "A", "additions": 1, "deletions": 0
    }  # fmt: skip

    improve = client.get(
        f"/api/commit/{team_repo.sha_of('Improve search')}", params={"repo": "acme/demo"}
    ).json()
    statuses = {file["path"]: file["status"] for file in improve["files"]}
    assert statuses == {"config.py": "D", "search.py": "M"}


def test_commit_details_for_merge(client: TestClient, team_repo: RepoBuilder) -> None:
    sha = team_repo.sha_of("Merge pull request #7 from acme/feat-old")
    body = client.get(f"/api/commit/{sha}", params={"repo": "acme/demo"}).json()
    assert body["is_merge"] is True
    assert body["merged_branch"] == "feat-old"
    assert body["pr_number"] == 7
    assert len(body["parents"]) == 2
    assert [file["path"] for file in body["files"]] == ["export.py"]


def test_unknown_or_invalid_commit_is_404(client: TestClient) -> None:
    assert client.get("/api/commit/deadbeef", params={"repo": "acme/demo"}).status_code == 404
    assert client.get("/api/commit/--all", params={"repo": "acme/demo"}).status_code == 404


def test_merge_edge_details(client: TestClient, team_repo: RepoBuilder) -> None:
    params = {
        "repo": "acme/demo",
        "source": team_repo.sha_of("Tweak export"),
        "target": team_repo.sha_of("Merge pull request #7 from acme/feat-old"),
    }
    body = client.get("/api/edge", params=params).json()
    assert body["is_merge"] is True
    assert body["parent_index"] == 1
    assert body["merged_by_name"] == "Carol Coder"
    assert (body["merged_branch"], body["pr_number"]) == ("feat-old", 7)
    assert body["commits_brought_in"] == 2
    assert [commit["subject"] for commit in body["brought_in"]] == [
        "Tweak export",
        "Add old export",
    ]
    assert body["time_gap_seconds"] == 3600


def test_first_parent_edge_details(client: TestClient, team_repo: RepoBuilder) -> None:
    params = {
        "repo": "acme/demo",
        "source": team_repo.sha_of("Set up dev config"),
        "target": team_repo.sha_of("Add login form"),
    }
    body = client.get("/api/edge", params=params).json()
    assert body["is_merge"] is False
    assert body["merged_by_name"] is None
    assert body["brought_in"] == []
    assert [file["path"] for file in body["files"]] == ["login.py"]


def test_edge_between_unconnected_commits_is_404(
    client: TestClient, team_repo: RepoBuilder
) -> None:
    params = {
        "repo": "acme/demo",
        "source": team_repo.sha_of("Add search"),
        "target": team_repo.sha_of("Add login form"),
    }
    assert client.get("/api/edge", params=params).status_code == 404
