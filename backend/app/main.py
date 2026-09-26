"""HTTP API for Team Git Visualizer."""

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings
from app.details import CommitNotFoundError, EdgeNotFoundError, commit_details, edge_details
from app.git_runner import GitError
from app.graph import build_graph
from app.identity import IdentityStore, PeopleIndex, get_store, load_people
from app.models import (
    CommitDetails,
    EdgeDetails,
    Graph,
    LinkRequest,
    Person,
    RepoSnapshot,
    RepoSuggestion,
    SyncRequest,
    UnlinkRequest,
)
from app.suggestions import InvalidReposFileError, load_suggestions
from app.sync import (
    InvalidRepoError,
    RepoAccessError,
    RepoNotLoadedError,
    open_cached_repo,
    read_fetched_at,
    sync_repo,
)

app = FastAPI(title="Team Git Visualizer API", version="0.1.0")
SettingsDep = Annotated[Settings, Depends(get_settings)]
MAX_WINDOW_DAYS = 30  # the graph only ever shows recent work


class UnknownPersonError(LookupError):
    """No such person or email in the repo."""


def identity_store(settings: SettingsDep) -> IdentityStore:
    return get_store(settings.identity_dir)


StoreDep = Annotated[IdentityStore, Depends(identity_store)]


def people_for(path: Path, store: IdentityStore) -> PeopleIndex:
    return load_people(path, read_fetched_at(path), store)


ERROR_STATUS: dict[type[Exception], int] = {
    InvalidRepoError: 400,
    RepoAccessError: 403,
    RepoNotLoadedError: 404,
    CommitNotFoundError: 404,
    EdgeNotFoundError: 404,
    UnknownPersonError: 404,
    InvalidReposFileError: 422,
    GitError: 502,
}


def _error_handler(status: int) -> Callable[[Request, Exception], Awaitable[JSONResponse]]:
    async def handle(_: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=status, content={"detail": str(exc)})

    return handle


for exc_type, status_code in ERROR_STATUS.items():
    app.add_exception_handler(exc_type, _error_handler(status_code))


@app.get("/api/health")
def health(settings: SettingsDep) -> dict[str, str | bool]:
    return {"status": "ok", "token_configured": settings.token is not None}


@app.get("/api/repos")
def repo_suggestions(settings: SettingsDep) -> list[RepoSuggestion]:
    """Repositories listed in repos.json, offered as suggestions in the search box."""
    return load_suggestions(settings.repos_file)


@app.post("/api/repo/sync")
def sync(request: SyncRequest, settings: SettingsDep, store: StoreDep) -> RepoSnapshot:
    """Clone the repo on first use, otherwise fetch its latest branches."""
    return sync_repo(request.url, settings.cache_dir, settings.token, store)


@app.get("/api/graph")
def graph(
    repo: str,
    settings: SettingsDep,
    store: StoreDep,
    days: Annotated[int, Query(ge=1, le=MAX_WINDOW_DAYS, description="Look-back window")] = 30,
    priority: Annotated[str, Query(description="Comma-separated branch names")] = "",
) -> Graph:
    ref, path = open_cached_repo(repo, settings.cache_dir)
    branch_priority = [name.strip() for name in priority.split(",") if name.strip()]
    return build_graph(
        path, ref.key, days, settings.max_commits, branch_priority, people_for(path, store)
    )


@app.get("/api/commit/{sha}")
def commit(sha: str, repo: str, settings: SettingsDep, store: StoreDep) -> CommitDetails:
    ref, path = open_cached_repo(repo, settings.cache_dir)
    return commit_details(path, ref, sha, people_for(path, store))


@app.get("/api/edge")
def edge(
    repo: str, source: str, target: str, settings: SettingsDep, store: StoreDep
) -> EdgeDetails:
    ref, path = open_cached_repo(repo, settings.cache_dir)
    return edge_details(path, ref, source, target, people_for(path, store))


@app.get("/api/people")
def people(repo: str, settings: SettingsDep, store: StoreDep) -> list[Person]:
    """Everyone who committed on any branch, with every git identity they used."""
    _, path = open_cached_repo(repo, settings.cache_dir)
    return people_for(path, store).people


@app.post("/api/people/link")
def link_people(request: LinkRequest, settings: SettingsDep, store: StoreDep) -> list[Person]:
    """Manually mark two identities (by email) as the same person."""
    _, path = open_cached_repo(request.repo, settings.cache_dir)
    known = {i.email for p in people_for(path, store).people for i in p.identities}
    for email in (request.email, request.target_email):
        if email.lower() not in known:
            raise UnknownPersonError(f"No commits by {email} in {request.repo}")
    store.add_link(request.email, request.target_email)
    return people_for(path, store).people


@app.post("/api/people/unlink")
def unlink_person(request: UnlinkRequest, settings: SettingsDep, store: StoreDep) -> list[Person]:
    """Undo every manual link involving this person."""
    _, path = open_cached_repo(request.repo, settings.cache_dir)
    person = next((p for p in people_for(path, store).people if p.key == request.key), None)
    if person is None:
        raise UnknownPersonError(f"No person {request.key} in {request.repo}")
    store.remove_links({identity.email for identity in person.identities})
    return people_for(path, store).people
