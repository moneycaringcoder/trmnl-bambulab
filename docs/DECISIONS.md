# Design decisions

Each entry says what was chosen, what it rules out, and why. Research that
supports a decision is cited to `docs/RESOURCES.md` or to the note that
produced it. Where a claim has not been verified against a real account, it
says so.

Last revised: 2026-08-25.

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

Bambu Cloud HTTP gives printer name, model, connectivity, and coarse job state.
Real responses did not provide reliable live progress, layer counts, remaining
time, or temperatures. Those richer fields arrive in MQTT reports.

HTTP alone is still an honest floor: which printers are selected, whether they
are reachable, and their best-known coarse state. MQTT adds progress, layers,
remaining time, temperatures, stage, filament, and HMS alerts.

This is what lets the hosted tier ship without a persistent connection, and it
is why the coordinator merges per-field observations from independent providers
instead of picking one source.

## D4. Cadence is five minutes, everywhere

**Superseded in part by D18.** The self-hosted Webhook push and the hosted HTTP
cron still run at most every five minutes. The optional collector writes rich
MQTT snapshots more often so the next TRMNL markup request sees recent data.

The original choice was one output update every five minutes at most. TRMNL
accepts 12 webhook pushes per hour on a standard account and answers 429 above
that; twelve per hour is one every five minutes.

That number removed streaming, sub-second output paths, and realtime delivery
from the bridge and cron. The marketplace conversion later let TRMNL request
markup on the user's chosen schedule, but those requests read a stored payload
and never increase Bambu traffic. The bridge still pushes when the payload
changed, plus a heartbeat when it has not, so the freshness stamp remains honest.

## D5. One plugin holds every printer you chose

**Chosen.** One TRMNL plugin installation carries an array of printers. For
self-hosting that installation is a Private Plugin; for hosted use it is the
marketplace plugin. The four views render one, two, or three printers at
different densities.

**Rejected:** one plugin per printer. It multiplies the setup the user has to
do by the number of printers they own, spends a separate rate-limit budget per
printer, and it is not how TRMNL playlists compose — `half_horizontal` and
`quadrant` are alternative renderings of *our* plugin when it shares a screen
with someone else's, not slots we can fill with one printer each.

Three printers is the practical ceiling for a screen this size. Beyond three the
plugin shows the three most interesting — printing before idle, idle before
offline — and says how many it left out.

## D6. Hosted runs on a cron, not on a socket

**Chosen.** A Cloudflare Worker uses a five-minute Cron Trigger to read Bambu
HTTP and store a normalized payload in Neon. TRMNL's marketplace requests read
that payload and receive server-rendered markup. No Durable Object or persistent
connection runs in the Worker.

An open TCP socket inside a Durable Object keeps that object resident and
billable for up to 15 minutes per connection, and a persistent connection per
user is a standing liability against a cloud service that has temporarily banned
accounts for excessive concurrent MQTT connections. A cron that wakes, reads
HTTP, stores, and exits has none of that.

MQTT enrichment was later added through the optional collector in D18 rather
than through persistent Worker connections. The HTTP cron remains the fallback,
so the product still works without the collector.

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
read for behaviour only. The emailed-code path was later confirmed against a
real account; D14 records that result.

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
**Superseded by D19.** This was the previous hosted delivery design; it remains
here because the credential and rate-limit reasoning informed the replacement.


**Earlier choice.** The hosted tier served a JSON endpoint that TRMNL fetched on
the plugin's own schedule using the Polling strategy. The self-hosted bridge
continued pushing to a webhook.

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
**Superseded by D19.** The marketplace installation is now the hosted identity,
so this provider and the polling key no longer exist.


**Earlier choice.** Hosted sign-in went through an identity provider offering
social and passwordless email, so the user clicked once rather than inventing
another password.

**Rejected at the time:** making the polling key the only identity. It was
tempting because it removed an account-creation step, but the project required
hosted identity to come from a provider. That requirement was non-negotiable
within the polling design.

It is also the weaker design once the key has to live in a TRMNL form field: a
capability that is simultaneously the credential and the account has nothing to
fall back on when it leaks, and no way for its owner to prove they are its
owner. The friction the rule costs is one click on a provider the user already
has an account with.

