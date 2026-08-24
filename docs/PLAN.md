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
`hosted/README.md` first — two of the six hosted gates in `AGENTS.md` are
open, which is fine for you testing with your own account and not fine for
anyone else's token.

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

## Distance to the product

The goal is two things at once: someone who wants zero pain signs in, picks
printers, and forgets about it; and someone who wants to self-host owes us
nothing. Measured against that:

**Self-hosting works today**, proven on a real account with two printers. What
is left is packaging rather than capability:

1. **Get the templates in without copy-paste.** `trmnlp push` does it, but it
   needs a plugin id and an API key, so it is the owner's to run once.
2. **Ship it as something other than a git clone.** A published package or a
   container image, plus a service unit so it restarts.
3. **Say something useful when the token expires.** It lasts about 90 days and
   cannot be refreshed, so the bridge should warn well before it stops rather
   than simply failing a request.

**Hosted has an engine and no front door.** The cron, the schema, the token
encryption and the payload are done and bundle for Cloudflare. Nothing creates
an account. What is left, in order:

1. ~~**A screen endpoint.**~~ **Done.** `GET /v1/screen` with an
   `Authorization: Bearer <screen key>` header, serving a render the cron
   stored. The key is a header rather than a query parameter because a
   credential in a URL is recorded by every intermediary and by Cloudflare's own
   per-request log. Verified against a real throwaway Postgres: the migration
   applies, the delete cascade works, and a sealed token still opens after a
   database round trip.
2. ~~**Sign-in and printer picker.**~~ **API done; no web page yet.** Six routes
   behind a verified session: ask Bambu to email a code, exchange the code for a
   token, list and choose printers, rotate the key, read the account, delete it.
   The Bambu sign-in is passwordless, so a Bambu password never reaches this
   service (D14). Nothing is kept between the two login steps (D15). What is
   missing is the HTML: a person cannot use this from a browser until there is a
   page, only from a client that can present a token.
3. ~~**Identity.**~~ **Code done; the provider is not provisioned.** Sessions are
   verified locally against the provider's published key set, with the algorithm
   pinned and only the subject kept (D17). The subject is stored as a keyed tag,
   never raw (D16). Provisioning Neon Auth in the owner's project is theirs to
   do, and until `NEON_AUTH_BASE_URL` is set the whole surface answers 404.
4. ~~**Revoke and delete, in the interface.**~~ **Done.** `DELETE /v1/account`
   and `POST /v1/enrol/key`, both behind a session. Proven against a real
   Postgres: the row and its screen go, the retired key stops resolving, another
   identity cannot touch either, and the same person can enrol again.
5. ~~**Rate limits and abuse controls.**~~ **Done.** Two Cloudflare rate-limit
   bindings. The address ceiling sits before the account lookup, so it bounds
   database work rather than relabelling a query already paid for; an
   allowlisted address skips it, which is what `TRMNL_ALLOWED_IPS` is for.
   The account ceiling is keyed by key fingerprint. Proven against a real
   runtime in two runs: with a working database 400 guesses from one address
   all answered 404, and with the database pointed at nothing 300 of 400
   reached Postgres while 100 were refused before it. Sign-up throttling now
   exists as well: `ENROL_LIMITER`, ten attempts a minute per identity,
   consulted before the route can make Bambu send an email.
6. ~~**Publish the recipe.**~~ **Declared, not published.** `plugin/src/settings.yml`
   carries the polling strategy, the header interpolation and the one password
   field. Publishing an Unlisted Recipe is an action in TRMNL's interface, so
   it is the owner's to take.

What remains is a browser page for step 2, and the two things only the owner can
do: provision Neon Auth, and publish the recipe. Nothing else is blocking.

## Known unknowns

What is left is genuinely unknown. Everything the first real run settled has
been moved into `docs/BAMBU-PROTOCOL.md`.

| Unknown | If it goes wrong |
| --- | --- |
| Whether the emailed-code path works for a two-factor account | The owner pastes a token exported from another client; `pnpm setup` already offers that |
| Whether `/user/print` ever carries `progress`, for a cloud-started print | Nothing: MQTT supplies progress, and the hosted tier shows state without a percentage |
| Whether TRMNL's polling reader accepts our payload unchanged | The shape is already flat, which is what it wants; worst case is a thin adapter |
| Whether a hosted account can be enrolled without the user pasting anything | Probably not: they must carry one key from us to TRMNL. One paste is the floor |
| Whether the hosted tier will ever need MQTT | D2 made the client transport-agnostic, so it is an addition rather than a rewrite |
