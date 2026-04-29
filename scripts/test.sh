#!/usr/bin/env bash
set -euo pipefail

corepack pnpm --filter @pane-on-g2/server test
corepack pnpm --filter @pane-on-g2/frontend test
