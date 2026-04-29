#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/srv/ayu-workspace/projects/pane-on-g2"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_LINK="${UNIT_DIR}/pane-on-g2.service"

mkdir -p "${UNIT_DIR}" "${HOME}/.pane-on-g2"
ln -sfn "${APP_DIR}/deploy/pane-on-g2.service" "${UNIT_LINK}"

systemctl --user daemon-reload
systemctl --user enable --now pane-on-g2.service
systemctl --user status pane-on-g2.service --no-pager
