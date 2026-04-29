#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Build frontend with the configured token / label
if command -v corepack >/dev/null 2>&1; then
  corepack pnpm --filter @pane-on-g2/frontend build
elif command -v pnpm >/dev/null 2>&1; then
  pnpm --filter @pane-on-g2/frontend build
else
  echo "pnpm or corepack required" >&2
  exit 1
fi

# Pack into an Even Hub package
npx --yes @evenrealities/evenhub-cli pack app.json frontend/dist -o pane-on-g2.ehpk

echo
echo "==> pane-on-g2.ehpk built. Upload to https://hub.evenrealities.com/dev to publish."
