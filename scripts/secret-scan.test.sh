#!/usr/bin/env bash

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

mkdir -p "$temporary/scripts"
cp "$repo_root/scripts/secret-scan.sh" "$temporary/scripts/secret-scan.sh"
cd "$temporary"
git init -q
git config user.email test@example.invalid
git config user.name "Secret scanner test"

printf 'safe\n' > tracked.txt
git add tracked.txt
git commit -qm baseline

token_value=$(printf '%024d' 0)
printf 'BAMBU_CLOUD_ACCESS_TOKEN=%s\n' "$token_value" > tracked.txt
git add tracked.txt
printf 'safe\n' > tracked.txt
if bash scripts/secret-scan.sh >/dev/null 2>&1; then
  echo "secret-scan test: staged content was replaced by working-tree content" >&2
  exit 1
fi
git restore --staged tracked.txt
git restore tracked.txt

printf 'ACCESS_TOKEN=%s\n' "$token_value" > assignment.txt
if bash scripts/secret-scan.sh assignment.txt >/dev/null 2>&1; then
  echo "secret-scan test: uppercase unquoted token assignment was missed" >&2
  exit 1
fi

password_value=$(printf '%012d' 0)
printf 'PASSWORD=%s\n' "$password_value" > assignment.txt
if bash scripts/secret-scan.sh assignment.txt >/dev/null 2>&1; then
  echo "secret-scan test: uppercase unquoted password assignment was missed" >&2
  exit 1
fi

printf 'secret-scan tests: passed\n'
