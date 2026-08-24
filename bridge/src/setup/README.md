# setup

The `pnpm setup` CLI: interactive configuration, `doctor`, and `reauth`. The
user-facing guide is [`docs/SETUP.md`](../../../docs/SETUP.md).

| Module | Responsibility |
| --- | --- |
| `index.ts` | Argument dispatch and the single place failures are rendered. |
| `flow.ts` | The wizard: mode, cloud, device selection, LAN, TRMNL. |
| `doctor.ts` | Re-verify a saved config. Writes nothing; pushes only with `--push`. |
| `reauth.ts` | Replace only the cloud token, in place. |
| `cloud-session.ts` | The I/O half of cloud auth: prompts and requests, no branching logic. |
| `config.ts` | Zod schema, `.env` serialization, and validation with guidance. Pure. |
| `webhook-url.ts` | TRMNL webhook URL validation. Pure. |
| `mask.ts` | Masking for anything that reaches a terminal or a log. Pure. |
| `store.ts` | Atomic 0600 read/write of `bridge/.env`. |
| `lan-verify.ts` | One-shot, read-only LAN MQTT probe with TLS verification on. |
| `webhook-push.ts` | One POST to TRMNL, with a 429 and 413 story. |
| `synthetic.ts` | Loads the committed merged fixture used as the test payload. |
| `prompt.ts` | Hidden prompts, choices, and validating retries. |
| `ui.ts`, `errors.ts` | Plain-ASCII output, and the error type that carries guidance. |

Rules that must hold, each with a named test where it is testable:

- Every failure carries an instruction. A bare status code shown to the user is
  a bug: `SetupError` requires `guidance`.
- No secret is ever echoed, logged, written outside `bridge/.env`, or passed as
  a process argument. Passwords and verification codes are never persisted at
  all.
- Identifiers are masked before display, including in a debug path.
- TLS verification is never disabled, and no option offers to.
- Nothing is published to the printer.
- The config is written atomically at mode 0600, and `reauth` patches only the
  keys it owns.