So the key stays a narrow read capability — it returns one account's display
payload and nothing else — and the account behind it is owned by an
authenticated identity that can rotate it, revoke it, and delete everything.

## D13. The rate ceiling sits before the query, not after it
**Superseded in part by D19.** The marketplace conversion deleted the screen
endpoint and account-key limiter. Its address-first principle remains in use for
the anonymous `/trmnl/` surface.


**Earlier choice.** `GET /v1/screen` was guarded by two Cloudflare rate-limit
bindings:
- **`SCREEN_ADDRESS_LIMITER`**, keyed by client address, consulted **before** the
  account lookup, and skipped entirely for an allowlisted address. 300 per
  minute per Cloudflare location.
- **`SCREEN_ACCOUNT_LIMITER`**, keyed by the account's key fingerprint, consulted
  after the account resolves. 120 per minute.

**Placement is the entire decision, and the first version got it wrong.** That
version counted only requests that *failed* to resolve, so TRMNL — which always
presented a valid key — could never be throttled by an address-keyed counter.
The placement had two faults:

- It bounded nothing. The counter sat *after* `accountByScreenKey`, so a refused
  request had already paid for its database query. The limiter changed a status
  code and nothing else. A control that looks protective while protecting
  nothing is worse than no control, because it stops anyone looking again.
- It leaked key validity. Once an address had spent its budget, a key that did
  not resolve answered `429` while a key that did answered `404` or `200`. That
  is precisely the oracle the uniform 404 exists to prevent, and the limiter
  introduced it.

So the counter moved before the lookup, which is the only position from which it
can bound what an anonymous caller costs us. That placement necessarily counts
every caller, TRMNL included, because whether a key is real is exactly what the
lookup is for and no cheaper signal exists beforehand.

**The allowlist is what makes that safe, so it stops being decorative.** An
allowlisted address skips the counter, which is an exact exemption rather than a
guess about someone else's traffic. Until `TRMNL_ALLOWED_IPS` is populated the
ceiling is sized for TRMNL at scale rather than for one user: 300 per minute per
location, against a fifteen-minute plugin refresh, is a few thousand accounts
per location before legitimate polling could approach it.

**Only the account ceiling answers `429`.** Reaching it requires already holding
that account's key, so the status tells its holder nothing new. The address
ceiling answers the same `404` as every other refusal, and `ScreenOutcome`
keeps `address-limited` distinct from `unknown-key` internally so the two stay
diagnosable without becoming distinguishable on the wire.

**A shape check before either.** A screen key is exactly 43 base64url
characters, and anything else is refused without consuming budget or a query, so
arbitrary junk costs a string comparison. It is not a security boundary: a
well-formed guess is still looked up. It reveals the key *format*, through
latency and through the 503-versus-404 split when the database is unavailable,
and the format is public anyway. Key *validity* stays hidden.

**Rejected: a Durable Object.** The more powerful tool and the obvious reach,
but wrong here. It adds a network hop to every poll and storage to maintain, in
exchange for exact global counting we have no use for — these are cost guards,
not billing. The platform binding runs in-process, needs no storage, and its
per-location approximation is the documented trade-off. A sign-up throttle will
probably need exactness; that is the point to reconsider, per surface rather
than for the whole tier.

**Both limiters fail open.** Failing open on a security control is normally
wrong, so the reasoning is written down: this is a volume guard, not
authentication. The key is the authentication. A limiter fault that failed
closed would blank every customer's display at once, turning an abuse control
into an outage, while failing open degrades to the unlimited behaviour this tier
had before any limiter existed.

**Verified by execution in two separate runs**, against `wrangler dev` and a real
throwaway Postgres, because the fault this decision corrects was invisible to a
test with a fake limiter. The two runs answer different questions and neither
could answer both.

- *Working database.* 400 well-formed guesses from one address all answered
  `404`, with no `429` anywhere, so no status distinguishes a live key from a
  dead one. This run cannot show where the ceiling fell — that it cannot is the
  property being tested.
