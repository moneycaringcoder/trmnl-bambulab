# Hosted tier

The hosted tier is the install-nothing form of the plugin. A Cloudflare Worker wakes on a five-minute Cron Trigger, reads each selected printer through Bambu Cloud's HTTP interface, builds the same normalized payload as the self-hosted bridge, and stores it. TRMNL then fetches that stored render from `GET /v1/screen` with an `Authorization: Bearer <screen key>` header, on whatever schedule the user's plugin uses. It never sends a request or command to a printer.

The key is a header and never a query parameter, because a credential in a URL is written down by everything the request passes through. TRMNL's Polling strategy interpolates a form field into a header, which is what makes this possible — see `docs/TRMNL-PLUGIN.md`.

**The cron writes and the endpoint reads**, and that separation is the design rather than an implementation detail. TRMNL polls on a schedule the user controls, so an endpoint that read Bambu on demand would let one user's refresh setting decide how hard we hit Bambu, would put two cloud round-trips inside TRMNL's request timeout, and would let anyone holding a key generate Bambu load at will. Serving a stored render makes Bambu's load a function of our cron alone.

Because TRMNL pulls, **we never receive the user's webhook URL** — the bearer credential that authorizes drawing on their display. It is not in the schema and cannot leak from here. See `docs/DECISIONS.md` D11.

Neon stores account configuration, sealed Bambu Cloud tokens, the hash of each screen key, and the rendered screens. Tokens are encrypted with AES-256-GCM before they reach Postgres, with the account id authenticated as additional data so moving ciphertext between accounts yields nothing usable. Device ids are printer identifiers and screen keys are bearer credentials; neither may be logged.

## What works and what does not, plainly

The render-and-serve path is complete and has been exercised against a real throwaway Postgres: the migration applies, `text[]` and `bigint` survive the HTTP driver, the delete cascade removes a rendered screen with its account, the UNIQUE fingerprint constraint refuses a collision, and a sealed token still opens after a database round trip.

**Nothing creates an account yet.** There is no sign-in flow, no printer picker, and no self-service revoke or delete endpoint, so a freshly deployed Worker would have no accounts and would serve 404 to every request. Enrolment needs an identity provider provisioned in the owner's Neon project, which only the owner can do. Read the obligation table at the bottom of this file before deploying anything: two of the six hosted gates in `AGENTS.md` are open — self-service revoke and delete, and identity — and a third, the threat model, is only partly met. Those are the ones that matter for anyone other than the owner.

## Install and check

From this directory:

```sh
pnpm install
pnpm typecheck
pnpm test
```

Node 22.18 or newer is required. Local tests use the complete in-memory store and do not contact Neon, Bambu Cloud, or TRMNL.

## Apply the migration

`migrations/0001_initial.sql` is plain Postgres SQL. Apply it once with either method:

1. Open the Neon SQL Editor for the intended branch, paste the migration, and run it.
2. Configure a direct, non-pooled connection as a libpq service and run, from the repository root:

   ```sh
   PGSERVICE=your-direct-neon-service psql -v ON_ERROR_STOP=1 -f hosted/migrations/0001_initial.sql
   ```

Use Neon's direct endpoint for migrations, not the hostname ending in `-pooler`. Keep the password in `.pgpass` or another credential manager rather than in the command line, shell history, or this repository. Test migrations on an isolated Neon branch before applying them to production.

The application itself may use Neon's pooled `DATABASE_URL`; each Worker invocation uses the serverless driver's one-shot HTTP transport rather than a session.

## Configure encryption

The Worker expects:

- `DATABASE_URL`: a Worker secret containing the application connection string.
- `TOKEN_KEY_K1`: a Worker secret containing a base64 AES-256 key.
- `TOKEN_KEY_CURRENT_ID`: the non-secret key id `k1` in Worker configuration.

Set the database connection through Wrangler's prompt:

```sh
pnpm exec wrangler secret put DATABASE_URL
```

Generate a key with Web Crypto and send it directly to Wrangler without writing it to a file or placing it in a process argument:

```sh
pnpm --silent hosted:key | pnpm exec wrangler secret put TOKEN_KEY_K1
```

