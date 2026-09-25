"""A synthetic team repo covering the scenarios the visualizer has to handle.

main    c1 ───────────────────────────────────────────────── M(stage→main)
stage     └──────────────────────────────────────── M(dev→stage)┘
dev       └ setup ─ update ─ M(login) ─ M(PR #7) ─ export(#12) ┘
feat/login    └ form ─ validation ─ rename ┘      │        │
feat-old (deleted)          └ old export ─ tweak ┘        │
feat/search   └ search ────────────────── M(dev→search) ─ improve
"""

import os
import subprocess
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.identity import GitHubUser, PeopleIndex, collect_identities, resolve_people
from app.sync import fetch_repo

AUTHORS = {
    "alice": ("Alice Admin", "alice@example.com"),
    "bob": ("Bob Builder", "bob@example.com"),
    "carol": ("Carol Coder", "carol@example.com"),
    # The same people under other identities, as happens in real repos:
    "bob-home": ("Bob Builder", "bob@home.example"),  # personal email, same name
    "bob-laptop": ("Your Name", "bob@laptop.local"),  # git's placeholder name
    "carol-web": ("carol-c", "4242+carol-c@users.noreply.github.com"),  # GitHub web merge
}
START = datetime(2026, 9, 1, 9, 0, tzinfo=UTC)


class RepoBuilder:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.clock = START
        path.mkdir(parents=True)
        self.git("init", "--quiet", "--initial-branch=main")

    def git(self, *args: str, author: str = "alice") -> str:
        name, email = AUTHORS[author]
        date = self.clock.isoformat()
        env = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": name,
            "GIT_AUTHOR_EMAIL": email,
            "GIT_AUTHOR_DATE": date,
            "GIT_COMMITTER_NAME": name,
            "GIT_COMMITTER_EMAIL": email,
            "GIT_COMMITTER_DATE": date,
        }
        result = subprocess.run(
            ["git", *args], cwd=self.path, env=env, check=True, capture_output=True, text=True
        )
        return result.stdout

    def commit(self, author: str, message: str, files: dict[str, str | None]) -> None:
        """Write (or delete, when the content is None) files and commit them."""
        self.clock += timedelta(hours=1)
        for rel_path, content in files.items():
            if content is None:
                self.git("rm", "--quiet", rel_path)
                continue
            file_path = self.path / rel_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content)
            self.git("add", rel_path)
        self.git("commit", "--quiet", "-m", message, author=author)

    def move(self, author: str, message: str, old: str, new: str) -> None:
        self.clock += timedelta(hours=1)
        (self.path / new).parent.mkdir(parents=True, exist_ok=True)
        self.git("mv", old, new)
        self.git("commit", "--quiet", "-m", message, author=author)

    def merge(self, author: str, branch: str, message: str) -> None:
        self.clock += timedelta(hours=1)
        self.git("merge", "--no-ff", "--quiet", "-m", message, branch, author=author)

    def switch(self, branch: str, create: bool = False) -> None:
        self.git("switch", "--quiet", *(["-c"] if create else []), branch)

    def sha_of(self, subject: str) -> str:
        """Full sha of the (unique) commit with this subject, on any branch."""
        output = self.git("log", "--all", "--format=%H %s")
        matches = [
            line.split(" ", 1)[0]
            for line in output.splitlines()
            if line.split(" ", 1)[1] == subject
        ]
        assert len(matches) == 1, f"expected one commit '{subject}', found {len(matches)}"
        return matches[0]


def build_team_repo(path: Path) -> RepoBuilder:
    repo = RepoBuilder(path)
    repo.commit("alice", "Initial commit", {"README.md": "# Demo\n"})
    repo.git("branch", "stage")
    repo.switch("dev", create=True)
    repo.commit("alice", "Set up dev config", {"config.py": "DEBUG = True\n"})

    repo.switch("feat/login", create=True)
    repo.commit("bob", "Add login form", {"login.py": "def form():\n    pass\n"})
    repo.switch("dev")
    repo.switch("feat/search", create=True)
    repo.commit("carol", "Add search", {"search.py": "def search():\n    pass\n"})
    repo.switch("feat/login")
    repo.commit("bob", "Add login validation", {"login.py": "def form():\n    return True\n"})
    repo.move("bob", "Move login into auth package", "login.py", "auth/login.py")

    repo.switch("dev")
    repo.commit("alice", "Update config", {"config.py": "DEBUG = False\n"})
    repo.merge("alice", "feat/login", "Merge branch 'feat/login' into dev")

    repo.switch("feat-old", create=True)
    repo.commit("bob-laptop", "Add old export", {"export.py": "def export():\n    pass\n"})
    repo.commit("bob-home", "Tweak export", {"export.py": "def export():\n    return []\n"})
    repo.switch("dev")
    repo.merge("carol-web", "feat-old", "Merge pull request #7 from acme/feat-old")
    repo.git("branch", "-D", "feat-old")
    repo.commit("alice", "Add report export (#12)", {"report.py": "def report():\n    pass\n"})

    repo.switch("feat/search")
    repo.merge("carol", "dev", "Merge branch 'dev' into feat/search")
    repo.commit(
        "carol",
        "Improve search",
        {"search.py": "def search():\n    return []\n", "config.py": None},
    )

    repo.switch("stage")
    repo.merge("alice", "dev", "Merge branch 'dev' into stage")
    repo.switch("main")
    repo.merge("alice", "stage", "Merge branch 'stage' into main")
    return repo


@pytest.fixture(scope="session")
def team_repo(tmp_path_factory: pytest.TempPathFactory) -> RepoBuilder:
    return build_team_repo(tmp_path_factory.mktemp("origin") / "demo")


@pytest.fixture(scope="session")
def cache_dir(tmp_path_factory: pytest.TempPathFactory, team_repo: RepoBuilder) -> Path:
    """A cache dir holding the team repo synced as `acme/demo`."""
    cache = tmp_path_factory.mktemp("cache")
    fetch_repo(cache / "acme__demo.git", str(team_repo.path), token=None)
    return cache


@pytest.fixture(scope="session")
def cached_repo(cache_dir: Path) -> Iterator[Path]:
    yield cache_dir / "acme__demo.git"


# What GitHub would answer for Carol's work email: it belongs to the account `carol-c`.
GITHUB_ACCOUNTS = {"carol@example.com": GitHubUser(login="carol-c", name="Carol Coder")}


@pytest.fixture(scope="session")
def people(cached_repo: Path) -> PeopleIndex:
    return resolve_people(collect_identities(cached_repo), GITHUB_ACCOUNTS, [])
