# Development plan

## Product sentence

Show the richest reliable A1 or A1 mini status on TRMNL by fusing direct printer Wi-Fi telemetry with optional Bambu Cloud discovery, remote fallback, and project metadata.

## Proposed repository layout

```text
.
├── AGENTS.md
├── README.md
├── docs/
├── bridge/
│   ├── src/
│   │   ├── providers/
│   │   │   ├── local-mqtt/
│   │   │   ├── bambu-cloud/
│   │   │   └── home-assistant/        # later
│   │   ├── coordinator/
│   │   ├── normalize/
│   │   ├── secrets/
│   │   ├── push/
│   │   └── index.ts
│   ├── test/
│   ├── fixtures/
│   │   ├── local/
│   │   ├── cloud/
│   │   └── merged/
│   ├── package.json
│   └── tsconfig.json
├── plugin/
│   ├── .trmnlp.yml.example
│   └── src/
│       ├── settings.yml
│       ├── shared.liquid
│       ├── full.liquid
│       ├── half_horizontal.liquid
│       ├── half_vertical.liquid
│       └── quadrant.liquid
└── examples/
    └── bridge.env.example
```

Do not create real `.env`, `.dev.vars`, API-key, access-code, cloud-token, password, or webhook files in the repository.

## Phase 0 — protocol and authentication spikes

### Direct LAN

1. Choose a maintained MQTT client with TLS/SNI support.
2. Connect read-only to A1 with a disposable spike.
3. Capture sanitized reports for the fixture matrix in `BAMBU-PROTOCOL.md`.
4. Repeat on A1 mini.
5. Confirm report topic, TLS identity, state tokens, units, and partial-report behavior.
6. Compare values with Bambu Studio and, if available, ha-bambulab.

### Bambu Cloud

1. Build a separate disposable cloud spike.
2. Start token-first; do not persist account password.
3. Validate device discovery, regional cloud MQTT, and minimum metadata endpoints.
4. Exercise verification-code/2FA and token-expiry behavior.
5. Capture only sanitized response shapes.
6. Confirm which fields exist only in cloud data: history, project/task metadata, cover, weight, length, bed type.
7. Measure API drift/failure behavior without bypass loops.

Delete spikes and all unsanitized captures.

Gate: useful sanitized A1/A1 mini local fixtures, sanitized cloud fixtures, documented authentication behavior, and no credential leakage.

## Phase 1 — provider contracts and normalization

Implement pure contracts/functions first:

- `LocalMqttProvider`
- `BambuCloudProvider`
- `mergeReport(previous, patch)`
- `mergeObservations(observations, now)`
- `normalizePrinterState(merged, now)`
- `redactForLog(value)`
- `buildWebhookPayload(snapshot)`
- `measurePayloadBytes(payload)`

Tests:

- partial nested updates do not erase siblings
- malformed numeric strings become `null`
- unknown state is preserved
- local realtime data beats older cloud data
- cloud metadata enriches without replacing local telemetry
- cloud-only and local-only snapshots remain complete
- provider conflicts and staleness
- HMS and `print_error` coexist and deduplicate
- external spool and AMS Lite selection
- cover URL allowlisting/expiry
- job-name privacy switch
- serial/IP/access-code/password/token pattern redaction
- worst-case body stays below 2 kB

Gate: deterministic snapshots for local-only, cloud-only, and hybrid fixtures.

## Phase 2 — provider implementations

### Local provider

- verified TLS connection and printer identity
- passive report subscription
- partial state cache
- reconnect with bounded backoff/jitter
- stale detection
- optional one-shot full-status request behind tested capability

### Cloud provider

- encrypted token storage abstraction
- optional interactive login with transient password/code
- account-region handling
- device discovery
- cloud MQTT telemetry
- minimum HTTP metadata retrieval
- conservative cache/expiry
- explicit `reauth_required`
- bounded retries; no CAPTCHA/Cloudflare bypass loops

Gate: each provider survives its own outage/restart without affecting the other.

## Phase 3 — coordinator and push scheduler

Implement:

- capability detection
- per-field provenance and observation time
- deterministic precedence/hysteresis
- multi-printer identity mapping
- normalized state cache
- push candidate generation
- coalescing/token bucket
- TRMNL webhook client
- structured redacted logs
- graceful shutdown

Persistence may store the latest normalized snapshot, provider metadata timestamps, and encrypted token reference. Never persist raw MQTT, account password, verification code, or unredacted HTTP response.

Gate: coordinator survives local outage, cloud outage, token expiry, provider disagreement, printer reboot, bridge restart, webhook timeout, 429, and 5xx without stale-state lies or retry storms.

## Phase 4 — TRMNL templates

1. Scaffold under `plugin/` without overwriting repository docs.
2. Use merged fixture JSON in local preview.
3. Build Shared components.
4. Implement full view.
5. Implement both half views independently.
6. Implement quadrant.
7. Render hybrid, local, cloud-degraded, idle, preparing, printing, paused, finished, failed, stale, offline, and alert states.
8. Add optional project cover image with image-free fallback.
9. Build PNGs and inspect 1-bit output.

Gate: `trmnlp lint` passes and every state fits every viewport without overflow.

## Phase 5 — end-to-end

1. Human creates a TRMNL Private Plugin using Webhook strategy.
2. Human supplies webhook URL through local secret configuration.
3. Bridge sends synthetic merged fixture.
4. Verify latest render before real credentials/printer.
5. Test direct LAN on A1 and A1 mini.
6. Test cloud-only from a host without LAN reachability.
7. Test hybrid and deliberately interrupt each provider.
8. Verify hourly request ceiling over a complete print.
9. Verify device behavior, remembering TRMNL display follows pull/playlist schedule rather than instant push.[4]

Gate: no secret appears in Git, logs, process arguments, screenshots, TRMNL variables, or test artifacts.

## Phase 6 — hardening and distribution

- container and plain Node service
- OS/keyring-backed token storage where possible
- setup UI/CLI for hybrid, local-only, and cloud-only
- health/readiness endpoint bound to loopback only, if needed
- documented upgrades, reauthentication, and rollback
- signed/reproducible release artifacts
- configuration migration tests
- multi-printer overview
- Home Assistant provider evaluation
- official Bambu Local Server SDK provider evaluation
- public/unlisted TRMNL Recipe evaluation

## Acceptance criteria for first excellent release

- A1 and A1 mini verified.
- Hybrid recommended and verified.
- Direct-LAN mode works without Bambu Cloud.
- Cloud-only mode works remotely and is clearly labelled experimental.
- Local telemetry automatically wins when fresher.
- Cloud enriches discovery/history/project metadata and provides fallback.
- Token-first setup; persisted password and verification code prohibited.
- Cloud expiry becomes explicit `reauth_required` without breaking local mode.
- Verified local TLS; no insecure bypass default.
- Full/half/quadrant states complete.
- Progress, remaining time, layer, temperatures, filament, status, freshness, HMS, print error, connection mode, and optional project metadata represented.
- Unknown/unsupported values render honestly.
- Worst-case webhook body under 2 kB.
- Hard limit below 12 webhook calls/hour.
- No public inbound home service required.
- Clean secret scan and clean repository status.

## Open questions to answer with hardware/accounts

- Does current A1 firmware emit full or partial local reports?
- Does A1 mini differ in stage tokens or AMS Lite shape?
- Is one `pushall` request accepted without Developer Mode?
- Which TLS SNI value and CA chain work across both printers?
- Which cloud region/broker applies to the test account?
- Does current cloud MQTT expose identical telemetry shape?
- Which HTTP endpoint set remains stable enough for discovery and enrichment?
- What is the safest user-friendly access-token acquisition and reauthentication flow?
- Which cloud fields disappear or lag after completion?
- How should cover URLs be cached before signed URLs expire?
- How quickly should hybrid mode fail over and fail back without flapping?

## Sources

[4] https://help.usetrmnl.com/en/articles/10113695-how-refresh-rates-work — TRMNL Refresh Rates