`pnpm hosted:key` prints a fresh key when an operator needs to transfer it through an approved secret manager. Treat that output as a production credential: do not paste it into chat, tickets, logs, shell arguments, environment examples, or Git. Cloudflare Worker secrets are the key-management boundary; Neon holds only the key id, nonce, and authenticated ciphertext.

Set `TOKEN_KEY_CURRENT_ID` to `k1` in the Worker's non-secret variables. The key id is intentionally meaningless and is safe to store with each ciphertext.

## Rotate an encryption key

Rotation is additive so old rows remain readable:

1. Generate and install a new secret without removing the old one:

   ```sh
   pnpm --silent hosted:key | pnpm exec wrangler secret put TOKEN_KEY_K2
   ```

2. Keep both `TOKEN_KEY_K1` and `TOKEN_KEY_K2` configured, change `TOKEN_KEY_CURRENT_ID` to `k2`, and deploy the Worker through the owner's normal reviewed process.
3. Confirm new token writes carry key id `k2`. Existing rows remain on `k1` and continue to open because the Worker imports both keys.
4. Do **not** delete `TOKEN_KEY_K1` until every row sealed by it has been replaced or re-encrypted and that fact has been verified. Automated background re-encryption is not implemented yet, so today retirement requires explicit reauthentication or a separate reviewed migration procedure.

A suspected compromise requires rotating immediately, revoking affected Bambu sessions account-side, and treating old ciphertext as exposed. Changing the encryption key does not revoke a Bambu Cloud token.

## Hosted obligations

The hosted obligations in [`AGENTS.md`](../AGENTS.md) are launch gates. Current status is:

