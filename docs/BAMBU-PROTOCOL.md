# Bambu data and protocol notes

Research date: 2026-08-22.

## Authority and stability

Bambu documents local MQTT, TLS, access-code authentication, and LAN mode.[12][13][14]

Bambu separately documents which operations are affected by authorization changes.[11]

Bambu does not publish the full telemetry schema used below. Field meanings come from OpenBambuAPI and the mature ha-bambulab integration, so treat them as reverse-engineered and firmware-sensitive.[15][17][19]

Never make a field-name assumption without a sanitized A1 or A1 mini fixture and a test.

## Local connection

Official network facts:

- LAN MQTT uses TCP port 8883.[14]
- Local communication is encrypted with TLS and authenticated with a printer access code.[13]
- LAN Mode can operate without Internet access; on A-series printers it is enabled from the printer settings.[12]
- Status monitoring remains available under the newer authorization mechanism; restricted commands are a separate concern.[11]

Community-observed MQTT parameters:

```text
broker:   <printer-ip>:8883
TLS:      required
username: bblp
password: <LAN access code>
report:   device/<printer-serial>/report
request:  device/<printer-serial>/request
```

These topic names and the `bblp` username are reverse-engineered, not a formal Bambu API contract.[15]

## TLS handling

Do not disable certificate verification. OpenBambuAPI documents a Bambu CA for printer certificates and notes that the certificate common name is the printer serial while clients usually connect to an IP. Correct clients therefore need CA trust plus SNI/hostname handling, or an explicit post-handshake serial check when their TLS library cannot provide SNI.[16]

Implementation requirements:

- Vendor or retrieve the expected Bambu CA through a reviewed, reproducible mechanism.
- Configure SNI to the expected printer serial when the library allows it.
- Reject a certificate whose identity does not match the configured printer.
- Fail closed on certificate errors.
- Never ship an insecure fallback as the default.

## Cloud connection

Cloud support is useful for remote fallback, account-bound device discovery, print history, project metadata, cover images, weight/length, and bed type. It is not a supported public consumer API contract.

Community-observed cloud behavior includes bearer-token HTTP requests, account device listing, print task/project endpoints, regional cloud MQTT brokers, and cloud MQTT authentication derived from account identity plus access token.[15][22]

Implementation rules:

- Keep Cloud in a separate adapter from local MQTT.
- Prefer token-first setup.
- If interactive login is supported, handle verification-code/2FA flow and discard the password/code immediately after token acquisition.
- Encrypt the token at rest.
- Make token expiry and `reauth_required` explicit; community notes report ineffective refresh-token behavior.[22]
- Fetch only minimum required metadata at low frequency.
- Never let stale Cloud observations overwrite fresher local state.
- Never require Cloud for direct LAN monitoring.

The ha-bambulab integration demonstrates practical cloud, local, and hybrid operation. Its docs describe cloud credentials as the richest setup and optional direct IP as the more efficient/reliable source for printer sensors and A1/P1 chamber images.[18][19]

## Report model

Messages are JSON objects. The report topic can contain printer status and command responses.[15]

Assume every incoming report is partial. Deep-merge present keys into the cached printer state; absence must not erase earlier values. This rule is mandatory even if a captured A1 firmware appears to send full objects, because other Bambu models are known to send only changed values.[15]

On initial connect:

1. Subscribe to the report topic.
2. Accept status messages immediately.
3. Optionally request one full status snapshot only if validated on A1 and A1 mini firmware.
4. Do not poll `pushall` frequently. Community protocol notes warn against intervals below five minutes on lower-power P-series hardware.[15]
5. If a full request is rejected, continue accumulating passive reports rather than enabling Developer Mode or weakening security.

## Minimum normalized field map

