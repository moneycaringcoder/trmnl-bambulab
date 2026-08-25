# Security policy

`trmnl-bambulab` shows Bambu Lab printer status on a TRMNL e-paper display. It
reads Bambu Cloud and pushes a small normalized snapshot to a TRMNL Private
Plugin webhook. It is a monitoring tool: it never sends a command to a printer.

It runs in two ways. Self-hosted, the user runs the bridge on their own machine
and our backend is never involved. Hosted, we run it, which means we hold the
user's Bambu Cloud token on their behalf. The hosted tier's public surface is
Cloudflare's, but its secrets are no longer confined to Cloudflare and Neon: an
always-on *collector*, running on hardware we own, holds the key that
opens those tokens. See "A compromised collector host" below.

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
rate limits before launch. Those obligations follow the key rather than the
Worker: the collector opens the same sealed tokens, so all of this applies on
the machine running it too.

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

### A leaked TRMNL installation token

TRMNL mints one access token per installation during the install handshake and
presents it on every request it makes for that user. A holder of one can, for
that installation only: read the rendered display payload through the markup
route, overwrite the recorded user uuid through the success webhook, and delete
the installation and its account through the uninstall webhook. It cannot
change which printers are shown, cannot reach a printer, and cannot read a
Bambu token.

It is a bearer credential in an `Authorization` header rather than a URL, so it
is not recorded by intermediary access logs, and the Worker's own per-request
logging is off. Only a keyed HMAC tag of it is stored, so a database leak
yields no working tokens. We never hand the token to a browser; it exists in
TRMNL's systems and, transiently, in the Worker's memory during a request.
Rotating it is TRMNL's to do — uninstalling and reinstalling the plugin
retires the old token's row and mints a fresh one.

### A leaked management token

The setup page authenticates with a short-lived token the install redirect
delivers in the URL fragment — the fragment, not the query, so no request log
anywhere records it, and the page strips it from the address bar on load. It is
HMAC-signed by the Worker's own keyring, expires after an hour, and its holder
can, for that installation only: run the Bambu sign-in, change which printers
are shown, and delete the account. They cannot read the Bambu token, and they
cannot obtain the TRMNL access token, which never reaches a browser.

A holder can also cause Bambu to email a sign-in code to an address of their
choosing. `ENROL_LIMITER` bounds that at ten a minute *per Cloudflare
location*, which is the honest figure: Cloudflare documents its rate-limit
binding as per-location, eventually consistent, and explicitly not an
accounting system, so the global ceiling is a multiple of ten rather than ten.
It is a cost and nuisance guard, not a quota. It fails *closed*: a limiter
fault stops new enrolment rather than removing the only bound on sending mail
to other people.

There is no session state to revoke, by design: expiry is the revocation, and a
fresh token requires re-running TRMNL's install handshake, which only someone
holding the TRMNL account can do.

### What the hosted database reveals if it leaks

Assume the rows without the key that seals the tokens — a key which now exists
in two places rather than one, since the collector holds a copy of it, so this
section's premise is only as strong as that machine. From `accounts`, an
attacker gets: encrypted Bambu tokens they cannot open, the printer serials
each account chose, a region, and a keyed tag identifying each owner. From
`trmnl_installations`: keyed HMAC tags of TRMNL's access tokens, which they
cannot reverse into a working token, and TRMNL's per-installation uuids, which
authenticate nothing on their own.

From `screens` they get something more sensitive, and it is worth naming rather
than leaving implied: that table holds the exact JSON last served to TRMNL, so it
carries each printer's name, its state, progress, layer, time remaining and
temperatures, and the job name for any account that opted into exporting one.
That is precisely the presence data described under "What telemetry alone
reveals" above — when someone is home, when the workshop is active, how long
jobs run — for every account at once rather than one. A leak of this table is a
privacy incident even though it contains no credential.

The serials are the other real exposure, and they are stored because the cron
needs them to poll. The owner tag and the token tag are HMACs under a key held
in Worker secrets rather than plain hashes, so a leak of the database alone
cannot be joined against anything: our installation ids are random, but the
HMAC costs nothing and removes the need to reason about the entropy of every
input for as long as the schema lives.

No email address, no password, no verification code, and no plaintext token is
stored anywhere. A password is never received in the first place: the hosted
Bambu sign-in uses an emailed code.

### A compromised collector host