| Obligation | Status |
| --- | --- |
| Tokens encrypted at rest with real key management | **Met in code and operations documentation.** AES-256-GCM uses fresh nonces, key ids support overlap during rotation, keys live in Cloudflare Worker secrets, and the schema has no plaintext-token column. Production secret access policy and recovery procedures still require operator configuration. |
| Written, current threat model | **Partly met, and reviewed with this change.** [`SECURITY.md`](../SECURITY.md) documents token, webhook and telemetry exposure, and this document adds database and key-rotation handling. Identity, onboarding and deletion all changed when the enrolment surface landed, so the threat model gained three entries with it: a leaked screen key, a compromised hosted session, and what the hosted database reveals if it leaks. It remains *partly* met because it has had no external review, and it must be revisited again whenever identity, onboarding, deletion or deployment changes. |
| User revocation and deletion that actually deletes | **Met.** `DELETE /v1/account` deletes the signed-in person's account behind a verified session, and `POST /v1/enrol/key` rotates a leaked screen key. Both were driven end to end against workerd, a real Postgres and a real JWKS: after a delete, the account row is gone, the rendered screen went with it through `ON DELETE CASCADE`, the retired key answers 404 at `/v1/screen`, and the same identity can enrol again because no tombstone holds the unique owner tag. A rotation issues a new key, the old one stops resolving immediately, and the chosen printers survive. Another signed-in identity gets 404 for both routes rather than touching the account. |
| Per-account rate limits and abuse controls | **Met for the surface that exists.** Two Cloudflare rate-limit bindings, chosen over a Durable Object because they run in-process, need no storage, and add no hop to every poll. `SCREEN_ADDRESS_LIMITER` is keyed by client address and consulted **before** the account lookup, at 300 per minute per Cloudflare location, so it is a real ceiling on database work rather than a status code applied after the query was already paid for. An allowlisted address skips it, which is why populating `TRMNL_ALLOWED_IPS` from `https://trmnl.com/api/ips` matters: it exempts TRMNL exactly, instead of relying on a limit its traffic never reaches. `SCREEN_ACCOUNT_LIMITER` is keyed by the account's key fingerprint — never the bearer key — at 120 per minute, bounding what one misconfigured plugin or one leaked key can cost. A key that is not 43 base64url characters is refused before consuming either budget or a query. Only the account ceiling answers `429`, because reaching it requires already holding that account's key; the address ceiling answers the same `404` as every other refusal, so no status distinguishes a live key from a dead one. Both of those two fail *open* deliberately: they are volume guards rather than authentication, and failing closed on a limiter fault would blank every display at once. Verified against a real runtime and a real Postgres, in two runs, because neither could answer both questions: with a working database 400 guesses from one address all answered `404`, proving no status distinguishes a live key from a dead one; with the database deliberately unreachable, which is the only way to observe where the ceiling fell, exactly 300 of 400 reached the database and 100 were refused before it. While `TRMNL_ALLOWED_IPS` is empty, note that TRMNL's polling for every account counts against its own small set of egress addresses at this ceiling, which is the practical reason to populate it before the tier carries more than a handful of accounts. Sign-up throttling now exists too, and it makes the opposite choice on failure: `ENROL_LIMITER` bounds one identity to ten enrolment attempts a minute per Cloudflare location, keyed by their owner tag, and **fails closed**. That is deliberate and is not an inconsistency with the sentence above: there a limiter fault costs only our own database work, whereas this limiter is the only bound on how often we can make Bambu email an arbitrary address, so a fault must stop us rather than free us. New enrolment pauses; every display already configured keeps working, because it polls a different route with a different limiter. It is consulted before any Bambu call on all three routes that make one — the two sign-in steps and the printer picker — so it bounds the outbound request and not merely our own status code, and the binding is required by the type rather than optional, so dropping it from configuration cannot silently remove the bound. Verified end to end: the eleventh attempt in a minute answered `429` and never reached Bambu. |
| Never log a token, email, device id, or webhook URL | **Met by the modules currently here.** All logging goes through `src/log.ts`, whose detail type admits only strings, numbers, booleans and null, so an account object or a response body cannot be handed to it. `src/worker.ts` builds every line through the single exported `cycleLogDetail`, which emits exactly four fields: a hashed account tag, a fixed outcome token, a coarse cloud status and a byte count. `test/worker.test.ts` asserts against that exact function rather than a copy of it, so adding a fifth field fails the suite. The screen endpoint logs nothing at all, and the key travels in an `Authorization` header rather than a query string so that Cloudflare's own request logging could not record it even if it were on — and it is off, via `observability.logs.invocation_logs`, which has to sit under `logs` because Wrangler silently discards it one level higher. `src/crypto.ts` and both stores contain no logging path, row-drift reasons name a column and never an account id, and every catch in the Worker logs a fixed message rather than an error's text. The sign-in flow has now landed and was re-audited with it: `src/session.ts`, `src/routes.ts` and `src/enrol.ts` contain no logging call at all, which is how the email address and the identity subject that now enter the system stay out of the log. Session verification returns only an opaque subject, dropping the token's `email` and `name` claims, so a later caller cannot log what it never received, and `CloudError` carries a status and a category but never a Bambu response body. |
| Identity from a hosted provider; no stored passwords | **Code complete and verified against the real provider; onboarding UI still missing.** Enrolment is behind a verified Neon Auth session: `src/session.ts` checks a short-lived Ed25519 token against the provider's published key set, pinning the algorithm rather than reading it from the token, deriving both the expected issuer and audience from `NEON_AUTH_BASE_URL`, and returning only an opaque subject so the `email` and `name` claims cannot reach a log. No password is stored, asked for, or accepted anywhere: the hosted Bambu sign-in uses an emailed code, so a Bambu password never transits this service either (see `docs/DECISIONS.md` D14). With `NEON_AUTH_BASE_URL` empty the whole enrolment surface answers 404 rather than trusting its caller. Forgeries were refused in the real runtime — `alg: none`, an HMAC signature, a genuine signature under a substituted key id, a tampered payload, a foreign issuer, an expired token and an unknown key id. Neon Auth is now provisioned on the owner's project and the Worker was driven against it: a token minted by the real provider was accepted and resolved to its subject, while a junk signature, an empty signature, a 63-byte signature and a swapped payload were each refused with 401. That run is also what exposed the throwing-`verify` defect described in `docs/DECISIONS.md` D17. Sign-up requires email verification, which matters here because an unverified identity would let one person mint unlimited identities and so defeat the per-identity enrolment limiter. What remains is a browser page: the API is reachable only by a client that can already present a token. |

The Worker, database, secrets, schedules, and identity provider are not provisioned by this repository. The owner performs resource creation and deployment only after the unmet launch gates are closed and the hosted stack has received a security review.
