# Pi Leo Bridge

> Unofficial companion project; not affiliated with Brave Software, OpenAI, or the Pi maintainers.

Pi Leo Bridge lets [Brave Leo BYOM](https://support.brave.app/hc/en-us/articles/34070140231821-How-do-I-use-the-Bring-Your-Own-Model-BYOM-with-Brave-Leo) use models and authentication configured in the [Pi coding agent](https://github.com/earendil-works/pi).

```text
Brave Leo -> authenticated 127.0.0.1 endpoint -> isolated Pi SDK session -> selected provider/model
```

The initial release supports macOS, starts automatically with `launchd`, and keeps tools disabled. It is a standalone Pi companion CLI rather than an extension loaded into interactive Pi sessions.

## Features

- Uses Pi providers, model discovery, and existing authentication, including `openai-codex` subscription authentication.
- Adds separate Leo picker entries for configurable Pi thinking levels.
- Implements the OpenAI Chat Completions subset used by Leo, including streaming, history, embedded images, titles, rewrites, assistant prefixes, and stop sequences.
- Binds only to IPv4 loopback and authenticates a random capability URL.
- Gives every request a fresh in-memory Pi session with no tools, extensions, skills, user prompt files, project instructions, or persisted transcript.
- Makes and verifies a timestamped backup before every Brave Preferences change.
- Installs an automatic per-user macOS LaunchAgent.

## Requirements

- macOS
- Brave with Leo BYOM support
- Node.js 22.19 or newer
- Pi authentication configured for the provider you want to use
- Python 3.10 or newer

## Installation

After the npm release is published:

```bash
npm install --global pi-leo-bridge
pi-leo install
```

For a source checkout:

```bash
git clone https://github.com/omaclaren/pi-leo-bridge.git
cd pi-leo-bridge
./scripts/install.sh
```

The source installer performs a locked dependency install, type check, and full test run before changing Brave.

A fresh interactive installation asks for the Pi provider, model, display name, and thinking levels. Defaults are:

- provider: `openai-codex`
- model: `gpt-5.6-sol`
- profiles: `low`, `medium`, and `high`
- primary profile: `medium`
- context cap advertised to Leo: 100,000 tokens

To install non-interactively or choose another model:

```bash
pi-leo install \
  --provider openai-codex \
  --model gpt-5.6-sol \
  --name "GPT-5.6 Sol" \
  --levels low,medium,high \
  --primary-level medium \
  --yes
```

List models available through configured Pi authentication:

```bash
pi-leo models
pi-leo models openai-codex
```

If validation reports missing or expired authentication, open Pi, sign in to that provider again, and rerun `pi-leo install` or `pi-leo configure`. Model and authentication validation happens before the installer changes Brave.

On a fresh installation, the installer uses Brave's most recently used profile. Select another channel or profile explicitly when needed:

```bash
pi-leo install --channel beta --profile "Profile 1"
```

Supported channel names are `stable`, `beta`, and `nightly`. To move an existing bridge to another Brave profile, uninstall it first, ensuring the authenticated entries are removed from the old profile, then install it against the new target.

## Daily use

1. Open Leo.
2. Select one of the **Pi — … (Low/Medium/High)** entries in the model picker.
3. Attach current-page context when you want Pi to read the page.
4. Chat normally.

No terminal is required during normal use. Operational commands can be run from any terminal directory:

```bash
pi-leo status
pi-leo restart
pi-leo doctor
pi-leo logs
pi-leo smoke-test
pi-leo smoke-test low
pi-leo default medium
```

`logs` follows both service logs until you press **Ctrl-C**. `smoke-test` makes one small real model request; the other commands do not invoke a model.

Re-run configuration at any time:

```bash
pi-leo configure --model OTHER_MODEL --name "Display name"
```

Set a managed profile—or the recorded pre-installation model—as the default for new Leo conversations:

```bash
pi-leo default medium
pi-leo default restore
```

Rotate the local capability if its endpoint may have been exposed:

```bash
pi-leo configure --rotate-token
```

## Upgrade

Upgrade the npm package, re-run its idempotent configuration migration, and verify the result:

```bash
npm install --global pi-leo-bridge@latest
pi-leo configure --yes
pi-leo doctor
```

Run `pi-leo uninstall` before removing the npm package itself; otherwise the LaunchAgent would retain a path into the removed package.

## Uninstall

```bash
pi-leo uninstall
```

This stops and removes the LaunchAgent and removes only the Brave model entries managed by the bridge, after another Preferences backup. Workspace and logs are retained by default:

```bash
pi-leo uninstall --purge
```

Uninstall the npm package separately if it was installed globally:

```bash
npm uninstall --global pi-leo-bridge
```

## Security model

- The HTTP server rejects any configured host other than `127.0.0.1`.
- The endpoint contains a random 256-bit capability; only its SHA-256 hash is stored in bridge configuration.
- The unauthenticated health endpoint reports only service availability; detailed health checks require the capability.
- Request bodies, page content, and model output are never written to bridge logs.
- Remote image URLs are not fetched. Embedded PNG, JPEG, WebP, and GIF data images are accepted.
- Incoming tool definitions are rejected, and the Pi session is checked at runtime to contain zero tools.
- Webpage and document text is explicitly treated as untrusted reference material.

The capability URL is stored in the selected Brave profile's Preferences file. That file is protected by the user's macOS account; do not paste or publish the endpoint. See [SECURITY.md](SECURITY.md) for the full boundary and reporting guidance.

### Data flow

Only the Brave-to-bridge hop is local. Pi then sends the supplied conversation, page context, and images to the configured model provider. Provider retention policies, subscription limits, and charges apply. Brave's hosted-model proxy protections do not apply to BYOM.

## Scope and limitations

The bridge can answer from text and images explicitly sent by Leo. It cannot inspect an unshared tab, click, type, navigate, access files, run commands, or communicate with other Pi sessions.

Those restrictions are intentional. Direct browser control or session-to-session communication should use separate, narrowly scoped profiles with explicit user approval, so prompt injection in attached pages cannot silently trigger actions.

Brave currently sends some OpenAI-compatible models a hard-coded sampling value. The bridge intentionally ignores sampling fields because Pi controls generation through the selected model and thinking level.

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

The test suite includes protocol normalization, assistant-prefix and streaming stop filtering, authentication behavior, health metadata, SSE responses, tool rejection, and model allowlisting. Installer tests should always use a temporary home directory and fixture Preferences file.

Runtime dependencies on Pi are exact-pinned so SDK drift is caught before release. Update them deliberately, run the full test suite, and perform an installed smoke test before changing the pin.

## License

[MIT](LICENSE)
