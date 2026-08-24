# Contributing

`trmnl-bambulab` is a local bridge that turns Bambu Lab printer telemetry into
a TRMNL e-paper display. It is monitoring only: it never publishes a command
that controls a printer.

Contributions are welcome. The single highest-value thing you can send is a
**sanitized fixture captured from real hardware**, because no field-name claim
in this project is trusted until a fixture and a test pin it down.

Anything security-sensitive goes to [`SECURITY.md`](SECURITY.md) instead of a
public issue.

## Repository layout

| Path | Contents |
| --- | --- |
| `bridge/` | The TypeScript bridge: providers, coordinator, normalization, redaction, and the push scheduler. |
| `bridge/fixtures/` | Sanitized captures, split into `local/`, `cloud/`, and `merged/`. |
| `bridge/test/` | Vitest suites, driven by those fixtures. |
| `plugin/` | The TRMNL Private Plugin: `settings.yml`, shared markup, and the four viewport Liquid templates. |
| `docs/` | Architecture, protocol notes, plugin contract, development plan, and sources. |
| `scripts/` | `secret-scan.sh` and the agent session launcher. |
| `examples/` | Configuration examples. Never real values. |
| `.githooks/` | The pre-commit secret gate. |
| `.omp/` | Project-scoped Oh My Pi agent definitions used to build this repository. |

Read the documentation in the order given in the README before making a
substantial change. `AGENTS.md` states the project boundaries in their shortest
form and applies to humans as much as to agents.

## Getting set up

Run these in order. The order matters.

```sh
git config core.hooksPath .githooks
cd bridge && pnpm install
pnpm typecheck
pnpm test
```

The hook configuration comes first because a fresh clone does not enable
repository hooks automatically. Until you run it, nothing stops a commit that
leaks a printer identifier, and a leak is permanent once pushed.

Node 22 or newer is required; see the `engines` field in `bridge/package.json`.
pnpm is the package manager, and the lockfile is committed.

## The secret gate

This is the part of the contribution process that is not negotiable.

### The scanner

`scripts/secret-scan.sh` has three modes:

```sh
scripts/secret-scan.sh              # the staged diff, which is what the hook runs
scripts/secret-scan.sh --tree       # every tracked and untracked file
scripts/secret-scan.sh path/to/file # just these paths
```

`.githooks/pre-commit` runs the staged scan on every commit and is the
enforcement layer. The editor-time warning hook under `.omp/extensions/` is an
early warning, not a gate. Neither replaces reading your own diff.

### What it blocks

Blockers, which fail the scan:

- Bambu printer serials, and any assignment to a serial-shaped key.
- LAN access codes and local MQTT passwords.
- Private IPv4 address literals.
- TRMNL webhook URLs containing a plugin identifier.
- Bare UUIDs, JSON Web Tokens, and bearer token literals.
- Token, key, and password assignments that carry a literal value.
- Bambu Cloud account identifiers.
- Private key blocks.

Warnings, which you should still look at: Wi-Fi network names, and signed or
long-lived asset URLs from vendor content domains.

Forbidden paths, which may never be committed at all regardless of content:
`.env` files, `.dev.vars`, `.trmnlp.yml`, `captures/`, `raw-telemetry/`,
`bridge/spikes/`, and any packet capture, certificate, or key file. A README
inside such a directory is allowed, so the directory can explain itself.

Documentation paths are partially exempt, so that `docs/` can describe a
pattern without containing one. Every new file outside that exemption, this one
included, is scanned in full.

### `--no-verify` is never acceptable

Do not bypass the hook. Not for a quick fix, not for a commit you intend to
amend, not for a branch you think nobody will pull. The gate is the only
automatic protection against a class of mistake that cannot be undone by a
later commit.

### The `secret-scan-allow` marker

Putting the literal string `secret-scan-allow` on a line makes the scanner skip
that line. It exists for the narrow case where a match provably cannot
correspond to anything real: an obviously fake illustrative value in a template
or an example file where the shape has to be shown, or a value that is public
by construction, such as this repository's own URL in
`.github/ISSUE_TEMPLATE/config.yml`, which trips the vendor-asset-URL rule
purely because the project name contains the word.

