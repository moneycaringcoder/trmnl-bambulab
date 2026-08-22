# trmnl-bambulab

A TRMNL plugin that shows useful Bambu Lab printer status on an e-paper display.

Status: research and architecture scaffold. No printer credentials, TRMNL tokens, production endpoints, or device data are committed.

## Chosen v1 direction

A small read-only bridge runs on the same LAN as the printer. It subscribes to the printer's local MQTT status feed, normalizes a compact snapshot, and pushes that snapshot to a TRMNL Private Plugin webhook. The TRMNL side renders Liquid templates for full, half-horizontal, half-vertical, and quadrant views.

This shape keeps printer access local, avoids depending on undocumented Bambu Cloud login APIs, and requires no inbound access to the home network. Bambu documents local MQTT status pushes as unaffected by its newer command authorization mechanism, while printer control operations have additional restrictions.[11]

## Initial scope

- A1 and A1 mini first.
- Read-only printer status.
- Current job, progress, remaining time, layer, stage, temperatures, filament, connectivity, and errors.
- No camera feed.
- No pause, resume, stop, temperature, motion, filament, or print-start controls.
- One printer per bridge instance initially; multi-printer schema remains possible.

## Documentation

Read in this order:

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — selected topology and trade-offs.
2. [`docs/BAMBU-PROTOCOL.md`](docs/BAMBU-PROTOCOL.md) — local MQTT transport and telemetry mapping.
3. [`docs/TRMNL-PLUGIN.md`](docs/TRMNL-PLUGIN.md) — webhook contract, Liquid views, and local preview workflow.
4. [`docs/DEVELOPMENT-PLAN.md`](docs/DEVELOPMENT-PLAN.md) — implementation sequence and acceptance gates.
5. [`docs/RESOURCES.md`](docs/RESOURCES.md) — source hierarchy and useful links.

Future coding agents must also read [`AGENTS.md`](AGENTS.md).

## Sources

[11] https://wiki.bambulab.com/en/software/third-party-integration — Bambu Lab Third-party Integration
