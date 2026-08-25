# TRMNL plugin contract and rendering

The repository supports two TRMNL delivery contracts. They share the normalized
payload and the four Liquid layouts, but installation and rendering differ.

- **Hosted is a TRMNL third-party marketplace plugin.** TRMNL performs the
  install handshake, identifies each installation with its own access token, and
  asks the Worker for server-rendered markup.
- **Self-hosted is a TRMNL Private Plugin using Webhook.** You run the bridge
  on your machine, and it pushes merge variables to the plugin's webhook URL.
  TRMNL cannot initiate a request to your private machine, so the bridge makes
  the outbound request.[2][3]

## Hosted marketplace contract

The hosted tier does not use a Private Plugin, Recipe, polling configuration,
screen key, or separate identity provider. Installing the marketplace plugin is
the identity handshake. Bambu sign-in is a separate step used only to obtain the
printer credential.

The Worker implements these routes:

| Route | Caller | Purpose |
| --- | --- | --- |
| `GET /trmnl/install` | Your browser, redirected by TRMNL | Exchanges TRMNL's single-use install code for a per-installation access token, then opens setup with a short-lived management token. |
| `POST /trmnl/installed` | TRMNL | Records the installation UUID and plugin-setting id from the authenticated success webhook. Names and email addresses in the webhook are deliberately discarded. |
| `POST /trmnl/markup` | TRMNL | Authenticates the installation's Bearer token and returns HTML fragments for all four layouts. |
| `GET /trmnl/manage` | Your browser, redirected by TRMNL | Resolves TRMNL's installation UUID and opens setup with a fresh short-lived management token. |
| `POST /trmnl/uninstall` | TRMNL | Deletes the linked account, stored render, and installation. |

TRMNL mints the installation access token and presents it on authenticated
requests. The Worker stores only a keyed HMAC tag of that token, never a
replayable copy. The access token never reaches the browser. The setup page uses
a one-hour management token delivered in the URL fragment so request logs do not
record it.[13][14][15][16]

A five-minute Worker cron and the optional collector write normalized payloads to
Postgres. The markup route reads the latest stored payload and renders
`src/full.liquid`, `src/half_horizontal.liquid`,
`src/half_vertical.liquid`, and `src/quadrant.liquid` with liquidjs. It returns:

```json
{
  "markup": "<div class=\"view view--full\">...</div>",
  "markup_half_horizontal": "<div class=\"view view--half_horizontal\">...</div>",
  "markup_half_vertical": "<div class=\"view view--half_vertical\">...</div>",
  "markup_quadrant": "<div class=\"view view--quadrant\">...</div>"
}
```

Rendering stored data rather than querying Bambu during a markup request keeps
Bambu traffic on our five-minute schedule. The refresh schedule you configure
in TRMNL therefore cannot increase Bambu traffic or place cloud round trips
inside the markup request timeout.[14]

## Self-hosted webhook contract

Create a TRMNL Private Plugin with the **Webhook** strategy and put its webhook
URL in `bridge/.env`. The bridge sends a complete compact snapshot at most once
every five minutes. The webhook request wraps the variables:

```json
{
  "merge_variables": {
    "v": 1,
    "updated_at": "2026-01-01T00:00Z",
    "printers": [
      {
        "state": "printing",
        "raw_state": "SYNTHETIC_RUNNING",
        "name": "Demo Printer",
        "model": "Demo Model",
        "online": true,
        "stale": false,
        "progress": 42,
        "layer": 81,
        "layers": 194,
        "remaining": "1h 16m",
        "stage": "Printing",
        "nozzle": 220,
        "nozzle_target": 220,
        "bed": 60,
        "bed_target": 60,
        "material": "Demo PLA",
        "job": null,
        "alert": null
      }
    ],
    "hidden": 0,
    "cloud": "connected"
  }
}
```

This is the application boundary. Raw Bambu responses and raw MQTT reports must
never reach Liquid templates.

### Webhook limits

Standard accounts allow at most 12 pushes per hour and 2 kB of request data.
TRMNL+ allows 30 pushes per hour and 5 kB. Faster pushes receive HTTP 429.[3]
The bridge designs and tests against the standard limits.

Each push is a full replacement rather than a deep merge. Replacement prevents
an optional value that disappeared from remaining stale on the display.

