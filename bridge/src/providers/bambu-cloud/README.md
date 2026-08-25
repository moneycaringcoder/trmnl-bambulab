# bambu-cloud

The Bambu Cloud provider. This is the only data source in the product: Bambu
Cloud or nothing.

Bambu publishes no supported consumer Cloud API, so every endpoint here is
reverse-engineered from OpenBambuAPI and ha-bambulab and can drift without
notice. We use the emailed-code sign-in flow because Bambu's TFA endpoint
requires a browser cookie that headless clients cannot obtain; treat endpoint
and response changes as volatile and preserve conservative read-only behavior.

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
  notes report unreliable refresh-token behaviour, so expiry requires explicit
  reauthentication.
- Read-only means read-only. Nothing here mutates the account or sends a printer
  command.

The I/O half of authentication lives in `../../setup/cloud-session.ts`.
