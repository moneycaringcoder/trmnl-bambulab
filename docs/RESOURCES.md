# Research resources

Research date: 2026-08-22, revised 2026-08-25. Re-check current docs before
implementation because both TRMNL and Bambu interfaces change. Entries that
applied only to a local-network transport were dropped when the project became
cloud-only; see `docs/DECISIONS.md` D10.

## TRMNL — primary sources

- [API documentation index](https://docs.usetrmnl.com/llms.txt) — machine-readable map of official developer docs.[1]
- [Private Plugins](https://help.usetrmnl.com/en/articles/9510536-private-plugins) — strategies, polling/webhook setup, markup editor, form fields, and sharing.[2]
- [Webhook API](https://docs.usetrmnl.com/go/private-plugins/webhooks.md) — authentication URL, payload envelope, limits, replacement/deep-merge/stream behavior.[3]
- [Refresh rates](https://help.usetrmnl.com/en/articles/10113695-how-refresh-rates-work) — device pulls, plugin refresh timing, playlist effects, and unchanged-data behavior.[4]
- [Liquid 101](https://help.usetrmnl.com/en/articles/10671186-liquid-101) — variables, loops, conditions, and filters.[5]
- [Screen templating](https://docs.usetrmnl.com/go/private-plugins/templates.md) — base view structure and hosted framework assets.[6]
- [TRMNL Framework](https://usetrmnl.com/framework) — current e-paper components, utilities, responsive behavior, devices, bit depths, and examples.[8]
- [Plugin Recipes](https://help.usetrmnl.com/en/articles/10122094-plugin-recipes) — sharing and installing Private Plugin configurations.[9]
- [Custom form builder](https://help.usetrmnl.com/en/articles/10513740-custom-plugin-form-builder) — fields available to Private Plugins.[10]
- [Marketplace plugin creation](https://docs.trmnl.com/go/plugin-marketplace/plugin-creation.md) — URLs required when registering a third-party plugin.[24]
- [Marketplace installation flow](https://docs.trmnl.com/go/plugin-marketplace/plugin-installation-flow.md) — single-use install code, token exchange, callback, and success webhook.[25]
- [Marketplace management flow](https://docs.trmnl.com/go/plugin-marketplace/plugin-management-flow.md) — management redirect UUID and return-to-TRMNL behavior.[26]
- [Marketplace screen generation](https://docs.trmnl.com/go/plugin-marketplace/plugin-screen-generation-flow.md) — authenticated markup requests and the four HTML response keys.[27]
- [Marketplace uninstallation flow](https://docs.trmnl.com/go/plugin-marketplace/plugin-uninstallation-flow.md) — authenticated teardown webhook.[28]

## TRMNL — official code

- [usetrmnl/trmnlp](https://github.com/usetrmnl/trmnlp) — local preview, lint, PNG build, clone/pull/push, and project scaffold.[7]
- [usetrmnl/trmnl-framework](https://github.com/usetrmnl/trmnl-framework) — design-system source and release assets.
- [usetrmnl/trmnl-liquid](https://github.com/usetrmnl/trmnl-liquid) — custom Liquid filters and tags.
- [usetrmnl/plugins](https://github.com/usetrmnl/plugins) — native/community examples; native templates may use ERB rather than Liquid.
- [usetrmnl/trmnl-liquid-components](https://github.com/usetrmnl/trmnl-liquid-components) — alpha reusable Liquid components and examples; evaluate stability before production use.
- [Recipe catalog](https://trmnl.com/recipes) — inspect and fork comparable status dashboards. Catalog search did not reveal an obvious Bambu-specific recipe during this research; verify again before publishing.

## Bambu Lab — official sources

- [Third-party integration](https://wiki.bambulab.com/en/software/third-party-integration) — authorization changes, monitoring exemption, Developer Mode, Bambu Connect, and Local Server SDK.[11]
- [Security](https://wiki.bambulab.com/en/general/bbl-security) — TLS and authentication policy.[13]
- [Bambu Studio](https://github.com/bambulab/BambuStudio) — official slicer source; note that the optional networking plugin includes non-free libraries.[21]
- [MQTT limitations notice](https://forum.bambulab.com/t/bambu-lab-mqtt-limitations/83440) — Bambu's own account of temporarily banning accounts over concurrent MQTT connections.[23]

Bambu's public docs establish supported connectivity and policy, but not the
cloud telemetry object. Do not describe reverse-engineered fields as an
official API. What we believe the interface to be, and how sure we are, is
recorded in `docs/BAMBU-PROTOCOL.md`.

## Community protocol references

- [OpenBambuAPI Cloud HTTP](https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md) — observed bearer auth, devices, tasks, projects, cover URLs, cloud MQTT identity, and token caveats.[22]
- [OpenBambuAPI MQTT](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md) — cloud broker parameters, topics, report examples, and status fields.[15]
- [OpenBambuAPI TLS](https://github.com/Doridian/OpenBambuAPI/blob/main/tls.md) — certificate identity and certificate-validation pitfalls.[16]
- [ha-bambulab overview](https://docs.page/greghesp/ha-bambulab) — current authorization impact on reads versus writes.[17]
- [ha-bambulab entities](https://docs.page/greghesp/ha-bambulab/entities) — mature telemetry surface and model-specific availability.[19]
- [ha-bambulab device triggers](https://docs.page/greghesp/ha-bambulab/device-triggers) — print lifecycle, HMS, and separate print-error events.[20]

Community sources are implementation clues, not guarantees. `ha-bambulab` in
particular carries no licence: read it for behaviour and never copy from it.
See the licence table in `AGENTS.md`.

## Questions these resources answer

| Question | Start here |
| --- | --- |
| Can monitoring work without unrestricted control? | Bambu third-party integration.[11] |
| What Cloud capabilities are observed? | OpenBambuAPI Cloud HTTP.[22] |
| What MQTT credentials and topics are observed? | OpenBambuAPI MQTT.[15] |
| How should TLS identity be verified? | OpenBambuAPI TLS.[16] |
| How often may we connect before Bambu objects? | MQTT limitations notice.[23] |
| Which status fields matter to users? | ha-bambulab entities.[19] |
| Why surface both HMS and print error? | OpenBambuAPI + ha-bambulab triggers.[15][20] |
| How does the self-hosted bridge reach TRMNL? | Private Plugins + Webhooks.[2][3] |
| How does the hosted tier integrate with TRMNL? | Marketplace installation, management, screen generation, and uninstallation.[25][26][27][28] |
| How often may the bridge push? | TRMNL Webhooks + Refresh Rates.[3][4] |
| How are screens developed locally? | trmnlp + Framework.[7][8] |
| What must a hosted marketplace plugin register? | Marketplace plugin creation.[24] |

## Sources

Numbers are stable; the gaps are entries that applied only to a local-network
transport and were dropped.

[1] https://docs.usetrmnl.com/llms.txt — TRMNL API documentation index
[2] https://help.usetrmnl.com/en/articles/9510536-private-plugins — TRMNL Private Plugins
[3] https://docs.usetrmnl.com/go/private-plugins/webhooks.md — TRMNL Private Plugin Webhooks
[4] https://help.usetrmnl.com/en/articles/10113695-how-refresh-rates-work — TRMNL Refresh Rates
[5] https://help.usetrmnl.com/en/articles/10671186-liquid-101 — TRMNL Liquid 101
[6] https://docs.usetrmnl.com/go/private-plugins/templates.md — TRMNL Screen Templating
[7] https://github.com/usetrmnl/trmnlp — TRMNL trmnlp local development server
[8] https://usetrmnl.com/framework — TRMNL Framework
[9] https://help.usetrmnl.com/en/articles/10122094-plugin-recipes — TRMNL Plugin Recipes
[10] https://help.usetrmnl.com/en/articles/10513740-custom-plugin-form-builder — TRMNL Custom Plugin Form Builder
[11] https://wiki.bambulab.com/en/software/third-party-integration — Bambu Lab Third-party Integration
[13] https://wiki.bambulab.com/en/general/bbl-security — Bambu Lab Security
[15] https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md — OpenBambuAPI MQTT protocol notes
[16] https://github.com/Doridian/OpenBambuAPI/blob/main/tls.md — OpenBambuAPI TLS certificate notes
[17] https://docs.page/greghesp/ha-bambulab — ha-bambulab Integration Overview
[19] https://docs.page/greghesp/ha-bambulab/entities — ha-bambulab Entities
[20] https://docs.page/greghesp/ha-bambulab/device-triggers — ha-bambulab Device Triggers
[21] https://github.com/bambulab/BambuStudio — Bambu Studio source repository
[22] https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md — OpenBambuAPI Cloud HTTP protocol notes
[23] https://forum.bambulab.com/t/bambu-lab-mqtt-limitations/83440 — Bambu Lab MQTT limitations notice
[24] https://docs.trmnl.com/go/plugin-marketplace/plugin-creation.md — TRMNL marketplace plugin creation
[25] https://docs.trmnl.com/go/plugin-marketplace/plugin-installation-flow.md — TRMNL marketplace installation flow
[26] https://docs.trmnl.com/go/plugin-marketplace/plugin-management-flow.md — TRMNL marketplace management flow
[27] https://docs.trmnl.com/go/plugin-marketplace/plugin-screen-generation-flow.md — TRMNL marketplace screen generation
[28] https://docs.trmnl.com/go/plugin-marketplace/plugin-uninstallation-flow.md — TRMNL marketplace uninstallation flow
