# Contributing

`trmnl-bambulab` contains a self-hosted bridge and a hosted TRMNL marketplace
plugin. Both turn Bambu Lab printer telemetry into an e-paper display. The
project is monitoring only: it never publishes a command that controls a printer.

Contributions are welcome. The single highest-value thing you can send is a
**sanitized fixture captured from real hardware**, because no field-name claim
in this project is trusted until a fixture and a test pin it down.

Anything security-sensitive goes to [`SECURITY.md`](SECURITY.md) instead of a
public issue.

## Repository layout

| Path | Contents |
| --- | --- |
| `bridge/` | The bridge: cloud providers, normalizers, coordinator, payload builder, subscribe-only MQTT client, push scheduler, daemon, and setup CLI. |
| `bridge/fixtures/` | Sanitized and synthetic fixtures, split into `cloud/` and `merged/`. |
| `bridge/test/` | Vitest suites, driven by those fixtures. |
| `src/` | Shared Liquid markup for all four viewport layouts. TRMNL renders it for the self-hosted Private Plugin; the hosted Worker renders it with liquidjs for marketplace markup responses. |
| `hosted/` | The hosted tier: TRMNL install and management routes, server-side markup rendering, Neon schema and store, token encryption, and the Cloudflare Worker cron. |
| `collector/` | The optional collector: one MQTT session per hosted account, a single-holder Postgres lease, and the container that supplies rich telemetry. It imports `bridge/src` and `hosted/src` rather than reimplementing either. |
| `docs/` | Architecture, protocol notes, plugin contracts, the collector operations guide, engineering decisions, and sources. |
| `scripts/` | The secret scanner. |
| `examples/` | Configuration examples. Never real values. |
| `.githooks/` | The pre-commit secret gate. |

Read `AGENTS.md` before making a substantial change. It states the project
boundaries in their shortest form and applies to humans as much as to agents.

## Getting set up

From the repository root, enable the hook before installing dependencies:

```sh
git config core.hooksPath .githooks
pnpm --dir bridge install
pnpm --dir hosted install
pnpm --dir collector install
```

A fresh clone does not enable repository hooks automatically. Until the hook
path is configured, nothing stops a commit that leaks a printer identifier, and
a leak is permanent once pushed.

Node 22.18 or newer is required. pnpm is the package manager, and each of the
three packages has its own committed lockfile.

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
enforcement layer. It does not replace reading your own diff. The full Git
history was swept for secrets before the repository became public.

### What it blocks

Blockers, which fail the scan:

- Bambu printer serials, and any assignment to a serial-shaped key.
- LAN access codes and local MQTT passwords.
- Private IPv4 address literals.
- TRMNL webhook URLs containing a plugin identifier.
- Bare UUIDs, JSON Web Tokens, and bearer token literals.
- Token and password assignments that carry a literal value.
- Postgres connection strings that carry a password.
- An encryption key: 40 or more base64 or base64url characters assigned to a
  name containing `key`, `kek` or `dek`, in any mixture of cases, with any
  prefix or suffix.
- Bambu Cloud account identifiers.
- Private key blocks.

Warnings, which you should still look at: Wi-Fi network names, and signed or
long-lived asset URLs from vendor content domains.

Forbidden paths, which may never be committed at all regardless of content:
`.env` files, `.dev.vars`, `.trmnlp.yml`, `captures/`, `raw-telemetry/`,
`bridge/spikes/`, and any packet capture, certificate, or key file. A README
inside such a directory is allowed, so the directory can explain itself, and so
is a `.dev.vars.example` whose values are blank. The example is still scanned in
full, so a filled-in one is refused.

Documentation paths are partially exempt, so that `docs/` can describe a
pattern without containing one. The exemption does not cover the rules that
match unambiguously live material — JSON Web Tokens, bearer tokens, private
keys, connection strings with a password, and key assignments — because setup
prose is exactly where somebody pastes a real one while writing an example.

### What it does not catch

The gate is a backstop, not a boundary. Four known gaps, written down so nobody
mistakes a clean scan for a guarantee:

- **A value with no name beside it.** A bare 44-character base64 key pasted on
  its own line into a note or a document looks like nothing in particular. The
  rules key off an assignment.
- **A value not adjacent to its name.** `wrangler secret put TOKEN_KEY_K1 <<<
  "…"` keeps the key on the same line but separates it from the name by
  something that is not `=` or `:`, and a heredoc moves it to the next line
  entirely. Neither is within reach of a rule that matches a name, a separator
  and a value. That is one reason `hosted/README.md` tells you to pipe a
  generated key straight into Wrangler rather than typing it anywhere.
- **A name the rules do not recognize.** `MASTER_SECRET=` is caught, but
  `AES256=` is not, and neither is a key shorter than 40 characters, such as a
  128-bit key in base64. The name list is the project's own vocabulary, not a
  general one.
- **Anything reshaped.** Split across lines, re-encoded, or stored in a binary,
  and no regex will find it.

Read your own diff. That is the part that actually works.

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

**States most wanted:** idle, preparing, printing, paused, finished, failed,
offline, an HMS alert, and a `print_error` that arrives with no HMS entry.
Partial reports mid-print are valuable too, because the bridge has to merge
them into accumulated state.

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

Before opening a pull request, run all three packages and the tree scan from the
repository root:

```sh
pnpm --dir bridge typecheck && pnpm --dir bridge test
pnpm --dir hosted typecheck && pnpm --dir hosted test
pnpm --dir collector typecheck && pnpm --dir collector test
scripts/secret-scan.sh --tree
```

Continuous integration repeats these package checks and the whole-tree secret
scan.

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