The hosted tier now has a second machine, and it is not one of Cloudflare's.
Bambu's HTTP interface carries no progress, layer, remaining time or
temperature — those arrive over MQTT, and a Worker cron cannot hold a socket
open — so an always-on *collector* runs in a container on our own hardware,
keeps one MQTT session per hosted account, and writes the same `screens`
rows the cron writes. Its design and operations guide is `docs/COLLECTOR.md`.

To open a sealed token it needs the key that sealed it, which is the same
`TOKEN_KEY_K1` material the Worker holds. So the exposure has to be said
plainly: **that machine holds the key that decrypts every hosted user's Bambu
Cloud token.** Not one account's. All of them.

Set that against "A leaked Bambu Cloud access token" above. That entry is one
person's printers, print history and cloud telemetry. This one is the same harm
multiplied by every enrolled account, reached without touching Cloudflare or
Neon, because the key is in neither. It is the largest single point of exposure
in the system, and it did not exist before the collector did.

Recovery is correspondingly worse. There is no bulk revocation to pull: as that
entry says, the mitigation for a leaked cloud token is account-side, so it is
every enrolled user changing their Bambu password and signing their sessions
out. Introducing a new token key is mechanical — the keyring already holds more
than one key, and `TOKEN_KEY_CURRENT_ID` chooses which one seals new writes —
but a new key cannot un-leak a token somebody has already opened.

Two properties bound the damage, and neither of them protects the key. The
collector is read-only in the same sense the rest of this project is: the MQTT
client cannot encode an outbound publish, so owning the host still yields no way
to command a printer without writing new code for it. And an opened token lives
in memory for the life of a session; nothing writes one to the box.

**Physical access.** The Worker's copy of the key sits in Cloudflare's secret
store. This copy sits on a machine somebody can pick up. Full-disk encryption on
the host is therefore an obligation rather than a suggestion, and it is ours
to discharge — nothing in this repository can check it. Be clear about
what it covers: a disk that is stolen or thrown away, not a powered-on machine
with a shell available on it.

**Backups.** A backup of that host which captures the container's environment is
a copy of every user's credential, kept wherever backups are kept, usually for
longer than anything else and usually under weaker access control than the host
itself. Either the key is excluded from the backup, or the backup is encrypted
under a key that is not inside it. Exclusion is the easy answer, because there
is nothing on the collector worth backing up: it keeps no local state, Neon is
the state, and a destroyed container loses nothing.

**Container escape and privilege.** The process runs as a non-root user, listens
on nothing, opens no inbound path, writes nothing to disk beyond log lines on
stdout, and makes only outbound connections — Bambu on 8883, Bambu over HTTPS,
and Postgres. The documented run drops all capabilities, mounts the root
filesystem read-only, and sets `no-new-privileges`. What that buys is the whole
class of attack needing a listening port, a writable path, or root inside the
container, and there is no inbound path from the internet to the machine at all.
What it does not buy is protection of the key, which is in the environment of
the process that has to read it. Any code execution as that user reads it, and
so does anyone on the host who can inspect the container's environment.
Container isolation narrows the ways in. It does not make the host and the
container two trust domains.

**Log exposure.** Logs on a machine we run are easier to reach than
Cloudflare's: a shell, a backup, a log shipper, a screenshot pasted into a
support thread. The property being relied on is that they hold nothing worth
reaching. Every collector log line identifies an account only as `account_tag`,
and no token, email, device id or serial appears at any level — the messages are
fixed strings and the failure paths log the fact rather than the cause,
precisely because a broker or HTTP error can name a host. `account_tag` is the
first 64 bits of an unsalted SHA-256 of the account id, which is safe only
because that id is 122 random bits and cannot be enumerated. It is not the
HMAC'd owner tag the database stores, and it must never be allowed to become a
digest of anything guessable.

### Two collectors holding one Bambu account

Two collector instances that both collect mean two concurrent MQTT connections
against one Bambu account and two writers racing on one screen row. The second
is a flickering display. The first is what Bambu temporarily bans accounts for,
which makes this an abuse control rather than a tidiness one: the penalty lands
on the user's own Bambu account, not on ours.

Exclusion is a Postgres session-scoped advisory lock. Whoever holds it collects
and the other idles, and a collector that crashes, is killed or loses power has
its lock released by the database when its connection drops — no lease timeout
to tune, no fencing token to reason about.

