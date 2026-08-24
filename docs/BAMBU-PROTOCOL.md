# The Bambu Cloud interface, as far as we know it

Bambu Lab publishes no supported public cloud API. Everything below is
reverse-engineered from the sources in `docs/RESOURCES.md` and can change
without notice. It already has: see the two-factor row.

**First confirmed against a real account on 2026-08-24.** Sign-in worked and the
device list came back with two printers. What that run established is marked
`confirmed` below. Everything still unmarked remains a guess.

Research snapshot: 2026-08-24.

Legend for the confidence column:

| Mark | Meaning |
| --- | --- |
| `confirmed` | We have seen this work against a real Bambu account |
| `documented` | Written down in OpenBambuAPI's notes, which are themselves observations |
| `observed` | A working third-party client sends or reads this today |
| `unverified` | Nobody we can read has established it |

## What the first real sign-in established

A global-region account, signed in with an email and password, answered with a
verification code by email, and the code was accepted. Two printers came back
from the device list, both named and both reported online.

Four things that were guesses are now facts:

- The header set is still accepted. The `bambu_network_agent` user agent plus
  the `X-BBL-*` client headers get through.
- `POST /v1/user-service/user/login` and the emailed-code exchange both work as
  described below.
- `GET /v1/iot-service/api/user/bind` returns the account's printers with
  usable `name` and `online` fields.
- **The access token is opaque, not a JWT.** It carries no readable `exp`, so
  expiry will surface only as a refused request. This is the single most
  valuable thing the run told us: the previous code required a token to have
  three dot-separated segments and would have rejected this one outright. See
  `docs/DECISIONS.md` D9.

Still unconfirmed, and worth knowing which: whether a two-factor account reaches
the emailed-code fallback, since this account was not two-factor.

Everything else that was open has since been closed by running the bridge
against these printers, including the one that mattered most — the hand-written
subscribe-only MQTT client connects to Bambu's broker, authenticates, and
receives reports. See the MQTT section.

## Hosts

| Purpose | Global | China | Confidence |
| --- | --- | --- | --- |
| API | `https://api.bambulab.com` | `https://api.bambulab.cn` | **confirmed** for global |
| MQTT | `us.mqtt.bambulab.com:8883` | `cn.mqtt.bambulab.com:8883` | documented |

Cloud MQTT is raw MQTT over TLS, not WebSocket. Its certificate is a publicly
trusted DigiCert certificate for `*.mqtt.bambulab.com`, so the ordinary system
trust store is enough and hostname verification stays on. Bambu's own notes
discuss an SNI workaround only for talking to a printer directly on a LAN,
which this project does not do.

## Authentication

| Step | Request | Confidence |
| --- | --- | --- |
| Password login | `POST /v1/user-service/user/login` with `account`, `password` | **confirmed** |
| Ask for an email code | `POST /v1/user-service/user/sendemail/code` with `email`, `type: "codeLogin"` | **confirmed** |
| Exchange the code | `POST /v1/user-service/user/login` with `account`, `code` | **confirmed** |

The first login answers in one of three ways.

| `loginType` | Meaning | What the bridge does |
| --- | --- | --- |
| absent, with `accessToken` | Done | Stores the token |
| `verifyCode` | Bambu emailed a code | Requests the email, then exchanges the code |
| `tfa`, with `tfaKey` | Authenticator app expected | Requests an email code instead — see below |

Third-party clients send a specific header set with every request, and the
cloud is known to reject generic ones. We send the same set: a
`bambu_network_agent` user agent plus the `X-BBL-*` client, version, language
and OS headers. The set as a whole is **confirmed** to be accepted. Which
individual headers are actually required is still `unverified`, and worth
knowing before trimming any of them.

### The two-factor endpoint is broken

`POST https://bambulab.com/api/sign-in/tfa` with `tfaKey` and `tfaCode`.

Note the host: it is the website, not the API host that issued the `tfaKey`.

Since 2026-08-01 it has answered every submission with HTTP 403 and a body
naming `missing_cookie`. It wants a CSRF cookie, and the API-host login
sequence never issues one, so the rejection happens before the code is even
examined. When it did work, it returned the token in a `Set-Cookie` header
rather than in the response body.

The bridge therefore does not call it. An account with two-factor enabled signs
in with an emailed code, which is the path the Home Assistant integration fell
back to on the same date. Reasoning in full: `docs/DECISIONS.md` D8.

### Tokens

| Property | Value | Confidence |
| --- | --- | --- |
| Lifetime | `expiresIn` around 7,776,000 seconds, roughly 90 days | documented |
| Format | **Opaque.** The token from the first real sign-in is not a readable JWT and carries no `exp` | **confirmed** |
| Refresh | `POST /v1/user-service/user/refreshtoken` answers 401. Assume re-login is the only path | documented |
| Presented as | `Authorization: Bearer <token>` on HTTP; the bare token as the MQTT password | **confirmed** for HTTP |

Bambu's notes say the MQTT username is no longer carried inside access tokens,
and the first real token bears that out: it is opaque, so there is no claim to
read. The bridge therefore reads the `username` claim when a token happens to
be a readable JWT and otherwise asks
`GET /v1/design-user-service/my/preference` for the account's numeric `uid`,
forming the MQTT username as `u_<uid>`. On current evidence the fallback is not
the exceptional path but the only one, which is why it exists.

## Read-only HTTP endpoints

