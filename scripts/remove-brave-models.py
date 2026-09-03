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
    parser.add_argument("--preferences", type=Path)
    args = parser.parse_args()

    config = json.loads(args.config.read_text())
    if not isinstance(config, dict):
        raise RuntimeError("Invalid bridge configuration")
    configured_path = config.get("bravePreferencesPath")
    preferences_path = args.preferences or (
        Path(configured_path)
        if isinstance(configured_path, str)
        else Path.home()
        / "Library/Application Support/BraveSoftware/Brave-Browser/Default/Preferences"
    )
    if not preferences_path.is_file():
        raise RuntimeError(f"Brave Preferences not found: {preferences_path}")

    owned_keys = {
        key for key in config.get("braveModelKeys", []) if isinstance(key, str)
    }
    owned_ids = (
        {
            profile.get("publicModelId")
            for profile in config.get("profiles", [])
            if isinstance(profile, dict) and isinstance(profile.get("publicModelId"), str)
        }
        if not owned_keys
        else set()
    )
    raw = preferences_path.read_bytes()
    preferences: dict[str, Any] = json.loads(raw)
    ai_chat = preferences.get("brave", {}).get("ai_chat", {})
    models = ai_chat.get("custom_models", [])
    if not isinstance(models, list) or not all(isinstance(model, dict) for model in models):
        raise RuntimeError("Unexpected Brave custom-model preference structure")

    def managed(model: dict[str, Any]) -> bool:
        # Current installations use the exact random Brave keys recorded in
        # config. Model ids are only a compatibility fallback for the original
        # private build, which did not record those keys.
        return model.get("key") in owned_keys or (
            not owned_keys and model.get("model_request_name") in owned_ids
        )

    removed = [model for model in models if managed(model)]
    if not removed:
        print("No managed Pi Leo models were present in Brave.")
        return

    removed_keys = {model.get("key") for model in removed}
    retained = [model for model in models if not managed(model)]
    ai_chat["custom_models"] = retained
    if ai_chat.get("default_model_key") in removed_keys:
        previous = config.get("previousDefaultModelKey")
        retained_keys = {model.get("key") for model in retained}
        previous_is_available = (
            isinstance(previous, str)
            and bool(previous)
            and (not previous.startswith("custom:") or previous in retained_keys)
        )
        if previous_is_available:
            ai_chat["default_model_key"] = previous
        else:
            ai_chat.pop("default_model_key", None)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = preferences_path.with_name(
        f"Preferences.backup-{stamp}-before-pi-leo-bridge-uninstall"
    )
    shutil.copy2(preferences_path, backup)
    if backup.read_bytes() != raw:
        raise RuntimeError("Brave Preferences backup verification failed")

    encoded = json.dumps(preferences, ensure_ascii=False, separators=(",", ":")).encode()
    json.loads(encoded)
    mode = stat.S_IMODE(preferences_path.stat().st_mode)
    atomic_bytes(preferences_path, encoded, mode)
    print(f"Removed {len(removed)} managed Brave model(s).")
    print(f"Brave backup: {backup}")


if __name__ == "__main__":
    main()
