# Project agents

One project-scoped agent lives here. Everything else uses the bundled agents
(`task`, `scout`, `librarian`, `reviewer`, `security-reviewer`, `designer`).

| Agent | Use it for |
| --- | --- |
| `secret-auditor` | Read-only privacy gate. Run it before every commit. Returns `clean` or `blocked`. |