| Endpoint | Gives | Confidence |
| --- | --- | --- |
| `GET /v1/iot-service/api/user/bind` | `devices[]` with `dev_id`, `dev_name`, `dev_model_name`, `dev_product_name`, `online`, `print_status`, `dev_access_code` | **confirmed**: two printers returned, `print_status` and `online` populated |
| `GET /v1/iot-service/api/user/print?force=true` | **Observed to return only `dev_id`, `dev_name`, `dev_model_name`, `dev_product_name`, `dev_online`, `dev_access_code`.** No `task_status`, no `task_name`, no `progress`, no `thumbnail`, no `task_id` — none of the task fields the community notes describe. | **confirmed**, and it contradicts the notes |
| `GET /v1/user-service/my/tasks` | `total` and `hits[]` with `id`, `title`, `status`, `startTime`, `endTime`, `costTime`, `deviceId` | documented |
| `GET /v1/design-user-service/my/preference` | `uid`, `name` | **confirmed**: supplies the `uid` for the MQTT username |

`dev_id` is the printer serial on Bambu hardware. It is masked everywhere it
reaches a terminal or a log, and it never reaches the display payload. Note that
both device endpoints return `dev_access_code`, the printer's local
authentication secret: the normalizers deliberately never carry it past their
boundary.

### `print_status` is the last job's outcome, not the printer's state

This one cost a real bug. On a real account, a printer that finished a job and
has been sitting idle since reports `print_status: "SUCCESS"`, and keeps
reporting it. Mapping that token the way MQTT's `gcode_state` is mapped rendered
an idle printer as "Finished", indefinitely.

So the bridge reads an HTTP task status through a separate mapping in which a
terminal outcome — `SUCCESS`, `FINISH`, `FAILED` — means the printer is idle
now. The raw token is preserved either way. MQTT's `gcode_state` reports `FINISH`
at the moment it is actually true, which is the only moment worth showing it.

**What HTTP does not give.** Confirmed the hard way: no layer count, no
remaining time, no temperature, and in practice no progress percentage either.
`costTime` on a task is a slicing estimate rather than a live countdown, and
using it as one would be a fabricated number. Those fields exist only in MQTT
reports, which is why the bridge merges two sources rather than choosing one.
See `docs/DECISIONS.md` D3 — a decision made from the notes, and since borne
out by measurement.

## MQTT

| Item | Value | Confidence |
| --- | --- | --- |
| Broker accepts our subscribe-only client | Yes, over TLS on 8883 with the public trust store | **confirmed** |
| Username | `u_<uid>`, from the preference endpoint | **confirmed** |
| Password | The access token, with no `Bearer` prefix | **confirmed** |
| Report topic | `device/<dev_id>/report`, subscribe | **confirmed** |
| Request topic | `device/<dev_id>/request`, publish — **never used** | documented |
| Client id | No documented convention; any distinct value was accepted | **confirmed** |

Report fields, all of them observed arriving on a real account and none of them
available over HTTP: `mc_percent`, `layer_num`, `total_layer_num`,
`mc_remaining_time`, `nozzle_temper`, `nozzle_target_temper`, `bed_temper`,
`bed_target_temper`, `gcode_state`, `stg_cur`. Also documented but not yet seen
here: `chamber_temper`, `subtask_name`, `gcode_file`.

### What a real 40-second window looked like

Two printers, one printing and one idle, watched with no publish of any kind:

- The printing one sent **14 reports**, and between them supplied `gcode_state`
  `RUNNING`, 21% progress, layer 48, 55 minutes remaining, nozzle 220/220 and
  bed 65/65. Everything the display needs, arriving within seconds.
- The idle one sent **4 reports**, carrying a single field between them: a bed
  temperature of 21°C.

That is exactly the behaviour `docs/DECISIONS.md` D1 predicted and accepted. A
delta-reporting printer tells a subscriber almost nothing while it is idle, and
idle is precisely the state where HTTP already tells us everything that matters.
The capability split in D3 is not a compromise made on paper; it is what the
wire actually does.

### Why the bridge never asks for a full report

X1-class printers put the whole status object in every report. P1-class printers
send only the fields that changed, so a client that has just connected has been
told nothing.

The documented remedy is to publish a `pushing` object with `command: "pushall"`
to the printer's request topic. It is a status query rather than an actuation,
and every other client does it. We do not, because it is still a message sent
to a printer and `AGENTS.md` forbids that over MQTT. `docs/DECISIONS.md` D1
covers the consequences, which are smaller than they look.

## Rate limits

Bambu's own 2024 forum notice describes temporarily banning accounts that
exceeded 50 concurrent MQTT connections, for between 24 hours and 7 days, and
attributes the incident to reconnect loops and repeated failed subscriptions
rather than to ordinary report traffic. It says a per-account maximum was
planned but does not state what shipped.

No HTTP request quota, poll throttle, or login lockout threshold is documented
anywhere we can read. All `unverified`. The bridge behaves as if they exist: one
connection, one poll every five minutes, bounded backoff with jitter, and no
automatic retry after a failed login.

## Recording what we learn

When a real response contradicts a row above, change the row, mark it
`observed`, and say what it was. When a real response confirms one, promote it
from `documented` to `observed`. A sanitized capture goes in `bridge/fixtures/`
under the rules in `bridge/fixtures/README.md`; a hand-written one is named
`*.synthetic.json` and is never called a capture.
