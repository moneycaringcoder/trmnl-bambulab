# trmnl-bambulab

See your Bambu Lab printers on a TRMNL e-paper display.

Sign in with your Bambu account, pick which printers to show, and the display
tells you what they are doing. Idle printers show their name. Printing printers
show progress, layer, time remaining, and temperatures.

Bambu Cloud only. Read only — this never sends a command to a printer.

Status: in development. The self-hosted bridge is complete and smoke tested,
but **nothing here has been verified against a real Bambu account yet**. See
[`docs/PLAN.md`](docs/PLAN.md).

## Two ways to run it

**Hosted.** Sign in, pick printers, done. You install nothing. Runs on
Cloudflare and Neon.

**Self-hosted.** Run the bridge yourself. Our backend is never involved and
nothing leaves your machine except the push to your own TRMNL plugin.

## Self-hosting

```sh
git config core.hooksPath .githooks   # enable the secret gate
cd bridge && pnpm install
pnpm setup
pnpm start
```

`pnpm setup` signs you in, lists the printers on your account, and asks which
ones to show. You can finish without a TRMNL webhook URL and add it later with
`pnpm setup webhook`. `pnpm start` then runs the bridge until you stop it.

| Command | Does |
| --- | --- |
| `pnpm setup` | Configure from scratch |
| `pnpm start` | Run the bridge |
| `pnpm setup doctor` | Check the saved configuration, change nothing |
| `pnpm setup reauth` | Sign in again when the token expires |
| `pnpm setup webhook` | Set the TRMNL webhook URL |

Your Bambu password and any verification code are used for a single request and
are never written to disk. Only the resulting access token is stored, in
`bridge/.env` at mode 0600.

Bambu tokens last around three months and their refresh endpoint no longer
works, so expect to sign in again roughly twice a year.

## What it will show

An idle printer shows its name and that it is ready — no progress bar, no zero
percentage, no empty layer counter. A printing printer shows the percentage,
the layer, the time remaining and the temperatures. Up to three printers share
one screen, ordered so the one that needs you is first. A reading that has gone
stale says so rather than presenting old numbers as current.

## What it will not do

- Control your printer. Not a design gap; a deliberate boundary.
- Work over your local network. There is no LAN mode.
- Show a live camera feed.
- Work if your printer is in LAN-only mode, because that turns the cloud off.

## Layout

| Path | Contents |
| --- | --- |
| `bridge/` | The bridge: cloud providers, normalizers, coordinator, payload, MQTT client, daemon, setup CLI |
| `src/` | The TRMNL Private Plugin: shared markup and the four Liquid views. TRMNL syncs this path. |
| `hosted/` | The hosted tier: Neon schema, token encryption, and the Cloudflare Worker |
| `docs/` | Decisions, the plan, what we know of the cloud interface, sources |
| `scripts/` | Secret scanner |
| `.omp/` | Agent charter and the project's review agent |

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md). The one rule that matters most: no
printer serial, device id, account email, token, or webhook URL ever enters this
repository. A pre-commit hook enforces it.

Agents working in this repository must read [`AGENTS.md`](AGENTS.md) and
[`.omp/CHARTER.md`](.omp/CHARTER.md).

## Licence

MIT. See [`LICENSE`](LICENSE).

Bambu Lab publishes no supported public cloud API. Everything here is
reverse-engineered from community work and can break without notice. This
project is not affiliated with Bambu Lab or TRMNL.
