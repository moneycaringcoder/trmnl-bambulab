# Research resources

Research date: 2026-08-22. Re-check current docs before implementation because both TRMNL and Bambu firmware/interfaces change.

## TRMNL — primary sources

- [API documentation index](https://docs.usetrmnl.com/llms.txt) — machine-readable map of official developer docs.[1]
- [Private Plugins](https://help.usetrmnl.com/en/articles/9510536-private-plugins) — strategies, polling/webhook setup, markup editor, form fields, and sharing.[2]
- [Webhook API](https://docs.usetrmnl.com/go/private-plugins/webhooks.md) — authentication URL, payload envelope, limits, replacement/deep-merge/stream behavior.[3]
- [Refresh rates](https://help.usetrmnl.com/en/articles/10113695-how-refresh-rates-work) — device pulls, plugin refresh timing, playlist effects, and unchanged-data behavior.[4]
- [Liquid 101](https://help.usetrmnl.com/en/articles/10671186-liquid-101) — variables, loops, conditions, and filters.[5]
- [Screen templating](https://docs.usetrmnl.com/go/private-plugins/templates.md) — base view structure and hosted framework assets.[6]
- [TRMNL Framework](https://usetrmnl.com/framework) — current e-paper components, utilities, responsive behavior, devices, bit depths, and examples.[8]
- [Plugin Recipes](https://help.usetrmnl.com/en/articles/10122094-plugin-recipes) — install versus fork, publishing, update behavior, and moderation.[9]
- [Custom form builder](https://help.usetrmnl.com/en/articles/10513740-custom-plugin-form-builder) — YAML settings fields for future distribution.[10]

## TRMNL — official code

- [usetrmnl/trmnlp](https://github.com/usetrmnl/trmnlp) — local preview, lint, PNG build, clone/pull/push, and project scaffold.[7]
- [usetrmnl/trmnl-framework](https://github.com/usetrmnl/trmnl-framework) — design-system source and release assets.
- [usetrmnl/trmnl-liquid](https://github.com/usetrmnl/trmnl-liquid) — custom Liquid filters and tags.
- [usetrmnl/plugins](https://github.com/usetrmnl/plugins) — native/community examples; native templates may use ERB rather than Liquid.
- [usetrmnl/trmnl-liquid-components](https://github.com/usetrmnl/trmnl-liquid-components) — alpha reusable Liquid components and examples; evaluate stability before production use.
- [Recipe catalog](https://trmnl.com/recipes) — inspect and fork comparable status dashboards. Catalog search did not reveal an obvious Bambu-specific recipe during this research; verify again before publishing.

## Bambu Lab — official sources

- [Third-party integration](https://wiki.bambulab.com/en/software/third-party-integration) — authorization changes, monitoring exemption, Developer Mode, Bambu Connect, and Local Server SDK.[11]
- [LAN Mode](https://wiki.bambulab.com/en/knowledge-sharing/enable-lan-mode) — model-specific setup, A-series steps, access code, and LAN behavior.[12]
- [Security](https://wiki.bambulab.com/en/general/bbl-security) — local MQTT broker, access-code authentication, TLS, and FTPS.[13]
- [Printer network ports](https://wiki.bambulab.com/en/general/printer-network-ports) — official port matrix including LAN MQTT 8883.[14]
- [Bambu Studio](https://github.com/bambulab/BambuStudio) — official slicer source; note that the optional networking plugin includes non-free libraries.[21]

Bambu's public docs establish supported connectivity and policy, but not the complete MQTT telemetry object. Do not describe reverse-engineered fields as an official API.

## Community protocol references

- [OpenBambuAPI MQTT](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md) — local broker parameters, topics, report examples, commands, and status fields.[15]
- [OpenBambuAPI TLS](https://github.com/Doridian/OpenBambuAPI/blob/main/tls.md) — Bambu CA, printer-serial certificate identity, SNI, and certificate-validation pitfalls.[16]
- [ha-bambulab overview](https://docs.page/greghesp/ha-bambulab) — current authorization impact on reads versus writes.[17]
- [ha-bambulab setup](https://docs.page/greghesp/ha-bambulab/setup) — cloud, hybrid, and LAN configuration requirements.[18]
- [ha-bambulab entities](https://docs.page/greghesp/ha-bambulab/entities) — mature telemetry surface and model-specific availability.[19]
- [ha-bambulab device triggers](https://docs.page/greghesp/ha-bambulab/device-triggers) — print lifecycle, HMS, and separate print-error events.[20]

Community sources are implementation clues, not guarantees. Pin the exact revision used for code borrowing, inspect its license, and validate behavior on sanitized A1/A1 mini fixtures.

## Questions these resources answer

| Question | Start here |
| --- | --- |
| Can monitoring work without unrestricted control? | Bambu third-party integration.[11] |
| Which local port and transport? | Bambu ports/security.[13][14] |
| What MQTT credentials/topics are observed? | OpenBambuAPI MQTT.[15] |
| How should TLS identity be verified? | OpenBambuAPI TLS.[16] |
| Which status fields matter to users? | ha-bambulab entities.[19] |
| Why surface both HMS and print error? | OpenBambuAPI + ha-bambulab triggers.[15][20] |
| How does data reach TRMNL? | Private Plugins + Webhooks.[2][3] |
| How often may the bridge push? | TRMNL Webhooks + Refresh Rates.[3][4] |
| How are screens developed locally? | trmnlp + Framework.[7][8] |
| How can this become shareable later? | Recipes + form builder.[9][10] |

## Sources

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
[12] https://wiki.bambulab.com/en/knowledge-sharing/enable-lan-mode — Bambu Lab LAN Mode
[13] https://wiki.bambulab.com/en/general/bbl-security — Bambu Lab Security
[14] https://wiki.bambulab.com/en/general/printer-network-ports — Bambu Lab Printer Network Ports
[15] https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md — OpenBambuAPI MQTT protocol notes
[16] https://github.com/Doridian/OpenBambuAPI/blob/main/tls.md — OpenBambuAPI TLS certificate notes
[17] https://docs.page/greghesp/ha-bambulab — ha-bambulab Integration Overview
[18] https://docs.page/greghesp/ha-bambulab/setup — ha-bambulab Setup
[19] https://docs.page/greghesp/ha-bambulab/entities — ha-bambulab Entities
[20] https://docs.page/greghesp/ha-bambulab/device-triggers — ha-bambulab Device Triggers
[21] https://github.com/bambulab/BambuStudio — Bambu Studio source repository
