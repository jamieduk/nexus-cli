#!/usr/bin/env bash
#
# Start Nexus from the project folder.
#
set -euo pipefail
cd "$(dirname "$0")"

if [ -x ./nexus ]; then
  exec ./nexus "$@"
fi
if [ -f dist/index.js ]; then
  exec node dist/index.js "$@"
fi
if command -v bun >/dev/null 2>&1; then
  exec bun src/index.ts "$@"
fi
if [ -f package.json ]; then
  npm install --no-audit --no-fund
  npm run build
  exec node dist/index.js "$@"
fi
echo "No build found. Run ./install.sh or npm run build." >&2
exit 1
