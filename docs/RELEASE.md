# Release evidence

## History sweep

**Date:** 2026-08-25

The sweep covered all 41 commits returned by `git rev-list --all`, including
root commits and commits reachable only from non-current refs. It inspected
added lines from each commit once, so secrets that were later deleted were
still in scope:

```bash
git rev-list --all | wc -l
git log --all --root --no-renames --format='@@COMMIT %H' \
  --patch --unified=0 --no-color |
  python3 /tmp/history-secret-sweep.py
```

`/tmp/history-secret-sweep.py` was an uncommitted parser that associated each
added line with its commit SHA and path. It copied every regular expression from
the `rules` array in `scripts/secret-scan.sh`, then added the requested checks
for Bambu access-token assignments, credentialed `postgresql://` URLs, `npg_`
Neon passwords, 43–44-character base64 `TOKEN_KEY` values, TRMNL webhook URLs
and UUIDs, 14–16-character uppercase printer-serial shapes, and account email
addresses. This history pass was deliberately stricter than the working-tree
scanner: it applied every rule to documentation paths and to
`secret-scan-allow` lines too.

**Verdict: clean. No real secret or private identifier was found.** All 61
pattern hits were reviewed:

- `903b159144ef822877dfb3e9b0a3f47ab76b68b4`: three account-email hits in
  `hosted/test/routes.test.ts` and `hosted/test/session.test.ts`; all are
  synthetic `example.com` test addresses.
- `c6d44fe0a72866887be6cac9eef78111251d5d52`: four account-email hits in bridge
  tests, all synthetic `example.com` addresses; four cover-URL warnings in the
  issue template and cloud-host definitions, all unsigned public URLs; and two
  generic serial-shape hits in `LICENSE`, both words in the MIT license text.
- `3c7deaa0672e7a75f1953f2fba4bde12f236b2c1` and
  `71084c5742b23596b79d7f008841483e84b2e1c2`: three cover-URL warnings in
  `docs/BAMBU-PROTOCOL.md`, all unsigned public source URLs.
- `cfb07b097e367188bbc60c151f0fa108a711b76e`: 33 cover-URL warnings in
  `README.md` and protocol, architecture, and resource documentation; all are
  unsigned public source URLs.
- `ec145a2c1488f909b57da6212cc94c0f83f10769`: three cover-URL warnings in
  `docs/RESOURCES.md`, all unsigned public source URLs.
- `f8250040531930544ca3e1cda4713ae47d5a44b2`: eight cover-URL warnings in
  `README.md` and architecture and connection-mode documentation; all are
  unsigned public source URLs.
- `40f6392bd6100f6f559b87ddc10cd310e24547bc`: one generic serial-shape hit in
  `hosted/worker-configuration.d.ts`, a word in generated license prose.

## Self-hosted parity

**Date:** 2026-08-25

An uncommitted Node script started a loopback HTTP receiver on an OS-assigned
free port, built a synthetic TRMNL config with the standard 2,048-byte ceiling,
and called the setup path's exported `sendTestPayload`. That path uses
`loadSyntheticPayload` and `pushPayload`, the same functions used by interactive
setup. The run required no Bambu or TRMNL account:

```bash
node /tmp/self-hosted-parity.mjs
```

The receiver parsed the request body as JSON, verified an HTTP `POST` with
`Content-Type: application/json`, returned HTTP 204, and observed:

```text
request bytes: 728
top-level keys: ["merge_variables"]
merge_variables type: object
under 2,048 bytes: yes
```

**Verdict: pass.** The self-hosted setup webhook path delivered the synthetic
fixture end to end with `merge_variables` at the top level required by TRMNL's
webhook contract.
