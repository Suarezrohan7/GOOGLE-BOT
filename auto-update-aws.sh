#!/usr/bin/env bash
set -euo pipefail

# Installs a lightweight 2-minute GitHub auto-sync daemon on AWS Lightsail
# Usage: bash auto-update-aws.sh https://github.com/Suarezrohan7/<your-repo>.git

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="${SUDO_USER:-$(whoami)}"
REPO_URL="${1:-}"

if [ -n "$REPO_URL" ]; then
  cd "$APP_DIR"
  git remote set-url origin "$REPO_URL"
fi

cat > "$APP_DIR/.auto-pull-runner.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
git fetch origin main --quiet || exit 0
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "[Artha AutoDeploy] New commit $REMOTE detected; pulling & rebuilding..."
  PREV_PKG=$(sha256sum package.json | awk '{print $1}')
  git reset --hard origin/main
  NEW_PKG=$(sha256sum package.json | awk '{print $1}')
  if [ "$PREV_PKG" != "$NEW_PKG" ] || [ ! -d node_modules ]; then
    npm install --legacy-peer-deps --no-audit --no-fund --no-save
  fi
  NODE_OPTIONS="--max-old-space-size=320" npm run build
  sudo systemctl restart artha-quant
  echo "[Artha AutoDeploy] Restarted artha-quant cleanly."
fi
EOF
chmod +x "$APP_DIR/.auto-pull-runner.sh"

sudo tee /etc/systemd/system/artha-autodeploy.service >/dev/null <<EOF
[Unit]
Description=Artha Quant Auto-Pull from GitHub
After=network-online.target

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/bash $APP_DIR/.auto-pull-runner.sh
EOF

sudo tee /etc/systemd/system/artha-autodeploy.timer >/dev/null <<EOF
[Unit]
Description=Check GitHub every 2 minutes for Artha Quant updates

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
Unit=artha-autodeploy.service

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now artha-autodeploy.timer
echo "Auto-deploy active! AWS will automatically sync from GitHub every 2 minutes."
