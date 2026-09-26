"""Run git commands isolated from the user's git config, with the GitHub token kept secret.

The token is only ever passed to git as an HTTP header through environment config
(`GIT_CONFIG_*`), so it never appears in command-line arguments, remote URLs, the
clone's config file or error messages.
"""

import base64
import os
import subprocess
from pathlib import Path

DEFAULT_TIMEOUT_S = 60.0


class GitError(Exception):
    """A git command failed. The message has any token redacted and is safe to show."""


def auth_header(token: str) -> str:
    credentials = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return f"Authorization: Basic {credentials}"


def redact(text: str, token: str | None) -> str:
    if not token:
        return text
    encoded = auth_header(token).removeprefix("Authorization: Basic ")
    return text.replace(token, "***").replace(encoded, "***")


def git_env(token: str | None) -> dict[str, str]:
    """Environment for git: no user/system config, no prompts, token only as a github.com header."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        {
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "LC_ALL": "C",
        }
    )
    if token:
        env.update(
            {
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "http.https://github.com/.extraHeader",
                "GIT_CONFIG_VALUE_0": auth_header(token),
            }
        )
    return env


def run_git(
    args: list[str],
    cwd: Path | None = None,
    token: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> str:
    """Run `git <args>` and return stdout; raise GitError on failure or timeout."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            env=git_env(token),
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise GitError(f"git {args[0]} timed out after {timeout:.0f}s") from None
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="replace").strip()
        raise GitError(redact(stderr, token) or f"git {args[0]} exited with {proc.returncode}")
    return proc.stdout.decode("utf-8", errors="replace")
