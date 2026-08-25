# The collector

**Status: designed, not built.** Nothing in this document describes running
software. It settles the decisions so that building it is mechanical, and it is
the operations guide for the machine that will run it. Where a number is
measured rather than estimated, it says so.

## What it is for

The hosted tier and the self-hosted bridge do not show the same amount, and the
reason is not a defect. Bambu's HTTP interface carries a printer's name, whether
it is online, and whether it is printing. It does not carry progress, layer
count, time remaining, or temperature. Those arrive over MQTT.

The bridge subscribes to MQTT because it runs on a machine that is always on. A
Cloudflare Worker cannot: it is a cron that wakes, works, and dies, and MQTT
wants a socket held open. So a hosted printer reads `Printing` over its name and
nothing else, while the same printer on the bridge reads `42%` with a rail,
remaining time, layer, temperatures and filament.

The collector closes that gap by being the always-on machine, for people who are
not running a bridge themselves.

## Shape

```
Bambu MQTT ──────► collector (LXC) ──────► Neon
                                             ▲
TRMNL ──────► Cloudflare Worker ─────────────┘
```

The collector makes **only outbound connections**: to Bambu's broker on 8883,
and to Neon over HTTPS. It listens on nothing. There is no tunnel, no port
forward, and no inbound path from the internet to the machine running it. The
public surface stays exactly where it is, on Cloudflare, with the rate ceilings
and the key checks already built.

It writes the same `screens` rows the Worker's cron writes, in the same shape.
The Worker needs no change at all: `GET /v1/screen` already serves whatever is
in that table.

## The one interaction that needs care

Two writers to one table. The cron renders from HTTP every five minutes; the
collector renders from MQTT whenever a printer reports. If both write freely,
the display flickers between a rich render and a thin one.

**The cron writes only when the stored render is already stale.** It compares
`rendered_at` against its own freshness window and skips accounts a collector
has touched recently. No new column, no precedence engine, no coordination
between the two processes.

That ordering is deliberate, and it is what makes the collector optional:

- Collector up: it writes often and richly, the cron finds fresh rows and skips.
- Collector down: rows go stale, the cron resumes, and the display falls back to
  HTTP fidelity rather than going blank.
- Both down: the screen endpoint keeps serving the last render and reports its
  age, which is what `FRESH_FOR_MS` is for.

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

A GPU is of no use here. There is no inference and no image work — TRMNL renders
the screen from our JSON on its own servers.

## Running it in an LXC

Nothing below has been executed; it is the intended shape.

**Container resources.** 1 vCPU and 512 MB is generous for hundreds of accounts.
Give it more disk than it needs for logs and nothing else; the collector stores
no state locally, because Neon is the state.

**No inbound rules.** The container needs egress to Bambu on 8883 and HTTPS to
Neon. It needs no listening port, so do not give it one. If a health check is
wanted, have the collector write a heartbeat row rather than open a socket.

**Environment.** The same names the Worker uses, so one mental model covers both:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon connection string |
| `TOKEN_KEY_CURRENT_ID` | Which key seals new writes |
| `TOKEN_KEY_<ID>` | The keys themselves, one per id |
| `COLLECTOR_ID` | Names this instance in the leader lock |
| `COLLECTOR_MAX_ACCOUNTS` | A ceiling, so one instance cannot take on more than it was sized for |

**Two instances.** Both holding MQTT for one account means two connections and
two writers, which is the churn Bambu dislikes and the flicker users see. Use a
Postgres advisory lock: whoever holds it collects, the other idles and takes over
when the lock is released or its holder stops renewing. This is a lock and a
heartbeat, not a cluster.

**Restart policy.** Restart on failure with backoff. A collector that cannot
reach Bambu must not reconnect in a tight loop; the bridge's existing backoff is
the behaviour to reuse.

**Updates.** Pull, restart, done. There is no migration to run and no local state
to preserve. The screen endpoint keeps serving through the gap, and the cron
covers a long one.

## Failure modes

| What fails | What a user sees |
| --- | --- |
| One MQTT session drops | That printer's figures stop updating; the cron refreshes it at HTTP fidelity within five minutes |
| The collector stops | Every hosted display falls back to HTTP fidelity, name and state only |
| The host stops | Same, because the cron is still running on Cloudflare |
| Neon unreachable | The Worker serves the last render and reports its age |
| A user's token is refused | That account is flagged for re-authentication and skipped, rather than retried into a ban |

The shape of that table is the argument for this design: every row degrades, and
none of them blanks a display.

## Before this carries anyone else's account

- Disk encryption on the host, and a backup story that does not copy the key.
- The threat model in `SECURITY.md` extended to cover a self-operated collector,
  because it currently reasons about Cloudflare and Neon only.
- A decision on who is allowed to enrol. An open hosted tier whose telemetry is
  collected on one person's hardware is a promise about uptime and privacy that
  should be made deliberately, not by leaving the door open.
