from pathlib import Path

import pytest

from app.git_runner import GitError, redact, run_git
from app.sync import (
    InvalidRepoError,
    RepoNotLoadedError,
    fetch_repo,
    list_branches,
    open_cached_repo,
    parse_github_url,
    read_default_branch,
    read_fetched_at,
)
from tests.conftest import RepoBuilder


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/acme/demo",
        "https://github.com/acme/demo/",
        "https://github.com/acme/demo.git",
        "  https://github.com/acme/demo  ",
    ],
)
def test_parse_github_url_accepts_repo_urls(url: str) -> None:
    ref = parse_github_url(url)
    assert (ref.owner, ref.name) == ("acme", "demo")
    assert ref.remote_url == "https://github.com/acme/demo.git"


def test_parse_github_url_keeps_dots_in_names() -> None:
    assert parse_github_url("https://github.com/acme/my.repo").name == "my.repo"


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/acme/demo",
        "https://gitlab.com/acme/demo",
        "https://github.com/acme",
        "https://github.com/acme/demo/tree/main",
        "https://github.com/acme/..",
        "https://github.com/acme/demo?tab=readme",
        "https://github.com.evil.com/acme/demo",
        "file:///etc/passwd",
        "/tmp/some/repo",
    ],
)
def test_parse_github_url_rejects_everything_else(url: str) -> None:
    with pytest.raises(InvalidRepoError):
        parse_github_url(url)


def test_fetch_mirrors_all_live_branches(cached_repo: Path) -> None:
    names = {branch.name for branch in list_branches(cached_repo)}
    assert names == {"main", "stage", "dev", "feat/login", "feat/search"}  # feat-old was deleted
    assert read_default_branch(cached_repo, list_branches(cached_repo)) == "main"
    assert read_fetched_at(cached_repo) is not None
    all_refs = run_git(["for-each-ref", "--format=%(refname)"], cwd=cached_repo).split()
    assert all(ref.startswith("refs/heads/") for ref in all_refs)


def test_refresh_picks_up_new_and_deleted_branches(tmp_path: Path) -> None:
    origin = RepoBuilder(tmp_path / "origin")
    origin.commit("alice", "Initial commit", {"a.txt": "a"})
    origin.git("branch", "old-feature")
    cached = tmp_path / "cache" / "x.git"
    fetch_repo(cached, str(origin.path), token=None)
    assert {b.name for b in list_branches(cached)} == {"main", "old-feature"}

    origin.git("branch", "-D", "old-feature")
    origin.git("branch", "new-feature")
    fetch_repo(cached, str(origin.path), token=None)
    assert {b.name for b in list_branches(cached)} == {"main", "new-feature"}


def test_failed_first_fetch_leaves_no_half_clone(tmp_path: Path) -> None:
    cached = tmp_path / "cache" / "missing.git"
    with pytest.raises(GitError):
        fetch_repo(cached, str(tmp_path / "does-not-exist"), token=None)
    assert not cached.exists()


def test_token_is_never_written_to_the_clone(tmp_path: Path, team_repo: RepoBuilder) -> None:
    token = "ghp_testsecret1234567890"
    cached = tmp_path / "cache" / "acme__demo.git"
    fetch_repo(cached, str(team_repo.path), token=token)
    for file in cached.rglob("*"):
        if file.is_file():
            assert token.encode() not in file.read_bytes(), f"token leaked into {file}"


def test_git_errors_redact_the_token(team_repo: RepoBuilder) -> None:
    token = "ghp_testsecret1234567890"
    with pytest.raises(GitError) as error:
        run_git(["show", token], cwd=team_repo.path, token=token)  # git echoes the bad revision
    assert "***" in str(error.value)
    assert token not in str(error.value)
    assert redact(f"bad {token}", token) == "bad ***"


def test_open_cached_repo_requires_a_prior_sync(tmp_path: Path) -> None:
    with pytest.raises(RepoNotLoadedError):
        open_cached_repo("acme/never-loaded", tmp_path)
    with pytest.raises(InvalidRepoError):
        open_cached_repo("../../etc", tmp_path)
