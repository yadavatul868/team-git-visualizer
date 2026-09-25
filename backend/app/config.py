"""App settings, read from the repo-root `.env` file and environment variables."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    github_pat: SecretStr = SecretStr("")
    cache_dir: Path = REPO_ROOT / ".cache" / "repos"
    identity_dir: Path = REPO_ROOT / ".cache" / "identities"
    max_commits: int = 2000
    repos_file: Path = REPO_ROOT / "repos.json"

    @property
    def token(self) -> str | None:
        """The GitHub token, or None when it isn't configured."""
        return self.github_pat.get_secret_value().strip() or None


@lru_cache
def get_settings() -> Settings:
    return Settings()
