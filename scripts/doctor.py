#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import socket
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

LABEL = "com.ojm.pi-leo-bridge"
ENDPOINT_RE = re.compile(
    r"^http://127\.0\.0\.1:(\d+)/auth/([A-Za-z0-9_-]{32,})/v1/chat/completions$"
)


def file_mode(path: Path) -> int | None:
    return stat.S_IMODE(path.stat().st_mode) if path.exists() else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        type=Path,
        default=Path.home() / ".config" / "pi-leo-bridge" / "config.json",
    )
    args = parser.parse_args()

    checks: list[tuple[bool, str]] = []

    def check(condition: bool, message: str) -> None:
        checks.append((condition, message))
        print(f"{'PASS' if condition else 'FAIL'}  {message}")

    config_path = args.config
    check(config_path.is_file(), f"Configuration exists: {config_path}")
    if not config_path.is_file():
        raise SystemExit(1)

    try:
        config: dict[str, Any] = json.loads(config_path.read_text())
        check(isinstance(config, dict), "Configuration is valid JSON")
    except Exception:
        check(False, "Configuration is valid JSON")
        raise SystemExit(1)

    check(file_mode(config_path) == 0o600, "Configuration permissions are 0600")
    check(config.get("host") == "127.0.0.1", "Bridge is configured for IPv4 loopback only")
    port = config.get("port")
    check(isinstance(port, int) and 1024 <= port <= 65535, "Bridge port is valid")

    plist_path = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    check(plist_path.is_file(), f"LaunchAgent exists: {plist_path}")
    check(file_mode(plist_path) == 0o600, "LaunchAgent permissions are 0600")
    if plist_path.is_file():
        try:
            plist = plistlib.loads(plist_path.read_bytes())
            arguments = plist.get("ProgramArguments", [])
            check(
                isinstance(arguments, list)
                and len(arguments) >= 2
                and all(Path(value).exists() for value in arguments[:2]),
                "LaunchAgent runtime paths exist",
            )
        except Exception:
            check(False, "LaunchAgent is valid")

    domain = f"gui/{os.getuid()}/{LABEL}"
    loaded = subprocess.run(
        ["launchctl", "print", domain],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0
    check(loaded, "LaunchAgent is loaded")

    configured_profiles = config.get("profiles", [])
    check(
        isinstance(configured_profiles, list) and bool(configured_profiles),
        "At least one thinking profile is configured",
    )

    preferences_value = config.get("bravePreferencesPath")
    preferences_path = (
        Path(preferences_value)
        if isinstance(preferences_value, str)
        else Path.home()
        / "Library/Application Support/BraveSoftware/Brave-Browser/Default/Preferences"
    )
    check(preferences_path.is_file(), f"Brave Preferences exists: {preferences_path}")
    health_url: str | None = None
    if preferences_path.is_file():
        try:
            preferences = json.loads(preferences_path.read_text())
            models = preferences.get("brave", {}).get("ai_chat", {}).get("custom_models", [])
            managed_keys = config.get("braveModelKeys", [])
            expected_hash = config.get("tokenSha256")
            profile_ok = (
                isinstance(configured_profiles, list)
                and isinstance(managed_keys, list)
                and len(managed_keys) == len(configured_profiles)
            )
            for index, profile in enumerate(configured_profiles):
                if not isinstance(profile, dict) or index >= len(managed_keys):
                    profile_ok = False
                    continue
                model = next(
                    (
                        candidate
                        for candidate in models
                        if isinstance(candidate, dict)
                        and candidate.get("key") == managed_keys[index]
                        and candidate.get("model_request_name") == profile.get("publicModelId")
                    ),
                    None,
                )
                match = ENDPOINT_RE.match(str(model.get("endpoint_url", ""))) if model else None
                current_ok = bool(
                    model
                    and match
                    and int(match.group(1)) == port
                    and hashlib.sha256(match.group(2).encode()).hexdigest() == expected_hash
                    and model.get("api_key") == ""
                    and model.get("supports_tools") is False
                )
                profile_ok = profile_ok and current_ok
                if current_ok and health_url is None and match is not None:
                    health_url = (
                        f"http://127.0.0.1:{match.group(1)}/auth/{match.group(2)}/healthz"
                    )
            check(profile_ok, "Brave models match the authenticated no-tools configuration")
        except Exception:
            check(False, "Brave model configuration is valid")

    health: dict[str, Any] = {}
    if health_url is not None:
        try:
            with urllib.request.urlopen(health_url, timeout=3) as response:
                health = json.load(response)
            check(
                health.get("status") == "ok"
                and health.get("service") == "pi-leo-bridge",
                "Authenticated bridge health endpoint identifies the expected service",
            )
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            check(False, "Authenticated bridge health endpoint is reachable")
    else:
        check(False, "Authenticated bridge health endpoint can be derived")

    if health:
        check(health.get("profiles") == configured_profiles, "Running profiles match configuration")
        check(health.get("tools") == "disabled", "Running bridge reports tools disabled")

    if isinstance(port, int):
        listener_is_local = False
        try:
            output = subprocess.run(
                ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            ).stdout
            lines = [line for line in output.splitlines()[1:] if line.strip()]
            listener_is_local = bool(lines) and all(
                "127.0.0.1:" in line and "*:" not in line for line in lines
            )
        except (OSError, subprocess.SubprocessError):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=2):
                    listener_is_local = config.get("host") == "127.0.0.1"
            except OSError:
                listener_is_local = False
        check(listener_is_local, "Listening socket is restricted to IPv4 loopback")

    passed = sum(1 for ok, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} checks passed.")
    if passed != len(checks):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
