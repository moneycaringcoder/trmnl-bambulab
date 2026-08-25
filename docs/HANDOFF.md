# Handoff: from working tree to public

**Status 2026-08-25: steps 1-4 are done and proven live.** The migration ran,
the Worker is deployed, the plugin is registered (plus a knowledge-base page at
`<worker>/help`), and the owner installed it: every TRMNL seam worked, and the
display renders both printers by name. The client id/secret TRMNL displays went
unused - the documented code-only exchange is correct. What remains is step 6
and the deliberately-not-done list.

Everything below is either a command you run or a button you click. Nothing in
it is a design decision — those are made, tested, and recorded in
`docs/DECISIONS.md`. Work through it in order; each step assumes the one before.

Your Worker's URL is written `<worker>` throughout. It is deliberately not
written down in this repository.

## 1. Migrate the database

The conversion adds an installations table and drops the screen-key column.
Dropping the column is not reversible and retires every issued screen key,
which is the point: TRMNL authenticates with its own per-installation token now.

Run `hosted/migrations/0002_trmnl_installations.sql` against the production
branch — Neon SQL Editor, or psql against the **direct** (non-`-pooler`)
endpoint. Your existing enrolment survives: the account row, sealed token and
rendered screen are untouched, verified by running the same migration and flow
against a throwaway database.

## 2. Deploy the Worker

```sh
cd hosted && npx wrangler deploy
```

Secrets survive redeploys; `NEON_AUTH_BASE_URL` is simply no longer read, and
you can delete it afterwards if you like tidiness:

```sh
npx wrangler secret delete NEON_AUTH_BASE_URL
```

Then check:

```sh
curl -s <worker>/healthz                      # ok
curl -s -o /dev/null -w '%{http_code}\n' -X POST <worker>/trmnl/markup   # 401
```

The old plugin stops working at this deploy: `/v1/screen` is gone. That is
expected — the polling plugin is replaced by the next step, and your display
falls back to whatever it last rendered until then.

## 3. Register the plugin with TRMNL

At <https://trmnl.com/plugins/my/new>, with these values:

| Field | Value |
| --- | --- |
| Name | Bambu Lab |
| Description | See your Bambu Lab printers: progress, layers, time remaining, temperatures. Read-only — it never sends a command to a printer. |
| Icon | Your choice; PNG |
| Installation URL | `<worker>/trmnl/install` |
| Installation Success Webhook URL | `<worker>/trmnl/installed` |
| Plugin Management URL | `<worker>/` |
| Plugin Markup URL | `<worker>/trmnl/markup` |
| Uninstallation Webhook URL | `<worker>/trmnl/uninstall` |

Keep it unlisted/private at first. Publishing to the public marketplace is a
separate decision with a support load attached; nothing in the code changes
either way.

## 4. Install it yourself, end to end

1. In TRMNL, install the plugin. You should land on the setup page with no
   sign-in step — the install handshake is the sign-in.
2. Connect Bambu: region, email, the emailed code. No password exists anywhere
   in this flow.
3. Pick printers, finish, and follow the back-to-TRMNL link.
4. Within your refresh interval the display should render. The rich fields
   (progress bar, layers, time, temperatures) appear when the collector is
   running; name-and-state otherwise.

This is the one sequence nobody has run, because it needs your TRMNL account:
the real `code` exchange at `trmnl.com/oauth/token`, the real success webhook,
and TRMNL's real markup POST. Everything on our side of each of those seams is
tested against TRMNL's documented shapes; the seams themselves are the residual
risk. If TRMNL's requests differ from their documentation, the markup route
answers 401 and the fix is ours to make — say what you see.

## 5. One known unknown, written down

TRMNL's docs do not say whether the Plugin Management URL is opened with any
identifying parameter. The management page therefore works from the install
redirect's own token (valid one hour, re-mintable by pressing TRMNL's
configure/install button again, which re-runs the handshake and lands on the
same installation). If TRMNL turns out to pass something useful to the
management URL, we can use it later; nothing breaks meanwhile.

## 6. Go public

When you say the word, in this order:

1. `git grep` one last time for anything that names your infrastructure —
   the history sweep is recorded in `docs/RELEASE.md` and was clean across all
   41 pre-conversion commits.
2. Flip the GitHub repository to public. CI needs no secrets by design.
3. Optionally publish the TRMNL plugin from unlisted to the marketplace. That
   makes you an operator for strangers: every installer's Bambu token lands in
   your Neon and is decryptable on your collector host. `SECURITY.md` names the
   obligations that activates — they are real work, and unlisted defers them.

## What is deliberately not done

- The collector still runs nowhere; your Proxmox box is the plan
  (`docs/COLLECTOR.md` is the runbook). Hosted shows name-and-state until then.
- `TRMNL_ALLOWED_IPS` is empty until the list at <https://trmnl.com/api/ips>
  has been checked by a person.
- The threat model's screen-key entries are superseded by the installation
  token and need a revision pass; noted in `hosted/README.md`'s obligation
  table.