| Normalized field | Candidate MQTT source | Notes |
| --- | --- | --- |
| `printer.online` | connection state / report timestamp | Derive locally; do not trust one boolean forever. |
| `printer.model` | configured model | Configuration, not guessed from serial. |
| `job.state` | `print.gcode_state` | Preserve unknown raw token. |
| `job.name` | `print.subtask_name`, fallback `gcode_file` | Sanitize and truncate before leaving LAN. |
| `job.progress` | `print.mc_percent` | Validate numeric 0–100. |
| `job.remaining_minutes` | `print.mc_remaining_time` | Community examples use minutes. Verify fixture. |
| `job.layer.current` | `print.layer_num` | `null` when unavailable. |
| `job.layer.total` | `print.total_layer_num` | `null` when unavailable. |
| `job.stage_code` | `print.mc_print_stage` / `mc_print_sub_stage` | Mapping may vary. Keep raw code. |
| `temperatures.nozzle` | `print.nozzle_temper` | Celsius. |
| `temperatures.nozzle_target` | `print.nozzle_target_temper` | Celsius. |
| `temperatures.bed` | `print.bed_temper` | Celsius. |
| `temperatures.bed_target` | `print.bed_target_temper` | Celsius. |
| `material.active_source` | `print.tray_now` | 254 commonly means external spool; verify per model. |
| `material.type` | matching AMS tray or `vt_tray.tray_type` | Do not guess if tray data is incomplete. |
| `material.color` | `tray_color` | Convert RGBA/RRGGBBAA safely; e-paper may ignore hue. |
| `alerts.hms` | `print.hms[]` | Keep code; text lookup optional. |
| `alerts.print_error` | `print.print_error` | Independent of HMS; format nonzero as 8-digit hex. |
| `diagnostics.wifi_signal` | `print.wifi_signal` | Optional; do not make it a hero metric. |
| `updated_at` | bridge clock at accepted report | UTC ISO 8601. |

The ha-bambulab entity catalog independently confirms the useful product surface: print status, stage, progress, remaining time, layers, temperatures, active tray, AMS details, online status, Wi-Fi, HMS errors, and print errors.[19]

## State semantics

Known community-observed `gcode_state` values include `IDLE`, `PREPARE`, `RUNNING`, `PAUSE`, `FINISH`, `FAILED`, `SLICING`, `INIT`, and `OFFLINE`.[15]

Normalize into a small display state without losing the raw value:

| Raw examples | Display state |
| --- | --- |
| `RUNNING` | `printing` |
| `PREPARE`, `SLICING`, `INIT` | `preparing` |
| `PAUSE` | `paused` |
| `FINISH` | `finished` |
| `FAILED` | `failed` |
| `IDLE` | `idle` |
| `OFFLINE` or stale connection | `offline` |
| anything else | `unknown` |

Do not infer success from 100% progress alone. Prefer explicit state transition. Do not infer healthy from an empty HMS list; `print_error` is a separate channel and can be nonzero while HMS is empty.[15][20]

## A1 and A1 mini fixture matrix

Capture sanitized reports for both printers in these conditions:

- cold idle
- heating/preparing
- active print at early, middle, and late progress
- paused
- resumed
- successful finish
- canceled print
- printer powered off / network disconnected
- external spool
- AMS Lite active slot and slot change
- filament runout or another safe recoverable alert, when naturally available
- nonzero print error, when naturally available

Redaction before commit:

- Replace serial, IP, access code, account/user IDs, task IDs, project IDs, filenames, model names, URLs, and timestamps.
- Preserve object shape, types, state tokens, stage codes, and numeric ranges.
- Run an automated secret/identifier scan before adding fixtures to Git.

## Home Assistant as a reference adapter

ha-bambulab supports cloud credentials, optional direct printer IP, or LAN-only configuration with serial, IP, and access code.[18] It is valuable for:

- Cross-checking field interpretation.
- Comparing A1/A1 mini state transitions.
- A future adapter that reads HA entities instead of MQTT.
- Error text and event behavior.

It is not a normative protocol specification. Its release notes and entities should be pinned when borrowed, and its license must be reviewed before copying code rather than behavior.

## Sources

[11] https://wiki.bambulab.com/en/software/third-party-integration — Bambu Lab Third-party Integration
[12] https://wiki.bambulab.com/en/knowledge-sharing/enable-lan-mode — Bambu Lab LAN Mode
[13] https://wiki.bambulab.com/en/general/bbl-security — Bambu Lab Security
[14] https://wiki.bambulab.com/en/general/printer-network-ports — Bambu Lab Printer Network Ports
[15] https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md — OpenBambuAPI MQTT protocol notes
[16] https://github.com/Doridian/OpenBambuAPI/blob/main/tls.md — OpenBambuAPI TLS certificate notes
[17] https://docs.page/greghesp/ha-bambulab — ha-bambulab Integration Overview
[18] https://docs.page/greghesp/ha-bambulab/setup — ha-bambulab Setup
[19] https://docs.page/greghesp/ha-bambulab/entities — ha-bambulab Entities
[20] https://docs.page/greghesp/ha-bambulab/device-triggers — ha-bambulab Device Triggers
[22] https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md — OpenBambuAPI Cloud HTTP protocol notes