It is not legitimate for a value that merely looks redacted, for anything that
came off real hardware, or as a way to get a commit through under time
pressure. If you use it, say so in the commit message and say why the line
cannot correspond to anything real.

## Contributing a fixture

A fixture is a sanitized capture of what a printer or the cloud interface
actually returns. Every normalization rule and every template state is tested
against one. This is the contribution the project most needs, and it is the
only way a protocol claim becomes trustworthy.

**Capture.** Use a read-only spike under `bridge/spikes/`, which is git-ignored
because such a script legitimately handles real credentials while it runs.
Never publish a raw capture, not in an issue, not in a gist, not in a
screenshot.

**Sanitize.** Remove or replace, with stable and obviously synthetic
placeholders: the printer serial, any IP address or hostname, the LAN access
code, any account identifier or email address, any access token, task and
project identifiers, cover and asset URLs, real file and model names, the Wi-Fi
network name, and real timestamps.

**Preserve.** Sanitization must not disturb what the tests pin: object shape,
key names, value types, state tokens, stage codes, and numeric ranges. A
fixture that has been cleaned into a different shape is worse than no fixture,
because it will pin the wrong contract.

**Place.** Put the file under `bridge/fixtures/cloud/` or
`bridge/fixtures/merged/` according to that directory's README. Name a
hand-authored file `*.synthetic.json` so that a real hardware capture can later
replace it deliberately rather than by accident.

**Verify.** Run the scanner over the file, then read the file yourself:

```sh
scripts/secret-scan.sh bridge/fixtures/cloud/your-fixture.json
```

**States most wanted**, from the fixture matrix in `docs/BAMBU-PROTOCOL.md`:
idle, preparing, printing, paused, finished, failed, offline, an HMS alert, and
a `print_error` that arrives with no HMS entry. Partial reports mid-print are
valuable too, because the bridge has to merge them into accumulated state.

## Supported printers

Any printer bound to a Bambu Cloud account is listed and can be shown, because
the endpoints the bridge reads are not model-specific. What varies by model is
how much a printer reports: an X1 sends its whole status in every report, while
a P1 sends only what changed.

So support is claimed per field, not per model, and only where a sanitized
fixture and a test that consumes it are both in the repository. A pull request
that claims a field is available on a model without a fixture will be declined.

Fixtures for a model nobody has covered yet are welcome on their own. That is
the first step, and a genuinely useful contribution before any code changes.

## Hard boundaries

These come from `AGENTS.md`. A pull request that crosses one is declined on
principle, not on quality:

- No MQTT publish that controls the printer, not even behind a flag or a
  configuration option that defaults to off.
- No TLS verification bypass and no `insecure` default, not even to make a
  stubborn local connection work on your bench.
- No committed credential, printer identifier, or raw telemetry.
- Unknown states and raw numeric error codes are preserved, never silently
  mapped to idle or healthy.
- TRMNL pushes stay rate-limited and coalesced, and payloads stay under the
  size ceiling. Printer MQTT frequency is not the TRMNL update frequency.

## Commits and pull requests

Commits follow Conventional Commits, matching the existing history: `docs:`,
`feat:`, `fix:`, `test:`, `chore:`, `ci:`, and so on. Imperative mood,
lower-case subject, no trailing period. Explain the reasoning in the body when
it is not obvious from the diff.

Before opening a pull request:

```sh
cd bridge && pnpm typecheck && pnpm test
scripts/secret-scan.sh --tree
```

Continuous integration runs the same checks on Node 22 and Node 24.

Expectations for the pull request itself:

- One logical change. Keep unrelated refactors on their own branch.
- Add or update tests alongside behavior changes. The required test gates are
  listed in `AGENTS.md`.
- Template changes need all four viewport layouts rendered locally with
  `trmnlp` and the 1-bit output inspected, including the degraded states.
- Where sources disagree about protocol behavior, document the disagreement and
  choose the conservative read-only reading.
- Never paste real telemetry, a serial, an address, an access code, a token, or
  a webhook URL into an issue, a pull request, a commit message, or a
  screenshot. Redact before you paste, and assume anything you post is
  permanent.
