# trmnl-bambulab

See your Bambu Lab printers on a [TRMNL](https://usetrmnl.com) e-paper display.

Sign in with your Bambu account, pick which printers to show, and the display
tells you what they are doing. An idle printer shows its name and **Ready**. A
printing one shows progress, layer, time remaining, and temperatures.

Bambu Cloud only. **Read only** — this never sends a command to a printer, and
the MQTT client it uses is structurally unable to publish.

![Two printers on a TRMNL display: one mid-print with progress, layers and temperatures, one finished](docs/images/device.png)

*An actual TRMNL render of the plugin — 1-bit, as the e-paper panel draws it.*

## Two ways to run it

**Hosted.** Install the TRMNL plugin, sign in to Bambu with an emailed code,
pick printers, done. You install nothing, create no account, and never handle a
credential — TRMNL's install handshake is the sign-in, and your Bambu password
never exists here because Bambu's emailed code is the whole flow.

**Self-hosted.** Run the bridge on your own machine. The hosted backend is
never involved, and nothing leaves your machine except the push to your own
TRMNL plugin.

The two tiers do not always show the same amount, and the difference is not a
bug. Bambu's HTTP interface carries no progress, layer count, time remaining or
temperature; those arrive over MQTT, which wants a connection held open. The
self-hosted bridge holds one. The hosted tier holds one only while its
collector component is running, and degrades to name-and-state — never to a
blank screen — when it is not.

| | Hosted | Self-hosted |
|---|---|---|
| You install | nothing | the bridge (Node 22+) |
| Sign-in | TRMNL install handshake | `pnpm setup` on your machine |
| Progress, layers, time, temps | while the collector runs | always |
| Your Bambu token lives | encrypted in the operator's database | on your machine |

## The four layouts

Every TRMNL viewport is supported, so the plugin works full-screen and in
mashups:

| | |
|---|---|
| ![Half horizontal](docs/images/half-horizontal.png) | ![Half vertical](docs/images/half-vertical.png) |
| ![Quadrant](docs/images/quadrant.png) | ![Two printers, full screen](docs/images/full-two.png) |

## Self-hosting

```sh
git clone https://github.com/moneycaringcoder/trmnl-bambulab
cd trmnl-bambulab
git config core.hooksPath .githooks   # enable the secret gate
cd bridge && pnpm install
pnpm setup
```

`pnpm setup` signs you in — Bambu emails you a code; there is no password
prompt — lists the printers on your account, and asks which ones to show. You
can finish without a TRMNL webhook URL and add it later with
`pnpm setup webhook`. `pnpm start` then runs the bridge until you stop it.

| Command | Does |
|---|---|
| `pnpm setup` | Configure from scratch |
| `pnpm setup printers` | Change which printers show |
| `pnpm setup reauth` | Sign in again when the token expires |
| `pnpm setup webhook` | Set the TRMNL webhook URL |
| `pnpm start` | Run the bridge |

Your Bambu password is never asked for, and the verification code is used for a
single request and never written to disk. Only the resulting access token is
stored, in a file the secret gate refuses to commit.

## Running your own hosted tier

Everything the hosted tier needs is in this repository: a Cloudflare Worker, a
Neon Postgres schema, and an optional collector container for live telemetry.
`hosted/README.md` is the deployment guide and `docs/COLLECTOR.md` the
collector's design and operations guide. It registers with TRMNL as a
third-party plugin — `docs/TRMNL-PLUGIN.md` documents the contract.

## How it is built

| Path | What |
|---|---|
| `bridge/` | The self-hosted bridge: cloud providers, normalizers, coordinator, payload builder, subscribe-only MQTT client, daemon, setup CLI |
| `src/` | The display itself: shared markup and the four Liquid layouts. One design source for both tiers |
| `hosted/` | The hosted tier: Cloudflare Worker, TRMNL marketplace protocol, Neon schema, token encryption, server-side Liquid rendering |
| `collector/` | The always-on process that holds Bambu MQTT for hosted accounts, so the hosted display shows the same numbers a self-hosted one does |
| `docs/` | Design decisions, protocol notes, plugin contract, sources |
| `scripts/` | The secret scanner the pre-commit hook runs |

Design decisions are written down with their reasoning in
[`docs/DECISIONS.md`](docs/DECISIONS.md), including the ones that were
reversed. What is known about Bambu's unpublished cloud interface — learned
from real accounts and community reverse-engineering — is in
[`docs/BAMBU-PROTOCOL.md`](docs/BAMBU-PROTOCOL.md).

## Honesty rules the display follows

- A metric that is absent is left blank, never shown as zero.
- A stale reading says it is old instead of posing as current.
- An unknown printer state is shown as unknown, not guessed into "idle".
- Job names can reveal what you are printing, so exporting them is opt-in and
  off by default.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md). The one rule that matters most: no
printer serial, device id, account email, token, or webhook URL ever enters
this repository. A pre-commit hook enforces it, and the full history has been
swept. AI agents working here must follow [`AGENTS.md`](AGENTS.md).

Security policy and threat model: [`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).

Bambu Lab publishes no supported public cloud API. Everything here is
reverse-engineered from community work and can break without notice. This
project is not affiliated with Bambu Lab or TRMNL.