- *Unreachable database.* Pointing the Worker at a dead Postgres turns "did we
  run the query" into an observable status, since a request that reaches the
  database can only fail. Of 400 guesses from one address, exactly 300 answered
  `503` and the remaining 100 answered `404`, so the ceiling stopped 100 queries
  that the earlier design would have paid for. A fresh address was served
  straight through, so the counters are per address.

Separately, 200 concurrent valid polls spread across 200 different client
addresses: 119 served and 81 refused with `429`. The account ceiling is
therefore keyed by the account and varying the address does not evade it. 119
rather than the configured 120 because a poll from the preceding check was still
inside the window; the figure is what was measured, not the theoretical number.

**One residual distinguisher, accepted knowingly.** `readScreen` runs only after
a key has resolved, and any throw out of `serveScreen` becomes a `503` rather
than the uniform `404`. So a fault isolated to reading screens — a statement
timeout, a lost table permission — would answer `503` for a key that resolves
and `404` for one that does not. It is not reachable through any caller-supplied
input, only through abnormal server state, and reaching it at all requires
already holding a 256-bit key, at which point a `200` would have said more. The
alternative is to answer `404` when the database fails, which would hide a real
outage from whoever has to fix it. Honest failure signalling is worth more than
closing a distinguisher that needs the key it would reveal.

**Since superseded:** sign-up throttling now exists, because sign-up does. See
D15 for `ENROL_LIMITER`.

## D14. Hosted sign-in never sees a Bambu password

**Chosen.** The hosted enrolment flow authenticates against Bambu with an
emailed code and never asks for a password. Bambu's `sendemail/code` endpoint
takes an address and a `codeLogin` type, and its login endpoint accepts that
address plus the code, so the code is a complete credential rather than only a
second factor.

`AGENTS.md` says a password is used for one request and discarded. Not receiving
one is strictly better than discarding one carefully: there is no window in which
it exists in our process, nothing to get wrong in an error path, and nothing for
a future logging change to leak. The self-hosted bridge keeps its password entry
point, because it runs on the user's own machine and one request beats waiting
for an email.

**Confirmed against a real account, 2026-08-25.** This was the last unverified
assumption in the hosted design, and it held: a sign-in that supplied only an
email address received a code, the code was accepted, and the printers on that
account were listed. No password was requested at any point. The hosted tier
therefore never needs one, and the fallback that would have been required if
Bambu had refused is not needed.

## D15. Login state lives in the browser, not on the server

**Chosen.** The two-step sign-in keeps nothing between the steps. The only thing
the second step needs from the first is the email address, which the browser
already has, so there is no server-side login session.

Nothing expires or needs cleanup, and no half-finished login sits in server
storage. A caller who fabricates the intermediate step gains nothing: they still
need the code Bambu emailed to that address, and Bambu checks it.

What this *does* create is an open relay risk: without a gate, anyone could make
Bambu email anyone repeatedly. Two things close it. Every enrolment route
requires a valid short-lived management token for an installed TRMNL plugin, so
there is no anonymous path; and `ENROL_LIMITER` bounds one installation to ten
attempts a minute, keyed by its owner tag.

**It fails closed, unlike the anonymous TRMNL address limiter.** The address
limiter fails open because a fault there costs database work, while failing
closed would stop markup for every installation. `ENROL_LIMITER` is the sole
bound on how often the service can make Bambu send email, so a fault must stop
enrolment rather than remove the bound. The blast radius is asymmetric: new
enrolment pauses while already configured displays keep using the independent
markup route.

Two consequences worth stating. The binding is **required by the type**, not
optional: it was optional so tests could omit it, which made the guarantee
depend on configuration, and dropping the entry from `wrangler.jsonc` would have
removed the bound silently — the same class of mistake as the fault the guarantee
exists to prevent. And the printer picker is metered too, because it also calls
Bambu; it cannot send mail, so it is a smaller exposure, but an unmetered
authenticated path to repeated cloud calls is exactly the loop `store.ts` warns
earns an account a ban.

The ten-a-minute figure is per Cloudflare location, not global. Cloudflare
documents the binding as per-location and eventually consistent, and explicitly
not an accounting system, so this is a cost and nuisance guard rather than a
quota.

