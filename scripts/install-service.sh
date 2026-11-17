#!/usr/bin/env bash
# Install reports-ui as a systemd user service (starts at boot when linger is on).
# Usage: scripts/install-service.sh [install|uninstall]
# Bakes in the current REPORTS_HOME, PORT and HOST; rerun to change them.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit="$HOME/.config/systemd/user/reports-ui.service"

if [[ "${1:-install}" == "uninstall" ]]; then
  systemctl --user disable --now reports-ui.service 2>/dev/null || true
  rm -f "$unit"
  systemctl --user daemon-reload
  echo "reports-ui service removed"
  exit 0
fi

node="$(command -v node)"
root="${REPORTS_HOME:-$HOME/reports}"
port="${PORT:-4400}"
host="${HOST:-127.0.0.1}"

mkdir -p "$(dirname "$unit")"
cat > "$unit" <<UNIT
[Unit]
Description=reports-ui — web reader for $root

[Service]
WorkingDirectory=$here
Environment=REPORTS_HOME=$root
Environment=PORT=$port
Environment=HOST=$host
ExecStart=$node $here/server.js
Restart=on-failure

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable reports-ui.service >/dev/null
systemctl --user restart reports-ui.service
echo "reports-ui running at http://$host:$port (root: $root)"
