# The Bambu Cloud interface, as far as we know it

Bambu Lab publishes no supported public cloud API. Everything below is
reverse-engineered from the sources in `docs/RESOURCES.md` and can change
without notice. It already has: see the two-factor row.

**Nothing here has been confirmed against a real account.** Every row is marked
with where it came from and how much weight it can carry. When the owner signs
in for the first time, this file is where the result gets recorded.

Research snapshot: 2026-08-24.

Legend for the confidence column:

| Mark | Meaning |
| --- | --- |
| `documented` | Written down in OpenBambuAPI's notes, which are themselves observations |
| `observed` | A working third-party client sends or reads this today |
| `unverified` | Nobody we can read has established it |

## Hosts

| Purpose | Global | China | Confidence |
| --- | --- | --- | --- |
| API | `https://api.bambulab.com` | `https://api.bambulab.cn` | documented |
| MQTT | `us.mqtt.bambulab.com:8883` | `cn.mqtt.bambulab.com:8883` | documented |

Cloud MQTT is raw MQTT over TLS, not WebSocket. Its certificate is a publicly
trusted DigiCert certificate for `*.mqtt.bambulab.com`, so the ordinary system
trust store is enough and hostname verification stays on. Bambu's own notes
discuss an SNI workaround only for talking to a printer directly on a LAN,
which this project does not do.

## Authentication

| Step | Request | Confidence |
| --- | --- | --- |
| Password login | `POST /v1/user-service/user/login` with `account`, `password` | documented |
| Ask for an email code | `POST /v1/user-service/user/sendemail/code` with `email`, `type: "codeLogin"` | observed |
| Exchange the code | `POST /v1/user-service/user/login` with `account`, `code` | documented |

The first login answers in one of three ways.

| `loginType` | Meaning | What the bridge does |
| --- | --- | --- |
| absent, with `accessToken` | Done | Stores the token |
| `verifyCode` | Bambu emailed a code | Requests the email, then exchanges the code |
| `tfa`, with `tfaKey` | Authenticator app expected | Requests an email code instead — see below |

Third-party clients send a specific header set with every request, and the
cloud is known to reject generic ones. We send the same set: a
`bambu_network_agent` user agent plus the `X-BBL-*` client, version, language
and OS headers. Which of them are actually required is `unverified`; the set as
a whole is `observed` to work.

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
| Format | Sometimes a readable JWT, sometimes opaque. Treat as opaque | observed |
| Refresh | `POST /v1/user-service/user/refreshtoken` answers 401. Assume re-login is the only path | documented |
| Presented as | `Authorization: Bearer <token>` on HTTP; the bare token as the MQTT password | documented |

Bambu's notes say the MQTT username is no longer carried inside access tokens,
which is the clearest evidence that the token format has already changed once.
So the bridge reads the `username` claim when a token happens to be a readable
JWT and otherwise asks `GET /v1/design-user-service/my/preference` for the
account's numeric `uid`, and forms the MQTT username as `u_<uid>`.

## Read-only HTTP endpoints

| Endpoint | Gives | Confidence |
| --- | --- | --- |
| `GET /v1/iot-service/api/user/bind` | `devices[]` with `dev_id`, `name`, `online`, `print_status`, `dev_model_name`, `dev_product_name`, and recently `print_job`, `nozzle_diameter`, `dev_structure` | documented |
| `GET /v1/iot-service/api/user/print?force=true` | `devices[]` with `dev_id`, `dev_name`, `dev_online`, `task_id`, `task_name`, `task_status`, `start_time`, `prediction`, `progress`, `thumbnail` | documented |
| `GET /v1/user-service/my/tasks` | `total` and `hits[]` with `id`, `title`, `status`, `startTime`, `endTime`, `costTime`, `deviceId` | documented |
| `GET /v1/design-user-service/my/preference` | `uid`, `name` | documented |

`dev_id` is the printer serial on Bambu hardware. It is masked everywhere it
reaches a terminal or a log, and it never reaches the display payload.

**What HTTP does not give.** No endpoint we can find returns a layer count, a
remaining time, or a temperature. `costTime` on a task is a slicing estimate,
not a live countdown, and using it as one would be a fabricated number. Those
fields exist only in MQTT reports, which is why the bridge merges two sources
rather than choosing one. See `docs/DECISIONS.md` D3.

## MQTT

| Item | Value | Confidence |
| --- | --- | --- |
| Username | `u_<uid>` | documented |
| Password | The access token, with no `Bearer` prefix | documented |
| Report topic | `device/<dev_id>/report`, subscribe | documented |
| Request topic | `device/<dev_id>/request`, publish — **never used** | documented |
| Client id | No documented convention | unverified |

Report fields that matter to the display, none of which HTTP provides:
`mc_percent`, `layer_num`, `total_layer_num`, `mc_remaining_time`,
`nozzle_temper`, `nozzle_target_temper`, `bed_temper`, `bed_target_temper`,
`chamber_temper`, `gcode_state`, `subtask_name`, `gcode_file`.

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