## Shared payload rules

The canonical sample is
`../bridge/fixtures/merged/printing.synthetic.json`. A payload contains at most
three printers, ordered so the printer needing attention appears first. Optional
values are omitted by the compact serializer, so every template must guard them.
Absent and unsupported values stay absent; templates must not invent zeros.

Do not include:

- printer serials, device ids, IP addresses, or LAN access codes
- Bambu email addresses, passwords, verification codes, or access tokens
- TRMNL webhook URLs, webhook UUIDs, installation tokens, or installation ids
- task, project, or profile ids
- raw provider URLs or raw telemetry
- camera images

Job names can reveal private model names. Export is configurable and remains off
unless you enable it.

## The four layouts

The same printer array is rendered at four densities. Smaller layouts are not
one-printer slots; they are alternative views of the same plugin when it appears
in a TRMNL Mashup.

| Layout | Intended content |
| --- | --- |
| `full` | Printer and connection state, prominent progress, remaining time, layer, nozzle, bed, filament, alerts, and freshness. |
| `half_horizontal` | Printer, state, progress rail, remaining time, layer, and a compact alert. |
| `half_vertical` | Prominent progress or state, remaining time, and compact temperatures. |
| `quadrant` | State or progress, remaining time, and an alert marker. |

Idle views do not show empty print metrics. Offline and stale readings remain
visually distinct from idle. The hosted tier has the same rich MQTT fields when
the optional collector is running and falls back to the honest HTTP subset when
it is not.

## Liquid and e-paper rules

TRMNL uses Liquid for variables, conditions, loops, and filters.[5]

- Guard optional values before reading or formatting them.
- Keep semantic calculations in the bridge payload builder; use Liquid for
  presentation.
- Use explicit empty, offline, stale, and error states.
- Bound alert iteration and truncate long names and stages.
- Avoid client-side fetches, animation-dependent meaning, hover, scrolling, and
  interaction requirements.
- Use high contrast, large figures, and hierarchy that survives 1-bit output.
- Use TRMNL framework components and responsive utilities rather than assuming
  one panel geometry.[6][8]
- Test all four layouts at their actual output dimensions.

## Local template development

The official `trmnlp` tool can serve, lint, and render the templates.[7]
The container form avoids a local Ruby installation:

```sh
cp .trmnlp.yml.example .trmnlp.yml
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp:latest lint
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp:latest build --png
docker run --rm -p 4567:4567 -v "$PWD:/plugin" trmnl/trmnlp:latest serve
```

Run these from the repository root. The copied `.trmnlp.yml` is ignored, so
preview variables and any local credentials stay out of Git.

`src/settings.yml` describes the self-hosted Webhook plugin because that is the
only tier synchronized through `trmnlp`. It deliberately omits `id`: pushing a
public clone must create a new Private Plugin rather than update an existing
one. A local sync may add an id, but contributors must never commit it. Do not
run `trmnlp push`, `login`, `pull`, `clone`, or `list` unless you intend to
access or change plugins in your own TRMNL account.

Review third-party `transform.*` files before previewing a cloned plugin because
`trmnlp` may execute serverless transforms.[7]


## Sources

[2] https://help.trmnl.com/en/articles/9510536-private-plugins — TRMNL Private Plugins
[3] https://docs.trmnl.com/go/private-plugins/webhooks.md — TRMNL Private Plugin Webhooks
[5] https://help.trmnl.com/en/articles/10671186-liquid-101 — TRMNL Liquid 101
[6] https://docs.trmnl.com/go/private-plugins/templates.md — TRMNL Screen Templating
[7] https://github.com/usetrmnl/trmnlp — TRMNL local development server
[8] https://trmnl.com/framework — TRMNL Framework
[13] https://docs.trmnl.com/go/plugin-marketplace/plugin-installation-flow.md — marketplace installation
[14] https://docs.trmnl.com/go/plugin-marketplace/plugin-screen-generation-flow.md — marketplace screen generation
[15] https://docs.trmnl.com/go/plugin-marketplace/plugin-management-flow.md — marketplace management
[16] https://docs.trmnl.com/go/plugin-marketplace/plugin-uninstallation-flow.md — marketplace uninstallation
