# Hosted tier

The hosted tier is the install-nothing form of the plugin, published as a TRMNL
third-party plugin. A Cloudflare Worker wakes on a five-minute Cron Trigger,
reads each selected printer through Bambu Cloud's HTTP interface, builds the
same normalized payload as the self-hosted bridge, and stores it. TRMNL POSTs to
`/trmnl/markup` on each installation's refresh schedule, using its
per-installation Bearer token, and the Worker renders the stored payload through
the repository's Liquid templates into the four layout fragments TRMNL expects.
We never send a request or command to a printer.

**Identity is TRMNL's.** During installation, TRMNL redirects the browser here
with a single-use code; the Worker exchanges it at `trmnl.com/oauth/token` for
the installation's access token and keeps only a keyed HMAC tag of it. The
setup page holds a short-lived management token signed with the same keyring.
We have no separate account system, password, verification email, or screen
key; `src/trmnl.ts` handles installation identity. Bambu sign-in is separate:
it uses an emailed code, never a password.

**The cron and collector write, the markup route reads**, and that separation is
part of the service contract. A markup route that read Bambu on demand would
let an installation's refresh setting decide our Bambu request rate, put two
cloud round trips inside TRMNL's request timeout, and allow a stolen
installation token to generate Bambu load. Serving a stored render keeps that
load on our five-minute schedule.

Because TRMNL pulls, **we never receive a webhook URL** — the bearer credential
that authorizes drawing on a display. Keeping it out of our schema removes a
display credential we would otherwise have to protect.

We store TRMNL installations in Neon as token tags, never tokens, along with
account configuration, sealed Bambu Cloud tokens, and rendered screens. We
encrypt tokens with AES-256-GCM before they reach Postgres and authenticate the
account id as additional data, so moving ciphertext between accounts yields
nothing usable. Device ids are printer identifiers; we never log them.

## Install and check

Node 22.18 or newer is required. From the repository root, enable Corepack and
install both package trees: the hosted tier imports shared bridge modules from
source.

```sh
corepack enable
pnpm --dir bridge install --frozen-lockfile
pnpm --dir hosted install --frozen-lockfile
pnpm --dir hosted typecheck
pnpm --dir hosted test
```

Local tests use the complete in-memory store and do not contact Neon, Bambu
Cloud, or TRMNL.

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
every stored screen key stops resolving, so plan the installation migration
before applying it.

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

`wrangler secret put` cannot be used before the Worker exists because there is
nothing to attach a secret to. The first deploy therefore supplies secrets from
the same file format used for local development:

```sh
cp .dev.vars.example .dev.vars
pnpm exec wrangler deploy --secrets-file .dev.vars
```

Fill `DATABASE_URL` and `TOKEN_KEY_K1` through your approved secret-management
process before deploying. Keep `.dev.vars` out of Git; `.gitignore` already
covers it.

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

`pnpm hosted:key` prints a fresh key when you need to transfer it through an
approved secret manager. Treat that output as a production credential: do not
paste it into chat, tickets, logs, shell arguments, environment examples, or
Git. Cloudflare Worker secrets are the key-management boundary; Neon holds only
the key id, nonce, and authenticated ciphertext.

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

2. Keep both `TOKEN_KEY_K1` and `TOKEN_KEY_K2` configured, change `TOKEN_KEY_CURRENT_ID` to `k2`, and deploy the Worker through your normal reviewed process.
3. Confirm new token writes carry key id `k2`. Existing rows remain on `k1` and continue to open because the Worker imports both keys.
4. Do **not** delete `TOKEN_KEY_K1` until you have replaced or re-encrypted every row sealed by it and confirmed that no rows still carry `k1`. Automated background re-encryption is not implemented, so retirement currently requires explicit reauthentication or a separate reviewed migration procedure.

A suspected compromise requires rotating immediately, revoking affected Bambu sessions account-side, and treating old ciphertext as exposed. Changing the encryption key does not revoke a Bambu Cloud token.

## Hosted obligations

The hosted obligations in [`AGENTS.md`](../AGENTS.md) are launch gates:

- We encrypt Bambu tokens at rest with AES-256-GCM, fresh nonces, and
  overlapping key ids for rotation. You must keep the keys in Cloudflare Worker
  secrets and control production access to them.
- We keep the threat model in [`SECURITY.md`](../SECURITY.md). Keep it current
  for your deployment, including the installation token, management token,
  database contents, telemetry, and collector host, and obtain an independent
  security review before accepting installations.
- We delete the linked account, rendered screen, and installation when TRMNL
  sends `POST /trmnl/uninstall`. `DELETE /v1/account` deletes the account after
  management-token authentication.
- We rate-limit the TRMNL surface by client address before database access and
  rate-limit Bambu enrolment per installation before requesting an email.
- We never log a token, email, device id, or webhook URL. Credentials travel in
  authorization headers or URL fragments, never query strings.
- We use the TRMNL installation as identity and keep only a keyed HMAC tag of
  its access token. We never store or accept passwords; Bambu sign-in uses an
  emailed code, so a Bambu password never transits the service.

This repository does not provision the Worker, database, secrets, or schedules.
You are responsible for creating those resources, restricting production
secret access, testing migrations on an isolated branch, and completing the
security review before accepting installations.
