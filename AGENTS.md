# Agent instructions

Before changing code, read `docs/ARCHITECTURE.md`, `docs/CONNECTION-MODES.md`, `docs/BAMBU-PROTOCOL.md`, `docs/TRMNL-PLUGIN.md`, and `docs/DEVELOPMENT-PLAN.md`.

## Non-negotiable v1 boundaries

- Monitoring and enrichment only. Do not publish MQTT commands that control the printer.
- Implement direct LAN and optional Bambu Cloud as isolated providers behind one coordinator; hybrid is the preferred mode.
- Cloud support must be optional and degrade cleanly. Local monitoring must survive cloud outage, token expiry, or API drift.
- Prefer token-first Cloud configuration. If interactive login is added, passwords and verification codes must be transient and discarded after token acquisition.
- Never commit printer serials, IP addresses, LAN access codes, Bambu Cloud credentials/tokens, TRMNL webhook UUIDs, API keys, captured model names, or raw telemetry.
- Keep all public payloads normalized and under the TRMNL webhook size ceiling.
- Treat MQTT reports as partial patches. Merge them into an in-memory state object before normalization.
- Preserve unknown states and raw numeric error codes. Do not silently map unknown values to healthy or idle.
- A1 and A1 mini are the first supported hardware. Do not claim support for another model without fixtures and tests.
- Use TLS certificate validation. Do not add an `insecure: true` default or disable verification to make local MQTT connect.
- Rate-limit and coalesce TRMNL pushes. Printer MQTT frequency is not the TRMNL update frequency.

## Source discipline

1. Bambu Lab Wiki for supported behavior and security policy.
2. TRMNL docs and official repositories for plugin contracts and rendering.
3. OpenBambuAPI and ha-bambulab for reverse-engineered field meanings.
4. Captured, sanitized A1/A1 mini fixtures for actual implementation truth.

When sources disagree, document the disagreement and prefer conservative read-only behavior.

## Required gates

- Unit tests for provider capability detection, per-field hybrid merging, normalization, partial-report merging, redaction, payload size, and rate limiting.
- Fixture tests for local-only, cloud-only, hybrid, cloud reauthentication, provider disagreement, idle, preparing, printing, paused, finished, offline, HMS alert, and `print_error` without HMS.
- Render all four TRMNL layouts locally and inspect PNG output.
- Test reconnects, stale data, printer reboot, bridge restart, and webhook 429/5xx handling.
