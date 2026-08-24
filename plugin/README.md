# plugin

TRMNL Private Plugin using the Webhook strategy.

## Layout

| File | Purpose |
| --- | --- |
| `src/settings.yml` | Plugin settings and custom fields exported to TRMNL. |
| `src/shared.liquid` | Reusable components and styles for the four viewports. |
| `src/full.liquid` | Full-screen layout. |
| `src/half_horizontal.liquid` | Half-horizontal layout. |
| `src/half_vertical.liquid` | Half-vertical layout. |
| `src/quadrant.liquid` | Quadrant layout. |

## Local preview

```sh
cp .trmnlp.yml.example .trmnlp.yml
docker run --rm -p 4567:4567 -v "$PWD:/plugin" trmnl/trmnlp serve
```

Preview at `http://dev.napoleon-pantone.ts.net:4567`.

## Rules

- Templates read only the normalized schema in `docs/TRMNL-PLUGIN.md`.
- Every layout must render every state without overflow, including the
  degraded ones: stale, offline, `reauth_required`, and cloud-only.
- Output is 1-bit e-paper. Meaning must survive without color or fine contrast.
- Never render a serial, IP address, access code, token, or webhook UUID.
