# Architecture

Research date: 2026-08-22.

## Decision

Build v1 as a local, read-only telemetry bridge feeding a TRMNL Private Plugin webhook.

```text
Bambu A1 / A1 mini
  MQTT over TLS :8883
          |
          v
Local bridge (Node.js/TypeScript)
  - authenticate with LAN access code
  - merge partial reports
  - normalize + redact
  - coalesce + rate-limit
          |
          | HTTPS POST, compact JSON
          v
TRMNL Private Plugin webhook
          |
          v
Liquid + TRMNL Framework render
          |
          v
TRMNL e-paper device
```

Bambu documents LAN MQTT on TCP 8883 and TLS/access-code protection for local printer communication.[13][14]

TRMNL webhook plugins accept merge variables pushed to a per-plugin URL and render them through the hosted markup engine.[2][3]

## Why this topology

### Local printer connection

The printer is a LAN resource. A cloud-hosted function cannot directly connect to a private printer address. A local bridge can subscribe without exposing MQTT, FTP, camera, Home Assistant, or the printer itself to the public Internet.

Bambu's newer authorization system restricts control operations, but Bambu explicitly lists MQTT status pushes, including Home Assistant-style monitoring, as unaffected. Developer Mode is needed for unrestricted control and disables Bambu Cloud; v1 does not need or request that trade-off.[11]

### Direct push to TRMNL

The bridge already receives events, so TRMNL's Webhook strategy is a natural fit. It avoids a public polling API and any hosted state database. The webhook UUID is an outbound credential held only by the bridge.

TRMNL's standard webhook budget is 12 requests/hour and 2 kB per payload; TRMNL+ raises those limits to 30/hour and 5 kB.[3] The bridge therefore must not forward MQTT messages one-for-one.

### Read-only first

A passive e-paper dashboard does not need machine control. Excluding commands removes the highest-risk paths: stopping prints, moving axes, changing temperatures, loading filament, or starting files. It also avoids dependence on Developer Mode and authorization behavior that varies by model and firmware.[11][17]

## Components

### 1. Bambu adapter

Responsibilities:

- Establish verified MQTT-over-TLS connection to the configured printer.
- Subscribe only to the report topic.
- Parse JSON defensively.
- Merge partial patches into cached state.
- Emit normalized snapshots, not raw MQTT.
- Mark data stale/offline after configurable deadlines.

It must not expose the access code, serial, IP, raw report, or model/project filename in logs by default.

### 2. Normalizer

The normalizer is a compatibility boundary. Templates consume one stable schema even when Bambu firmware changes field names, report density, or state codes.

Rules:

- Keep schema versioned with `schema_version`.
- Convert temperatures to numeric Celsius values.
- Keep remaining time in integer minutes.
- Keep progress in integer percent, clamped only after type validation.
- Surface both HMS and `print_error`; they are independent channels in community protocol observations.[15]
- Represent unsupported or absent values as `null`, not fabricated zeros.
- Preserve raw unknown state/error tokens in explicitly named fields.

### 3. Push scheduler

Recommended default policy:

- Immediate candidate on transition into printing, paused, finished, failed, or offline.
- Immediate candidate when a new error appears.
- Periodic candidate every 10 minutes while printing.
- Periodic heartbeat every 30 minutes while idle.
- Coalesce candidates for a short debounce window.
- Enforce a hard token bucket below the account limit; queue only the newest snapshot.
- Retry transient failures with bounded exponential backoff and jitter.
- Honor `429`; never retry fast enough to amplify rate limiting.

The device itself requests screens and may not display a pushed update immediately. TRMNL refresh timing is pull-based and constrained by device, playlist, plugin, and account settings.[4]

### 4. TRMNL renderer

One Private Plugin instance uses Webhook strategy. The templates read the normalized schema and provide all four TRMNL layouts. Shared markup owns reusable Liquid components and styles.

## Secrets

Local-only configuration:

- `BAMBU_PRINTER_HOST`
- `BAMBU_PRINTER_SERIAL`
- `BAMBU_ACCESS_CODE`
- `TRMNL_WEBHOOK_URL`
- optional friendly display name

Rules:

- Load from environment or a permission-restricted local secrets file.
- Never put secrets in sample config, fixtures, screenshots, logs, errors, telemetry, GitHub Actions, or TRMNL merge variables.
- Treat the TRMNL webhook URL as a credential because it contains the plugin-setting UUID.[3]
- Keep the Bambu LAN access code on the LAN bridge only.

## Rejected v1 alternatives

### Bambu Cloud API from a hosted worker

Rejected. The public integration path is Bambu Connect/Local Server rather than a stable public telemetry API for this use case. Cloud-login reverse engineering would add account credentials, 2FA/session churn, remote dependency, and avoidable privacy risk.[11]

### TRMNL polling a Home Assistant endpoint

Deferred. It can reuse the mature ha-bambulab entity model, but it requires a public authenticated Home Assistant-facing endpoint or another relay. The direct bridge has fewer dependencies. A Home Assistant adapter remains a useful later option because the integration exposes progress, layers, temperatures, AMS state, connectivity, HMS errors, and print errors.[18][19]

### Camera images

Rejected for v1. Camera availability differs by model and mode, increases privacy exposure and bandwidth, and adds image processing that does not improve the core glanceable status use case.[18][19]

### Printer controls from TRMNL

Rejected. E-paper is the display, not a safety-critical control surface. TRMNL refresh is asynchronous, so command feedback would be poor even if controls were technically possible.[4][11]

## Future extension seams

- Multiple printers: array of normalized printer snapshots plus selection/summary views.
- Home Assistant adapter: read existing entities instead of direct MQTT.
- Optional hosted relay: only if recipe distribution needs installer-specific endpoints.
- Public Recipe: after local setup is simple, all layouts pass, and secrets remain user-owned.

## Sources

[2] https://help.usetrmnl.com/en/articles/9510536-private-plugins — TRMNL Private Plugins
[3] https://docs.usetrmnl.com/go/private-plugins/webhooks.md — TRMNL Private Plugin Webhooks
[4] https://help.usetrmnl.com/en/articles/10113695-how-refresh-rates-work — TRMNL Refresh Rates
[11] https://wiki.bambulab.com/en/software/third-party-integration — Bambu Lab Third-party Integration
[13] https://wiki.bambulab.com/en/general/bbl-security — Bambu Lab Security
[14] https://wiki.bambulab.com/en/general/printer-network-ports — Bambu Lab Printer Network Ports
[15] https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md — OpenBambuAPI MQTT protocol notes
[17] https://docs.page/greghesp/ha-bambulab — ha-bambulab Integration Overview
[18] https://docs.page/greghesp/ha-bambulab/setup — ha-bambulab Setup
[19] https://docs.page/greghesp/ha-bambulab/entities — ha-bambulab Entities
