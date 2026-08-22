# Architecture

Research date: 2026-08-22.

## Decision

Build a capability-driven hybrid integration. Use direct printer Wi-Fi/LAN MQTT for the freshest telemetry whenever reachable, and optionally connect to Bambu Cloud for remote fallback, account device discovery, print-history metadata, cover art, weight/length, and other cloud-only enrichment.

```text
                         Bambu Cloud
                    HTTP API + cloud MQTT
                              |
                              v
Bambu A1 / A1 mini      Provider coordinator
local MQTT/TLS :8883 -> - capability detection
                              - freshness/provenance
                              - deterministic field merge
                              - normalization/redaction
                              - coalescing/rate limits
                                      |
                                      | HTTPS POST, compact JSON
                                      v
                           TRMNL Private Plugin
                                      |
                                      v
                         Liquid + Framework render
                                      |
                                      v
                           TRMNL e-paper device
```

Bambu documents LAN MQTT on TCP 8883 and TLS/access-code protection for local printer communication.[13][14]

Bambu does not publish a general public consumer Cloud API contract. Current cloud HTTP/MQTT behavior is reverse-engineered and must remain an optional, isolated adapter with graceful degradation.[15][18][22]

TRMNL webhook plugins accept merge variables pushed to a per-plugin URL and render them through the hosted markup engine.[2][3]

## Product modes

### Hybrid — preferred

Run both providers when the printer is locally reachable and the user opts into Bambu Cloud.

- Local MQTT is authoritative for live printer state, temperatures, layers, progress, stage, AMS state, and errors.
- Cloud enriches the snapshot with account-bound device discovery and print-history metadata.
- Cloud becomes a telemetry fallback when the local connection is unavailable.
- Every normalized field carries internal provenance and observation time so merge behavior is deterministic.

The mature ha-bambulab integration independently uses this pattern: cloud credentials provide the broadest metadata, while an optional local printer IP supplies more efficient and reliable sensor data and A1/P1 chamber-image support.[18][19]

### Direct LAN

Use printer host, serial, and LAN access code. Works without Bambu Cloud and is the privacy-preserving baseline. LAN MQTT status monitoring remains available under Bambu's newer authorization model; unrestricted control is a separate Developer Mode concern.[11][12]

### Cloud-only

Useful when the bridge is away from the printer LAN or local connectivity is temporarily unavailable. It must be labelled experimental because authentication, endpoints, token behavior, and cloud MQTT details are not a supported public API contract.[15][22]

### Home Assistant adapter

Optional later provider. It can reuse a deployed ha-bambulab integration and its mature entity model, but must not be required for normal operation.[18][19]

## Why the coordinator matters

Without a coordinator, hybrid connections can flap between conflicting values or regress to stale cloud data. The coordinator owns:

- provider health and capability discovery
- per-field observation timestamps
- source precedence
- stale thresholds
- conflict logging without secret/data leakage
- normalized schema versioning
- bounded fallback behavior

Recommended precedence:

| Field class | Primary | Fallback/enrichment |
| --- | --- | --- |
| live connectivity and state | local MQTT | cloud MQTT |
| progress, layer, remaining time, stage | local MQTT | cloud MQTT |
| temperatures, fans, AMS/filament | local MQTT | cloud MQTT |
| HMS and `print_error` | union of fresh providers | deduplicate by code |
| friendly device/account naming | explicit local config | cloud device metadata |
| cover image, weight, length, bed type, history | cloud HTTP | local print-file parsing later |
| bridge freshness | coordinator clock | never remote timestamp alone |

Never let older cloud data overwrite fresher local data. Never infer healthy from one provider if another fresh provider reports an error.

## Components

### 1. Local provider

- Establish verified MQTT-over-TLS connection to the configured printer.
- Subscribe to the report topic.
- Parse JSON defensively and merge partial patches.
- Emit provider observations, not TRMNL payloads.
- Mark data stale/offline after tested deadlines.
- Keep LAN access code, serial, IP, and raw reports out of logs.

### 2. Cloud provider

- Support token-first configuration.
- If interactive login is implemented, handle verification-code/2FA flow and discard the password after obtaining a token.
- Discover account-bound devices and select by stable device identity.
- Subscribe to cloud MQTT for remote telemetry when available.
- Query only the minimum HTTP endpoints needed for enrichment.
- Cache metadata with conservative expiry and backoff.
- Stop cleanly on authentication failure instead of retrying credentials aggressively.

OpenBambuAPI documents observed bearer-token HTTP auth, device listing, print tasks/projects, cover URLs, and cloud MQTT identity derivation, but also notes unreliable refresh-token behavior. Treat all of it as volatile.[22]

### 3. Provider coordinator and normalizer

