# Design decisions

Each entry says what was chosen, what it rules out, and why. Research that
supports a decision is cited to `docs/RESOURCES.md` or to the note that
produced it. Where a claim has not been verified against a real account, it
says so.

Last revised: 2026-08-24.

---

## D1. The display never publishes anything to a printer

**Chosen.** The bridge subscribes to Bambu Cloud MQTT and never publishes. Not
to the device request topic, not to any topic.

This has a cost that is easy to miss. X1-class printers send a complete status
object in every report, but P1-class printers send only the fields that
changed. The documented way to obtain a full baseline is to publish a `pushing`
object with `command: "pushall"` to `device/<id>/request`. That is a status
query rather than an actuation, so it is tempting.

It is still a message sent to a printer, and `AGENTS.md` says never send one
over MQTT and says to take the conservative read when sources disagree. So the
answer is no.

The consequence is visible and acceptable: on a P1, a freshly connected bridge
knows nothing until the printer reports something. During an active print the
values we care about — percentage, layer, temperatures — change every few
seconds, so the screen fills in almost immediately. While idle, almost nothing
is reported, and idle is exactly the case where HTTP already tells us
everything we need. Fields we have not been told stay `null`. They are never
filled with a zero.

**Enforced structurally, not by review.** See D2.

## D2. Our own MQTT client, with no publish method at all

**Chosen.** A small MQTT 3.1.1 client covering exactly CONNECT, CONNACK,
SUBSCRIBE, SUBACK, inbound PUBLISH, PINGREQ, PINGRESP and DISCONNECT. No
outbound PUBLISH encoder exists in the codebase.

**Rejected:** the `mqtt` npm package. Three reasons, in order of weight.

1. D1 becomes a property of the type system rather than a rule someone has to
   remember. You cannot publish with a client that cannot encode a publish.
2. The `mqtt` package needs Node's `net` and `tls`. The hosted tier runs on
   Cloudflare Workers, where the only outbound TCP is `connect()` from
   `cloudflare:sockets`. A client written against a duplex byte stream runs on
   both without a second implementation.
3. Subscribe-only MQTT 3.1.1 is a small, fully specified subset. The dependency
   is not carrying much weight here.

The client is therefore transport-agnostic: it is handed a readable and a
writable stream of bytes and does not know what produced them.

## D3. HTTP is the floor and MQTT is the enrichment

**Chosen.** Two independent read paths, merged.

Bambu Cloud HTTP gives printer name, model, online, job name, job status,
progress percentage and start time. It does **not** give layer counts,
remaining time, or temperatures in any endpoint we could find documented.
Those exist only in MQTT reports.

So HTTP alone is a complete, honest product: which printers you have, whether
they are online, what they are printing, and how far along it is. MQTT adds
layer, remaining time, temperatures, stage and HMS alerts on top.

This is what lets the hosted tier ship without a persistent connection, and it
is why the coordinator merges per-field observations from independent providers
instead of picking one source.

## D4. Cadence is five minutes, everywhere

**Chosen.** One push every five minutes, at most.

TRMNL accepts 12 webhook pushes per hour on a standard account and answers 429
above that. Twelve per hour is one every five minutes. There is no point
anywhere in this system for machinery that reacts faster than the only output
can change.

That single number removes a great deal of design. No streaming, no
sub-second update path, no realtime pipeline. It also means the difference
between HTTP polling and a live MQTT subscription is much smaller than it looks:
both are sampled at five minutes before anything reaches a screen.

The bridge pushes when the payload changed, plus a heartbeat push when it has
not, so the freshness stamp on the display stays honest.

## D5. One plugin holds every printer you chose

**Chosen.** A single TRMNL Private Plugin whose payload carries an array of
printers. The four views render one, two or three of them at different
densities.

**Rejected:** one plugin per printer. It multiplies the setup the user has to
do by the number of printers they own, spends a separate rate-limit budget per
printer, and it is not how TRMNL playlists compose — `half_horizontal` and
`quadrant` are alternative renderings of *our* plugin when it shares a screen
with someone else's, not slots we can fill with one printer each.

Three printers is the practical ceiling for a screen this size. Beyond three the
plugin shows the three most interesting — printing before idle, idle before
offline — and says how many it left out.

## D6. Hosted runs on a cron, not on a socket

**Chosen.** A Cloudflare Worker with a five-minute Cron Trigger, reading from
Neon, pushing to TRMNL. No Durable Objects and no persistent connections in the
first hosted version, which follows directly from D3 and D4.

An open TCP socket inside a Durable Object keeps that object resident and
billable for up to 15 minutes per connection, and a persistent connection per
user is a standing liability against a cloud service that has previously
temporarily banned accounts for excessive concurrent MQTT connections. A cron
that wakes, reads HTTP, and exits has none of that.

MQTT can be added to the hosted tier later without changing the contract,
because D2 made the client portable. It is not needed for the product to work.

## D7. Self-hosting shares the code and shares nothing else

