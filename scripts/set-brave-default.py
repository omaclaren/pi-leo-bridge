#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


def atomic_bytes(path: Path, payload: bytes, mode: int) -> None:
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("selector", help="Thinking level, public model id, or 'restore'")
    args = parser.parse_args()

    config: dict[str, Any] = json.loads(args.config.read_text())
    preferences_value = config.get("bravePreferencesPath")
    if not isinstance(preferences_value, str):
        raise RuntimeError("The installed configuration has no Brave profile path")
    preferences_path = Path(preferences_value)
    raw = preferences_path.read_bytes()
    preferences = json.loads(raw)
    ai_chat = preferences.get("brave", {}).get("ai_chat", {})
    models = ai_chat.get("custom_models", [])
    if not isinstance(models, list):
        raise RuntimeError("Unexpected Brave custom-model preference structure")

    if args.selector == "restore":
        previous = config.get("previousDefaultModelKey")
        available_custom_keys = {
            model.get("key") for model in models if isinstance(model, dict)
        }
        if not isinstance(previous, str) or not previous:
            raise RuntimeError("No previous Brave default was recorded")
        if previous.startswith("custom:") and previous not in available_custom_keys:
            raise RuntimeError("The previously selected custom model no longer exists")
        ai_chat["default_model_key"] = previous
        selected_label = "the recorded previous Brave model"
    else:
        profiles = config.get("profiles", [])
        profile_index = next(
            (
                index
                for index, candidate in enumerate(profiles)
                if isinstance(candidate, dict)
                and (
                    candidate.get("thinkingLevel") == args.selector
                    or candidate.get("publicModelId") == args.selector
                )
            ),
            None,
        )
        profile = profiles[profile_index] if profile_index is not None else None
        if profile is None:
            levels = ", ".join(
                str(candidate.get("thinkingLevel"))
                for candidate in profiles
                if isinstance(candidate, dict)
            )
            raise RuntimeError(f"Unknown profile. Available thinking levels: {levels}")
        managed_keys = config.get("braveModelKeys", [])
        expected_key = (
            managed_keys[profile_index]
            if isinstance(managed_keys, list)
            and profile_index is not None
            and profile_index < len(managed_keys)
            else None
        )
        model = next(
            (
                candidate
                for candidate in models
                if isinstance(candidate, dict)
                and candidate.get("model_request_name") == profile.get("publicModelId")
                and (expected_key is None or candidate.get("key") == expected_key)
            ),
            None,
        )
        if model is None or not isinstance(model.get("key"), str):
            raise RuntimeError("The selected managed model is missing from Brave")
        ai_chat["default_model_key"] = model["key"]
        selected_label = str(model.get("label") or profile.get("publicModelId"))

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = preferences_path.with_name(
        f"Preferences.backup-{stamp}-before-pi-leo-default-change"
    )
    shutil.copy2(preferences_path, backup)
    if backup.read_bytes() != raw:
        raise RuntimeError("Brave Preferences backup verification failed")

    encoded = json.dumps(preferences, ensure_ascii=False, separators=(",", ":")).encode()
    json.loads(encoded)
    atomic_bytes(preferences_path, encoded, stat.S_IMODE(preferences_path.stat().st_mode))
    print(f"Default for new Leo conversations: {selected_label}")
    print(f"Brave backup: {backup}")


if __name__ == "__main__":
    main()
