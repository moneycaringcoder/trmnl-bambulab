# Security policy

`trmnl-bambulab` is a bridge that a user runs on their own machine. It reads
Bambu Lab printer telemetry over local MQTT and, optionally, over Bambu Cloud,
and pushes a small normalized snapshot to that user's TRMNL Private Plugin
webhook. It is a monitoring tool: it never publishes a command that controls a
printer.

The security policy matters more here than in an average repository, because
the bridge holds three unrelated credentials at once, each with a different
blast radius, and because two of them are long-lived and awkward to rotate.

## Threat model

### A leaked LAN access code

The access code is the printer's local authentication secret. It is a short
code shown on the printer's own screen, shared by every client on the network,
and it is not scoped per application.

An attacker who has the code and network reachability to the printer can
authenticate to its local MQTT broker and read everything the printer reports:
job name, progress, temperatures, filament state, camera-adjacent metadata, and
errors. Reading is the limit of what this project does with it. The local
protocol itself also carries a command surface, so the same code in other hands
is not read-only.

Rotation means changing the code on the printer and updating every client that
uses it, including Bambu Studio and any home-automation integration. There is
no revoke-one-client option.

### A leaked Bambu Cloud access token

The cloud token is account-scoped, not printer-scoped. This is the largest
exposure of the three.

A holder of the token gets whatever the account grants: enumeration of every
printer bound to the account, print history, project metadata, cover imagery,
and cloud MQTT telemetry for the whole fleet, from anywhere on the internet
rather than from the printer's own network.

Observed refresh-token behavior in the reverse-engineered cloud interface is
unreliable, so this project treats reauthentication as an explicit state rather
than hidden retry logic. The practical mitigation for a leaked token is
account-side revocation, which today means changing the account password and
signing sessions out. Do not assume a leaked token expires on its own.

### A leaked TRMNL webhook URL

The webhook URL is itself a bearer credential, because the plugin-setting
identifier is embedded in the path. There is no separate key to withhold.

A holder of the URL can push arbitrary merge variables to the user's plugin and
therefore render arbitrary content on their display, and can exhaust the
account's hourly push budget so that genuine updates are dropped. It does not
read anything back. Treat it as a display-defacement and denial-of-refresh
vector, and rotate it by regenerating the plugin's webhook in TRMNL.

### What telemetry alone reveals

Even with no credential leaked, printer telemetry is presence data. A public
render says when someone is home, when the workshop is active, and how long
jobs run. Job names are worse: they frequently contain a private or
pre-release model name. That is why the bridge exports a job name only when
`TRMNL_EXPORT_JOB_NAME` is turned on, and why the default is off.

## Project security rules

These are commitments, and they are auditable in the tree.

- **Monitoring and enrichment only.** No MQTT publish that controls a printer.
  No pause, resume, stop, motion, temperature, filament, or print-start path is
  exposed, and none may be added without a separate design and explicit
  approval.
- **TLS verification is never disabled.** Local MQTT runs over TLS with
  certificate validation and printer identity checking. There is no `insecure`
  option, no plaintext fallback, and no environment switch that weakens either.
  A connection that cannot verify the printer fails loudly instead of
  downgrading.
- **No credential is ever committed.** `scripts/secret-scan.sh` runs from
  `.githooks/pre-commit` over the staged set and is the enforcement layer. A
  write-time editor hook warns earlier, and human review sits on top. Bypassing
  the hook with `--no-verify` is not acceptable in this repository.
- **No hosted relay.** The project operates no server. Credentials never leave
  the user's machine, and the only outbound destinations are the user's own
  printer, Bambu's own endpoints when cloud mode is enabled, and the user's own
  TRMNL webhook.
- **Fixtures are sanitized.** Everything under `bridge/fixtures/` is a scrubbed
  capture or a hand-authored synthetic file. No real identifier, address,
  credential, task or project id, asset URL, or real file name is present. See
  [`CONTRIBUTING.md`](CONTRIBUTING.md) for the sanitization workflow.
- **Unknown states stay unknown.** Unrecognized state tokens and raw numeric
  error codes are preserved rather than mapped to idle or healthy, so a fault
  cannot be rendered as a clean printer.

## Where secrets live

Configuration is read from `bridge/.env`, which is git-ignored and should be
mode 0600. Copy it from `examples/bridge.env.example`, which ships with every
value blank. The sensitive variables are `BAMBU_PRINTER_HOST`,
`BAMBU_PRINTER_SERIAL`, `BAMBU_ACCESS_CODE`, `BAMBU_CLOUD_ACCESS_TOKEN`,
`BAMBU_CLOUD_ACCOUNT_HINT`, and `TRMNL_WEBHOOK_URL`. The last one counts as a
credential even though it looks like a link.

Two things are deliberately never stored:

- **The Bambu account password.** Cloud configuration is token-first. If an
  interactive login is used, the password exists only for the duration of the
  login request and is discarded once a token comes back. It is never written
  to disk, never placed in a process argument, and never logged.
- **Any verification or two-factor code.** Same lifetime, same rule.

Where the platform offers one, the cloud token is held in an OS keyring-backed
store rather than in plain configuration. Logs never contain a serial, an
address, an access code, a token or token prefix, an account email, a webhook
URL, or a raw report body, at any log level.

Disposable exploration scripts live under `bridge/spikes/`, which is
git-ignored apart from its README precisely because such a script may hold real
credentials while it runs.

## Reporting a vulnerability

Report privately through GitHub's private security advisories: open the
**Security** tab of this repository and choose **Report a vulnerability**. Do
not open a public issue, a discussion, or a pull request for anything
exploitable.

Include what you need to make the problem reproducible: affected version or
commit, connection mode, the sequence of steps, and the impact you believe it
has. **Do not include a real serial, address, access code, token, account
email, or webhook URL.** Redact them in transcripts before you attach them; a
report is a public artifact the moment the advisory is published.

What to expect:

| Stage | Target |
| --- | --- |
| Acknowledgement of the report | 7 days |
| Initial assessment and severity | 14 days |
| Fix and coordinated disclosure | agreed with the reporter once scope is clear |

This is a volunteer project with no bug bounty and no paid triage rotation.
Credit is given in the advisory unless you prefer otherwise.

## Out of scope

- **Bambu Cloud drift.** The cloud interface is reverse-engineered and has no
  supported public contract. Endpoints, payload shapes, and token behavior can
  change without notice. Cloud support breaking is a bug, and the bridge is
  designed to degrade to local-only when it happens, but it is not a
  vulnerability.
- **Vendor-side issues.** Weaknesses in printer firmware, in the Bambu Lab
  cloud service, or in the TRMNL service belong to those vendors and should be
  reported to them. The exception is real: if this project *mishandles* such a
  weakness, for example by widening its blast radius or by failing to fail
  closed, that handling is in scope here.
- **Local attackers already inside the trust boundary.** Anyone who can read
  the user's filesystem or process environment already has every credential the
  bridge holds. Local privilege escalation on the user's own machine is not
  modelled.
- **A LAN attacker who already knows the access code.** They are inside the
  printer's own trust boundary; that is a property of the printer's local
  protocol, not of this bridge.
- **Rate limiting and the payload size ceiling.** These exist so the bridge is
  a good citizen of the TRMNL API and so renders stay correct. They are
  correctness constraints, not security boundaries.
- **Vulnerabilities that require a user to paste a credential into a public
  place.** That is what the redaction rules throughout this repository exist to
  prevent.
