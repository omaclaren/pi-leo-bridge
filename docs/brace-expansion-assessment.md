# Brace-expansion advisory assessment

Assessed on 2026-10-02 against Pi SDK 0.99.2 and the bridge implementation in commit `31af6db`, with an additional conversation-data regression test. This document records that historical assessment, not a reachability assessment for later SDK versions.

On 2026-10-27, an isolated installation of Pi SDK 1.4.0 resolved `brace-expansion` 5.0.12, fixing the advisories described below. Pi 1.4.0 has a separate `undici` audit finding; see [SECURITY.md](../SECURITY.md). The historical observations and release recommendations below apply to 0.99.2 and the then-current 1.0.0 release.

## Conclusion

No path from Leo request content to the affected brace parser was found in the current bridge, and none was observed in an instrumented HTTP/SDK test. The vulnerable dependency is present, but the bridge bypasses the Pi features that use it.

This specific advisory need not block the 0.1.3 release, provided the existing isolation and exact-model-selection boundaries are preserved and the outstanding dependency warning is recorded. This is a scoped reachability assessment, **not** a claim that the dependency has been patched or that Pi's general-purpose CLI is unaffected. `npm audit` still reports a high-severity finding.

## Dependency and impact

```text
@earendil-works/pi-coding-agent 0.99.2
└── minimatch 10.2.6
    └── brace-expansion 5.0.9
```

The three reported issues affect parsing of an untrusted **glob pattern**: nested braces and comma groups can exhaust the stack, and a particular closing-brace rewrite can consume quadratic CPU time. The reported impact is denial of service, not code execution, credential disclosure, or an authentication bypass. Version 5.0.12 includes fixes for all three advisories.

Message text containing braces is not itself an exploit unless it is passed to the glob parser.

## Source trace

The installed, unbundled SDK has two consumers of `minimatch`:

| Consumer | Pattern source | Bridge behavior |
|---|---|---|
| `core/model-resolver.js`, `resolveModelScopeFromModels()` | CLI/configured model-scope patterns | The bridge does not invoke model-scope matching. `PiCompletionRunner.create()` calls `ModelRuntime.getModel(provider, modelId)` for an exact configured model, and every session receives that explicit model. |
| `core/package-manager.js`, `matchesAnyPattern()` | Package/resource selection filters | Every completion supplies the bridge's own empty `ResourceLoader`. The SDK therefore skips constructing and reloading `DefaultResourceLoader`, which would perform package/resource discovery. |

Additional boundaries in `src/server.ts`, `src/openai.ts`, and `src/pi-runner.ts`:

- The requested public model must exactly match one of the configured profiles before the SDK runs. Request-supplied model names are not treated as patterns.
- System/developer instructions, historical messages, current prompts, and assistant prefixes remain text. Stop sequences use literal output filtering.
- Prompt-template expansion is disabled; the loader has no skills, extensions, prompt templates, or project instructions.
- Sessions use `noTools: "all"` and are checked to contain zero tools. Incoming tool definitions are rejected before completion.
- Settings and session history are in memory. The ordinary Pi CLI startup, model-scope selection, and package-manager commands are not part of the HTTP request path.

The conclusion depends on these explicit boundaries, not merely on the fact that the service binds to loopback or advertises no tools. User-owned Pi configuration remains trusted local configuration; this assessment does not protect a general Pi invocation from malicious local glob patterns.

## Runtime evidence

A disposable Node process installed module-load hooks at the actual transitive `brace-expansion` ESM/CommonJS entrypoints. Its `expand()` export incremented a counter and threw a distinctive tripwire error on every invocation. The test reused the existing SDK fake-provider fixture, so no provider request or private conversation was involved.

The actual bridge HTTP server and `PiCompletionRunner` processed:

- 21 successful completions, including streaming and non-streaming requests. Advisory-shaped inputs were placed in current prompts, system instructions, developer instructions, history, and assistant prefixes; a brace-shaped literal stop sequence was also exercised.
- 12 rejected requests with oversized stop sequences, unregistered model names, or tool definitions containing those inputs.
- Two rejected capability URLs: the oversized percent-encoded URL was rejected by Node's HTTP header-size boundary, and a shorter brace-shaped token was rejected by the bridge's capability check.

**Brace-parser calls during those requests: zero.** A positive control then called the actual Pi model-scope resolver with the glob `*{a,b}`. It reached the intercepted parser and raised the expected tripwire error exactly once, confirming that the instrumentation was active.

A permanent regression in `test/pi-runner.test.ts` exercises the four reported payload shapes as literal SDK conversation data, including history and assistant continuations. The full bridge check passes with 27 tests.

## Remediation and release follow-up

A clean temporary installation with a root override to `brace-expansion` 5.0.12 still installed 5.0.9 under npm 10.9.8: Pi 0.99.2's published `npm-shrinkwrap.json` retains that version. The normal `npm audit fix` also leaves the finding unresolved. No ineffective override, custom supplier tarball, or post-install mutation was added to the bridge.

A subsequent registry check on 2026-10-02 found Pi **1.0.0** as the latest release. Its published shrinkwrap still pins `brace-expansion` 5.0.9, and an isolated fresh installation reports the same three advisories as one high-severity dependency finding. Its model-scope and resource-filter call sites also still use brace-capable `minimatch`. Updating to that release does not resolve this finding; the bridge itself remains pinned to 0.99.2.

Prefer an upstream Pi release with a corrected shrinkwrap, then update the bridge's exact pins and rerun its checks. Do not suppress the audit finding as though the package were fixed.

Reassess before enabling ordinary resource discovery, extensions, tools, user-supplied model globs, or other pattern-based request features, and when upgrading the SDK. Such changes could invalidate the current reachability result.

## Advisory references

- [GHSA-q2hr-2g5m-vwhr — quadratic closing-brace rewrite](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)
- [GHSA-qhr7-859c-m2p7 — nested-brace stack exhaustion](https://github.com/advisories/GHSA-qhr7-859c-m2p7)
- [GHSA-6j4f-fj2g-mc7p — comma-parser stack exhaustion](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)
