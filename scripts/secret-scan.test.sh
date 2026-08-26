#!/usr/bin/env bash

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
temporary=$(mktemp -d)
message_repo=$(mktemp -d)
allow_repo=$(mktemp -d)
alias_repo=$(mktemp -d)
trap 'rm -rf "$temporary" "$message_repo" "$allow_repo" "$alias_repo"' EXIT

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

printf 'ACCESS_TOKEN=%s\n\0' "$token_value" > binary.dat
if bash scripts/secret-scan.sh binary.dat >/dev/null 2>&1; then
  echo "secret-scan test: a NUL byte disabled credential detection" >&2
  exit 1
fi

printf 'BAMBU_CLOUD_ACCESS_TOKEN=%s\n' "$token_value" > historical.txt
git add historical.txt
git commit -qm "add historical fixture"
printf 'safe\n' > historical.txt
git add historical.txt
git commit -qm "remove historical fixture"
if bash scripts/secret-scan.sh --history >/dev/null 2>&1; then
  echo "secret-scan test: add-then-remove history was missed" >&2
  exit 1
fi

mkdir -p "$message_repo/scripts"
cp "$repo_root/scripts/secret-scan.sh" "$message_repo/scripts/secret-scan.sh"
cd "$message_repo"
git init -q
git config user.email test@example.invalid
git config user.name "Secret scanner test"
printf 'safe\n' > tracked.txt
git add tracked.txt
git commit -qm "BAMBU_CLOUD_ACCESS_TOKEN=$token_value"
if bash scripts/secret-scan.sh --history >/dev/null 2>&1; then
  echo "secret-scan test: credential-shaped commit message was missed" >&2
  exit 1
fi

mkdir -p "$allow_repo/scripts"
cp "$repo_root/scripts/secret-scan.sh" "$allow_repo/scripts/secret-scan.sh"
cd "$allow_repo"
git init -q
git config user.email test@example.invalid
git config user.name "Secret scanner test"
for line in 1 2 3 4 5 6; do
  printf 'ACCESS_TOKEN=%s%s\n' "$token_value" "$line"
done > six.txt
git add six.txt
git commit -qm "add reviewed history candidates"
object=$(git rev-parse HEAD:six.txt)
for line in 1 2 3 4 5; do
  printf '%s:%s:token-assign\n' "$object" "$line"
done > scripts/secret-scan-history.allow
if bash scripts/secret-scan.sh --history >/dev/null 2>&1; then
  echo "secret-scan test: a sixth match hid behind five allowances" >&2
  exit 1
fi

mkdir -p "$alias_repo/scripts"
cp "$repo_root/scripts/secret-scan.sh" "$alias_repo/scripts/secret-scan.sh"
cd "$alias_repo"
git init -q
git config user.email test@example.invalid
git config user.name "Secret scanner test"
printf 'safe\n' > allowed.txt
cp allowed.txt .env
git add allowed.txt
git add -f .env
git commit -qm "reuse one blob under allowed and forbidden paths"
if bash scripts/secret-scan.sh --history >/dev/null 2>&1; then
  echo "secret-scan test: a forbidden path alias was missed" >&2
  exit 1
fi

printf 'secret-scan tests: passed\n'
