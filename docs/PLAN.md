# Plan

What is built, what is next, and what only the owner can do. Kept current so
progress is readable without reading diffs.

Last revised: 2026-08-24.

## Status at a glance

| Area | State |
| --- | --- |
| Bambu Cloud sign-in | Code complete, **never run against a real account** |
| Cloud HTTP reads | Code complete, responses unverified |
| Cloud MQTT reads | Not started |
| Normalizers | Not started |
| Webhook payload | Not started |
| Push scheduler | Not started |
| TRMNL templates | Not started |
| Hosted backend | Not started |

Every claim about Bambu Cloud in this repository comes from reverse-engineering
notes, not from a response we have seen. Fixtures that were written by hand are
named `*.synthetic.json` and are never described as captured.

## What the owner needs to do

**One thing, and it unblocks everything else: sign in.**

```sh
cd bridge && pnpm install && pnpm setup
```

Choose your region, sign in with the email and password you use for Bambu
Handy, and enter the code Bambu emails you. Your password and the code are sent
once and never written anywhere.

Then say what happened. Any of these is a useful answer:

- It worked, and it listed my printers.
- It asked for a code and then refused the code.
- It failed at this step with this message.

That single result tells us whether the login flow, the header set, the token
format and the device-listing endpoint are right. All four are currently
guesses. Nothing after this point can be trusted until it passes.

Later, and not yet needed: creating the TRMNL Private Plugin and handing over
its webhook URL, looking at a real display, and deploying to Cloudflare and
Neon.

## Done

- **Bambu Cloud provider.** Login state machine, HTTP transport with no TLS
  bypass and no automatic retry, read-only endpoint wrappers, token claim
  parsing.
- **Setup CLI.** `pnpm setup`, and `doctor`, `reauth`, `webhook` subcommands.
  Writes one file, `bridge/.env`, at mode 0600.
- **Two-factor fallback.** A two-factor account now signs in with an emailed
  code, because the two-factor endpoint has been returning 403 since
  2026-08-01. See `docs/DECISIONS.md` D8.
- **Opaque token support.** A token no longer has to look like a JWT to be
  accepted. See D9.
- **Design decisions written down.** `docs/DECISIONS.md`.

## Next

In order. Each lands as its own commit.

1. **Normalizers.** Turn a cloud HTTP response and an MQTT report into the
   `PrinterState` contract. Pure functions, no I/O, tested against synthetic
   fixtures. Absent stays `null`.
2. **Payload builder.** Turn merged state for one to three printers into the
   `merge_variables` body, with a test proving three printers fit inside 2 kB.
3. **TRMNL templates.** `settings.yml`, shared markup and the four views, using
   framework classes that exist today.
4. **Subscribe-only MQTT client.** MQTT 3.1.1 over a duplex byte stream, with
   no publish encoder. Node TLS transport first.
5. **Coordinator and scheduler.** Merge observations per printer, push at most
   once every five minutes, push when the payload changed and on a heartbeat.
6. **Bridge daemon.** `pnpm start`.
7. **Hosted backend.** Neon schema with tokens encrypted at rest, a Cloudflare
   Worker on a five-minute cron, and a sign-in and printer-picker flow.

## Known unknowns

Each of these is a real risk with a stated fallback, not a worry.

| Unknown | If it goes wrong |
| --- | --- |
| Whether the login header set is still accepted | Sign-in fails outright; the header set is one small file to revise |
| Whether the emailed-code path works for a two-factor account | The owner pastes a token exported from another client; `pnpm setup` already offers that |
| Whether the current token is a JWT | Handled: the MQTT username falls back to the account-id endpoint |
| Whether `/user/print` really carries `progress` | The display shows state without a percentage until MQTT is wired up |
| Whether Bambu's MQTT broker accepts a Cloudflare Workers TCP socket | Hosted stays HTTP-only, which D3 already treats as complete |
| Whether a P1 reports enough while idle without a `pushall` publish | Expected and accepted: idle needs no telemetry, and D1 forbids the publish |
