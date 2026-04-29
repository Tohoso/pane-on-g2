#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/srv/ayu-workspace/projects/pane-on-g2"
LOG_DIR="${HOME}/.pane-on-g2"
LOG_FILE="${LOG_DIR}/server.log"

cd "${APP_DIR}"
mkdir -p "${LOG_DIR}"

if [[ -f "${APP_DIR}/.env.prod" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${APP_DIR}/.env.prod"
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"
export PANE_ON_G2_BIND="${PANE_ON_G2_BIND:-127.0.0.1}"
export PANE_ON_G2_PORT="${PANE_ON_G2_PORT:-3457}"

exec >> "${LOG_FILE}" 2>&1
echo "[$(date -Is)] starting pane-on-g2 on ${PANE_ON_G2_BIND}:${PANE_ON_G2_PORT}"

if [[ ! -d "${APP_DIR}/frontend/dist" ]]; then
  echo "[$(date -Is)] warning: frontend/dist missing; run pnpm build before production start"
fi

exec node --experimental-strip-types --experimental-transform-types server/src/index.ts
