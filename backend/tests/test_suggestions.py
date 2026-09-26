import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings, get_settings
from app.main import app
from app.suggestions import InvalidReposFileError, load_suggestions


def write(path: Path, value: object) -> Path:
    path.write_text(json.dumps(value))
    return path


def test_missing_file_means_no_suggestions(tmp_path: Path) -> None:
    assert load_suggestions(tmp_path / "repos.json") == []


def test_loads_and_normalises_entries(tmp_path: Path) -> None:
    path = write(
        tmp_path / "repos.json",
        [
            {"name": " Payments API ", "url": "https://github.com/acme/payments.git"},
            {"name": "Web app", "url": "https://github.com/acme/web/"},
        ],
    )
    assert [(s.name, s.url) for s in load_suggestions(path)] == [
        ("Payments API", "https://github.com/acme/payments"),
        ("Web app", "https://github.com/acme/web"),
    ]


def test_skips_bad_entries_and_duplicates(tmp_path: Path) -> None:
    path = write(
        tmp_path / "repos.json",
        [
            {"name": "Good", "url": "https://github.com/acme/good"},
            {"name": "Dup", "url": "https://github.com/ACME/good"},
            {"name": "Not GitHub", "url": "https://gitlab.com/acme/x"},
            {"url": "https://github.com/acme/no-name"},
            {"name": "", "url": "https://github.com/acme/empty-name"},
            "just a string",
        ],
    )
    assert [s.name for s in load_suggestions(path)] == ["Good"]


@pytest.mark.parametrize("content", ["{not json", '{"name": "x"}'])
def test_invalid_file_is_reported(tmp_path: Path, content: str) -> None:
    path = tmp_path / "repos.json"
    path.write_text(content)
    with pytest.raises(InvalidReposFileError):
        load_suggestions(path)


def test_api_serves_suggestions(tmp_path: Path) -> None:
    path = write(tmp_path / "repos.json", [{"name": "Web", "url": "https://github.com/acme/web"}])
    settings = Settings(_env_file=None, github_pat=SecretStr(""), repos_file=path)
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        client = TestClient(app)
        assert client.get("/api/repos").json() == [
            {"name": "Web", "url": "https://github.com/acme/web"}
        ]
        path.write_text("{broken")
        assert client.get("/api/repos").status_code == 422
    finally:
        app.dependency_overrides.clear()
