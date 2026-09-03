# Releasing

Publishing is intentionally manual.

1. Update `CHANGELOG.md` and the version in `package.json` and `package-lock.json`.
2. Confirm the working tree is clean and CI passes on Node.js 22 and 24.
3. Run:

   ```bash
   npm ci
   npm audit
   npm run check
   npm pack --dry-run
   ```

4. Create the tarball and inspect it. It must include `dist/src/index.js`, the CLI, management scripts, documentation, and no credentials, Preferences files, logs, tests, or local configuration:

   ```bash
   npm pack
   tar -tzf pi-leo-bridge-*.tgz
   ```

5. Install that tarball under a temporary npm prefix and verify `pi-leo version`, `pi-leo help`, and `pi-leo models` before testing installation against a disposable Brave profile.
6. Tag the verified commit as `vX.Y.Z` and create the GitHub release.
7. Run `npm publish` and complete npm's normal browser/passkey/OTP flow. Do not create a long-lived npm access token for this manual release.
8. Verify the registry artifact and installation instructions from a clean environment.

Never publish from a directory containing user configuration or copied Brave Preferences. The package `files` allowlist is a second line of defense, not a substitute for inspecting the tarball.
