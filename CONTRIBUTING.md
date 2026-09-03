# Contributing

Issues and pull requests are welcome. Please keep the default security boundary intact: loopback-only binding, authenticated chat routes, tools disabled, no request-content logging, and verified browser backups.

## Development

```bash
npm ci
npm run check
```

Use a disposable Brave profile for installer testing. Never commit real Preferences files, endpoint capabilities, Pi authentication files, logs, or page content.

Changes to Pi dependencies must use deliberate exact version updates and include a real installed smoke test. Changes to the Brave protocol adapter should add fixture-based tests for both streaming and non-streaming requests.

See [`docs/RELEASING.md`](docs/RELEASING.md) for the release checklist.
