"""Resolve the many git identities (name + email) a person commits with into one person.

Two identities belong to the same person when any of these link them, in order of strength:

1. **GitHub account:** GitHub knows which account every verified email belongs to, including
   the private `…@users.noreply.github.com` address it uses for web merges. Looked up once per
   email at sync time and cached.
2. **Same email** (case-insensitive).
3. **Same full name** (at least two words, case/space-insensitive, not a placeholder like
   "Your Name").
4. **Manual link** made in the app, as a last resort.

Links are transitive (union-find), so one shared key is enough to join two identities.
"""

import json
import logging
import re
import threading
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from app.git_runner import run_git
from app.models import Identity, Person, PersonRef

log = logging.getLogger(__name__)

GRAPHQL_URL = "https://api.github.com/graphql"
LOOKUP_BATCH = 50
COMMIT_AUTHOR_FIELDS = "... on Commit { author { user { login name } } }"
RECHECK_AFTER = timedelta(days=7)
NOREPLY_RE = re.compile(r"^(?:(?P<id>\d+)\+)?(?P<login>[A-Za-z0-9-]+)@users\.noreply\.github\.com$")
PLACEHOLDER_NAMES = {"your name", "unknown user", "github action", "github actions", "root user"}


@dataclass(frozen=True)
class GitHubUser:
    login: str
    name: str | None


@dataclass(frozen=True)
class RawIdentity:
    name: str
    email: str
    commit_count: int
    sample_sha: str


# ---------- persistence: GitHub lookups and manual links, shared by all repos ----------


class IdentityStore:
    """GitHub lookups (email → account) and manual links, saved as JSON under `directory`."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self._lock = threading.Lock()
        self.version = 0

    @property
    def _lookups_file(self) -> Path:
        return self.directory / "github-lookups.json"

    @property
    def _links_file(self) -> Path:
        return self.directory / "manual-links.json"

    def _read(self, path: Path, default: object) -> object:
        try:
            return json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return default

    def _write(self, path: Path, value: object) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2, sort_keys=True))
        self.version += 1

    def github_users(self) -> dict[str, GitHubUser | None]:
        """Email → GitHub account, or None when GitHub says the email isn't linked to one."""
        raw = self._read(self._lookups_file, {})
        assert isinstance(raw, dict)
        return {
            email: GitHubUser(entry["login"], entry.get("name")) if entry.get("login") else None
            for email, entry in raw.items()
        }

    def emails_to_look_up(self, emails: set[str], now: datetime) -> set[str]:
        raw = self._read(self._lookups_file, {})
        assert isinstance(raw, dict)
        stale = set()
        for email in emails:
            entry = raw.get(email)
            if entry is None or now - datetime.fromisoformat(entry["checked_at"]) > RECHECK_AFTER:
                stale.add(email)
        return stale

    def save_github_users(self, found: dict[str, GitHubUser | None], now: datetime) -> None:
        with self._lock:
            raw = self._read(self._lookups_file, {})
            assert isinstance(raw, dict)
            for email, user in found.items():
                raw[email] = {
                    "login": user.login if user else None,
                    "name": user.name if user else None,
                    "checked_at": now.isoformat(timespec="seconds"),
                }
            self._write(self._lookups_file, raw)

    def manual_links(self) -> list[tuple[str, str]]:
        raw = self._read(self._links_file, [])
        assert isinstance(raw, list)
        return [(a, b) for a, b in raw]

    def add_link(self, email_a: str, email_b: str) -> None:
        with self._lock:
            links = self.manual_links()
            pair = sorted([email_a.lower(), email_b.lower()])
            if pair[0] != pair[1] and tuple(pair) not in links:
                links.append((pair[0], pair[1]))
            self._write(self._links_file, [list(link) for link in links])

    def remove_links(self, emails: set[str]) -> None:
        """Drop every manual link that touches any of `emails`."""
        with self._lock:
            lowered = {email.lower() for email in emails}
            links = [link for link in self.manual_links() if not lowered & set(link)]
            self._write(self._links_file, [list(link) for link in links])


# ---------- reading identities from git and looking them up on GitHub ----------


def collect_identities(path: Path) -> list[RawIdentity]:
    """Every distinct (author name, email) on any branch, with a commit count and sample sha."""
    output = run_git(["log", "--branches", "--format=%an%x1f%ae%x1f%H"], cwd=path)
    counts: Counter[tuple[str, str]] = Counter()
    samples: dict[tuple[str, str], str] = {}
    for line in output.splitlines():
        name, email, sha = line.split("\x1f")
        key = (name, email.lower())
        counts[key] += 1
        samples.setdefault(key, sha)
    return [
        RawIdentity(name=name, email=email, commit_count=count, sample_sha=samples[(name, email)])
        for (name, email), count in counts.items()
    ]


