# The collector

An optional always-on process that gives hosted installations live telemetry.
It holds one subscribe-only MQTT connection per enrolled Bambu account and
writes rendered screens into the same table the Worker's cron writes; when it
is not running, the hosted tier continues at HTTP fidelity — name and state —
and never blanks.

This document is the design and the operations guide for the machine that runs
it. Where a number is measured rather than estimated, it says so.

One requirement shapes most of what follows: the collector must close every
live MQTT session the moment it loses its lease. The lock is gone by the time
the heartbeat notices, so a standby may already be collecting the same
accounts, and a holder that merely stopped *renewing* would leave two MQTT
connections on one Bambu account — the condition Bambu bans for and the one
the lease exists to prevent. The orchestration lives in
`collector/src/supervise.ts`, and four tests fail if a session ever becomes
unstoppable again.

## What it is for

The five-minute hosted cron reads Bambu's HTTP interface. That interface gives
enough data for an honest basic status, but the richer progress, layer, remaining
time, temperature, filament, and alert fields arrive over MQTT.

The self-hosted bridge can hold an MQTT subscription because it runs as an
always-on process. A Cloudflare cron invocation cannot hold that socket between
runs. The collector closes the gap for hosted installations by keeping one
subscribe-only MQTT connection per enrolled Bambu account. It is optional:
without it, the hosted tier continues at HTTP fidelity.

## Shape

```text
Bambu MQTT ──────► collector ──────► Neon
                                         ▲
Bambu HTTP ──────► Worker cron ──────────┘
                                         │
TRMNL ───────────► Worker markup route ──┘
```

The collector makes **only outbound connections**: to Bambu over HTTPS and MQTT
on 8883, and to Neon over HTTPS and direct Postgres. It listens on nothing.
There is no tunnel, port forward, or inbound path from the internet to the
machine running it. Cloudflare remains the public surface, with rate ceilings
and per-installation token checks.

The collector writes the same `screens` rows as the Worker cron, in the same
normalized JSON shape. `POST /trmnl/markup` reads the stored payload and the
Worker renders all four `src/*.liquid` layouts through liquidjs. The collector
does not serve TRMNL traffic and does not render HTML itself.

## The one interaction that needs care

Two writers share one table. The cron stores an HTTP payload every five minutes;
the collector stores an MQTT-enriched payload when printer reports arrive. If
both write freely, the display flickers between a rich view and a thin one.

**The cron writes only when the stored payload is already stale.** It compares
`rendered_at` against its freshness window and skips accounts a collector has
touched recently. No new column, precedence engine, or coordination between the
two processes is needed.

That ordering is deliberate, and it is what makes the collector optional:

- Collector up: it writes often and richly, the cron finds fresh rows and skips.
- Collector down: rows go stale, the cron resumes, and the display falls back to
  HTTP fidelity rather than going blank.
- Both writers down: the markup route keeps rendering the last stored payload,
  whose update time makes its age visible.

Availability therefore never gets worse than the cron-only tier that exists
today. That is the property worth protecting, and it is why the collector must
not replace the cron.

## What it holds, and what that obliges

The collector reads the `accounts` table and opens each sealed Bambu token, so
**the machine running it holds the key that decrypts every hosted user's cloud
token**. That is the same obligation the Worker carries, moved onto hardware
somebody owns, which adds a threat the Worker does not have: physical access.

Consequences, none of them optional:

- The token key lives in the container's environment, never in an image, never in
  a snapshot, never in the repository.
- Disk encryption on the host is not paperwork. A stolen or discarded disk with
  the key on it is every user's Bambu account.
- Backups of the container inherit the key. Either exclude it or encrypt them.
- `AGENTS.md` forbids logging a token, an email, a device id or a webhook URL.
  The collector is subject to that in full, and it is the process most tempted to
  break it, because printer telemetry is exactly what one wants to print while
  debugging.
- Read-only stays read-only. The MQTT client has no publish encoder and a test
  asserts none appears. The collector must not add one, for any reason,
  including `pushall`.

## Reuse

