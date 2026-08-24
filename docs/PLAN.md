# Plan

What is built, what is next, and what only the owner can do. Kept current so
progress is readable without reading diffs.

Last revised: 2026-08-24.

## Status at a glance

| Area | State |
| --- | --- |
| Bambu Cloud sign-in | Code complete, **never run against a real account** |
| Cloud HTTP reads | Code complete, responses unverified |
| Cloud MQTT reads | Code complete, never run against the real broker |
| Normalizers | Complete, tested against synthetic fixtures |
| Coordinator | Complete, tested |
| Webhook payload | Complete. Three printers fit in 1338 of 2048 bytes |
| Push scheduler | Complete, tested |
| Bridge daemon | Complete. Smoke tested end to end against a fake cloud and a fake TRMNL |
| TRMNL templates | Complete. Lints, and rendered at 800x480 1-bit |
| Hosted backend | In progress |

Every claim about Bambu Cloud in this repository comes from reverse-engineering
notes, not from a response we have seen. Fixtures written by hand are named
`*.synthetic.json` and are never described as captured.

## What the owner needs to do

**One thing, and it unblocks everything else: sign in.**

```sh
cd bridge && pnpm install && pnpm setup
```

Choose your region, sign in with the email and password you use for Bambu Handy,
and enter the code Bambu emails you. Your password and the code are sent once
and are never written anywhere.

Then say what happened. Any of these is a useful answer:

- It worked, and it listed my printers.
- It asked for a code and then refused the code.
- It failed at this step, with this message.

That single result tells us whether the login flow, the header set, the token
format and the device-listing endpoint are right. All four are currently
guesses. Nothing downstream can be trusted until it passes.

If it works, `pnpm start` will then run the bridge for real, and
`docs/BAMBU-PROTOCOL.md` is where the result gets recorded.

Later, and not blocking: creating the TRMNL Private Plugin and handing over its
webhook URL, looking at a physical display, and deploying to Cloudflare and
Neon.

## Done

- **Bambu Cloud provider.** Login state machine, HTTP transport with no TLS
  bypass and no automatic retry, read-only endpoints, token claim parsing.
- **Setup CLI.** `pnpm setup`, plus `doctor`, `reauth` and `webhook`.
- **Two-factor fallback.** A two-factor account signs in with an emailed code,
  because Bambu's authenticator endpoint has answered 403 since 2026-08-01. D8.
- **Opaque token support.** A token no longer has to look like a JWT. D9.
- **Normalizers.** Cloud HTTP and cloud MQTT into one internal contract, with
  absent staying absent so a near-empty P1 report cannot erase what we knew.
- **Coordinator.** Both read paths merged per printer, with the live report
  winning a disagreement and a ten-minute window before a coarser source is
  allowed back in.
- **Payload builder.** Up to three printers, ordered by what needs attention,
  inside the 2 kB ceiling, shedding detail in a defined order when it has to.
- **Subscribe-only MQTT client.** MQTT 3.1.1 over a duplex byte stream, with no
  publish encoder anywhere in the codebase. D1, D2.
- **Push scheduler.** A sliding-hour budget spent evenly, change detection that
  ignores the timestamp, and a half-hourly heartbeat.
- **The bridge.** `pnpm start`. Two independent loops, bounded jittered
  reconnect, and a log built to be pasted into an issue.
- **The TRMNL plugin.** Four views, linting clean and rendered to 1-bit PNG at
  800x480. An idle printer shows no invented numbers; a stale one says so.

## Next

1. **Hosted push engine.** Neon schema with the token encrypted at rest, and a
   Cloudflare Worker on a five-minute cron. In progress.
2. **Hosted enrolment.** A way for an account to exist. The self-service
   sign-in and printer-picker flow needs an identity provider provisioned in
   the owner's Neon project, which only they can do, so the first step is an
   operator-run enrolment path.
3. **Record what the first real sign-in taught us**, in
   `docs/BAMBU-PROTOCOL.md`.

## Known unknowns

Each is a real risk with a stated fallback, not a worry.

| Unknown | If it goes wrong |
| --- | --- |
| Whether the login header set is still accepted | Sign-in fails outright; the header set is one small file to revise |
| Whether the emailed-code path works for a two-factor account | The owner pastes a token exported from another client; `pnpm setup` already offers that |
| Whether the current token is a JWT | Handled: the MQTT username falls back to the account-id endpoint |
| Whether `/user/print` really carries `progress` | The display shows state without a percentage until MQTT is connected |
| Whether Bambu's broker accepts our hand-written MQTT client | The bridge keeps working on HTTP alone, with no layer counts or temperatures |
| Whether a P1 reports enough while idle without a `pushall` publish | Expected and accepted: idle needs no telemetry, and D1 forbids the publish |
| Whether the hosted tier will ever need MQTT | D2 made the client transport-agnostic, so it is an addition rather than a rewrite |
