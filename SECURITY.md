# Security

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting form](https://github.com/omaclaren/pi-leo-bridge/security/advisories/new). Do not include capability URLs, API keys, OAuth credentials, browser Preferences files, or private page content in a public issue.

## Security boundary

Pi Leo Bridge is intended for a single-user macOS account. It binds only to IPv4 loopback and authenticates chat requests with a random capability embedded in the Brave model endpoint. Only the capability's SHA-256 hash is stored in the bridge configuration.

Leo-facing Pi sessions intentionally have no tools, extensions, skills, project instructions, or persistent session state. Text and images supplied by webpages are treated as untrusted reference material. The bridge does not provide browser control or communication with other Pi sessions.

The capability URL is stored in the selected Brave profile's local Preferences file. Anyone able to read files as the same macOS user should be considered inside the local trust boundary. The public health route reports only availability; configuration details require the same capability. Installation also verifies that the listening process belongs to the installed LaunchAgent before accepting its health response.

## Data flow

The HTTP hop from Brave to the bridge stays on the local machine. Prompts, attached page content, and images are then sent by Pi to the configured model provider. Provider policies, retention, subscription limits, and charges still apply. Brave's hosted-model proxy protections do not apply to BYOM endpoints.

Request bodies and page contents are not written to bridge logs. Operational logs contain timestamps, generated request identifiers, selected public profile names, message counts, character counts, durations, and redacted error summaries.

## Supported versions

Until a later release is published, only the latest tagged release will receive security fixes. The initial release is macOS-only and requires Node.js 22.19 or newer.