The hosted modules run in plain Node without modification. This was checked
rather than assumed: `hosted/src/store-neon.ts` and `hosted/src/crypto.ts` were
imported into a Node 24 script, which read a real account and opened its real
sealed token. `@neondatabase/serverless` speaks HTTP, and `crypto.subtle` is a
global in modern Node, so neither module needs a Workers runtime.

So the collector is a new entrypoint over parts that already exist:

| Part | Where it already lives |
| --- | --- |
| Read accounts, write screens | `hosted/src/store-neon.ts` |
| Open a sealed token | `hosted/src/crypto.ts` |
| Subscribe-only MQTT client | `bridge/src/mqtt/` |
| Normalize MQTT reports | `bridge/src/normalize/` |
| Merge HTTP and MQTT views | `bridge/src/coordinator/` |
| Build the payload | `bridge/src/push/payload.ts` |

What is genuinely new: a loop that holds one MQTT session per account, and a
leader lock so two collectors do not both hold one.

## Sizing

Measured, on the bridge holding a live MQTT session for one account with two
printers: **116 MB resident, 25 open file descriptors.** That is Node plus the
application, running from TypeScript source.

The marginal cost of another account is one more TLS socket and a few kilobytes
of state — about **0.2 MB** — because Bambu's cloud MQTT is one connection per
*account*, and extra printers are extra topic subscriptions on it rather than
extra connections.

| Accounts | Expected resident |
| --- | --- |
| 1 | 116 MB |
| 100 | ~140 MB |
| 500 | ~220 MB |
| 2000 | ~500 MB |

**512 MB is comfortable for around a thousand accounts.** RAM is not the
constraint. In order, the real ones are:

1. **Neon write rate.** One row per render per account.
2. **File descriptors.** 25 for one account, roughly two more per account. Raise
   `ulimit -n` well above the account count.
3. **Bambu's tolerance.** Their published note documents temporary bans for
   accounts exceeding 50 *concurrent* connections. That limit is per Bambu
   account, so separate users do not stack against each other. Connection churn
   is the thing to avoid, and the bridge already learned that lesson the hard
   way: see `docs/DECISIONS.md`.

A GPU is of no use here. There is no inference or image work: the Worker renders
the stored variables into HTML, and TRMNL turns that markup into an e-paper image.

## Deployment and operations

Build from the repository root. The root is the build context because the
collector imports the existing bridge and hosted modules directly:

```sh
docker build -f collector/Dockerfile -t trmnl-bambulab-collector .
```

Keep the runtime environment in a root-owned file outside the repository and
set its mode to `0600`. The names are:

```dotenv
DATABASE_URL=
TOKEN_KEY_K1=
TOKEN_KEY_CURRENT_ID=k1
# Optional. There is no "no ceiling": omitting this line uses the default of
# 200 accounts, so set it explicitly once more than that many people enrol.
COLLECTOR_MAX_ACCOUNTS=1000
```

`TOKEN_KEY_K1` must contain the same key material as the Worker. Otherwise the
collector cannot open any stored Bambu token. `TOKEN_KEY_CURRENT_ID` is not a
secret; `k1` names that key when rows are sealed.

`DATABASE_URL` **must be a direct Postgres connection, never a pooled
connection**. The collector's exclusion lease is a session-scoped Postgres
advisory lock. A pooler can put two collectors on one backend, where both can
appear to own the same lock. That risks two MQTT connections for each Bambu
account, which is exactly the connection pattern Bambu bans for. In the Neon
dashboard, open **Connect**, turn off the pooled connection option, and copy the
direct connection string. For an existing Neon string, the direct host is the
same hostname without the `-pooler` suffix. The collector also probes the
connection at startup and refuses to collect when the session cannot enforce
the lease.

Run the image without an inbound port and with its root filesystem read-only:

```sh
docker run -d \
  --name trmnl-bambulab-collector \
  --restart on-failure:5 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --ulimit nofile=4096:4096 \
  --env-file /etc/trmnl-bambulab/collector.env \
  trmnl-bambulab-collector
```

The environment file is read by Docker and is not copied into the container.
The process keeps no local state and needs no writable temporary directory.
There is therefore no volume to mount. Do not add `-p`: nothing listens inside
the container.

