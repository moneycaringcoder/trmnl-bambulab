# bambu-cloud

The Bambu Cloud provider. This is the only data source in the product: Bambu
Cloud or nothing.

Every endpoint in this directory is reverse-engineered from OpenBambuAPI and
ha-bambulab. Bambu publishes no general public consumer Cloud API contract, so
treat all of it as volatile and record observed drift in
`docs/BAMBU-PROTOCOL.md`.

| Module | Responsibility |
| --- | --- |
| `hosts.ts` | Region to API/MQTT host map for `global` and `china`. |
| `http.ts` | Header shim, one-shot request helper, timeout, and `CloudError`. |
| `token.ts` | Access-token claim parsing and expiry state. Pure; `now` is a parameter. |
| `auth.ts` | The three login branches as a pure state machine. No I/O at all. |
| `api.ts` | The read-only endpoints, plus defensive parsing of the device list. |

Rules that must hold:

- `CloudError` never carries a response body, a token, an email, or a device id.
  Bodies from this service can contain account detail.
- `auth.ts` imports nothing from `node:*` and never touches a stream. The caller
  performs the requests and the prompting; that split is what makes the
  verification-code and two-factor branches testable without a network.
- No secret is ever retained in a state object. A password or verification code
  appears only in the request body it is sent in.
- Token expiry surfaces as an explicit state, never a silent retry. Community
  notes report unreliable refresh-token behaviour, so reauthentication is a
  first-class user action.
- Read-only means read-only. Nothing here mutates the account or sends a printer
  command.

The I/O half of authentication lives in `src/setup/cloud-session.ts`.