## D16. The identity subject is stored as a keyed tag, never raw
**Superseded by D19.** The raw identity-provider subject no longer exists. The
current `owner_tag` is derived from the TRMNL installation id, while the keyed
tag and key-separation reasoning below still applies.


**Earlier choice.** An account's owner was stored as `owner_tag`, an HMAC-SHA256
of the identity provider's `sub` under a key derived from the token-encryption
secret by HKDF with a distinct label. The raw subject was never written down.

**Why keyed rather than hashed.** Neon documents that `sub` is the
`neon_auth.user.id` and shows UUID-shaped examples, but it does not document the
generator, the length, or any entropy guarantee; upstream Better Auth's default
is a 32-character alphanumeric id, which is evidence about self-hosted Better
Auth and not a promise about Neon's managed configuration. If that value were
ever low-entropy or guessable, a bare SHA-256 would be reversible by dictionary
attack and a database leak would name everyone who holds an account here. An
HMAC under a key that lives in Worker secrets rather than in the database removes
that, and costs nothing.

**Why HKDF rather than reusing the encryption key.** One key for both encryption
and a MAC is the shortcut that has broken real protocols; the two algorithms
assume different things about what an attacker may observe. A derivation with a
distinct label keeps them independent for the price of one function call.

**Rotation.** A tag is a lookup value, so it cannot be recomputed after a key
rotation without the original subject, which is deliberately not kept. So
`accountByOwner` takes every tag the subject could be stored under and matches
any of them, rather than storing a key id per row. The label is a constant baked
into every stored tag and must never change.

`owner_tag` is `UNIQUE`: one signed-in person has one account. That is a product
decision as much as a constraint — this plugin shows up to three printers on one
screen, so a second account for the same person would be a second display.

## D17. Sessions are verified locally against a published key set
**Superseded by D19.** The marketplace install token replaced provider sessions,
so there is no JWKS or hosted session verifier in the current system.


**Earlier choice.** A signed-in browser sent a short-lived Ed25519 token; the
Worker verified it against the provider's JWKS with no provider call on the
request path. `iss` and `aud` were both derived from the origin of
`NEON_AUTH_BASE_URL`, preventing a verifier from accepting tokens from another
issuer. Neon documented no introspection endpoint, and reading the session row
from Postgres would have put a query on every enrolment request.

Four choices inside that, each with a cheap wrong version:

- **The algorithm is pinned, never read from the token.** A verifier that picks
  its algorithm from the token's own `alg` header lets the sender decide how they
  will be checked. `none`, HMAC and RSA are refused before any key is touched.
- **An unknown key id cannot be used to make us fetch.** Refetching on every
  unknown `kid` is the documented way to pick up a rotation, and left there it is
  also a way for anyone to command one outbound request per forged token. So a
  miss refetches at most once every thirty seconds, which makes a rotation
  invisible while bounding the abuse to two requests a minute. Runtime
  measurement found the original bound was false: the floor exempted an empty
  key cache, so a provider that never yielded a usable key gave every forged
  token its own outbound fetch. The floor became unconditional, and a regression
  test presents twenty forged ids against a failing provider and asserts one
  fetch. The five-minute
  staleness TTL is a separate number: a key we already hold keeps working past
  it, because treating it as an expiry would reject live sessions whenever the
  provider was briefly unreachable.
- **Only the subject survives.** The token also carries `email` and `name`.
  `AGENTS.md` forbids logging an email, and the reliable way to honour that is
  not to carry one: verification returns an opaque subject and discards every
  other claim, so no later caller can leak what it never received.
- **Unconfigured means the surface does not exist.** With no
  `NEON_AUTH_BASE_URL`, every enrolment route answers 404 rather than falling
  back to trusting its caller, so a half-provisioned deployment exposes nothing.

**Three bugs worth recording, because only the real runtime found them.** The verifier
stored the global `fetch` on a field and called it as `this.fetchImpl(...)`,
which invokes it with the wrong receiver. Node tolerates that; the Workers
runtime rejects it. The throw landed in the `catch` that exists to survive a
provider outage, so the key set stayed silently empty and *every* session was
refused as `unknown-key` — with a full unit suite passing. The fix is a wrapper
rather than an assignment.

