# Hosted tier

The hosted tier is the install-nothing form of the plugin, as a TRMNL
third-party plugin. A Cloudflare Worker wakes on a five-minute Cron Trigger,
reads each selected printer through Bambu Cloud's HTTP interface, builds the
same normalized payload as the self-hosted bridge, and stores it. TRMNL POSTs to
`/trmnl/markup` with its per-installation Bearer token on whatever schedule the
user chose, and the Worker renders the stored payload through the repository's
own Liquid templates into the four layout fragments TRMNL wants. It never sends
a request or command to a printer.

**Identity is TRMNL's.** Installing the plugin redirects the user here with a
single-use code; the Worker exchanges it at `trmnl.com/oauth/token` for the
installation's access token and keeps only a keyed HMAC tag of it. The setup
page holds a short-lived management token signed with the same keyring. There is
no sign-up, no password, no verification email and no screen key: the entire
account system this replaced is gone, and `src/trmnl.ts` is what stands in its
place. Bambu sign-in is unchanged and separate — it is the printer credential,
an emailed code, never a password.

**The cron and collector write, the markup route reads**, and that separation is
the design rather than an implementation detail. TRMNL asks on a schedule the
user controls, so a route that read Bambu on demand would let one user's refresh
setting decide how hard we hit Bambu, would put two cloud round-trips inside
TRMNL's request timeout, and would let anyone holding a token generate Bambu
load at will. Serving a stored render makes Bambu's load a function of our own
schedule alone.

Because TRMNL pulls, **we never receive the user's webhook URL** — the bearer
credential that authorizes drawing on their display. It is not in the schema and
cannot leak from here. See `docs/DECISIONS.md` D11.

Neon stores TRMNL installations (as token tags, never tokens), account
configuration, sealed Bambu Cloud tokens, and the rendered screens. Tokens are
encrypted with AES-256-GCM before they reach Postgres, with the account id
authenticated as additional data so moving ciphertext between accounts yields
nothing usable. Device ids are printer identifiers; they may never be logged.

## Install and check

From this directory:

```sh
pnpm install
pnpm typecheck
pnpm test
```

Node 22.18 or newer is required. Local tests use the complete in-memory store and do not contact Neon, Bambu Cloud, or TRMNL.

## Apply the migrations

`migrations/` is plain Postgres SQL, numbered; apply in order. Either method:

1. Open the Neon SQL Editor for the intended branch, paste each migration, and run it.
2. Configure a direct, non-pooled connection as a libpq service and run, from the repository root:

   ```sh
   PGSERVICE=your-direct-neon-service psql -v ON_ERROR_STOP=1 \
     -f hosted/migrations/0001_initial.sql \
     -f hosted/migrations/0002_trmnl_installations.sql
   ```

An existing deployment that ran 0001 needs only 0002. It creates the
installations table and drops the screen-key column, which is not reversible:
every stored screen key stops resolving, which is the point of the conversion.

Use Neon's direct endpoint for migrations, not the hostname ending in `-pooler`. Keep the password in `.pgpass` or another credential manager rather than in the command line, shell history, or this repository. Test migrations on an isolated Neon branch before applying them to production.

The application itself may use Neon's pooled `DATABASE_URL`; each Worker invocation uses the serverless driver's one-shot HTTP transport rather than a session.

## Configure encryption

The Worker expects:

- `DATABASE_URL`: a Worker secret containing the application connection string.
- `TOKEN_KEY_K1`: a Worker secret containing a base64 AES-256 key.
- `TOKEN_KEY_CURRENT_ID`: the non-secret key id `k1` in Worker configuration.

Both secrets are listed in `secrets.required` in `wrangler.jsonc`, so a deploy
that is missing one fails rather than shipping a Worker whose cron cannot open a
single stored token. There is no identity-provider setting: identity is TRMNL's,
established per installation during the install handshake.

### The first deploy

`wrangler secret put` cannot be used before the Worker exists — there is nothing
to attach a secret to, and it fails saying so. The first deploy therefore supplies
them from a file, which is the same format `.dev.vars` already uses:

```sh
pnpm exec wrangler deploy --secrets-file .dev.vars
```

Keep that file out of Git; `.gitignore` already covers `.dev.vars*`.

### Afterwards

Once the Worker exists, set or replace one secret at a time through Wrangler's
prompt, which keeps the value out of shell history and process arguments:

```sh
pnpm exec wrangler secret put DATABASE_URL
```

Generate a key with Web Crypto and send it directly to Wrangler without writing
it to a file or placing it in a process argument:

```sh
pnpm --silent hosted:key | pnpm exec wrangler secret put TOKEN_KEY_K1
```

`pnpm hosted:key` prints a fresh key when an operator needs to transfer it
through an approved secret manager. Treat that output as a production credential:
do not paste it into chat, tickets, logs, shell arguments, environment examples,
or Git. Cloudflare Worker secrets are the key-management boundary; Neon holds
only the key id, nonce, and authenticated ciphertext.

**A replacement `TOKEN_KEY_K1` is not a recoverable mistake.** Every stored token
is sealed with the key that was current when it was written, so installing a
different one under the same id does not fail loudly — it silently orphans every
existing enrolment, and no later deploy undoes it. Rotation exists for this and
is additive; see below.

Set `TOKEN_KEY_CURRENT_ID` to `k1` in the Worker's non-secret variables. The key
id is intentionally meaningless and is safe to store with each ciphertext.

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
| Written, current threat model | **Met, pending external review.** [`SECURITY.md`](../SECURITY.md) covers the TRMNL installation token, the management token, the database leak inventory including the installations table, telemetry-as-presence-data, and the collector host. The screen-key entries were replaced when the credential was. It has had no external review, which is the remaining honest gap. |
| User revocation and deletion that actually deletes | **Met.** Uninstalling the plugin in TRMNL fires `POST /trmnl/uninstall`, which deletes the account, its rendered screen (`ON DELETE CASCADE`) and the installation row, verified against real Postgres with raw row counts. `DELETE /v1/account` does the same for the account alone, behind a verified management token, and the installation can enrol again because nothing tombstones the owner tag. |
| Per-account rate limits and abuse controls | **Met for the surface that exists.** `SCREEN_ADDRESS_LIMITER` is keyed by client address and consulted before any `/trmnl/` route can reach the database, so anonymous probing is bounded before it is paid for. `ENROL_LIMITER` bounds what one installation can make Bambu do, keyed by owner tag, consulted before Bambu is asked to send mail. |
| Never log a token, email, device id, or webhook URL | **Met by the modules currently here.** All logging goes through `src/log.ts`, whose detail type admits only strings, numbers, booleans and null. `src/worker.ts` builds every line through the single exported `cycleLogDetail`, which emits exactly four fields, and `test/worker.test.ts` asserts against that exact function. The TRMNL and enrolment surfaces log nothing at all, and every credential travels in an `Authorization` header or a URL fragment — never a query string — so platform request logging cannot record one. |
| Identity from a hosted provider; no stored passwords | **Met, by TRMNL.** Identity is the TRMNL installation itself: a per-installation access token minted by TRMNL during the install handshake, stored here only as a keyed HMAC tag, verified on every request. There is no account database of ours, no password is stored, asked for, or accepted anywhere, and the hosted Bambu sign-in uses an emailed code, so a Bambu password never transits this service either (see `docs/DECISIONS.md` D14). |

The Worker, database, secrets and schedules are not provisioned by this repository. The owner performs resource creation and deployment only after the unmet launch gates are closed and the hosted stack has received a security review.
