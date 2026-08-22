# trmnl-bambulab

A TRMNL plugin that shows useful Bambu Lab printer status on an e-paper display.

Status: research and architecture scaffold. No printer credentials, TRMNL tokens, production endpoints, or device data are committed.

## Chosen direction

Build the best available hybrid integration. A provider coordinator combines direct printer Wi-Fi/LAN MQTT with optional Bambu Cloud HTTP/MQTT. Local data wins for fresh realtime telemetry; cloud adds remote fallback, device discovery, print history, project metadata, and cover art. A compact normalized snapshot is pushed to a TRMNL Private Plugin webhook and rendered through Liquid templates.

Bambu documents local MQTT status pushes as unaffected by its newer command authorization mechanism, while printer control operations have additional restrictions.[11] Bambu Cloud has no general supported public consumer API contract, so the cloud provider remains isolated, optional, and capable of failing without breaking direct LAN operation.[18][22]

## Initial scope

- A1 and A1 mini first.
- Hybrid mode recommended; direct-LAN and cloud-only modes supported.
- Current job, progress, remaining time, layer, stage, temperatures, filament, connectivity, and errors.
- Cloud enrichment for printer discovery, history/project metadata, weight/length/bed data, and optional cover image.
- Multi-printer discovery and a clean path to fleet views.
- No pause, resume, stop, temperature, motion, filament, or print-start controls through TRMNL.

## Documentation

Read in this order:

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — hybrid topology and trade-offs.
2. [`docs/CONNECTION-MODES.md`](docs/CONNECTION-MODES.md) — direct LAN, cloud, hybrid, provider merge, and failure behavior.
3. [`docs/BAMBU-PROTOCOL.md`](docs/BAMBU-PROTOCOL.md) — local MQTT transport and telemetry mapping.
4. [`docs/TRMNL-PLUGIN.md`](docs/TRMNL-PLUGIN.md) — webhook contract, Liquid views, and local preview workflow.
5. [`docs/DEVELOPMENT-PLAN.md`](docs/DEVELOPMENT-PLAN.md) — implementation sequence and acceptance gates.
6. [`docs/RESOURCES.md`](docs/RESOURCES.md) — source hierarchy and useful links.

Future coding agents must also read [`AGENTS.md`](AGENTS.md).

## Sources

[11] https://wiki.bambulab.com/en/software/third-party-integration — Bambu Lab Third-party Integration
[18] https://docs.page/greghesp/ha-bambulab/setup — ha-bambulab Setup
[22] https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md — OpenBambuAPI Cloud HTTP protocol notes
