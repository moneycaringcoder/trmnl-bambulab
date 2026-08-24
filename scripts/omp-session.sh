#!/usr/bin/env bash
# Launch the trmnl-bambulab build session in Oh My Pi.
#
# One primary agent runs the work and delegates to the project crew in
# .omp/agents plus the bundled agents (task, scout, librarian, reviewer,
# security-reviewer, designer). Model selection comes from the global omp
# config; this script does not override it.
#
# Usage:
#   scripts/omp-session.sh                 interactive session
#   scripts/omp-session.sh "phase 1 ..."   interactive session with a prompt
#   scripts/omp-session.sh -p "..."        non-interactive, print and exit

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

if ! command -v omp >/dev/null 2>&1; then
  echo "omp is not on PATH" >&2
  exit 1
fi

# Refuse to start if the working tree already holds something that must not be
# committed. Better to find it now than at commit time.
if ! ./scripts/secret-scan.sh --tree >/dev/null 2>&1; then
  echo "secret-scan found blockers in the working tree. Resolve them before starting." >&2
  ./scripts/secret-scan.sh --tree >&2 || true
  exit 1
fi

# The enforcement gate is the git hook; make sure it is actually wired up.
if [ "$(git config --get core.hooksPath || true)" != ".githooks" ]; then
  echo "Enabling the pre-commit secret gate: git config core.hooksPath .githooks"
  git config core.hooksPath .githooks
fi

exec omp \
  --hook .omp/extensions/secret-guard.ts \
  --advisor \
  "$@"
