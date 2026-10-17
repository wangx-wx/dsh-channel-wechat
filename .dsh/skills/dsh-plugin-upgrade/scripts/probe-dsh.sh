#!/usr/bin/env bash
# Install one DSH release from npm and arrange it into the shape the integration
# suite expects, so the suite measures THAT release instead of the packaged app.
#
# Why this exists: `tests/support/harness.ts` resolves the launcher as
# `$DSH_CHECKOUT/apps/cli/lib/bin.js` and, when that file is absent, silently
# falls back to `/Applications/DeepSeek Harness.app`. Since `lib/` is gitignored
# in the DSH checkout, a checkout that was never built takes the fallback - and
# the run reports the PACKAGED app's version while you believe it tested the new
# one. This script produces a directory where the launcher really is the version
# you asked for, and then proves it.
#
# Usage:
#   probe-dsh.sh <dsh-version> [--sources <dsh-checkout>] [--out <dir>]
#
#   --sources  A DSH checkout whose `ui-theme` sources and pnpm store are reused.
#              Only `client-half-runs` needs them (React + theme tokens). Without
#              it that one suite skips - an environment limit, not a version
#              incompatibility. Point it at any checkout of any version; the
#              tokens are read from source, not from the runtime under test.
#   --out      Where to stage the shim. Defaults to /tmp/dsh-probe-<version>.
#
# Prints the shim path on stdout (last line) so a caller can consume it:
#   DSH_CHECKOUT=$(probe-dsh.sh 0.2.1-rc.1) pnpm test:integration

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: probe-dsh.sh <dsh-version> [--sources <checkout>] [--out <dir>]" >&2
  exit 2
fi
shift

SOURCES=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sources) SOURCES="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

OUT="${OUT:-/tmp/dsh-probe-$VERSION}"
INSTALL="$OUT/install"
SHIM="$OUT/checkout"

# npm's user-level cache is often root-owned (EPERM). Keep the cache disposable
# and local to this probe so it never depends on the caller's npm config.
CACHE="${NPM_PROBE_CACHE:-/tmp/npmcache}"
mkdir -p "$CACHE"

echo "== installing @deepseek-ai/dsh@$VERSION" >&2
rm -rf "$INSTALL" "$SHIM"
mkdir -p "$INSTALL"
npm install --prefix "$INSTALL" --cache "$CACHE" --no-audit --no-fund \
  "@deepseek-ai/dsh@$VERSION" >&2

LAUNCHER="$INSTALL/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ ! -f "$LAUNCHER" ]; then
  echo "ERROR: $LAUNCHER missing after install; the package layout changed." >&2
  exit 1
fi

# The suite runs `node <checkout>/apps/cli/lib/bin.js`, so the shim only has to
# put the installed launcher at that path. Everything else is optional support
# for the client-half suite.
mkdir -p "$SHIM/apps/cli/lib"
ln -s "$LAUNCHER" "$SHIM/apps/cli/lib/bin.js"

if [ -n "$SOURCES" ]; then
  STORE="$SOURCES/node_modules/.pnpm"
  STYLES="$SOURCES/packages/client/ui-theme/src/styles"
  if [ -d "$STORE" ]; then
    mkdir -p "$SHIM/node_modules"
    ln -s "$STORE" "$SHIM/node_modules/.pnpm"
  else
    echo "WARN: no pnpm store at $STORE; client-half-runs will skip" >&2
  fi
  if [ -d "$STYLES" ]; then
    mkdir -p "$SHIM/packages/client/ui-theme/src"
    ln -s "$STYLES" "$SHIM/packages/client/ui-theme/src/styles"
  else
    echo "WARN: no ui-theme sources at $STYLES; client-half-runs will skip" >&2
  fi
fi

# Prove the launcher is the version asked for. An npm alias, a cached tarball or
# a stale install all show up here rather than as a mysterious test result.
ACTUAL=$(DSH_HOME="$(mktemp -d)" node "$SHIM/apps/cli/lib/bin.js" --version 2>/dev/null | tail -1)
echo "== launcher reports: $ACTUAL" >&2
if [ "$ACTUAL" != "$VERSION" ]; then
  echo "ERROR: asked for $VERSION, launcher reports '$ACTUAL'." >&2
  exit 1
fi

echo "$SHIM"
