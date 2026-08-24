<!--
Never paste a serial, an IP address, an access code, a token, an account email,
or a TRMNL webhook URL into this description, into a commit message, or into a
screenshot. Redact first. Anything here is public and permanent.

Something exploitable belongs in a private security advisory, not in a pull
request. See SECURITY.md.
-->

## What this changes

<!-- One paragraph. What behavior is different after this lands? -->

## Why

<!-- The reasoning that is not obvious from the diff. Link an issue if there is one. -->

## How it was verified

<!--
Name what you actually ran or looked at: a failing test that now passes, a
fixture that pins the new behavior, a rendered layout you inspected. "It
builds" is not verification.
-->

## Checklist

- [ ] `scripts/secret-scan.sh --tree` is clean, and I did not use `--no-verify`.
- [ ] Nothing in this diff contains a real serial, address, access code, token, account identifier, or webhook URL.
- [ ] `pnpm typecheck` and `pnpm test` pass in `bridge/`.
- [ ] Tests were added or updated for the behavior this changes.
- [ ] Monitoring-only boundary respected: no MQTT publish that controls a printer, in any code path, behind any flag.
- [ ] TLS verification is still mandatory: no `insecure` option, no plaintext fallback, no relaxed certificate or identity check.
- [ ] Unknown states and raw error codes are still preserved, not mapped to idle or healthy.
- [ ] Any new fixture is sanitized and shape-preserving, per `CONTRIBUTING.md`.
- [ ] Documentation updated where behavior or configuration changed.
- [ ] Commits follow Conventional Commits.

## Printer models exercised

<!--
Which hardware this was run against, if any. A change that claims support for
a model needs sanitized fixtures and tests for that model in this same pull
request. Say "none, fixtures only" if that is the case.
-->

## If a `secret-scan-allow` marker was added

<!--
Quote the line and explain why the flagged value provably cannot correspond to
anything real. Delete this section if you added none.
-->
