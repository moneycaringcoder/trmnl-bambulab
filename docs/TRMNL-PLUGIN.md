# TRMNL plugin contract and rendering

Research date: 2026-08-24.

## Plugin type

Two strategies, one per tier, because the two tiers sit in different places on
the network.

**Self-hosted uses Webhook.** The bridge runs on the user's own machine and
POSTs to their Private Plugin's webhook URL. TRMNL cannot reach a machine on
someone's home network, so the bridge has to do the reaching.[2][3]

**Hosted uses Polling.** TRMNL fetches from a Worker on the public internet,
which it can reach perfectly well. This document originally ruled polling out
for the same reason the self-hosted tier still uses webhooks, and that reason
does not apply to a Worker. Pulling also means we never receive the user's
webhook URL, which is a bearer credential for their display. See
`docs/DECISIONS.md` D11.

The two strategies differ in one detail that will catch you out. The webhook
body wraps its variables: `{"merge_variables": {...}}`. A polled response puts
them at the **root**: `{"v": 1, "printers": [...]}`. TRMNL's own troubleshooting
says as much — "we suggest putting relevant merge variables in the root node of
your payload".[2]

### Polling authentication, and why the key is a header

The hosted tier's whole authentication story depends on one TRMNL capability,
so it is recorded here rather than left in a code comment: **a Polling plugin
can interpolate a custom form field into its request headers.**

TRMNL's Private Plugins guide states it directly — "your polling headers may
access values from custom form fields via `##{{ form_field_keyname }}`
interpolation" — and gives the example `authorization=bearer ##{{ api_key }}`.
Headers are assigned with `=` and separated with `&`, and a literal `=` inside a
value is percent-encoded.[2]

That is what lets the screen key travel in an `Authorization: Bearer` header
instead of a query string. It matters because a credential in a URL is recorded
by every intermediary's access log and by Cloudflare's own per-request
invocation log. If this capability ever went away, the hosted tier would have no
way to authenticate that does not write the key into a log, so it is worth
noticing if TRMNL changes it.

The same interpolation works in the polling URL and body. Global variables such
as `##{{ trmnl.user.first_name }}` are available in all three.[2]

A polled endpoint can also be locked to TRMNL's own server addresses, published
at `https://trmnl.com/api/ips`.[2] The hosted tier reads that list from a
`TRMNL_ALLOWED_IPS` variable and ships it empty, because shipping a guessed
address list would lock TRMNL out of every account at once.

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
    "connection": {
      "mode": "hybrid",
      "local": "connected",
      "cloud": "connected",
      "cloud_metadata_stale": false
    },
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
    "project": {
      "cover_url": null,
      "weight_grams": null,
      "length_mm": null,
      "bed_type": null
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
- Bambu account email, password, verification code, or access token
- TRMNL webhook UUID
- task/project/profile IDs
- raw provider URLs other than an explicitly allowlisted, short-lived project cover URL
- provider provenance details beyond safe coarse connection mode
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
- coarse connection mode when degraded from hybrid

Cloud-derived project cover art may be used only after URL allowlisting, privacy review, expiry handling, and 1-bit rendering tests. The display must remain useful when the image is absent or stale.

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

## Distribution

**Hosted uses an Unlisted Recipe.** Recipes provide a one-click installation of
a private plugin. An Unlisted Recipe skips moderation and produces a shareable
link immediately, so each hosted user does not have to reconstruct the Polling
plugin by hand.[9]

The Recipe declares the documented Polling settings (`strategy: polling`,
`refresh_interval`, `polling_url`, `polling_headers`, and `polling_verb: GET`)
and one custom field. TRMNL requires `keyname`, `name`, and `field_type` for a
form field, and `password` is a supported field type.[10][11]

```yaml
custom_fields:
- keyname: screen_key
  name: Screen key
  field_type: password
  help_text: Copy this from the hosted enrolment page. You can rotate it there.
```

Polling headers assign a header with `=` and separate multiple headers with
`&`. The screen key uses TRMNL's documented `##{{ }}` custom-field prefix
exactly; its header setting is:[2]

```yaml
polling_headers: 'authorization=bearer ##{{ screen_key }}'
```

The hosted cron renders every five minutes, but a default TRMNL account has a
15-minute minimum refresh; TRMNL+ can reach five minutes. The Recipe therefore
declares `refresh_interval: 15`: a standard display can skip two intermediate
hosted renders, while TRMNL+ owners may choose the faster cadence.[11][12]

**Unverified:** TRMNL documents adding custom fields to a Recipe and using their
values, but does not say whether those fields are prompted during Recipe
installation or configured afterwards. Do not promise either flow until it has
been observed.[9][10]

Self-hosted remains a separately created Private Plugin using the Webhook
strategy; it does not use the Recipe's Polling URL, authorization header, or
screen-key field.[2]

## Sources

[2] https://help.trmnl.com/en/articles/9510536-private-plugins — TRMNL Private Plugins
[3] https://docs.trmnl.com/go/private-plugins/webhooks.md — TRMNL Private Plugin Webhooks
[5] https://help.trmnl.com/en/articles/10671186-liquid-101 — TRMNL Liquid 101
[6] https://docs.trmnl.com/go/private-plugins/templates.md — TRMNL Screen Templating
[7] https://github.com/usetrmnl/trmnlp — TRMNL trmnlp local development server
[8] https://trmnl.com/framework — TRMNL Framework
[9] https://help.trmnl.com/en/articles/10122094-plugin-recipes — TRMNL Plugin Recipes
[10] https://help.trmnl.com/en/articles/10513740-custom-plugin-form-builder — TRMNL Custom Plugin Form Builder
[11] https://help.trmnl.com/en/articles/10542599-importing-and-exporting-private-plugins — TRMNL Private Plugin import/export settings
[12] https://help.trmnl.com/en/articles/10113695-how-refresh-rates-work — TRMNL refresh rates
