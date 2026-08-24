#!/usr/bin/env bash
# Secret and identifier scanner for trmnl-bambulab.
#
# Blocks Bambu printer identifiers, Bambu Cloud credentials, TRMNL webhook
# UUIDs, and unsanitized captures from entering Git.
#
# Usage:
#   scripts/secret-scan.sh              scan the staged diff (pre-commit default)
#   scripts/secret-scan.sh --tree       scan every tracked and untracked file
#   scripts/secret-scan.sh PATH...      scan the given paths
#
# Exit codes: 0 clean, 1 blocked, 2 usage or environment error.

set -uo pipefail

RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; OFF=$'\033[0m'
[ -t 1 ] || { RED=""; YEL=""; GRN=""; OFF=""; }

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "secret-scan: not inside a git repository" >&2
  exit 2
}
cd "$repo_root" || exit 2

mode="staged"
declare -a explicit_paths=()
case "${1-}" in
  --tree) mode="tree" ;;
  --staged|"") mode="staged" ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  *) mode="paths"; explicit_paths=("$@") ;;
esac

# Paths that are allowed to describe forbidden patterns without containing them.
is_exempt() {
  case "$1" in
    scripts/secret-scan.sh|.githooks/*|.omp/agents/*|.omp/extensions/*) return 0 ;;
    docs/*|AGENTS.md|README.md) return 0 ;;
    *) return 1 ;;
  esac
}

collect_paths() {
  case "$mode" in
    staged) git diff --cached --name-only --diff-filter=ACMR ;;
    tree)   git ls-files --cached --others --exclude-standard ;;
    paths)  printf '%s\n' "${explicit_paths[@]}" ;;
  esac
}

# Each rule is: id|severity|description|extended-regex
# Patterns are deliberately broad. A false positive is cheap; a leak is not.
rules=(
  'bambu-serial|blocker|Bambu printer serial (three letters + alphanumerics, 15 chars)|(^|[^A-Za-z0-9])0[0-9A-Z]{2}[A-Z]{2}[A-Z0-9]{10}([^A-Za-z0-9]|$)'
  'bambu-serial-key|blocker|Assignment to a serial-shaped key|(serial|serial_number|serialNumber|dev_id|device_id|SERIAL)["'"'"']?\s*[:=]\s*["'"'"'][^"'"'"'{$][^"'"'"']{6,}'
  'access-code|blocker|Bambu LAN access code assignment|(access[_-]?code|accessCode|ACCESS_CODE|lan[_-]?code)["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9]{6,}'
  'mqtt-password|blocker|MQTT password assignment|(bblp|mqtt[_-]?password|MQTT_PASSWORD)["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9]{6,}'
  'private-ipv4|blocker|Private IPv4 address literal|(^|[^0-9.])(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}([^0-9.]|$)'
  'trmnl-webhook|blocker|TRMNL webhook URL with a plugin UUID|usetrmnl\.com/[A-Za-z0-9_/-]*[0-9a-fA-F-]{16,}'
  'uuid|blocker|Bare UUID literal|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
  'jwt|blocker|JSON Web Token|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}'
  'bearer|blocker|Bearer token literal|[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}'
  'token-assign|blocker|Token or key assignment with a literal value|(access[_-]?token|refresh[_-]?token|api[_-]?key|apiKey|auth[_-]?token|[Ss][Ee][Cc][Rr][Ee][Tt])["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9._~+/-]{16,}'
  'password-assign|blocker|Password assignment with a literal value|(password|passwd|pwd)["'"'"']?\s*[:=]\s*["'"'"'][^"'"'"'{$][^"'"'"']{3,}'
  'bambu-account|blocker|Bambu Cloud account identifier|(bambu[_-]?(user|email|account)|BAMBU_(USER|EMAIL|ACCOUNT))["'"'"']?\s*[:=]\s*["'"'"']?[^"'"'"'{$ ]+@'
  'private-key|blocker|Private key block|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  # The hosted tier introduced a database, and a connection string carries its
  # password inline. Nothing above catches it: the key is usually named
  # `DATABASE_URL` rather than anything resembling `password`.
  'postgres-url|blocker|Postgres connection string with credentials|postgres(ql)?://[^:@/"'"'"' ]+:[^@/"'"'"' ]+@'
  # An encryption key assigned to a key-ish variable name. The trigger is the
  # value, not the name: 40 or more base64 characters is far longer than any
  # setting and shorter than anything we would legitimately inline. The letters
  # are spelled out as classes because `grep -E` runs case-sensitively here, and
  # the name may carry a suffix — the hosted tier's own key is `TOKEN_KEY_K1`,
  # which an unanchored `TOKEN_KEY` branch silently misses.
  #
  # The value class includes `-` and `_` so base64url is covered. Note what that
  # is and is not for: `atob` in the Workers runtime actually *rejects* those two
  # characters, so a base64url key would fail to load. It is still 256 bits of
  # key material in Git, which is the thing being prevented. Before the class was
  # widened, 74% of base64url-encoded 32-byte keys went through, measured over
  # 500 samples.
  'key-assign|blocker|Encryption or signing key assigned a literal value|([A-Za-z0-9_-]*([Kk][Ee][Yy]|[Kk][Ee][Kk]|[Dd][Ee][Kk])[A-Za-z0-9_-]*)["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9+/_-]{40,}={0,2}'
  'wifi-ssid|warning|Wi-Fi SSID or network name|(ssid|SSID|wifi[_-]?name)["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9_-]{3,}'
  'cover-url|warning|Signed or long-lived cover or asset URL|https?://[^"'"'"' ]*(bambulab|bblmw|myqcloud|amazonaws)[^"'"'"' ]*'
)

findings=0
warnings=0

scan_file() {
  local path="$1"
  [ -f "$path" ] || return 0
  # Skip binaries.
  if ! grep -Iq . "$path" 2>/dev/null; then return 0; fi
  local exempt=0
  is_exempt "$path" && exempt=1

  local rule id severity desc pattern hits
  for rule in "${rules[@]}"; do
    IFS='|' read -r id severity desc pattern <<<"$rule"
    # Documentation may name a pattern without holding one, so an exempt path
    # skips the shape-based rules. It does not skip these: each one matches
    # material that is unambiguously a live credential wherever it appears, and
    # setup prose is exactly where somebody pastes a connection string or a key
    # while writing an example.
    case "$id" in
      jwt|private-key|bearer|postgres-url|key-assign) : ;;
      *) [ "$exempt" = 1 ] && continue ;;
    esac
    hits=$(grep -nE "$pattern" -- "$path" 2>/dev/null | grep -vE 'secret-scan-allow' | head -5)
    [ -n "$hits" ] || continue
    while IFS= read -r hit; do
      local line="${hit%%:*}"
      if [ "$severity" = blocker ]; then
        findings=$((findings + 1))
        printf '%sBLOCKER%s %s:%s  [%s] %s\n' "$RED" "$OFF" "$path" "$line" "$id" "$desc"
      else
        warnings=$((warnings + 1))
        printf '%sWARNING%s %s:%s  [%s] %s\n' "$YEL" "$OFF" "$path" "$line" "$id" "$desc"
      fi
    done <<<"$hits"
  done
}

# Files that must never be committed at all, regardless of content.
forbidden_paths='(^|/)(\.env($|\.)|\.dev\.vars|\.trmnlp\.yml$|captures/|raw-telemetry/|bridge/spikes/)|\.(pcap|pcapng|pem|p12|key)$'

while IFS= read -r path; do
  [ -n "$path" ] || continue
  # A directory can be forbidden while still carrying a committed README that
  # explains why it is forbidden. The blank `.dev.vars.example` is the safe
  # template Wrangler users copy; the real `.dev.vars` remains forbidden.
  case "$path" in
    */README.md|*/.gitkeep|.dev.vars.example|*/.dev.vars.example) : ;;
    *)
  if printf '%s' "$path" | grep -qE "$forbidden_paths"; then
    findings=$((findings + 1))
    printf '%sBLOCKER%s %s  [forbidden-path] this path must never be committed\n' "$RED" "$OFF" "$path"
    continue
  fi
      ;;
  esac
  scan_file "$path"
done < <(collect_paths)

echo
if [ "$findings" -gt 0 ]; then
  printf '%ssecret-scan: %d blocker(s), %d warning(s). Commit refused.%s\n' "$RED" "$findings" "$warnings" "$OFF"
  echo 'Redact the value, or append the marker "secret-scan-allow" to the line if it is provably a placeholder.'
  exit 1
fi
printf '%ssecret-scan: clean%s (%d warning(s))\n' "$GRN" "$OFF" "$warnings"
exit 0
