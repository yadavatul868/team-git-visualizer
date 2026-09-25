"""HTTP API for Team Git Visualizer."""

from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings
from app.details import CommitNotFoundError, EdgeNotFoundError, commit_details, edge_details
from app.git_runner import GitError
from app.graph import build_graph
from app.models import CommitDetails, EdgeDetails, Graph, RepoSnapshot, SyncRequest
from app.sync import (
    InvalidRepoError,
    RepoAccessError,
    RepoNotLoadedError,
    open_cached_repo,
    sync_repo,
)

app = FastAPI(title="Team Git Visualizer API", version="0.1.0")
SettingsDep = Annotated[Settings, Depends(get_settings)]

ERROR_STATUS: dict[type[Exception], int] = {
    InvalidRepoError: 400,
    RepoAccessError: 403,
    RepoNotLoadedError: 404,
    CommitNotFoundError: 404,
    EdgeNotFoundError: 404,
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


@app.post("/api/repo/sync")
def sync(request: SyncRequest, settings: SettingsDep) -> RepoSnapshot:
    """Clone the repo on first use, otherwise fetch its latest branches."""
    return sync_repo(request.url, settings.cache_dir, settings.token)


@app.get("/api/graph")
def graph(
    repo: str,
    settings: SettingsDep,
    days: Annotated[int, Query(ge=0, le=36500, description="0 = all history")] = 30,
    priority: Annotated[str, Query(description="Comma-separated branch names")] = "",
) -> Graph:
    ref, path = open_cached_repo(repo, settings.cache_dir)
    branch_priority = [name.strip() for name in priority.split(",") if name.strip()]
    return build_graph(path, ref.key, days or None, settings.max_commits, branch_priority)


@app.get("/api/commit/{sha}")
def commit(sha: str, repo: str, settings: SettingsDep) -> CommitDetails:
    ref, path = open_cached_repo(repo, settings.cache_dir)
    return commit_details(path, ref, sha)


@app.get("/api/edge")
def edge(repo: str, source: str, target: str, settings: SettingsDep) -> EdgeDetails:
    ref, path = open_cached_repo(repo, settings.cache_dir)
    return edge_details(path, ref, source, target)
