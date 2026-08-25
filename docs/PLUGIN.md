# The TRMNL plugin

The Liquid templates under `../src/` are the single design source for both
tiers:

- The self-hosted bridge pushes variables to a TRMNL Private Plugin using the
  Webhook strategy, and TRMNL renders the templates.
- The hosted TRMNL marketplace plugin stores the same variables, renders the
  four templates with liquidjs in the Worker, and returns the HTML from
  `POST /trmnl/markup`.

The hosted tier is not a polling Private Plugin. It has no Recipe, screen key,
polling endpoint, or separate identity provider. See `TRMNL-PLUGIN.md` for the
installation and request contracts.

## Self-hosted installation

Create a TRMNL Private Plugin with the **Webhook** strategy. Copy its webhook URL
into `bridge/.env`, then run the bridge. `src/settings.yml` describes this
plugin and deliberately omits its remote id.

## Hosted installation

Install the third-party plugin from the TRMNL marketplace. TRMNL redirects your
browser through the install handshake, after which the setup page asks you for a
Bambu email code and lets you choose printers. There is no credential to copy
between services.

## Payload

`bridge/src/types.ts` defines the normalized display payload. The canonical
sample is `../bridge/fixtures/merged/printing.synthetic.json`:

```json
{
  "v": 1,
  "updated_at": "2026-01-01T00:00Z",
  "printers": [
    {
      "state": "printing",
      "name": "Demo Printer",
      "progress": 42,
      "layer": 81,
      "layers": 194,
      "remaining": "1h 16m"
    }
  ],
  "hidden": 0,
  "cloud": "connected"
}
```

A payload contains at most three printers, ordered so the printer needing
attention comes first. The compact serializer omits keys whose value is `null`,
so every optional field must be guarded in Liquid. Raw Bambu HTTP and MQTT
objects never reach the templates.

The hosted cron provides the honest HTTP subset. The optional collector enriches
that stored payload with MQTT progress, remaining time, layers, temperatures,
filament, and alerts. The self-hosted bridge receives both sources directly.
The templates therefore treat every enriched value as optional rather than
maintaining separate hosted and self-hosted markup.

## Previewing

Run the official container from the repository root; Ruby is not required:

```sh
cp .trmnlp.yml.example .trmnlp.yml
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp:latest lint
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp:latest build --png
docker run --rm -p 4567:4567 -v "$PWD:/plugin" trmnl/trmnlp:latest serve
```

`build --png` writes ignored `_build/*.html` and `_build/*.png` files at the
real 800x480, 1-bit output size. Edit the ignored `.trmnlp.yml` `variables:`
block to exercise one or three printers, idle, printing, failure, offline, and
stale states.

Do not run `trmnlp push`, `login`, `pull`, `clone`, or `list` unless you intend
to authenticate to and change plugins in your own TRMNL account. A local sync
may add an `id` to `src/settings.yml`; never commit that id.

## Views

`half_horizontal`, `half_vertical`, and `quadrant` are not one printer per cell.
They are alternative renderings of the same payload when the plugin shares a
screen with another plugin, so each layout handles one, two, or three printers
at its own density.

| View | Shows |
| --- | --- |
| `full` | Headline percentage or state, printer, progress rail, remaining time, layer, nozzle, bed, and filament. With three printers the figures collapse onto the state line so the view does not clip. |
| `half_horizontal`, `half_vertical` | Printer, state, percentage, rail, remaining time, and layer. |
| `quadrant` | Percentage or state, remaining time, and an alert marker. |

Only `full` carries a title bar. A permanent bar costs too much space in a
Mashup, so smaller views show a short note only when the viewer could not infer
the condition from the printer rows.

## Template rules

- **No invented numbers.** An idle printer shows its name and that it is ready.
  It gets no progress rail, zero percentage, or empty layer counter.
- **Stale is not idle, and neither is offline.** An old reading shows a dash and
  an explicit stale message rather than presenting the last figures as current.
- **A failure keeps known numbers.** The layer at which a print failed remains
  useful.
- **1-bit first.** No colour-only meaning, opacity, fine gray, photographs, or
  animation. A numeric percentage sits beside its rail because a bar alone is
  hard to read at a glance.
- **Nothing identifying.** No serial, device id, installation id, token, or
  webhook URL. A job name appears only when you enable its export.

## Framework details

Two TRMNL framework properties matter when changing the layout:

- `.layout` carries `container-type: size`, so its contents do not contribute to
  its height. If no parent stretches it, it collapses and its children vanish.
  Use `.list` for a plain vertical stack and `.grid` for even columns.
- `.item` is a flex row with `line-height: 0` and expects `.content` as direct
  children. A nested layout can collapse. Adjacent `.content` boxes have a
  two-pixel gap, so separate figures belong in a `.grid` rather than one item.

Type sizes are chosen against the roughly 430 pixels left after the full view's
title bar. The one-printer headline is 220 pixels, the two-printer headline 74,
and the three-printer headline 58.
