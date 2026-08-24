# fixtures

Sanitized captures only. Nothing here may contain a real serial, IP address,
access code, account identifier, task or project ID, cover URL, model name, or
real timestamp.

Sanitization must preserve object shape, value types, state tokens, stage codes,
and numeric ranges, because those are what the tests pin.

| Directory | Contents |
| --- | --- |
| `local/` | Sanitized A1 and A1 mini LAN MQTT reports. |
| `cloud/` | Sanitized Bambu Cloud HTTP and cloud MQTT response shapes. |
| `merged/` | Coordinator output used by the bridge tests and by `trmnlp` preview. |

Name a fixture `*.synthetic.json` when it was hand-authored rather than
captured, so a later hardware capture can replace it deliberately.

Run `scripts/secret-scan.sh --tree` before committing anything in this tree.