The second was the same shape. `crypto.subtle.verify` does not merely return
false for a signature of the wrong length: Ed25519 wants sixty-four bytes and
workerd throws on anything else, while Node returns false. Unwrapped, that throw
escaped to the route's outer catch, so a caller sending junk in the signature
segment received `503` — our fault rather than theirs, and a distinguisher
between a malformed signature and a merely wrong one. It is now caught and
treated as a bad signature.

The third was found while fixing the second. `new URL` on the configured base
URL was unguarded, and the Worker builds the verifier *before* the try that
catches configuration failures, so a typo in that setting escaped as an
unhandled exception and a platform `500` rather than the deliberate `503` every
other misconfiguration produces. An unusable base URL is now treated exactly as
an absent one, so the surface answers `404` and exposes nothing; only `http` and
`https` are accepted, because `file:` and `data:` would otherwise parse and then
be fetched.

The lesson is the one the project rules already state: a unit test that never
touches the runtime is not evidence about the runtime. The obvious regression
test for the second bug — presenting a short signature — passes with the fix
reverted because Vitest runs under Node and Node does not throw. The effective
test forces the throw by replacing `crypto.subtle.verify`; reverting the fix
confirms that it fails.

## D18. Public surface on Cloudflare, MQTT on operator-controlled hardware

**Chosen.** The hosted tier keeps its public surface on Cloudflare — the setup
page, TRMNL's install, management, markup, and uninstall routes, the rate
ceilings, and per-installation token verification — and uses an always-on
*collector* running in a container on a machine the operator controls. The
collector holds one MQTT session per hosted account and writes the same
normalized `screens` rows as the cron. See `docs/COLLECTOR.md`.

**The problem it solves.** Bambu's HTTP interface carries no progress, layer,
remaining time or temperature; those come over MQTT, and MQTT wants a socket held
open. So the hosted tier shows a printer's name and that it is printing, and
nothing else, while the self-hosted bridge shows the numbers. That gap is
inherent to a cron, not a bug in one.

**Rejected: a Durable Object per account.** This became technically possible in
June 2026, when Cloudflare made an active outbound `connect()` socket keep a
Durable Object alive. It would work: the MQTT client is already
transport-agnostic and has no publish encoder, so only a workerd TLS transport is
missing. Two things ruled it out. A connection stops holding the object alive
after fifteen minutes, so every account reconnects about four times an hour
forever — modest against Bambu's documented fifty-concurrent limit, but
permanent churn for no gain. And a Durable Object held in memory bills for
duration, continuously, per user: it is renting an always-on process per person
from someone else. If the shape is "one always-on process per user", owning the
hardware is the cheaper end of the same trade.

**Rejected: tunnelling the collector's own HTTP surface.** Exposing the
collector, rather than having it write to Neon, would put an inbound path from
the internet into the operator's home network, and would move the rate limiting
and key checking off Cloudflare onto a self-managed box. The collector makes only
outbound connections instead: Bambu on 8883, Neon over HTTPS. It listens on
nothing.

**The collector does not replace the cron, and that is the whole design.** Both
write `screens`; the cron writes only when the stored render is already stale.
Collector up, the cron finds fresh rows and skips. Collector down, the cron
resumes and the display degrades to HTTP fidelity rather than blanking. So
availability never becomes worse than the cron-only tier that exists today, which
is the property worth protecting — a richer display that can disappear is a worse
product than a thin one that cannot.

**What this obliges.** The collector opens every hosted user's sealed token, so
the machine running it holds the key that decrypts all of them. That is the
Worker's obligation moved onto hardware somebody owns, plus a threat the Worker
does not have: physical access. Disk encryption and a backup story that does not
copy the key stop being paperwork. `SECURITY.md` now carries that threat model,
under "A compromised collector host", along with the scope change it forces: the
old blanket exclusion of local attackers covered a self-hosted user's own
machine, where every credential is already theirs, and it cannot cover a machine
holding other people's.

