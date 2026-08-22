# TRMNL plugin contract and rendering

Research date: 2026-08-22.

## Plugin type

Use a TRMNL Private Plugin with the Webhook strategy for v1. The local bridge sends JSON to the plugin's generated webhook URL. TRMNL places values under `merge_variables`, then Liquid markup renders them.[2][3]

Do not use Polling for the first version. TRMNL cannot reach a private LAN printer, and exposing a polling API would add hosting, authentication, and storage with no product benefit.

## Webhook constraints

Standard accounts:

- Maximum 12 pushes/hour.
- Maximum 2 kB request data.

TRMNL+:

- Maximum 30 pushes/hour.
- Maximum 5 kB request data.

Faster pushes receive HTTP 429.[3] Design and test against the standard 12/hour and 2 kB limits.

Send a complete compact snapshot each time. Full replacement is easier to reason about than webhook `deep_merge`, avoids stale optional values, and should fit comfortably under 2 kB.

Example request shape:

```json
{
  "merge_variables": {
    "schema_version": 1,
    "printer": {
      "name": "Workshop A1",
      "model": "A1",
      "online": true,
      "stale": false
    },
    "job": {
      "state": "printing",
      "raw_state": "RUNNING",
      "name": "Current print",
      "progress": 42,
      "remaining_minutes": 76,
      "stage": "Printing",
      "stage_code": "2",
      "layer": { "current": 81, "total": 194 }
    },
    "temperatures": {
      "nozzle": 220,
      "nozzle_target": 220,
      "bed": 60,
      "bed_target": 60
    },
    "material": {
      "source": "AMS Lite 1",
      "type": "PLA",
      "color": "#E5E5E5"
    },
    "alerts": {
      "active": false,
      "hms": [],
      "print_error": null
    },
    "updated_at": "2026-08-22T12:00:00Z"
  }
}
```

This is the application contract. Raw MQTT must never reach Liquid templates.

## Privacy budget

Do not include:

- printer serial
- printer IP
- LAN access code
- Bambu account identity or token
- TRMNL webhook UUID
- task/project/profile IDs
- raw URLs
- full raw MQTT
- camera images

Job names can reveal private model names. Make job-name export configurable and default to a generic value until the user explicitly enables it.

## View hierarchy

Provide all four templates:

```text
src/
  settings.yml
  shared.liquid
  full.liquid
  half_horizontal.liquid
  half_vertical.liquid
  quadrant.liquid
```

TRMNL's private-plugin export format uses `settings.yml` plus the four viewport templates, while the official `trmnlp` local tool adds `shared.liquid` and project metadata for development.[7]

Suggested information density:

### Full

- printer name + connectivity
- large progress percentage and progress rail
- state/stage
- remaining time and estimated finish
- layer current/total
- nozzle and bed current/target
- active filament
- prominent alert area
- freshness timestamp

### Half horizontal

- status + printer
- large progress rail
- remaining time
- layer
- compact alert indicator

### Half vertical

- large progress percentage
- state
- remaining time
- compact temperatures

### Quadrant

- state icon/word
- progress percentage
- remaining time
- alert marker

Idle views should not show fake zeros. Replace print metrics with readiness, temperatures, filament, and last update. Offline/stale views must be visually distinct from idle.

## Liquid rules

TRMNL uses Liquid for variables, conditions, loops, and filters.[5]

- Guard every optional nested object before reading it.
- Use explicit empty/offline/error states.
- Keep calculations in the bridge when they affect meaning; use Liquid for presentation.
- Iterate over a bounded alert collection.
- Truncate long names and stages.
- Avoid client-side fetches.
- Put reusable templates and styles in Shared markup; TRMNL prepends Shared to every view.[2]

## E-paper design rules

The original TRMNL target is 800×480 and e-paper optimized, but the current framework supports multiple device geometries and bit depths. Use framework components and responsive utilities instead of assuming one panel.[6][8]

- High contrast first.
- Grayscale-safe hierarchy; hue is optional enhancement.
- Large numbers and short labels.
- No animation-dependent meaning.
- No hover, scrolling, or interaction requirements.
- Avoid dense charts for v1; a progress rail communicates the key value better.
- Alert state must survive 1-bit rendering.
- Test every layout at actual output dimensions.

## Local development

The official `trmnlp` tool can scaffold, serve, build, lint, clone, pull, push, and render PNGs. It watches Liquid files and uses the TRMNL design system.[7]

Expected loop after implementation begins:

```bash
trmnlp serve
trmnlp lint
trmnlp build --png
```

Review third-party `transform.*` files before running cloned plugins: current `trmnlp` executes serverless transforms during preview by default.[7]

Do not run `trmnlp push` until a human has supplied and approved the target TRMNL plugin ID and credentials. Ensure `src/settings.yml` has the intended `id`; the tool warns that pushing without it can create a new plugin instead of updating one.[7]

## Publishing later

Recipes are the recommended shareable form when code can live inside TRMNL and does not require the author to host user data.[9] This project still needs a local bridge, so recipe publication requires a clean installer story where each user's bridge pushes to their own webhook.

Before publishing:

- all four layouts complete
- no author-controlled data relay required
- setup docs for A1/A1 mini
- secret handling audited
- recipe form fields contain no shared credentials
- master recipe tested on clone before updates, because installed recipes can receive author changes automatically.[9][10]

## Sources

[2] https://help.usetrmnl.com/en/articles/9510536-private-plugins — TRMNL Private Plugins
[3] https://docs.usetrmnl.com/go/private-plugins/webhooks.md — TRMNL Private Plugin Webhooks
[5] https://help.usetrmnl.com/en/articles/10671186-liquid-101 — TRMNL Liquid 101
[6] https://docs.usetrmnl.com/go/private-plugins/templates.md — TRMNL Screen Templating
[7] https://github.com/usetrmnl/trmnlp — TRMNL trmnlp local development server
[8] https://usetrmnl.com/framework — TRMNL Framework
[9] https://help.usetrmnl.com/en/articles/10122094-plugin-recipes — TRMNL Plugin Recipes
[10] https://help.usetrmnl.com/en/articles/10513740-custom-plugin-form-builder — TRMNL Custom Plugin Form Builder