def lookup_github_users(
    owner: str, repo: str, samples: dict[str, str], token: str
) -> dict[str, GitHubUser | None]:
    """Ask GitHub which account authored one sample commit per email (batched GraphQL)."""
    found: dict[str, GitHubUser | None] = {}
    items = list(samples.items())
    for start in range(0, len(items), LOOKUP_BATCH):
        batch = items[start : start + LOOKUP_BATCH]
        fields = " ".join(
            f'c{i}: object(oid: "{sha}") {{ {COMMIT_AUTHOR_FIELDS} }}'
            for i, (_, sha) in enumerate(batch)
        )
        query = (
            "query($owner: String!, $name: String!) "
            f"{{ repository(owner: $owner, name: $name) {{ {fields} }} }}"
        )
        response = httpx.post(
            GRAPHQL_URL,
            json={"query": query, "variables": {"owner": owner, "name": repo}},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        response.raise_for_status()
        repository = (response.json().get("data") or {}).get("repository") or {}
        for i, (email, _) in enumerate(batch):
            user = ((repository.get(f"c{i}") or {}).get("author") or {}).get("user")
            found[email] = GitHubUser(user["login"], user.get("name") or None) if user else None
    return found


def refresh_github_identities(
    path: Path, owner: str, repo: str, token: str | None, store: IdentityStore
) -> None:
    """Look up emails not yet (or not recently) checked. Never fails the sync."""
    if not token:
        return
    now = datetime.now(UTC)
    identities = collect_identities(path)
    todo = store.emails_to_look_up({identity.email for identity in identities}, now)
    if not todo:
        return
    samples = {i.email: i.sample_sha for i in identities if i.email in todo}
    try:
        store.save_github_users(lookup_github_users(owner, repo, samples, token), now)
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("GitHub identity lookup failed for %s/%s: %s", owner, repo, type(exc).__name__)


# ---------- grouping identities into people ----------


def normalize_name(name: str) -> str | None:
    """Name key for matching, or None if the name is too generic to trust."""
    words = re.sub(r"\s+", " ", name.strip().lower())
    if len(words.split(" ")) < 2 or words in PLACEHOLDER_NAMES:
        return None
    return words


def noreply_login(email: str) -> str | None:
    match = NOREPLY_RE.match(email)
    return match["login"] if match else None


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, key: str) -> str:
        self.parent.setdefault(key, key)
        while self.parent[key] != key:
            self.parent[key] = self.parent[self.parent[key]]
            key = self.parent[key]
        return key

    def union(self, a: str, b: str) -> None:
        root_a, root_b = self.find(a), self.find(b)
        if root_a != root_b:
            self.parent[max(root_a, root_b)] = min(root_a, root_b)


@dataclass
class PeopleIndex:
    people: list[Person]
    _by_email: dict[str, Person] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for person in self.people:
            for identity in person.identities:
                self._by_email[identity.email] = person

    def ref(self, name: str, email: str) -> PersonRef:
        person = self._by_email.get(email.lower())
        if person is None:
            return PersonRef(key=f"email:{email.lower()}", name=name, login=None)
        return PersonRef(key=person.key, name=person.name, login=person.login)


def _display_name(identities: list[RawIdentity], github_name: str | None, login: str | None) -> str:
    if github_name:
        return github_name
    names: Counter[str] = Counter()
    for identity in identities:
        names[identity.name] += identity.commit_count
    real_names = [name for name, _ in names.most_common() if normalize_name(name) and name != login]
    if real_names:
        return real_names[0]
    return names.most_common(1)[0][0] if names else (login or "unknown")


def resolve_people(
    identities: list[RawIdentity],
    github: dict[str, GitHubUser | None],
    links: list[tuple[str, str]],
) -> PeopleIndex:
    uf = _UnionFind()
    linked_emails = {email for link in links for email in link}
    login_of: dict[str, str] = {}
    for identity in identities:
        email_key = f"e:{identity.email}"
        uf.find(email_key)
        if name_key := normalize_name(identity.name):
            uf.union(email_key, f"n:{name_key}")
        user = github.get(identity.email)
        login = user.login if user else noreply_login(identity.email)
        if login:
            login_of[identity.email] = login
            uf.union(email_key, f"g:{login.lower()}")
    for email_a, email_b in links:
        uf.union(f"e:{email_a}", f"e:{email_b}")

    groups: dict[str, list[RawIdentity]] = {}
    for identity in identities:
        groups.setdefault(uf.find(f"e:{identity.email}"), []).append(identity)

    people = []
    for members in groups.values():
        logins: Counter[str] = Counter()
        for member in members:
            if member.email in login_of:
                logins[login_of[member.email]] += member.commit_count
        login = logins.most_common(1)[0][0] if logins else None
        github_name = next(
            (u.name for m in members if (u := github.get(m.email)) and u.login == login and u.name),
            None,
        )
        key = f"gh:{login.lower()}" if login else f"email:{min(m.email for m in members)}"
        members.sort(key=lambda m: -m.commit_count)
        people.append(
            Person(
                key=key,
                name=_display_name(members, github_name, login),
                login=login,
                commit_count=sum(m.commit_count for m in members),
                manually_linked=any(m.email in linked_emails for m in members),
                identities=[
                    Identity(name=m.name, email=m.email, commit_count=m.commit_count)
                    for m in members
                ],
            )
        )
    people.sort(key=lambda person: (-person.commit_count, person.name.lower()))
    return PeopleIndex(people)


_index_cache: dict[tuple[Path, str | None, int], PeopleIndex] = {}
_index_lock = threading.Lock()
_stores: dict[Path, IdentityStore] = {}


def get_store(directory: Path) -> IdentityStore:
    """One store per directory, so its version counter invalidates cached people."""
    with _index_lock:
        return _stores.setdefault(directory, IdentityStore(directory))


def load_people(path: Path, fetched_at: str | None, store: IdentityStore) -> PeopleIndex:
    """People for a synced repo, cached until the next sync or identity change."""
    cache_key = (path, fetched_at, store.version)
    with _index_lock:
        if cache_key in _index_cache:
            return _index_cache[cache_key]
    index = resolve_people(collect_identities(path), store.github_users(), store.manual_links())
    with _index_lock:
        stale = [key for key in _index_cache if key[0] == path]
        for key in stale:
            del _index_cache[key]
        _index_cache[cache_key] = index
    return index
