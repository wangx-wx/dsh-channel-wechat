#!/usr/bin/env bash
# Check every name this plugin depends on against a DSH source tree.
#
# The dangerous half of a DSH upgrade is not a changed function signature - the
# type checker catches those. It is a renamed service key, event name, or slot:
# `ctx.get('llm')` returns undefined when the name moves, the plugin keeps
# booting, and a feature silently stops working. Nothing fails. So the names are
# extracted from THIS REPO rather than hand-listed: a hand-written list drifts
# the moment someone adds a `ctx.get`.
#
# Usage: check-contract.sh <dsh-checkout>
#
# Exit 0 when every name still exists somewhere in the DSH tree; exit 1 listing
# what vanished. "Exists somewhere" is a weak claim on purpose - a name can move
# module and stay valid. Treat a miss as a prompt to read DSH, not as proof of
# breakage.

set -euo pipefail

DSH="${1:-}"
if [ -z "$DSH" ] || [ ! -d "$DSH" ]; then
  echo "usage: check-contract.sh <dsh-checkout>" >&2
  exit 2
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PKGS="$DSH/packages"
# `cordis` and `schemastery` are vendored, not under packages/. Searching only
# packages/ reports their symbols as missing and sends you chasing a rename that
# never happened - the first run of this script did exactly that for `Volatile`.
VENDOR="$DSH/vendor"
fail=0

# Both roots are passed as separate quoted arguments to every grep. As one
# space-joined string, a checkout path containing a space splits into two
# nonexistent paths, grep finds nothing, and EVERY name reports as missing -
# a false alarm that looks exactly like a total contract break. Verified: a
# path with a space produced 31/31 MISS before this was split.
SEARCH_ROOTS=("$PKGS" "$VENDOR")

# Search only package sources; node_modules would match anything.
grep_dsh() {
  grep -rIl -- "$1" "${SEARCH_ROOTS[@]}" --include='*.ts' 2>/dev/null | head -1
}

report() {
  local kind="$1" name="$2" hit="$3"
  if [ -n "$hit" ]; then
    printf '  ok    %-8s %s\n' "$kind" "$name"
  else
    printf '  MISS  %-8s %s\n' "$kind" "$name"
    fail=1
  fi
}

echo "== service keys (ctx.get / ctx.inject / inject array)"
services=$(
  {
    grep -rhoE "ctx\.get\('[a-zA-Z.]+'\)" --include='*.ts' "$REPO/src" 2>/dev/null
    grep -rhoE "ctx\.inject\(\['[a-zA-Z.]+'\]" --include='*.ts' "$REPO/src" 2>/dev/null
    grep -rhoE "^export const inject = \[[^]]*\]" --include='*.ts' "$REPO/src" 2>/dev/null
  } | grep -oE "'[a-zA-Z.]+'" | tr -d "'" | sort -u
)
for s in $services; do
  # A service is provided by exactly one `ctx.provide('<name>'`. Checking the
  # provide call rather than a plain mention is what distinguishes a live
  # service from a comment or a config key that happens to share the name.
  report service "$s" "$(grep -rhoE "ctx\.provide\('$s'" --include='*.ts' "$PKGS" 2>/dev/null | head -1)"
done

echo "== session event types (the plugin's inbound contract)"
# Session events are matched by type string. KNOWN_SESSION_EVENT_TYPES is the
# generated authority for what this build understands; a type that leaves it is
# refused by the persistence read path as if written by a newer harness.
for e in $(grep -rhoE "'(assistant/message|deliverables/presented)'" --include='*.ts' "$REPO/src" 2>/dev/null | tr -d "'" | sort -u); do
  report event "$e" "$(grep -F "'$e'" "$PKGS/core/session/src/known-event-types.ts" 2>/dev/null | head -1)"
done

echo "== client slots (the plugin's page)"
for slot in $(grep -rhoE "'plugins\.bundle\.[a-z]+'" --include='*.js' "$REPO/src" 2>/dev/null | tr -d "'" | sort -u); do
  report slot "$slot" "$(grep -F "key: '$slot'" "$DSH/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts" 2>/dev/null | head -1)"
done

echo "== event and waterfall names emitted by the host for cards and turns"
for e in $(grep -rhoE "'(approval/request|user-questions/request|session/event)'" --include='*.ts' "$REPO/src" 2>/dev/null | tr -d "'" | sort -u); do
  report event "$e" "$(grep_dsh "'$e'")"
done

echo "== imported @deepseek-ai symbols"
# Signatures are the type checker's job. This only answers "does the symbol still
# exist", which is what a rename looks like before any type is consulted.
#
# The symbols are read out of the import statements, not hand-listed: a list
# here goes stale the first time someone imports something new, and stale
# coverage of this kind fails silently in the same way the contract does.
#
# Only braced specifiers are collected. A default import (`import z from ...`)
# and a bare `import type {} from ...` are skipped: the first has no braces to
# parse and the second names nothing, so both only produce junk tokens.
symbols=$(
  grep -rh "from '@deepseek-ai/" --include='*.ts' "$REPO/src" 2>/dev/null \
    | grep '{' \
    | sed -E "s/^[^{]*\{([^}]*)\}.*/\1/" \
    | tr ',' '\n' \
    | sed -E "s/^[[:space:]]*(type[[:space:]]+)?//; s/[[:space:]]*$//" \
    | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' \
    | sort -u
)
# Default imports are real dependencies too (`import z from '...schemastery'`),
# and their local name says nothing about the export, so they are checked as
# "the package still has a default export" rather than by name.
for pkg in $(grep -rhoE "^import [A-Za-z_]+ from '@deepseek-ai/[a-z-]+'" --include='*.ts' "$REPO/src" 2>/dev/null | sed -E "s/.*from '//; s/'//" | sort -u); do
  base=$(basename "$pkg")
  report default "$pkg" "$(grep -rhoE "export default |export \{ default" --include='*.ts' "$VENDOR/$base/src" "$PKGS" 2>/dev/null | head -1)"
done
for sym in $symbols; do
  report symbol "$sym" "$(grep -rhoE "export (declare )?(type |interface |function |const |class )?\b$sym\b" --include='*.ts' "${SEARCH_ROOTS[@]}" 2>/dev/null | head -1)"
done

echo
if [ "$fail" -ne 0 ]; then
  echo "Some names were not found. Read the DSH sources for each MISS before changing"
  echo "anything: a provided service can be renamed, an event can be superseded, and"
  echo "a slot can be retired with its owner still exporting the old key."
  exit 1
fi
echo "Every name this plugin depends on still exists in $DSH."
