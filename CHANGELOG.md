# Changelog

All notable changes to this project will be documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Updated the pinned Pi SDK dependencies to 1.4.0, including official OpenAI Sign in with ChatGPT subscription authentication under the `openai` provider. This resolves the previously reported `brace-expansion` dependency advisories, but Pi 1.4.0 has a separate `undici` audit finding; see `SECURITY.md`.

### Added

- A historical scoped reachability assessment for Pi 0.99.2's upstream `brace-expansion` advisory and a regression test for advisory-shaped conversation data.

### Fixed

- Restored incoming conversation history through Pi's in-memory session manager, as required by the current SDK. Added SDK-level regression tests for multimodal history, tool-free isolation, and independent request sessions.

## [0.1.2] - 2026-09-03

### Added

- Theme-aware light and dark screenshots showing Pi answering with current-page context in Brave Leo.

## [0.1.1] - 2026-09-03

### Changed

- Reframed the README around bringing Pi models and authentication into Brave Leo, with protocol details kept in the implementation section.

## [0.1.0] - 2026-09-03

### Added

- Authenticated, IPv4-loopback-only OpenAI Chat Completions endpoint for Brave Leo BYOM.
- Isolated, tool-free Pi SDK session per request.
- Streaming and non-streaming responses, conversation history, embedded images, assistant prefixes, and stop sequences.
- Configurable Pi provider, model, context guardrail, and thinking-level picker profiles.
- macOS LaunchAgent installation with verified Brave Preferences backups.
- `pi-leo` install, uninstall, status, restart, doctor, model-listing, default-selection, log, and smoke-test commands.
- Request cancellation, concurrency and body-size limits, output filtering, and redacted metadata-only logs.

[Unreleased]: https://github.com/omaclaren/pi-leo-bridge/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/omaclaren/pi-leo-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/omaclaren/pi-leo-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/omaclaren/pi-leo-bridge/releases/tag/v0.1.0
