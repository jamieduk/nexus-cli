#!/usr/bin/env bash
#
# Build a standalone Nexus binary with Bun and hand it straight to install.sh.
# Everything is one command: build -> smoke test -> install + shell integration.
#
#   ./export-ts.sh                     build and install to /usr/local
#   ./export-ts.sh --yes               accept install prompts
#   ./export-ts.sh --no-shell          skip ~/.bashrc integration
#   ./export-ts.sh --prefix "$HOME/.local"
#
# If Bun is not installed, install.sh is launched directly so it can install
# Bun first and build the binary itself.
#
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  exec ./install.sh --help
fi

ENTRY="./src/index.ts"
OUT="$PWD/nexus"
TARGET="bun-linux-arm64"

if [ "$(uname -m)" = "x86_64" ]; then
  TARGET="bun-linux-x64"
fi

BUN_BIN="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN_BIN="$HOME/.bun/bin/bun"; fi

if [ -z "$BUN_BIN" ]; then
  echo "Bun is not installed yet; handing off to install.sh to install prerequisites."
  exec ./install.sh "$@"
fi

echo "Building $OUT ($TARGET)..."
if "$BUN_BIN" build "$ENTRY" --compile --target="$TARGET" --outfile "$OUT"; then
  chmod +x "$OUT"
  echo "Running smoke test..."
  if "$OUT" --version; then
    echo "Launching install.sh..."
    exec ./install.sh --prebuilt "$OUT" "$@"
  fi
fi

rm -f "$OUT"
echo "Bun standalone build failed; handing off to install.sh for its fallback build."
exec ./install.sh "$@"
