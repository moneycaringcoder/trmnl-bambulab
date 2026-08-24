# Hosted tier

The hosted tier is the install-nothing form of the plugin. A Cloudflare Worker wakes on a five-minute Cron Trigger, reads each selected printer through Bambu Cloud's HTTP interface, builds the same normalized payload as the self-hosted bridge, and pushes it to the user's TRMNL Private Plugin. It never sends a request or command to a printer.

Neon stores account configuration, sealed Bambu Cloud tokens, and durable push-scheduler state. Tokens are encrypted with AES-256-GCM before they reach Postgres. The account id is authenticated as additional data, so moving ciphertext between accounts does not produce a usable token. Device ids are identifiers and webhook URLs are bearer credentials; neither may be logged.

## What works and what does not, plainly

The push engine is complete: given a row in `accounts`, the cron opens the token, reads the cloud, builds the payload and pushes it, respecting the same twelve-per-hour ceiling as the self-hosted bridge. It is tested against a complete in-memory store and the Worker bundles cleanly.

**Nothing creates that row yet.** There is no sign-in flow, no printer picker, and no self-service revoke or delete endpoint, so a freshly deployed Worker would have no accounts and would do nothing on every cron tick. Enrolment needs an identity provider provisioned in the owner's Neon project, which only the owner can do. Read the obligation table at the bottom of this file before deploying anything: two of the six hosted gates in `AGENTS.md` are still open, and they are the two that matter for anyone other than the owner.

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
| Written, current threat model | **Partly met.** [`SECURITY.md`](../SECURITY.md) documents token, webhook, and telemetry exposure, and this document adds database and key-rotation handling. It must be reviewed whenever hosted identity, onboarding, deletion, or deployment changes. |
| User revocation and deletion that actually deletes | **Storage primitive met; user flow not yet met.** `deleteAccount` physically deletes the account and the schema cascades to scheduler state. No authenticated user-facing revoke/delete endpoint exists yet, so this remains a launch blocker. |
| Per-account rate limits and abuse controls | **Rate-limit persistence is present; broader abuse controls are not yet met.** Each account has explicit push and payload ceilings and durable scheduler state. Signup throttling, identity-scoped request limits, and operational abuse controls still need implementation and verification before launch. |
| Never log a token, email, device id, or webhook URL | **Met by the modules currently here.** All logging goes through `src/log.ts`, whose detail type admits only strings, numbers, booleans and null, so an account object or a response body cannot be handed to it. `src/worker.ts` builds every line through the single exported `cycleLogDetail`, which emits four fields: a hashed account tag, a fixed outcome token, a fixed reason token and a byte count. A test asserts against that exact function rather than a copy of it, so adding a fifth field fails the suite. `src/crypto.ts` and both stores contain no logging path at all, row-drift reasons name a column and never an account id, and every catch in the Worker logs a fixed message rather than an error's text. This must be re-audited when the sign-in flow lands, because that is where an email first enters the system. |
| Identity from a hosted provider; no stored passwords | **Not yet met.** Hosted identity and onboarding are not implemented. The schema stores neither passwords nor verification codes, but the required identity-provider flow remains a launch blocker. |

The Worker, database, secrets, schedules, and identity provider are not provisioned by this repository. The owner performs resource creation and deployment only after the unmet launch gates are closed and the hosted stack has received a security review.
