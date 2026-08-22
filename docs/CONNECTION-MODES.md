# Connection modes and provider behavior

Research date: 2026-08-22.

## Goal

Deliver the richest reliable snapshot available without forcing one connectivity model. Users should be able to run local-only, cloud-only, or hybrid. Hybrid is the premium/default recommendation when both connections are configured.

## Capability matrix

| Capability | Direct LAN MQTT | Bambu Cloud | Hybrid |
| --- | --- | --- | --- |
| live state/progress | best latency | remote fallback | local primary |
| temperatures/layers/stage | direct | usually available through cloud MQTT | local primary |
| AMS/filament | direct | remote fallback | local primary |
| HMS/print error | direct | remote fallback | union + dedupe |
| account device discovery | manual config | yes | cloud-assisted |
| remote operation away from printer LAN | no | yes | yes |
| print history/project metadata | limited | richest source | cloud enrichment |
| cover/project image | limited | available in observed task data | cloud enrichment |
| works without Internet | yes | no | local degrades cleanly |
| supported public API stability | local transport documented; schema not public | no general public consumer API | adapters isolate risk |

Bambu officially documents the local transport and monitoring exemption, but not the full status schema or a general Cloud API contract.[11][13][14]

Community implementations demonstrate cloud and hybrid operation, including cloud-derived print metadata plus direct local telemetry.[18][19][22]

## Provider interface

Each provider should implement a small internal contract:

```ts
interface BambuProvider {
  id: "local" | "cloud" | "home_assistant" | "local_server";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  health(): ProviderHealth;
  capabilities(): CapabilitySet;
  subscribe(onObservation: (observation: Observation) => void): Unsubscribe;
  refreshMetadata?(): Promise<void>;
}
```

An `Observation` contains:

- provider id
- printer identity key
- observed-at timestamp
- received-at timestamp
- partial normalized fields
- provider confidence/capabilities
- raw state token only where needed for debugging/compatibility

Raw provider payloads never cross into the TRMNL renderer.

## Local provider

Configuration:

- printer IP/hostname
- printer serial
- LAN access code
- expected model
- optional friendly name

Transport uses MQTT over TLS on port 8883. Community observations identify username `bblp` and `device/<serial>/report` as the status topic.[15]

Connection requirements:

- validate the Bambu certificate chain
- validate printer identity/serial using SNI or explicit certificate inspection
- no insecure fallback
- merge partial MQTT reports
- reconnect with bounded exponential backoff
- detect stale data independently from socket state

## Cloud provider

Cloud support is valuable, but experimental.

Observed community flow:

1. Authenticate to Bambu HTTP services and receive a bearer access token.
2. Discover account-bound printers.
3. Derive the cloud MQTT user identity.
4. Connect to the regional cloud MQTT broker using TLS and the access token.
5. Fetch minimal task/project metadata for enrichment.[15][22]

Security design:

- Prefer importing an existing access token over storing account password.
- If password login is added, use an interactive one-time flow and support verification code/2FA.
- Immediately discard password and verification code after token acquisition.
- Encrypt the access token at rest with an OS/keyring-backed secret store where available.
- Never print token prefixes, claims, account email, device IDs, or response bodies in normal logs.
- Do not implement high-frequency login retries or CAPTCHA/Cloudflare bypass loops.
- On token expiry, enter `reauth_required` while local mode continues.

Observed refresh-token behavior is unreliable, so reauthentication must be a first-class state rather than hidden retry magic.[22]

## Hybrid merge policy

Use per-field merge, not whole-snapshot winner-takes-all.

Priority rules:

1. Reject observations outside their provider's freshness window.
2. Prefer fresher observation when sources are equivalent.
3. Prefer local for realtime telemetry when both are fresh.
4. Prefer cloud for account/history/project enrichment.
5. Union current errors from all fresh providers and deduplicate by normalized code.
6. Never clear an error solely because one provider omits it; require explicit clear or expiry semantics.
7. Apply hysteresis to connection-mode labels to avoid local/cloud flapping.
8. Record provenance internally for diagnostics, but export only safe coarse mode.

Suggested freshness windows must be validated on hardware:

- realtime local telemetry: tens of seconds
- cloud MQTT telemetry: tens of seconds to a few minutes
- project metadata: hours or task lifetime
- history: refresh on task transition plus low-frequency background update

## Connection selection UX

Setup should offer:

- `Hybrid (recommended)`
- `Direct LAN only`
- `Bambu Cloud only (experimental)`
- later: `Home Assistant`

Hybrid setup sequence:

1. Configure Cloud and discover printers.
2. Select printer(s).
3. Attempt local discovery.
4. Ask for LAN access code only for selected printers.
5. Verify local TLS identity.
6. Show capability summary before saving.
7. Run a synthetic TRMNL preview before enabling automatic pushes.

No setup path should require Developer Mode for monitoring. If a firmware/model cannot provide local reads without it, report that limitation and fall back to cloud rather than silently changing printer mode.[11][17]

## Multi-printer behavior

Cloud discovery makes multi-printer support natural. The coordinator should key printers by an internal opaque identifier, while templates receive only safe friendly names and normalized status.

Initial rendering options:

- one selected printer per plugin instance
- automatic "active printer" view
- compact fleet overview

Do not expose printer serials as public custom fields or merge variables.

## Failure behavior

| Failure | Expected result |
| --- | --- |
| local Wi-Fi/MQTT down | cloud telemetry continues; mode becomes `cloud` |
| Bambu Cloud outage | local telemetry continues; cloud-only metadata marked stale |
| cloud token expired | local continues; setup reports `reauth_required` |
| both unavailable | last safe snapshot becomes stale, then offline |
| provider disagreement | fresher local realtime value wins; conflict recorded safely |
| TRMNL 429/5xx | newest snapshot retained; bounded retry |
| printer reboot | providers reconnect; stale state cannot masquerade as idle |

## Licensing and implementation caution

Use ha-bambulab and OpenBambuAPI as behavioral references and fixture cross-checks. Do not copy source without confirming the exact repository/file license. Reverse-engineered interfaces can change without notice; keep them behind adapters and contract tests.

## Sources

[11] https://wiki.bambulab.com/en/software/third-party-integration — Bambu Lab Third-party Integration
[13] https://wiki.bambulab.com/en/general/bbl-security — Bambu Lab Security
[14] https://wiki.bambulab.com/en/general/printer-network-ports — Bambu Lab Printer Network Ports
[15] https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md — OpenBambuAPI MQTT protocol notes
[17] https://docs.page/greghesp/ha-bambulab — ha-bambulab Integration Overview
[18] https://docs.page/greghesp/ha-bambulab/setup — ha-bambulab Setup
[19] https://docs.page/greghesp/ha-bambulab/entities — ha-bambulab Entities
[22] https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md — OpenBambuAPI Cloud HTTP protocol notes
