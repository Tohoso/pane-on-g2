#!/usr/bin/env bash
set -euo pipefail

corepack pnpm --parallel --filter @pane-on-g2/server --filter @pane-on-g2/frontend dev
