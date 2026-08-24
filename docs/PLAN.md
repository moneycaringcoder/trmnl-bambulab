# Plan

What is built, what is next, and what only the owner can do. Kept current so
progress is readable without reading diffs.

Last revised: 2026-08-24.

## Status at a glance

| Area | State |
| --- | --- |
| Bambu Cloud sign-in | **Confirmed against a real account** |
| Cloud HTTP reads | **Confirmed.** Gives identity and online state, and nothing more |
| Cloud MQTT reads | **Confirmed.** Progress, layer, remaining time and temperatures all arriving |
| Normalizers | Complete, tested, corrected by real data |
| Coordinator | Complete, tested |
| Webhook payload | Complete. Three printers fit in 1338 of 2048 bytes |
| Push scheduler | Complete, tested |
| Bridge daemon | **Running against real printers, pushing to a real display** |
| TRMNL templates | Complete, rendered at 800x480 1-bit. Not yet seen on hardware |
| Hosted backend | Push engine complete; enrolment blocked on an identity provider |

First real sign-in: 2026-08-24. What it confirmed, and the two places it
contradicted the community notes, are recorded in `docs/BAMBU-PROTOCOL.md`.

Fixtures written by hand are named `*.synthetic.json` and are never described as
captured.

## What the owner needs to do

Sign-in is done, the printers are found, and the bridge is pushing. One thing
remains, and it is the only thing between here and a working display.

**Put the templates into your TRMNL plugin, then look at the screen.**

The payload is arriving — TRMNL returns 200 — but a Private Plugin renders
whatever markup is in its editor, and yours is still empty. So the data is
there and nothing is drawing it.

Copy the contents of these four files into the matching markup boxes in the
plugin's editor, and `plugin/src/shared.liquid` into the shared markup box:

```text
plugin/src/full.liquid
plugin/src/half_horizontal.liquid
plugin/src/half_vertical.liquid
plugin/src/quadrant.liquid
plugin/src/shared.liquid
```

Then tell me whether it reads well from across the room, because that is the
one judgement I cannot make from here. `plugin/_build/*.png` is what I think it
looks like; the hardware is the authority.

Later, and not blocking: deploying the hosted tier to Cloudflare and Neon. Read
`hosted/README.md` first — two of the six hosted gates in `AGENTS.md` are open,
which is fine for you testing with your own account and not fine for anyone
else's token.

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
