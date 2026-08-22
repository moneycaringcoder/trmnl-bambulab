# Development plan

## Product sentence

Show the state of an A1 or A1 mini print at a glance on TRMNL without exposing the printer or granting remote control.

## Proposed repository layout

```text
.
├── AGENTS.md
├── README.md
├── docs/
├── bridge/
│   ├── src/
│   │   ├── bambu/
│   │   ├── normalize/
│   │   ├── push/
│   │   └── index.ts
│   ├── test/
│   ├── fixtures/
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

Do not create real `.env`, `.dev.vars`, API-key, access-code, or webhook files in the repository.

## Phase 0 — fixtures and spike

1. Choose one maintained MQTT client with TLS/SNI support.
2. Connect read-only to one A1 using a disposable local spike.
3. Capture sanitized reports for the fixture matrix in `BAMBU-PROTOCOL.md`.
4. Repeat on A1 mini.
5. Confirm actual report topic, TLS identity behavior, state tokens, progress units, remaining-time units, and whether reports are partial.
6. Compare normalized values with Bambu Studio and, if available, ha-bambulab.
7. Delete the spike and all unsanitized captures.

Gate: no production implementation until both printer models have useful sanitized fixtures and no credential leakage.

## Phase 1 — normalization library

Implement pure functions first:

- `mergeReport(previous, patch)`
- `normalizePrinterState(cache, connectionState, now)`
- `redactForLog(value)`
- `buildWebhookPayload(snapshot)`
- `measurePayloadBytes(payload)`

Tests:

- partial nested updates do not erase siblings
- malformed numeric strings become `null`
- unknown state is preserved
- HMS and `print_error` coexist
- stale/offline timing
- external spool and AMS Lite selection
- job-name privacy switch
- serial/IP/access-code/token pattern redaction
- JSON body remains below 2 kB for worst-case bounded alerts

Gate: deterministic snapshots from every fixture.

## Phase 2 — local bridge

Implement:

- validated TLS connection
- reconnect with bounded backoff and jitter
- passive report subscription
- optional one-shot full-status request behind a tested model capability
- state cache
- push candidate generation
- coalescing/token bucket
- TRMNL webhook client
- structured logs with no secrets
- graceful shutdown

Persistence is optional for v1. If added, store only the latest normalized snapshot and scheduler timestamps, not raw MQTT or secrets.

Gate: bridge survives printer reboot, network interruption, its own restart, webhook timeout, 429, and 5xx without hot loops or duplicate storms.

## Phase 3 — TRMNL templates

1. Scaffold the plugin with `trmnlp` in `plugin/` without overwriting repository docs.
2. Use fixture JSON through local config.
3. Build Shared components.
4. Implement full view.
5. Implement both half views independently; do not merely scale the full view.
6. Implement quadrant.
7. Render idle, preparing, printing, paused, finished, failed, stale, offline, and alert states.
8. Build PNGs and visually inspect 1-bit output.

Gate: `trmnlp lint` passes and every state fits every viewport without overflow.

## Phase 4 — end-to-end

1. Human creates a TRMNL Private Plugin using Webhook strategy.
2. Human supplies the generated webhook URL through local secret configuration.
3. Bridge sends a synthetic fixture snapshot.
4. Verify the latest render in TRMNL before connecting a real printer.
5. Connect A1, then A1 mini.
6. Verify event coalescing and hourly request ceiling over a complete print.
7. Verify device behavior, remembering that TRMNL screen display follows its pull/playlist schedule rather than instant push.[4]

Gate: no secret appears in Git, logs, process arguments, screenshots, TRMNL merge variables, or test artifacts.

## Phase 5 — hardening and distribution

- package bridge as a small container and a plain Node service
- health/readiness endpoint bound to loopback only, if needed
- documented upgrades and rollback
- signed/reproducible release artifacts
- configuration migration tests
- multi-printer design only after one-printer reliability
- evaluate a Home Assistant adapter
- evaluate public/unlisted TRMNL Recipe publication

## Acceptance criteria for v1

- A1 and A1 mini both verified.
- Read-only operation; no control publish path exists.
- Verified TLS; no insecure bypass default.
- Full/half/quadrant render states complete.
- Progress, remaining time, layer, temperatures, filament, status, freshness, HMS, and print error represented.
- Unknown/unsupported values render honestly.
- Worst-case webhook body under 2 kB.
- Hard limit below 12 webhook calls/hour.
- No public inbound service required.
- No Bambu Cloud credentials required.
- Clean secret scan and clean repository status.

## Open questions to answer with hardware

- Does current A1 firmware emit full or partial status reports?
- Does A1 mini differ in stage tokens or AMS Lite data shape?
- Is one `pushall` request accepted without Developer Mode on current firmware?
- Which exact TLS SNI value and CA chain work across both printers?
- How quickly does each printer report offline versus a dead TCP session?
- Are remaining-time values consistently minutes?
- Which fields disappear immediately after completion?
- How many HMS entries can be active in realistic conditions while staying under payload budget?

## Sources

[4] https://help.usetrmnl.com/en/articles/10113695-how-refresh-rates-work — TRMNL Refresh Rates
