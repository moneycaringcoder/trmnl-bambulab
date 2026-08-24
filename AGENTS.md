# Agent instructions

## What this is

A TRMNL plugin that shows the status of your Bambu Lab printers on an e-paper
display. Bambu Cloud only. Read only.

The whole product:

1. Sign in with your Bambu account.
2. Pick which of your printers to show.
3. Idle printer shows its name and that it is idle.
4. Printing printer shows progress, layer, time remaining, and temperatures.

Two ways to run it, and both must keep working:

- **Hosted.** The user signs in and picks printers. We run everything. They
  install nothing.
- **Self-hosted.** The user runs the bridge themselves and our backend is never
  involved.

Anything hosted runs on Cloudflare and Neon.

## Non-negotiable

- **Read only.** Never send a command to a printer. No pause, resume, stop,
  temperature, motion, filament, or print-start. Not through MQTT, not through
  the cloud API, not ever.
- **No LAN.** There is no local transport, no access code, and no printer
  network configuration. Bambu Cloud is the only data source.
- **No secrets in Git.** Never commit a printer serial, a device id, an account
  email, a Bambu token, a TRMNL webhook URL or its UUID, a captured model or job
  name, or raw telemetry. `scripts/secret-scan.sh` runs in the pre-commit hook.
- **Never disable TLS verification**, and never add an option that lets a user
  disable it.
- **A password or verification code is never stored.** It is used for one
  request and discarded. Never written to disk, a log, an error message, or a
  process argument.
- **Nothing is a fabricated zero.** Absent or unsupported is `null`. An unknown
  state token is preserved, not mapped to idle or healthy.
- **Payload stays under the TRMNL ceiling**, proven by a test: 2 kB standard,
  5 kB for TRMNL+.

## Hosted backend rules

The hosted tier necessarily holds a user's Bambu Cloud token, because the user
runs nothing. That is allowed, and it carries obligations that are not optional:

- Tokens encrypted at rest, with a real key management story.
- A written threat model, kept current.
- The user can revoke and delete, and deletion actually deletes.
- Per-account rate limits and abuse controls before launch, not after.
- Never log a token, an email, a device id, or a webhook URL.
- Identity comes from a hosted identity provider. Do not store passwords.

Self-hosting must never require the hosted backend, and must never send anything
to it.

## Where the truth is

1. Real captured responses from a real account. This beats everything.
2. Bambu Lab Wiki for supported behavior and security policy.
3. TRMNL docs for the webhook contract and rendering.
4. OpenBambuAPI and ha-bambulab for reverse-engineered field meanings.

Bambu publishes no supported public cloud API. Every endpoint is
reverse-engineered and can change without notice. It already did once: the 2FA
endpoint began requiring a CSRF cookie the API host never issues, and the
working path is to fall back to email-code login.

When sources disagree, document the disagreement and pick the conservative read.

## License hazard

Read these for behavior; never copy their code or assets.

| Project | License | Rule |
| --- | --- | --- |
| `greghesp/ha-bambulab` | none | Behavior reference only. No code, no certificates. |
| `maziggy/bambuddy` | AGPL-3.0 | Copying would force AGPL onto this MIT project. |
| `Rdiger-36/StudioBridge` | GPL-3.0 | Same hazard. |
| `BambuTools/bambulabs_api` | MIT | Safe to borrow with attribution. |

## Gates

Before every commit, all three must pass:

```sh
pnpm --dir bridge typecheck
pnpm --dir bridge test
scripts/secret-scan.sh --tree
```

Then run the `secret-auditor` agent over the change. A `blocked` verdict stops
the commit.