**Chosen.** The bridge core — providers, normalizers, coordinator, payload
builder — is one body of code with two entrypoints. The self-hosted entrypoint
talks to Bambu Cloud and to the user's own TRMNL webhook, and has no notion
that a hosted backend exists. There is no phone-home, no telemetry, and no
shared identifier.

## D8. Two-factor accounts sign in with an emailed code

**Chosen.** When Bambu answers a password login with `loginType: "tfa"`, the
bridge asks Bambu to email a verification code and completes the login with
that code.

**Rejected:** calling the two-factor endpoint. It is worth explaining why,
because the obvious reading is that we are skipping the correct path.

The endpoint lives on the website host, `bambulab.com/api/sign-in/tfa`, not on
the API host the rest of the login uses. As of 2026-08-01 it rejects every
submission with HTTP 403 and a body naming `missing_cookie`: it wants a CSRF
cookie that the API-host login sequence never issues. The rejection happens
before the code is even looked at. On top of that, when it did work it returned
the token in a `Set-Cookie` header rather than the JSON body, so supporting it
means a second host, a cookie jar, and header plumbing — all to reach a code
path that currently cannot succeed.

The emailed-code exchange runs on the API host we already use, needs no
cookies, and is the path the Home Assistant integration fell back to when it
hit the same wall. So that is the path.

If Bambu repairs the endpoint, nothing here breaks; users with two-factor
enabled keep signing in by email code. If we later want the authenticator app
back, it is an additive change.

Source: `docs/RESOURCES.md` [22] and the ha-bambulab change dated 2026-08-01,
read for behaviour only. Not yet confirmed against a real account — see
`docs/PLAN.md` for what the owner needs to test.

## D9. An access token is opaque until proven otherwise

**Chosen.** The bridge accepts any non-empty access token. It reads the MQTT
username from the token payload when the token happens to be a readable JWT,
and otherwise asks the cloud for the account's numeric id.

The earlier code required three dot-separated segments before it would store a
token. Bambu's current documentation says the MQTT username is no longer
carried in access tokens, which strongly suggests the token format has already
changed at least once. A validator that rejects a token the cloud just issued
is worse than no validator, so the shape check is a hint used for parsing and
never a gate on acceptance.

## D10. No LAN, ever, and the code says so

**Chosen.** Bambu Cloud is the only data source. Earlier revisions of this
repository designed for a hybrid LAN and cloud bridge, and some strings and
types survived the change of direction. They are being removed rather than left
to mislead.

A user whose printer is in LAN-only mode cannot use this plugin, because
LAN-only mode is precisely the setting that stops the printer talking to the
cloud. That is stated plainly in the README rather than worked around.

## D11. Hosted is pulled by TRMNL; self-hosted pushes

**Chosen.** The hosted tier serves a JSON endpoint that TRMNL fetches on the
plugin's own schedule, using TRMNL's Polling strategy. The self-hosted bridge
keeps pushing to a webhook.

`docs/TRMNL-PLUGIN.md` originally ruled polling out, and its reasoning was
sound at the time: TRMNL cannot reach a printer on someone's home network. That
reason died with the LAN transport. Nothing about the hosted tier is on a
private network — it is a Worker on the public internet — so TRMNL can reach it
perfectly well.

Pulling is better for the hosted tier in four ways, and the fourth is the one
that matters:

- The twelve-pushes-an-hour ceiling stops applying, because we are not pushing.
  TRMNL fetches at the plugin's refresh interval, and the cron, the sliding-hour
  budget and the change detection all become unnecessary on this path.
- TRMNL already skips regenerating a screen when the merge variables have not
  changed, so the deduplication we built is duplicated work here.
- The endpoint can be locked to TRMNL's published server addresses.
- **We stop holding the user's webhook URL.** That URL is a bearer credential
  for their display: anyone with it can draw anything on their screen. Under
  polling we never receive it, never store it, and cannot leak it. One fewer
  credential in the database is worth more than any of the above.

The push path stays exactly as it is for self-hosting, where TRMNL genuinely
cannot reach the bridge. Both remain first-class, which is the requirement.

The payload shape needs no change: TRMNL's polling reader wants merge variables
at the root of the response, and `WebhookVariables` is already flat.

## D12. Users sign in with an identity provider, not a bare key

**Chosen.** The hosted sign-in goes through a hosted identity provider offering
social and passwordless email, so the user clicks once rather than inventing
another password.

**Rejected:** making the polling key the only identity. It is tempting, because
it removes an entire account-creation step from a product whose whole promise is
that there is nothing to set up. But `AGENTS.md` requires hosted identity to
come from a provider, and that rule is not mine to trade away for convenience.

It is also the weaker design once the key has to live in a TRMNL form field: a
capability that is simultaneously the credential and the account has nothing to
fall back on when it leaks, and no way for its owner to prove they are its
owner. The friction the rule costs is one click on a provider the user already
has an account with.

So the key stays a narrow read capability — it returns one account's display
payload and nothing else — and the account behind it is owned by an
authenticated identity that can rotate it, revoke it, and delete everything.