Holding the lock is only half of it. Losing it has to close the MQTT sessions,
not merely note the loss, and that distinction is the whole control: by the time
the heartbeat notices, the lock is already gone and a standby may have taken
over, so a collector that kept its connections would be the second holder on
every one of those accounts. This failure mode is easy to build by accident —
dropping the broker's stop handle is enough — so tests pin it: a session that
cannot be closed, or a lost lease that keeps writing, fails the suite. Losing
the lease closes every session and exits non-zero.

All of that rests on two collectors getting two Postgres sessions, and against a
pooled endpoint that is false while looking fine. Transaction pooling moves a
connection between backends, and session multiplexing puts two clients on one
backend, where the second acquisition re-enters the first's lock and both
callers believe they hold it alone. This was measured against real Postgres
rather than reasoned about: on Neon's `-pooler` host, two clients both held it.

So **the collector must be given the direct Postgres endpoint, and that is
enforced rather than advised.** Before relying on the lock, `takeLease` in
`collector/src/lease.ts` asks for `pg_backend_pid()` twice on one connection and
once on a second, and refuses the endpoint if the backend changed underneath one
connection or if two connections shared one. A refusal exits non-zero before any
account is collected. On Neon the direct host is the same hostname without the
`-pooler` suffix.

The check deliberately takes no lock while checking. The obvious probe — take
the lock twice and see — was tried and is worse than useless on a pooler, where
`pg_advisory_unlock` lands on whichever backend is free: it stranded a held lock
which then blocked a correctly configured collector until that backend died. A
control that causes the outage it was guarding against is not a control.

### Losing the collector

Losing the collector is not a security incident, and that is a design property
rather than a reassurance. Both the cron and the collector write `screens`, and
the cron writes only when the stored render is already stale —
`DEFER_TO_RENDER_WITHIN_MS` in `hosted/src/cycle.ts`, four minutes against a
five-minute cron. Collector up, the cron finds fresh rows and steps aside.
Collector gone — crashed, stolen, unplugged, or deliberately shut down — the
rows go stale and the cron resumes, so every display degrades to the thin
HTTP-only view of name and state. It never blanks.

That is what makes switching the box off an available response rather than an
outage: if we suspect the host is compromised, we stop it and lose a tier of
display fidelity instead of the service. Stopping it does not undo the
exposure — the recovery above is still every user's to do — but it costs nothing
to do immediately. It is also why the collector must never replace the cron: a
richer display that can disappear is a worse product than a thin one that
cannot.

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
- **The collector runs against the direct Postgres endpoint.** Its single-holder
  lease is a session-scoped advisory lock, and a pooled endpoint silently stops
  that lock excluding anything. `takeLease` in `collector/src/lease.ts` proves
  the session is real before it trusts the lock, and an endpoint that fails the
  proof stops the process rather than being collected on. This is enforcement,
  not a runbook note, because the consequence is two MQTT connections against
  one Bambu account and Bambu bans accounts for that.
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

The hosted tier keeps its secrets in Cloudflare's secret store and its rows in
Neon, with one exception that belongs here rather than only in the threat model:
the collector's container environment holds `DATABASE_URL` and `TOKEN_KEY_K1`,
and the second of those opens every stored token. It is set on the container and
belongs nowhere else — not baked into an image, not captured in a snapshot, not
copied into a backup, and never in this repository.

Two things are deliberately never stored:

- **The Bambu account password.** It exists only for the duration of the one
  login request it is sent in, and is discarded as soon as a token or a
  next-step answer comes back. It is never written to disk, never placed in a
  process argument, and never logged.
- **Any verification or two-factor code.** Same lifetime, same rule.

Logs never contain a serial, a device id, a token or token prefix, an account
email, a webhook URL, or a raw report body, at any log level. That holds for the
bridge, the Worker and the collector alike. Where a hosted log has to tell
accounts apart it prints the hashed `account_tag` and never the account id.

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
- **Local attackers on a self-hosted user's own machine.** Anyone who can read
  that user's filesystem or process environment already has every credential the
  bridge holds, and all of it is their own. Local privilege escalation there is
  not modelled. The exclusion stops at the collector host: local access to
  *that* machine reaches other people's credentials, which is in scope and is
  covered under "A compromised collector host".
- **Self-hosted push cadence and payload size.** The bridge's TRMNL webhook
  spacing and payload ceiling keep renders valid and respect TRMNL's limits;
  they are correctness constraints, not security boundaries. This exclusion
  does not cover the hosted tier's address and enrolment abuse controls.
- **Vulnerabilities that require a user to paste a credential into a public
  place.** That is what the redaction rules throughout this repository exist to
  prevent.
