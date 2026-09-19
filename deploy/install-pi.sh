#!/usr/bin/env bash
# One-shot install/update on the Pi. Idempotent: safe to re-run.
#
#   bash deploy/install-pi.sh
#
# It deliberately does NOT write .env — credentials are the operator's job.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/pi/tl-service-stars}"
SERVICE="tl-service-stars"

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "No .env here. Copy .env.example to .env, set ADMIN_EMAILS and TROOP_*, then re-run." >&2
  exit 1
fi
chmod 600 .env

echo "==> dependencies"
npm ci --omit=dev

echo "==> backup"
if [ -f data/stars.db ]; then
  node -e "require('better-sqlite3')('data/stars.db').exec(\"VACUUM INTO 'data/pre-deploy-$(date +%Y%m%d-%H%M%S).db'\")"
fi

echo "==> migrations"
npm run migrate

echo "==> service"
sudo cp deploy/tl-service-stars.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"
sudo systemctl restart "$SERVICE"

sleep 2
PORT_LINE=$(grep -E '^PORT=' .env || echo 'PORT=3200')
PORT="${PORT_LINE#PORT=}"
echo "==> health"
curl -fsS "http://127.0.0.1:${PORT}/health" && echo
echo "Done. Logs: journalctl -u ${SERVICE} -f"
