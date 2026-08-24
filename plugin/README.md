# The TRMNL plugin

A TRMNL Private Plugin using the Webhook strategy. The bridge POSTs a small
JSON snapshot to the plugin's webhook URL; these Liquid templates render it.

## What the payload looks like

One object, described in `bridge/src/types.ts` as `WebhookVariables`:

```json
{
  "v": 1,
  "updated_at": "2026-01-01T09:41Z",
  "printers": [{ "state": "printing", "name": "Workshop A1", "progress": 96 }],
  "hidden": 0,
  "cloud": "connected"
}
```

At most three printers, ordered so the one that needs attention is first. Keys
whose value is null are **absent** from the body, so every optional value has
to be guarded. `bridge/fixtures/merged/printing.synthetic.json` is the canonical
sample and is what the preview config renders.

## Previewing

Ruby is not required; the official container does everything.

```sh
docker run --rm -v "$PWD/plugin:/plugin" trmnl/trmnlp:latest lint
docker run --rm -v "$PWD/plugin:/plugin" trmnl/trmnlp:latest build --png
docker run --rm -p 4567:4567 -v "$PWD/plugin:/plugin" trmnl/trmnlp:latest serve
```

`build --png` writes `_build/*.html` and `_build/*.png` at the real 800x480,
1-bit. That directory is git-ignored.

Sample data comes from `.trmnlp.yml`, which is git-ignored because a developer
may later add an API key. Copy `.trmnlp.yml.example` to start, and edit its
`variables:` block to try other cases — one printer, three printers, a failure,
a stale reading. Those all take different branches and all four were checked
this way.

Do not run `trmnlp push`, `login`, `pull`, `clone` or `list`. Those need the
owner's TRMNL credentials and their plugin id.

## The views

`half_horizontal`, `half_vertical` and `quadrant` are not one printer per cell.
They are alternative renderings of the *same* payload, used when the plugin
shares a screen with another plugin, so each one has to handle one, two or three
printers at its own density.

| View | Shows |
| --- | --- |
| `full` | Headline percentage, printer and state, a full-width rail, and remaining, layer, nozzle, bed and filament. At three printers the figures collapse onto the state line so nothing is clipped. |
| `half_horizontal`, `half_vertical` | Printer, state, percentage, rail, remaining and layer. |
| `quadrant` | Percentage or state word, remaining, and an alert marker. Little else fits. |

Only `full` carries a title bar. On a shared screen a permanent bar costs more
room than it earns, so the smaller views show a short note instead, and only
when there is something the viewer could not otherwise work out.

## Rules these templates follow

- **No invented numbers.** An idle printer shows its name and that it is ready.
  It gets no progress rail, no zero percentage and no empty layer counter,
  because the bridge sends no such values and a template must not supply them.
- **Stale is not idle, and neither is offline.** A stale reading is the bridge's
  fault rather than the printer's, so those states show a dash instead of a
  headline number and say the reading is old. Presenting the last known figures
  at headline size would present them as current.
- **A failure keeps its numbers.** "Failed at layer 141 of 300" is the useful
  part of a failure.
- **1-bit first.** No colour-only meaning, no opacity, no fine grey, no photo,
  no animation. A numeric percentage always sits next to the rail, because a bar
  alone is hard to read at a glance on e-paper.
- **Nothing identifying.** No serial, no device id, no webhook URL. The payload
  does not contain them, and a job name appears only if the owner turned that
  on.

## Framework notes worth knowing before editing

Two properties of the design system caused real bugs while building this, both
worth knowing before restructuring anything:

- `.layout` carries `container-type: size`, which means its own contents do not
  contribute to its height. A `.layout` that no parent is stretching therefore
  collapses to nothing and its children vanish. Use `.list` for a plain vertical
  stack and `.grid` for even columns.
- `.item` is a flex row with `line-height: 0`, and expects `.content` as its
  direct children. Nesting a layout inside one collapses it. The gap between
  sibling `.content` boxes is two pixels, which runs adjacent figures together,
  so a row of separate figures wants `.grid`, not one `.item`.

Type sizes are chosen against the height each block actually gets: about 430px
of content once the title bar is out. The headline is 220px for one printer,
74px for two and 58px for three.