**The lease needs a real session, and that was nearly missed.** Two collectors
both collecting means two concurrent MQTT connections against one Bambu account,
which is what Bambu bans for, so exclusion is a Postgres session-scoped advisory
lock. The first implementation trusted the lock, and measurement against real
Postgres showed the trust was misplaced: on Neon's `-pooler` host two clients
landed on one backend, the second acquisition re-entered the first's lock, and
both callers held what only one may hold. Silently. So `takeLease` now proves the
session is real — two reads of `pg_backend_pid()` on one connection and one on a
second — and refuses the endpoint otherwise. It proves this with reads rather
than a trial lock, because the trial-lock version stranded a held lock on the
pooler, where `pg_advisory_unlock` lands on whichever backend is free: a control
that caused the outage it was guarding against.

**And a session has to be closable, which was the second thing measured.** The
lock is necessary but not sufficient: losing it has to end the MQTT sessions,
because the lock is already gone by the time a heartbeat notices and a standby
is free to take over. The first implementation discarded the stop handle the
MQTT provider returns, so a collector that lost its lease kept its connections
and kept writing rows that were no longer its to write — the very condition the
lease exists to prevent, reached through the lease's own failure path. The
orchestration now lives in `collector/src/supervise.ts`, where its stop behavior
can be exercised directly.

**Checked rather than assumed.** The hosted data layer runs in plain Node without
modification: `store-neon.ts` and `crypto.ts` were imported into a Node 24
script, which read a real account and opened its real sealed token.
`@neondatabase/serverless` speaks HTTP and `crypto.subtle` is a global, so
neither needs a Workers runtime. The collector is therefore a new entrypoint over
existing parts rather than a second implementation, which is what makes this
worth doing at all.

**Measured, not estimated.** The bridge holding one live MQTT session for an
account with two printers sits at 116 MB resident with 25 open file descriptors.
Bambu's cloud MQTT is one connection per account, so another account costs one
socket and a few kilobytes — about 0.2 MB. 512 MB covers roughly a thousand
accounts. RAM is not the constraint; Neon write rate, file descriptors and
Bambu's tolerance are, in that order.

## D19. Identity is TRMNL's: the hosted tier is a third-party plugin

**Chosen.** The hosted tier speaks TRMNL's marketplace protocol instead of being
a Private Plugin: TRMNL redirects an installing user to us with a single-use
code, we exchange it for a per-installation access token, TRMNL presents that
token on every markup request, and we render the four layout fragments from our
own Liquid templates inside the Worker. `hosted/src/trmnl.ts` is the protocol
and `hosted/src/markup.ts` is the renderer.

**What it deleted.** The entire identity apparatus: Neon Auth (email, password,
verification codes, JWKS verification in `session.ts`) and the screen key with
its rotation, fingerprints and polling endpoint. A user now installs, signs in
to Bambu with an emailed code, and picks printers — no separate account, no
credential to paste into TRMNL, and no key to lose.

**The token is treated like the screen key was.** Stored only as a keyed HMAC
tag; a database leak yields nothing replayable. The setup page gets its own
short-lived management token, signed with the same keyring, delivered in the URL
fragment so no request log anywhere records it — the TRMNL access token itself
never reaches a browser.

**Rendering moved to us, deliberately.** TRMNL's marketplace contract has the
plugin's server return HTML for all four layouts, so the Worker renders the
repository's own `src/*.liquid` through liquidjs, verified against trmnlp's own
renderer as an oracle: identical text content on all four layouts. One design
source for both tiers survives.

**Rejected: keeping both identity systems.** A fallback path that kept screen
keys "just in case" would keep every obligation the keys carried — rotation,
fingerprints, the no-oracle 404 discipline — for a credential with no remaining
legitimate holder. The self-hosted tier never used any of it; its webhook plugin
is untouched.

**Not yet verified against TRMNL's production service.** Three external seams
remain: the live code exchange, the installation-success webhook, and TRMNL's
real markup POST. Everything on this side of each seam is driven by tests using
TRMNL's documented request shapes, and the whole flow ran against real Postgres.
The management route follows TRMNL's documented `?uuid=` flow and falls back to
an explicit open-from-TRMNL state when the UUID is absent or unknown.
