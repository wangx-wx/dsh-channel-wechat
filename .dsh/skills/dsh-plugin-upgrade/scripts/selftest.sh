#!/usr/bin/env bash
# Prove check-contract.sh can tell a healthy contract from a broken one.
#
# The script it tests exists to convert silence into a signal, so the failure
# that matters most is the script itself going quiet - reporting MISS for
# everything, or ok for everything. Both look like a result. The first version
# did the former whenever the checkout path contained a space.
#
# This runs four fixtures and asserts the outcome is the one expected, so a
# future edit that breaks detection fails here instead of at upgrade time.
#
# Usage: selftest.sh <dsh-checkout>        (a real tree, for the positive case)
#
# Exit 0 when every fixture behaves as expected.

set -uo pipefail

DSH="${1:-}"
if [ -z "$DSH" ] || [ ! -d "$DSH" ]; then
  echo "usage: selftest.sh <dsh-checkout>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/check-contract.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# Count how many entries came back ok vs missing.
run() {
  "$CHECK" "$1" > "$TMP/out" 2>&1
  local code=$?
  ok=$(grep -c '^  ok' "$TMP/out" || true)
  miss=$(grep -c '^  MISS' "$TMP/out" || true)
  return $code
}

expect() {
  local name="$1" want_code="$2" want_ok="$3" want_miss="$4" dir="$5"
  run "$dir"; local code=$?
  local bad=0
  [ "$code" = "$want_code" ] || bad=1
  if [ "$want_ok" = any ]; then [ "$ok" -gt 0 ] || bad=1
  elif [ "$ok" != "$want_ok" ]; then bad=1; fi
  if [ "$want_miss" = any ]; then [ "$miss" -gt 0 ] || bad=1
  elif [ "$miss" != "$want_miss" ]; then bad=1; fi
  if [ "$bad" -eq 0 ]; then
    printf '  pass  %-34s exit=%s ok=%s miss=%s\n' "$name" "$code" "$ok" "$miss"
  else
    printf '  FAIL  %-34s exit=%s ok=%s miss=%s (want exit=%s ok=%s miss=%s)\n' \
      "$name" "$code" "$ok" "$miss" "$want_code" "$want_ok" "$want_miss"
    fail=1
  fi
}

echo "== a healthy tree is admitted"
expect "real checkout" 0 any 0 "$DSH"

echo "== a partially broken tree is refused, and only the broken part"
mkdir -p "$TMP/partial/packages/core/session/src" "$TMP/partial/packages/x"
cat > "$TMP/partial/packages/x/a.ts" <<'EOF'
ctx.provide('llm')
ctx.provide('credentials')
export function parseCmdline() {}
EOF
cat > "$TMP/partial/packages/core/session/src/known-event-types.ts" <<'EOF'
export const KNOWN_SESSION_EVENT_TYPES = new Set(['assistant/message', 'deliverables/presented'])
EOF
expect "partial tree" 1 5 29 "$TMP/partial"

echo "== the partial case must still admit what it does contain"
run "$TMP/partial"
partial_ok=$ok
partial_miss=$miss
grep -q '^  ok    service  llm' "$TMP/out" && printf '  pass  %-34s\n' "llm still reported ok" \
  || { printf '  FAIL  %-34s\n' "llm should still be ok"; fail=1; }

echo "== a path containing a space gives the same answer as one without"
# This is the regression that was actually shipped: the two source roots were
# joined into one string, so a checkout whose path contains a space split into
# two nonexistent paths and grep found nothing. Earlier this fixture asserted
# only "some ok, some missing", which the buggy version satisfied - the wrong
# assertion cannot catch the bug. What matters is that the ANSWER DOES NOT
# DEPEND ON THE PATH SPELLING, so the two runs are compared to each other.
#
# A real directory is required: grep -r does not follow a symlinked root, so a
# symlink here would fail for an unrelated reason.
SPACED="$TMP/dsh with space"
mkdir -p "$SPACED"
cp -R "$TMP/partial/packages" "$SPACED/packages"
run "$SPACED"; spaced_code=$?
if [ "$spaced_code" = 1 ] && [ "$ok" = "$partial_ok" ] && [ "$miss" = "$partial_miss" ]; then
  printf '  pass  %-34s ok=%s miss=%s (same as unspaced)\n' "spaced path" "$ok" "$miss"
else
  printf '  FAIL  %-34s ok=%s miss=%s (unspaced was ok=%s miss=%s, exit want 1 got %s)\n' \
    "spaced path" "$ok" "$miss" "$partial_ok" "$partial_miss" "$spaced_code"
  fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "check-contract.sh is not distinguishing healthy contracts from broken ones."
  exit 1
fi
echo "check-contract.sh distinguished every fixture correctly."
