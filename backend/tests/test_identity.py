from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from app import identity
from app.identity import (
    GitHubUser,
    IdentityStore,
    RawIdentity,
    lookup_github_users,
    noreply_login,
    normalize_name,
    refresh_github_identities,
    resolve_people,
)

NOW = datetime(2026, 9, 26, 12, 0, tzinfo=UTC)


def ident(name: str, email: str, commits: int = 1) -> RawIdentity:
    return RawIdentity(name=name, email=email, commit_count=commits, sample_sha="a" * 40)


def names_and_counts(identities: list[RawIdentity], **kwargs: Any) -> list[tuple[str, int]]:
    people = resolve_people(identities, kwargs.get("github", {}), kwargs.get("links", [])).people
    return [(person.name, person.commit_count) for person in people]


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Atul Yadav", "atul yadav"),
        ("  atul   YADAV ", "atul yadav"),
        ("yadavatul868", None),  # single word: too ambiguous to match on
        ("Your Name", None),  # git's placeholder
        ("", None),
    ],
)
def test_normalize_name(name: str, expected: str | None) -> None:
    assert normalize_name(name) == expected


def test_noreply_login() -> None:
    assert noreply_login("59263373+yadavatul868@users.noreply.github.com") == "yadavatul868"
    assert noreply_login("octocat@users.noreply.github.com") == "octocat"  # old format
    assert noreply_login("atul@gmail.com") is None


def test_github_account_joins_local_and_web_identities() -> None:
    """The case from this repo: local commits vs. merges made on github.com."""
    identities = [
        ident("Atul Yadav", "yadavatul868@gmail.com", 5),
        ident("yadavatul868", "59263373+yadavatul868@users.noreply.github.com", 3),
    ]
    github = {"yadavatul868@gmail.com": GitHubUser("yadavatul868", None)}
    people = resolve_people(identities, github, []).people
    assert len(people) == 1
    # No GitHub profile name, so the most-used real name wins over the login.
    assert (people[0].name, people[0].login, people[0].key) == (
        "Atul Yadav",
        "yadavatul868",
        "gh:yadavatul868",
    )
    assert people[0].commit_count == 8


def test_noreply_email_alone_is_enough_to_join_an_account() -> None:
    identities = [
        ident("Ravi K", "ravi@work.com"),
        ident("ravi-k", "111+ravi-k@users.noreply.github.com"),
    ]
    github = {"ravi@work.com": GitHubUser("ravi-k", "Ravi Kumar")}
    assert names_and_counts(identities, github=github) == [("Ravi Kumar", 2)]


def test_same_full_name_joins_different_emails() -> None:
    identities = [ident("Priya Shah", "priya@work.com", 3), ident("priya  shah", "p@home.net")]
    assert names_and_counts(identities) == [("Priya Shah", 4)]


def test_links_are_transitive() -> None:
    # work email ↔ (name) ↔ home email ↔ (GitHub) ↔ noreply
    identities = [
        ident("Priya Shah", "priya@work.com"),
        ident("Priya Shah", "p@home.net"),
        ident("pshah", "9+pshah@users.noreply.github.com"),
    ]
    github = {"p@home.net": GitHubUser("pshah", None)}
    assert names_and_counts(identities, github=github) == [("Priya Shah", 3)]


def test_placeholder_and_single_word_names_do_not_merge_people() -> None:
    identities = [
        ident("Your Name", "a@laptop.local"),
        ident("Your Name", "b@laptop.local"),
        ident("admin", "admin@one.com"),
        ident("admin", "admin@two.com"),
    ]
    assert len(names_and_counts(identities)) == 4


def test_manual_link_joins_anything() -> None:
    identities = [ident("Your Name", "bob@laptop.local"), ident("Bob Builder", "bob@x.com", 2)]
    result = resolve_people(identities, {}, [("bob@laptop.local", "bob@x.com")]).people
    assert [(p.name, p.commit_count, p.manually_linked) for p in result] == [
        ("Bob Builder", 3, True)
    ]


def test_github_profile_name_wins() -> None:
    identities = [ident("atul", "a@x.com", 9), ident("Atul Y", "a@y.com")]
    github = {"a@x.com": GitHubUser("atul-y", "Atul Yadav"), "a@y.com": GitHubUser("atul-y", None)}
    assert names_and_counts(identities, github=github) == [("Atul Yadav", 10)]


def test_unknown_email_falls_back_to_its_own_person() -> None:
    index = resolve_people([ident("Ann Lee", "ann@x.com")], {}, [])
    ref = index.ref("Someone New", "new@x.com")
    assert (ref.key, ref.name, ref.login) == ("email:new@x.com", "Someone New", None)


# ---------- GitHub lookup ----------


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict[str, Any]:
        return self.payload


def test_lookup_batches_and_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_post(url: str, json: dict[str, Any], headers: dict[str, str], timeout: int) -> Any:
        calls.append({"query": json["query"], "auth": headers["Authorization"]})
        count = json["query"].count("object(oid:")
        repository = {
            f"c{i}": {"author": {"user": {"login": f"user{i}", "name": None}}} for i in range(count)
        }
        repository["c0"] = {"author": {"user": None}}  # an email GitHub doesn't know
        return FakeResponse({"data": {"repository": repository}})

    monkeypatch.setattr(identity.httpx, "post", fake_post)
    samples = {f"dev{i}@x.com": f"{i:040x}" for i in range(60)}
    found = lookup_github_users("acme", "demo", samples, "ghp_secret")

    assert len(calls) == 2  # 50 + 10
    assert all(call["auth"] == "Bearer ghp_secret" for call in calls)
    assert found["dev0@x.com"] is None
    assert found["dev1@x.com"] == GitHubUser("user1", None)
    assert found["dev50@x.com"] is None  # first item of the second batch
    assert len(found) == 60


def test_refresh_skips_without_token_and_survives_errors(
    monkeypatch: pytest.MonkeyPatch, cached_repo: Path, tmp_path: Path
) -> None:
    store = IdentityStore(tmp_path)

    def failing_post(*args: Any, **kwargs: Any) -> Any:
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(identity.httpx, "post", failing_post)
    refresh_github_identities(cached_repo, "acme", "demo", None, store)  # no token: no call
    refresh_github_identities(cached_repo, "acme", "demo", "ghp_x", store)  # error: swallowed
    assert store.github_users() == {}


def test_store_rechecks_only_stale_emails(tmp_path: Path) -> None:
    store = IdentityStore(tmp_path)
    store.save_github_users({"old@x.com": None, "fresh@x.com": GitHubUser("f", None)}, NOW)
    later = NOW + timedelta(days=8)
    store.save_github_users({"fresh@x.com": GitHubUser("f", None)}, later)
    assert store.emails_to_look_up({"old@x.com", "fresh@x.com", "new@x.com"}, later) == {
        "old@x.com",
        "new@x.com",
    }


def test_store_links(tmp_path: Path) -> None:
    store = IdentityStore(tmp_path)
    store.add_link("A@x.com", "b@x.com")
    store.add_link("b@x.com", "a@x.com")  # duplicate, ignored
    store.add_link("c@x.com", "d@x.com")
    assert store.manual_links() == [("a@x.com", "b@x.com"), ("c@x.com", "d@x.com")]
    store.remove_links({"b@x.com"})
    assert store.manual_links() == [("c@x.com", "d@x.com")]
