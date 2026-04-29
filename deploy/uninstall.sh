#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_LINK="${UNIT_DIR}/pane-on-g2.service"

systemctl --user disable --now pane-on-g2.service || true
rm -f "${UNIT_LINK}"
systemctl --user daemon-reload
