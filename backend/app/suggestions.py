"""Repository suggestions for the search box, read from `repos.json` in the repo root.

Format: a JSON list of `{"name": "...", "url": "https://github.com/owner/repo"}`.
Entries with a missing name or a non-GitHub URL are skipped, so one typo never hides the rest.
"""

import json
import logging
from pathlib import Path

from app.models import RepoSuggestion
from app.sync import InvalidRepoError, parse_github_url

log = logging.getLogger(__name__)


class InvalidReposFileError(ValueError):
    """repos.json exists but isn't a JSON list."""


def load_suggestions(path: Path) -> list[RepoSuggestion]:
    """Suggestions from `path`; an empty list when the file doesn't exist."""
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        return []
    except json.JSONDecodeError as exc:
        raise InvalidReposFileError(
            f"{path.name} is not valid JSON (line {exc.lineno}, column {exc.colno})"
        ) from None
    if not isinstance(raw, list):
        raise InvalidReposFileError(f"{path.name} must be a JSON list of {{name, url}} objects")

    suggestions: list[RepoSuggestion] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw):
        name = entry.get("name") if isinstance(entry, dict) else None
        url = entry.get("url") if isinstance(entry, dict) else None
        if not isinstance(name, str) or not name.strip() or not isinstance(url, str):
            log.warning("Skipping %s entry %d: needs a name and a url", path.name, index)
            continue
        try:
            ref = parse_github_url(url)
        except InvalidRepoError:
            log.warning("Skipping %s entry %d: %r is not a GitHub repo URL", path.name, index, url)
            continue
        if ref.key.lower() in seen:
            continue
        seen.add(ref.key.lower())
        suggestions.append(RepoSuggestion(name=name.strip(), url=ref.web_url))
    return suggestions
