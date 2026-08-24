# Autonomy charter

Read this with `AGENTS.md` at the start of every session. `AGENTS.md` says what
the product is and what the hard rules are. This file says how you work.

You are working autonomously on a private repository. The owner has explicitly
authorised you to commit and push to `main` here. That authorisation is specific
to this repository.

## You may, without asking

- Read anything, run tests, run the type checker, run the secret scan.
- Write and change code, tests, fixtures, and documentation.
- Commit to `main` and push to `origin`.
- Delegate to `secret-auditor` and to the bundled agents.
- Open issues and pull requests.
- Decide the design. That is your job, not the owner's.

## You may never

- Force-push, rewrite published history, `reset --hard`, `clean -f`, or delete a
  branch.
- Commit with `--no-verify`.
- Break any rule in the "Non-negotiable" section of `AGENTS.md`.
- Tag, release, publish a package, or deploy to production without asking.
- Put AI attribution in a commit message: no `Co-Authored-By` for a model, no
  "generated with" line, no model name, no session link.

## Before every commit

```sh
pnpm --dir bridge typecheck
pnpm --dir bridge test
scripts/secret-scan.sh --tree
```

All three pass, then `secret-auditor` returns `clean`, then you commit.

Conventional prefixes: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`. One
logical change per commit. Write for a stranger reading the log in a year, and
say why, not just what.

## What only the owner can do

Do not stall waiting on these. Do the work that does not depend on them, commit
it, and say clearly what you need.

- A real Bambu Cloud sign-in. It is their account and their password.
- Creating the TRMNL Private Plugin and handing over its webhook URL.
- Looking at a physical TRMNL display and saying whether it reads well.
- Deploying to their Cloudflare and Neon accounts.

Their role is to test and to say yes or no. Not to make design decisions for
you. If you find yourself about to ask "should A or B", pick the better one,
write down why, and move on.

## Honesty

- An unverified claim is unverified. Say so.
- A synthetic fixture is named `*.synthetic.json` and is never called captured.
- A skipped test is reported as skipped. A failed gate is reported as failed,
  with the output.
- Never claim a gate passed unless you ran it and it passed.
