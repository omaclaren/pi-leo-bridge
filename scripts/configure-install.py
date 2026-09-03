#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import secrets
import shutil
import stat
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

LABEL = "com.ojm.pi-leo-bridge"
DEFAULT_PROVIDER = "openai-codex"
DEFAULT_MODEL = "gpt-5.6-sol"
DEFAULT_PORT = 43127
DEFAULT_LEVELS = ("low", "medium", "high")
VALID_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
ENDPOINT_RE = re.compile(
    r"^http://127\.0\.0\.1:(\d+)/auth/([A-Za-z0-9_-]{32,})/v1/chat/completions$"
)


def atomic_bytes(path: Path, payload: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_object(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object: {path}")
    return value


def parse_levels(raw: str | None, existing: dict[str, Any]) -> list[str]:
    if raw is None:
        existing_profiles = existing.get("profiles")
        if isinstance(existing_profiles, list):
            values = [
                profile.get("thinkingLevel")
                for profile in existing_profiles
                if isinstance(profile, dict)
            ]
            if values and all(isinstance(value, str) for value in values):
                raw_values = values
            else:
                raw_values = list(DEFAULT_LEVELS)
        else:
            raw_values = list(DEFAULT_LEVELS)
    else:
        raw_values = [part.strip().lower() for part in raw.split(",") if part.strip()]

    if not raw_values:
        raise RuntimeError("At least one thinking level is required")
    if len(set(raw_values)) != len(raw_values):
        raise RuntimeError("Thinking levels must be unique")
    invalid = [value for value in raw_values if value not in VALID_LEVELS]
    if invalid:
        raise RuntimeError(f"Unsupported thinking level(s): {', '.join(invalid)}")
    return list(raw_values)


def title_model(model_id: str) -> str:
    words = re.split(r"[-_/]+", model_id)
    titled: list[str] = []
    start = 0
    if len(words) >= 2 and words[0].lower() == "gpt":
        titled.append(f"GPT-{words[1]}")
        start = 2
    for word in words[start:]:
        lower = word.lower()
        if lower in {"gpt", "llm", "ai"}:
            titled.append(lower.upper())
        elif lower == "codex":
            titled.append("Codex")
        else:
            titled.append(word[:1].upper() + word[1:])
    return " ".join(titled)


def public_base_id(provider: str, model_id: str) -> str:
    model_slug = re.sub(r"[^A-Za-z0-9._-]+", "-", model_id).strip("-._").lower()
    provider_slug = re.sub(r"[^A-Za-z0-9._-]+", "-", provider).strip("-._").lower()
    if not model_slug:
        raise RuntimeError("The model id cannot be converted into a Leo model name")
    prefix = "pi" if provider == DEFAULT_PROVIDER else f"pi-{provider_slug}"
    return f"{prefix}-{model_slug}"[:120]


def build_profiles(
    provider: str,
    model_id: str,
    display_name: str,
    levels: list[str],
    primary_level: str,
    existing: dict[str, Any],
) -> list[dict[str, str]]:
    existing_ids: dict[str, str] = {}
    if existing.get("provider") == provider and existing.get("modelId") == model_id:
        for profile in existing.get("profiles", []):
            if isinstance(profile, dict):
                level = profile.get("thinkingLevel")
                public_id = profile.get("publicModelId")
                if isinstance(level, str) and isinstance(public_id, str):
                    existing_ids[level] = public_id

    base_id = public_base_id(provider, model_id)
    profiles = []
    for level in levels:
        generated_id = base_id if level == primary_level else f"{base_id}-{level}"
        profiles.append(
            {
                "public_model_id": existing_ids.get(level, generated_id),
                "label": f"Pi — {display_name} ({level.title()})",
                "thinking_level": level,
            }
        )
    if len({profile["public_model_id"] for profile in profiles}) != len(profiles):
        raise RuntimeError("Generated Leo model names are not unique")
    return profiles


def is_bridge_model(
    model: dict[str, Any],
    owned_keys: set[str],
    owned_ids: set[str],
) -> bool:
    key = str(model.get("key", ""))
    request_name = str(model.get("model_request_name", ""))
    # Ownership comes only from the installed manifest. Never infer ownership
    # from a localhost port or a user-chosen model-name prefix.
    return key in owned_keys or request_name in owned_ids


def new_model_key(existing_keys: set[str]) -> str:
    key = f"custom:{secrets.token_hex(4)}"
    while key in existing_keys:
        key = f"custom:{secrets.token_hex(4)}"
    existing_keys.add(key)
    return key


def configure_preferences(
    path: Path,
    *,
    port: int,
    profiles: list[dict[str, str]],
    existing_config: dict[str, Any],
    context_size: int,
    vision_support: bool,
    rotate_token: bool,
) -> tuple[str, Path, list[str], str | None]:
    raw = path.read_bytes()
    preferences = json.loads(raw)
    ai_chat = preferences.setdefault("brave", {}).setdefault("ai_chat", {})
    models = ai_chat.setdefault("custom_models", [])
    if not isinstance(models, list) or not all(isinstance(model, dict) for model in models):
        raise RuntimeError("Unexpected Brave custom-model preference structure")

    owned_keys = {
        str(key)
        for key in existing_config.get("braveModelKeys", [])
        if isinstance(key, str)
    }
    owned_ids: set[str] = set()
    # Current installations identify entries by their random Brave keys. Model
    # ids are used only to migrate the original private build, which predated
    # the managed-key manifest.
    if not owned_keys:
        owned_ids.update(
            str(profile.get("publicModelId"))
            for profile in existing_config.get("profiles", [])
            if isinstance(profile, dict) and isinstance(profile.get("publicModelId"), str)
        )
        if (
            existing_config.get("provider") == DEFAULT_PROVIDER
            and existing_config.get("modelId") == DEFAULT_MODEL
        ):
            owned_ids.update(
                {
                    "pi-gpt-5.6-sol-low",
                    "pi-gpt-5.6-sol",
                    "pi-gpt-5.6-sol-high",
                }
            )

    bridge_models = [
        model for model in models if is_bridge_model(model, owned_keys, owned_ids)
    ]
    old_default_key = ai_chat.get("default_model_key")
    old_default_profile_id: str | None = None
    old_default_level: str | None = None
    for model in bridge_models:
        if model.get("key") == old_default_key:
            value = model.get("model_request_name")
            old_default_profile_id = value if isinstance(value, str) else None
            break
    if old_default_profile_id is not None:
        for profile in existing_config.get("profiles", []):
            if (
                isinstance(profile, dict)
                and profile.get("publicModelId") == old_default_profile_id
                and isinstance(profile.get("thinkingLevel"), str)
            ):
                old_default_level = profile["thinkingLevel"]
                break

    token: str | None = None
    if not rotate_token:
        for bridge_model in bridge_models:
            match = ENDPOINT_RE.match(str(bridge_model.get("endpoint_url", "")))
            if match:
                token = match.group(2)
                break
    if token is None:
        token = secrets.token_urlsafe(32)

    existing_keys = {str(model.get("key")) for model in models}
    existing_by_request = {
        str(model.get("model_request_name")): model for model in bridge_models
    }
    old_primary_id = existing_config.get("publicModelId")
    legacy_primary = next(
        (
            model
            for model in bridge_models
            if model.get("model_request_name") == old_primary_id and model.get("key")
        ),
        next((model for model in bridge_models if model.get("key")), None),
    )

    endpoint = f"http://127.0.0.1:{port}/auth/{token}/v1/chat/completions"
    replacements: list[dict[str, Any]] = []
    model_keys: list[str] = []
    for profile in profiles:
        old = existing_by_request.get(profile["public_model_id"])
        if old is None and profile["thinking_level"] == existing_config.get("thinkingLevel"):
            old = legacy_primary
        model_key = (
            str(old["key"])
            if old is not None and old.get("key")
            else new_model_key(existing_keys)
        )
        model_keys.append(model_key)
        replacements.append(
            {
                "api_key": "",
                "context_size": context_size,
                "endpoint_url": endpoint,
                "key": model_key,
                "label": profile["label"],
                "model_request_name": profile["public_model_id"],
                "model_system_prompt": (
                    "Be concise unless asked for detail. Use attached page context when relevant."
                ),
                "supports_tools": False,
                "vision_support": vision_support,
            }
        )

    if bridge_models:
        first_index = next(
            index
            for index, model in enumerate(models)
            if is_bridge_model(model, owned_keys, owned_ids)
        )
        insertion_index = sum(
            1
            for model in models[:first_index]
            if not is_bridge_model(model, owned_keys, owned_ids)
        )
        retained = [
            model for model in models if not is_bridge_model(model, owned_keys, owned_ids)
        ]
        models[:] = retained[:insertion_index] + replacements + retained[insertion_index:]
    else:
        models.extend(replacements)

    if old_default_profile_id is not None:
        replacement_by_id = {
            model["model_request_name"]: model["key"] for model in replacements
        }
        replacement_by_level = {
            profile["thinking_level"]: model["key"]
            for profile, model in zip(profiles, replacements, strict=True)
        }
        ai_chat["default_model_key"] = replacement_by_id.get(
            old_default_profile_id,
            replacement_by_level.get(old_default_level, replacements[0]["key"]),
        )

    previous_default = existing_config.get("previousDefaultModelKey")
    if not isinstance(previous_default, str):
        removed_keys = {str(model.get("key")) for model in bridge_models}
        previous_default = (
            str(old_default_key)
            if isinstance(old_default_key, str) and old_default_key not in removed_keys
            else None
        )

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = path.with_name(f"Preferences.backup-{stamp}-before-pi-leo-bridge")
    shutil.copy2(path, backup)
    if backup.read_bytes() != raw:
        raise RuntimeError("Brave Preferences backup verification failed")

    mode = stat.S_IMODE(path.stat().st_mode)
    encoded = json.dumps(preferences, ensure_ascii=False, separators=(",", ":")).encode()
    check = json.loads(encoded)
    if not isinstance(check, dict):
        raise RuntimeError("Updated Brave Preferences failed validation")
    atomic_bytes(path, encoded, mode)
    return token, backup, model_keys, previous_default


def configure_runtime(
    *,
    home: Path,
    project: Path,
    node: Path,
    token: str,
    preferences: Path,
    app_name: str,
    provider: str,
    model_id: str,
    display_name: str,
    profiles: list[dict[str, str]],
    primary_level: str,
    port: int,
    context_size: int,
    vision_support: bool,
    model_keys: list[str],
    previous_default: str | None,
) -> tuple[Path, Path]:
    config_dir = home / ".config" / "pi-leo-bridge"
    workspace = home / ".local" / "share" / "pi-leo-bridge" / "workspace"
    logs = home / "Library" / "Logs"
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
    logs.mkdir(parents=True, exist_ok=True)
    os.chmod(config_dir, 0o700)
    os.chmod(workspace, 0o700)

    primary = next(
        profile for profile in profiles if profile["thinking_level"] == primary_level
    )
    config_path = config_dir / "config.json"
    config: dict[str, Any] = {
        "version": 1,
        "host": "127.0.0.1",
        "port": port,
        "tokenSha256": hashlib.sha256(token.encode()).hexdigest(),
        "publicModelId": primary["public_model_id"],
        "provider": provider,
        "modelId": model_id,
        "displayName": display_name,
        "thinkingLevel": primary_level,
        "profiles": [
            {
                "publicModelId": profile["public_model_id"],
                "thinkingLevel": profile["thinking_level"],
            }
            for profile in profiles
        ],
        "workspace": str(workspace),
        "agentDir": str(home / ".pi" / "agent"),
        "maxBodyBytes": 12 * 1024 * 1024,
        "maxConcurrentRequests": 2,
        "contextSize": context_size,
        "visionSupport": vision_support,
        "bravePreferencesPath": str(preferences),
        "braveApplicationName": app_name,
        "braveModelKeys": model_keys,
        "previousDefaultModelKey": previous_default,
    }
    atomic_bytes(config_path, (json.dumps(config, indent=2) + "\n").encode(), 0o600)

    plist_path = home / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    plist = {
        "Label": LABEL,
        "ProgramArguments": [
            str(node),
            str(project / "dist" / "src" / "index.js"),
            "--config",
            str(config_path),
        ],
        "WorkingDirectory": str(project),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ProcessType": "Background",
        "Umask": 0o077,
        "StandardOutPath": str(logs / "pi-leo-bridge.log"),
        "StandardErrorPath": str(logs / "pi-leo-bridge.error.log"),
        "EnvironmentVariables": {
            "HOME": str(home),
            "NODE_ENV": "production",
            "PATH": f"{node.parent}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
    }
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    payload = plistlib.dumps(plist, fmt=plistlib.FMT_XML, sort_keys=True)
    atomic_bytes(plist_path, payload, 0o600)
    return config_path, plist_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--preferences", type=Path, required=True)
    parser.add_argument("--app-name", default="Brave Browser")
    parser.add_argument("--provider")
    parser.add_argument("--model")
    parser.add_argument("--display-name")
    parser.add_argument("--levels", help="Comma-separated Pi thinking levels")
    parser.add_argument("--primary-level")
    parser.add_argument("--port", type=int)
    parser.add_argument("--context-size", type=int)
    parser.add_argument("--vision-support", choices=("true", "false"))
    parser.add_argument("--rotate-token", action="store_true")
    args = parser.parse_args()

    home = Path.home().resolve()
    project = args.project.resolve()
    node = args.node.resolve()
    preferences = args.preferences.resolve()
    config_path = home / ".config" / "pi-leo-bridge" / "config.json"
    existing = read_object(config_path)

    provider = args.provider or str(existing.get("provider") or DEFAULT_PROVIDER)
    model_id = args.model or str(existing.get("modelId") or DEFAULT_MODEL)
    display_name = args.display_name or str(existing.get("displayName") or title_model(model_id))
    levels = parse_levels(args.levels, existing)
    primary_level = args.primary_level or str(existing.get("thinkingLevel") or "medium")
    if primary_level not in levels:
        primary_level = "medium" if "medium" in levels else levels[0]
    port = args.port if args.port is not None else int(existing.get("port") or DEFAULT_PORT)
    context_size = (
        args.context_size
        if args.context_size is not None
        else int(existing.get("contextSize") or 100_000)
    )
    vision_support = (
        args.vision_support == "true"
        if args.vision_support is not None
        else bool(existing.get("visionSupport", True))
    )

    if not display_name.strip() or len(display_name) > 120 or any(
        ord(character) < 32 for character in display_name
    ):
        raise RuntimeError("Display name must be 1-120 printable characters")
    if not 1024 <= port <= 65535:
        raise RuntimeError("Port must be between 1024 and 65535")
    if not 1_024 <= context_size <= 2_000_000:
        raise RuntimeError("Context size must be between 1,024 and 2,000,000")
    if not node.is_file():
        raise RuntimeError(f"Node executable not found: {node}")
    if not (project / "dist" / "src" / "index.js").is_file():
        raise RuntimeError("Build output is missing")
    if not preferences.is_file():
        raise RuntimeError(f"Brave Preferences not found: {preferences}")

    profiles = build_profiles(
        provider,
        model_id,
        display_name,
        levels,
        primary_level,
        existing,
    )
    token, backup, model_keys, previous_default = configure_preferences(
        preferences,
        port=port,
        profiles=profiles,
        existing_config=existing,
        context_size=context_size,
        vision_support=vision_support,
        rotate_token=args.rotate_token,
    )
    config_path, plist_path = configure_runtime(
        home=home,
        project=project,
        node=node,
        token=token,
        preferences=preferences,
        app_name=args.app_name,
        provider=provider,
        model_id=model_id,
        display_name=display_name,
        profiles=profiles,
        primary_level=primary_level,
        port=port,
        context_size=context_size,
        vision_support=vision_support,
        model_keys=model_keys,
        previous_default=previous_default,
    )

    # Never print the capability token or endpoint URL.
    print(f"Brave backup: {backup}")
    print("Brave models:")
    for profile in profiles:
        print(f"  {profile['label']}: {profile['thinking_level']}")
    print(f"Bridge model: {provider}/{model_id}")
    print(f"Bridge config: {config_path}")
    print(f"LaunchAgent: {plist_path}")


if __name__ == "__main__":
    main()