Templates consume one stable schema regardless of provider mix.

Rules:

- Keep schema versioned with `schema_version`.
- Track source and observation time internally for every merged field.
- Convert temperatures to numeric Celsius values.
- Keep remaining time in integer minutes.
- Keep progress in integer percent after validation.
- Surface both HMS and `print_error`; they are independent channels.[15]
- Represent unsupported or absent values as `null`, not fabricated zeros.
- Preserve unknown state/error tokens in explicitly named fields.
- Export only coarse connection mode (`hybrid`, `local`, `cloud`, `offline`), never provider credentials or identifiers.

### 4. Push scheduler

Recommended default policy:

- Immediate candidate on transition into printing, paused, finished, failed, or offline.
- Immediate candidate when a new error appears.
- Periodic candidate every 10 minutes while printing.
- Periodic heartbeat every 30 minutes while idle.
- Coalesce candidates for a short debounce window.
- Enforce a hard token bucket below the TRMNL account limit; queue only the newest snapshot.
- Retry transient failures with bounded exponential backoff and jitter.
- Honor `429`; never amplify rate limiting.

TRMNL devices request screens and may not display a pushed update immediately. Refresh timing is pull-based and constrained by device, playlist, plugin, and account settings.[4]

### 5. TRMNL renderer

One Private Plugin instance uses Webhook strategy. Templates read the normalized schema and provide full, half-horizontal, half-vertical, and quadrant layouts. Shared markup owns reusable Liquid components and styles.

## Secret model

Local provider:

- `BAMBU_PRINTER_HOST`
- `BAMBU_PRINTER_SERIAL`
- `BAMBU_ACCESS_CODE`

Cloud provider, optional:

- encrypted Bambu Cloud access token
- account region
- optional account identifier for reauthentication UX
- password and verification code must be transient, never persisted

TRMNL:

- `TRMNL_WEBHOOK_URL`

Rules:

- Load secrets from a permission-restricted local secret store.
- Never put secrets in sample config, fixtures, screenshots, logs, errors, telemetry, process arguments, GitHub Actions, or TRMNL merge variables.
- Treat the TRMNL webhook URL as a credential because it contains the plugin-setting UUID.[3]
- Never send Bambu Cloud tokens or LAN credentials to an author-controlled relay.
- Cloud support must be optional; local mode must keep working during cloud outages or API drift.

## Scope boundaries

### Monitoring and enrichment

In scope: best available status, progress, remaining time, layer, stage, temperatures, AMS/filament, errors, connectivity, cloud-derived cover art/history metadata, and multi-printer discovery.

### Printer controls

Still out of scope for the TRMNL display path. E-paper refresh is asynchronous and unsuitable for safety-critical control feedback. The provider architecture may discover capabilities, but no pause/resume/stop/motion/temperature/print-start operation should be exposed without a separate design and explicit approval.[4][11]

### Live camera

Deferred. A static cloud cover image or project thumbnail is useful on e-paper; a live camera feed adds privacy, bandwidth, model-specific behavior, and poor fit for a slow-refresh display.[18][19]

## Official future path

Bambu's Local Server SDK offers supported printer management, monitoring, control, file, and task APIs, but access requires application and platform support remains constrained. Keep an adapter seam for it; do not block v1 on SDK approval.[11]

## Future extension seams

- Multi-printer overview and per-printer views.
- Home Assistant provider.
- Official Bambu Local Server provider.
- Optional hosted state relay only if public Recipe distribution demands it.
- Public Recipe after setup is simple, all layouts pass, and user credentials remain user-owned.

## Sources

[2] https://help.usetrmnl.com/en/articles/9510536-private-plugins — TRMNL Private Plugins
[3] https://docs.usetrmnl.com/go/private-plugins/webhooks.md — TRMNL Private Plugin Webhooks
[4] https://help.usetrmnl.com/en/articles/10113695-how-refresh-rates-work — TRMNL Refresh Rates
[11] https://wiki.bambulab.com/en/software/third-party-integration — Bambu Lab Third-party Integration
[12] https://wiki.bambulab.com/en/knowledge-sharing/enable-lan-mode — Bambu Lab LAN Mode
[13] https://wiki.bambulab.com/en/general/bbl-security — Bambu Lab Security
[14] https://wiki.bambulab.com/en/general/printer-network-ports — Bambu Lab Printer Network Ports
[15] https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md — OpenBambuAPI MQTT protocol notes
[18] https://docs.page/greghesp/ha-bambulab/setup — ha-bambulab Setup
[19] https://docs.page/greghesp/ha-bambulab/entities — ha-bambulab Entities
[22] https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md — OpenBambuAPI Cloud HTTP protocol notes
