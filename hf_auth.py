"""Hugging Face Device Code login helpers for remote ComfyUI instances.

Uses only requests (already provided by ComfyUI). Token is stored in the standard
Hugging Face cache path so other tools that read HF_TOKEN / ~/.cache/huggingface/token
can reuse it.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

HF_ENDPOINT = "https://huggingface.co"
# Official huggingface_hub CLI / library OAuth client id (public, no secret).
DEVICE_CODE_OAUTH_CLIENT_ID = "26be6b09-91c5-47da-9861-d2d2bb7a7e36"
_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
_HF_FILE_MARKERS = {"resolve", "blob", "tree"}
_HF_RESERVED_NAMESPACES = {
    "api",
    "docs",
    "login",
    "settings",
    "organizations",
    "spaces",
    "datasets",
    "models",
}


def _hf_home() -> Path:
    if hf_home := os.environ.get("HF_HOME"):
        return Path(hf_home)
    if hub_cache := os.environ.get("HUGGINGFACE_HUB_CACHE"):
        return Path(hub_cache).parent
    return Path.home() / ".cache" / "huggingface"


def _token_path() -> Path:
    if token_path := os.environ.get("HF_TOKEN_PATH"):
        return Path(token_path)
    return _hf_home() / "token"


def get_hf_token() -> str | None:
    for env_name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        value = os.environ.get(env_name, "").strip()
        if value:
            return value

    path = _token_path()
    try:
        if path.is_file():
            token = path.read_text(encoding="utf-8").strip()
            return token or None
    except OSError:
        logger.exception("Failed to read Hugging Face token from %s", path)
    return None


def parse_hf_repo(url: str) -> tuple[str, str] | None:
    """Return (repo_type, repo_id) from a Hugging Face URL, or None."""
    parts = [part for part in urlparse(url.strip()).path.split("/") if part]
    if not parts:
        return None

    repo_type = "model"
    if parts[0].lower() in ("datasets", "spaces"):
        repo_type = "dataset" if parts[0].lower() == "datasets" else "space"
        parts = parts[1:]
    if not parts or parts[0].lower() in _HF_RESERVED_NAMESPACES:
        return None

    if len(parts) >= 2 and parts[1].lower() in _HF_FILE_MARKERS:
        repo_id = parts[0]
    elif len(parts) >= 2:
        repo_id = f"{parts[0]}/{parts[1]}"
    else:
        repo_id = parts[0]
    return repo_type, repo_id


def _repo_page_url(repo_type: str, repo_id: str) -> str:
    if repo_type == "dataset":
        return f"{HF_ENDPOINT}/datasets/{repo_id}"
    if repo_type == "space":
        return f"{HF_ENDPOINT}/spaces/{repo_id}"
    return f"{HF_ENDPOINT}/{repo_id}"


def lookup_hf_repo_gate(url: str) -> dict[str, Any] | None:
    """Read Hub metadata to see if a repo is gated or private. None if unknown."""
    parsed = parse_hf_repo(url)
    if not parsed:
        return None
    repo_type, repo_id = parsed
    api_kind = {"model": "models", "dataset": "datasets", "space": "spaces"}[repo_type]
    headers: dict[str, str] = {}
    token = get_hf_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        response = requests.get(
            f"{HF_ENDPOINT}/api/{api_kind}/{repo_id}",
            headers=headers,
            timeout=15,
        )
    except requests.RequestException:
        logger.exception("Failed to look up Hugging Face repo %s", repo_id)
        return None

    page_url = _repo_page_url(repo_type, repo_id)
    if response.status_code in (401, 403):
        return {
            "repo_id": repo_id,
            "repo_type": repo_type,
            "gated": None,
            "private": True,
            "page_url": page_url,
            "inaccessible": True,
        }
    if not response.ok:
        return None

    try:
        info = response.json()
    except ValueError:
        return None

    gated = info.get("gated", False)
    return {
        "repo_id": repo_id,
        "repo_type": repo_type,
        "gated": bool(gated),
        "gated_mode": gated,
        "private": bool(info.get("private")),
        "page_url": page_url,
        "inaccessible": False,
    }


def get_logged_in_username() -> str | None:
    token = get_hf_token()
    if not token:
        return None
    try:
        response = requests.get(
            f"{HF_ENDPOINT}/api/whoami-v2",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        if response.status_code in (401, 403):
            return None
        response.raise_for_status()
        info = response.json()
        return info.get("name") or info.get("fullname")
    except Exception:
        logger.exception("Failed to resolve Hugging Face username")
        return None


def request_device_code() -> dict[str, Any]:
    response = requests.post(
        f"{HF_ENDPOINT}/oauth/device",
        data={"client_id": DEVICE_CODE_OAUTH_CLIENT_ID},
        timeout=30,
    )
    response.raise_for_status()
    info = response.json()
    info.setdefault("interval", 5)
    info.setdefault("expires_in", 900)
    if not info.get("verification_uri_complete"):
        info["verification_uri_complete"] = info["verification_uri"]
    return info


def poll_device_token(
    device_info: dict[str, Any],
    *,
    on_pending: Callable[[], None] | None = None,
    should_abort: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Poll until the user authorizes, times out, or aborts."""
    interval = int(device_info.get("interval") or 5)
    expires_in = int(device_info.get("expires_in") or 900)
    deadline = time.time() + expires_in
    device_code = device_info["device_code"]

    while time.time() < deadline:
        if should_abort is not None:
            should_abort()
        time.sleep(interval)
        if should_abort is not None:
            should_abort()

        response = requests.post(
            f"{HF_ENDPOINT}/oauth/token",
            data={
                "grant_type": _DEVICE_CODE_GRANT_TYPE,
                "device_code": device_code,
                "client_id": DEVICE_CODE_OAUTH_CLIENT_ID,
            },
            timeout=30,
        )
        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError(
                f"Invalid response from Hugging Face OAuth token endpoint: {response.text[:300]}"
            ) from exc

        if "access_token" in data:
            return data

        error = data.get("error")
        if error == "authorization_pending":
            if on_pending is not None:
                on_pending()
            continue
        if error == "slow_down":
            interval += 5
            if on_pending is not None:
                on_pending()
            continue
        if error == "access_denied":
            raise RuntimeError("Hugging Face authorization was denied.")
        if error in ("expired_token", "invalid_grant"):
            raise RuntimeError("Hugging Face device code expired. Please run the login node again.")
        raise RuntimeError(
            f"Hugging Face login failed: {error or response.status_code} - {data.get('error_description', '')}"
        )

    raise RuntimeError("Timed out waiting for Hugging Face authorization.")


def save_oauth_token(token_response: dict[str, Any]) -> str | None:
    """Persist access token to the standard HF token file. Returns username if known."""
    access_token = token_response.get("access_token")
    if not access_token:
        raise RuntimeError("OAuth response missing access_token.")

    path = _token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(access_token.strip() + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass

    # Prefer env for this process too, without requiring a restart.
    os.environ["HF_TOKEN"] = access_token.strip()
    return get_logged_in_username()


def format_login_instructions(device_info: dict[str, Any]) -> str:
    uri = device_info.get("verification_uri_complete") or device_info.get("verification_uri")
    code = device_info.get("user_code", "")
    return (
        f"Hugging Face login: open {uri} and enter code {code}. "
        "Waiting for authorization..."
    )