### Proxmox LXC

Use an unprivileged LXC. If Docker runs inside it, enable nesting for that
container; do not make the LXC privileged to make Docker easier. Start with one
vCPU and 512 MB of memory, which the measurements above make generous for
hundreds of accounts. The image and its logs are the only meaningful disk use.
Set the open-file limit comfortably above the account ceiling; `4096` covers the
example ceiling of 1000 and its expected sockets.

The LXC needs outbound DNS, HTTPS, Bambu MQTT on TCP 8883, and the direct
Postgres connection to Neon. It needs no inbound firewall rule, forwarded port,
tunnel or public address.

### Restarts and logs

Docker's `on-failure` policy restarts a crashed process with a bounded retry
count. MQTT reconnections have their own backoff, so a Bambu outage does not
turn into a tight connection loop. Three exit statuses matter, and the restart
policy is what makes the difference between them load-bearing:

| Status | Means | Do |
| --- | --- | --- |
| 0 | Stopped on a signal, or it was a standby that was stopped while waiting | Nothing. This is a clean stop and `on-failure` will not restart it |
| 1 | The lease was lost, or the process failed | Let it restart. It gives up its sessions first |
| 78 | Configuration a restart cannot repair | Stop the container, fix the environment, start it again. Restarting will not help |

Logs are structured JSON lines. A healthy leader logs `collector starting`, then
`holding the collection lease`, then `collecting accounts` with a count, then
`stored a live render` as reports arrive. Per-account entries carry only an
`account_tag`, which is a truncated one-way digest of the account id, never an
email, token, device id or serial. A standby logs `another collector holds the
lease` once and then waits, asking again every few seconds; this is normal, not
a warning, and the process stays running. A pooled or otherwise unusable
database session logs `this database cannot enforce the collection lease` and
exits with status 78. `lost the collection lease` means the heartbeat found the
lock gone: the collector closes its MQTT sessions, gives up whatever it still
holds, and exits **1**, not 0, so the `on-failure` policy restarts it. That
status is deliberate. By the time the heartbeat notices, a standby may already
be collecting these accounts, and a collector that kept its sessions open would
put a second MQTT connection on each Bambu account — which is what Bambu bans
for. Exiting zero would be just as wrong in the other direction: the container
would stop and stay stopped.

A collector with nobody enrolled logs `collecting accounts` with a count of
zero, keeps the lease, and looks again every five minutes. It does not exit,
because a container that exits cleanly is not restarted by the `on-failure`
policy above, and the next person to enrol would then get no live telemetry
until somebody noticed.

A second instance is safe and provides a restart without a collection gap:
start the replacement, wait for its standby line, then stop the old instance.
The replacement takes the lease as soon as the old Postgres connection drops.
There is no coordination step, timeout, or local state to carry over.

When the collector is down, rich MQTT figures stop updating. The cron resumes
writing the HTTP-only payload within five minutes, so displays degrade but do
not lose their basic printer status. The markup route keeps rendering the latest
stored payload throughout collector failover. This fallback is why the cron
remains in place rather than being replaced by the collector.

## Failure modes

| What fails | What a user sees |
| --- | --- |
| One MQTT session drops | That printer's rich figures stop updating; the cron refreshes it at HTTP fidelity within five minutes |
| The collector stops | Every hosted display falls back to HTTP fidelity |
| The collector host stops | Same, because the cron is still running on Cloudflare |
| Neon is unreachable | The markup request cannot load the stored payload and returns a service-unavailable response |
| A user's token is refused | That account is flagged for re-authentication and skipped rather than retried into a ban |

Collector-specific failures degrade to the cron-only service. Neon is a shared
dependency of both the writers and the markup route, so its failure is not
masked by the collector fallback.

## Before this carries anyone else's account

- Disk encryption on the host, and a backup story that does not copy the key.
- Keep the "A compromised collector host" threat in `SECURITY.md` current. It
  records the obligations above rather than leaving them implicit.
- Decide which installations may enrol before opening a self-operated hosted
  tier. Collecting other people's telemetry on one operator's hardware is a
  promise about uptime and privacy that should be made deliberately.
