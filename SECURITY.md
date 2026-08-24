# Security policy

`trmnl-bambulab` shows Bambu Lab printer status on a TRMNL e-paper display. It
reads Bambu Cloud and pushes a small normalized snapshot to a TRMNL Private
Plugin webhook. It is a monitoring tool: it never sends a command to a printer.

It runs in two ways. Self-hosted, the user runs the bridge on their own machine
and our backend is never involved. Hosted, we run it, which means we hold the
user's Bambu Cloud token on their behalf.

The security policy matters more here than in an average repository, because
two long-lived credentials are in play — a Bambu Cloud token and a TRMNL
webhook URL — and both are awkward to rotate.

## Threat model

### A leaked Bambu Cloud access token

The cloud token is account-scoped, not printer-scoped. It is the largest
exposure in the system.

A holder of the token gets whatever the account grants: enumeration of every
printer bound to the account, print history, project metadata, cover imagery,
and cloud MQTT telemetry for the whole fleet, from anywhere on the internet.

The refresh endpoint in the reverse-engineered cloud interface answers 401, so
this project treats reauthentication as an explicit state rather than hidden
retry logic. The practical mitigation for a leaked token is account-side
revocation, which today means changing the account password and signing
sessions out. Do not assume a leaked token expires on its own.

In the hosted tier we hold that token because the user runs nothing. That
carries obligations which are not optional, and they are listed in `AGENTS.md`:
encryption at rest with a real key management story, a written threat model
kept current, revocation and deletion that actually delete, and per-account
rate limits before launch.

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

### A leaked hosted screen key

The screen key is a read capability and nothing more: it returns one account's
rendered display payload. It cannot change a selection, cannot reach a printer,
cannot read a Bambu token, and cannot be exchanged for anything else. A holder
sees what that person's display shows.

It is a bearer credential in an `Authorization` header rather than a URL, so it
is not recorded by intermediary access logs, and the Worker's own per-request
logging is off. Only a SHA-256 fingerprint is stored, so a database leak yields
no working keys. The owner rotates it from the account page, and the previous
key stops resolving immediately.

### A compromised hosted session

The hosted tier's enrolment surface trusts a short-lived Ed25519 token from the
identity provider. A holder of a live token can, for that account only: change
which printers are shown, rotate the screen key, and delete the account. They
cannot read the Bambu token, and they cannot see the current screen key, because
it is not stored.

They can also cause Bambu to email a sign-in code to an address of their
choosing. `ENROL_LIMITER` bounds that at ten a minute *per Cloudflare
location*, which is the honest figure: Cloudflare documents its rate-limit
binding as per-location, eventually consistent, and explicitly not an
accounting system, so the global ceiling is a multiple of ten rather than ten.
It is a cost and nuisance guard, not a quota. It fails *closed*, unlike the
limiters on the screen endpoint: a limiter fault stops new enrolment rather
than removing the only bound on sending mail to other people.

The token is verified locally against the provider's published key set. The
algorithm is pinned rather than read from the token, the issuer and audience are
derived from one configured origin, and an absent expiry is refused rather than
treated as eternal. Tokens live fifteen minutes, so the practical mitigation for
a compromised session is the provider's own sign-out; there is no session state
here to revoke, by design.

### What the hosted database reveals if it leaks

Assume the rows without the Worker's secrets. From `accounts`, an attacker gets:
encrypted Bambu tokens they cannot open, screen-key fingerprints they cannot
reverse, the printer serials each account chose, a region, and a keyed tag
identifying each owner.

From `screens` they get something more sensitive, and it is worth naming rather
than leaving implied: that table holds the exact JSON last served to TRMNL, so it
carries each printer's name, its state, progress, layer, time remaining and
temperatures, and the job name for any account that opted into exporting one.
That is precisely the presence data described under "What telemetry alone
reveals" above — when someone is home, when the workshop is active, how long
jobs run — for every account at once rather than one. A leak of this table is a
privacy incident even though it contains no credential.

The serials are the other real exposure, and they are stored because the cron
needs them to poll. The owner tag is an HMAC under a key held in Worker secrets rather
than a plain hash, specifically so that a leak of the database alone cannot be
turned into a list of which people hold accounts here — the identity provider
does not document the entropy of the subject it issues, and a bare digest of a
guessable identifier is reversible by dictionary attack.

No email address, no password, no verification code, and no plaintext token is
stored anywhere. A password is never received in the first place: the hosted
Bambu sign-in uses an emailed code.

## Project security rules

These are commitments, and they are auditable in the tree.

- **Monitoring only.** Nothing publishes to a printer, over any transport. No
  pause, resume, stop, motion, temperature, filament, or print-start path is
  exposed, and none may be added without a separate design and explicit
  approval. The MQTT client cannot encode an outbound publish at all, so this
  is a property of the code rather than a rule someone has to remember.
- **TLS verification is never disabled.** Cloud HTTP and cloud MQTT both run
  with certificate validation and hostname checking on. There is no `insecure`
  option, no plaintext fallback, and no environment switch that weakens either.
  A connection that cannot be verified fails loudly instead of downgrading.
- **No credential is ever committed.** `scripts/secret-scan.sh` runs from
  `.githooks/pre-commit` over the staged set and is the enforcement layer. A
  write-time editor hook warns earlier, and human review sits on top. Bypassing
  the hook with `--no-verify` is not acceptable in this repository.
- **Self-hosting never involves us.** A self-hosted bridge talks to Bambu's
  endpoints and to the user's own TRMNL webhook, and to nothing else. There is
  no phone-home, no telemetry, and no shared identifier.
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
value blank. The sensitive variables are `BAMBU_CLOUD_ACCESS_TOKEN`,
`BAMBU_CLOUD_ACCOUNT_HINT`, `BAMBU_CLOUD_DEVICE_IDS`, and `TRMNL_WEBHOOK_URL`.
The last one counts as a credential even though it looks like a link, and the
device ids are printer serials.

Two things are deliberately never stored:

- **The Bambu account password.** It exists only for the duration of the one
  login request it is sent in, and is discarded as soon as a token or a
  next-step answer comes back. It is never written to disk, never placed in a
  process argument, and never logged.
- **Any verification or two-factor code.** Same lifetime, same rule.

Logs never contain a serial, a device id, a token or token prefix, an account
email, a webhook URL, or a raw report body, at any log level.

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
  designed to say so plainly rather than to render a stale or invented state,
  but it is not a vulnerability.
- **Vendor-side issues.** Weaknesses in printer firmware, in the Bambu Lab
  cloud service, or in the TRMNL service belong to those vendors and should be
  reported to them. The exception is real: if this project *mishandles* such a
  weakness, for example by widening its blast radius or by failing to fail
  closed, that handling is in scope here.
- **Local attackers already inside the trust boundary.** Anyone who can read
  the user's filesystem or process environment already has every credential the
  bridge holds. Local privilege escalation on the user's own machine is not
  modelled.
- **Rate limiting and the payload size ceiling.** These exist so the bridge is
  a good citizen of the TRMNL API and so renders stay correct. They are
  correctness constraints, not security boundaries.
- **Vulnerabilities that require a user to paste a credential into a public
  place.** That is what the redaction rules throughout this repository exist to
  prevent.
