#!/usr/bin/env bash
set -euo pipefail

# Artha Quant - 512 MB RAM / 20 GB SSD AWS Lightsail (Ubuntu, Static IP 3.110.6.180)
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="${SUDO_USER:-$(whoami)}"

echo "=== Artha Quant AWS 512 MB Production Setup ==="
echo "App Directory: $APP_DIR | User: $APP_USER"

# 1. Create 1 GB swapfile (prevents out-of-memory during npm install / vite build on 512 MB RAM)
if ! swapon --show | grep -q '/swapfile'; then
  echo "[1/6] Creating 1 GB swapfile..."
  sudo fallocate -l 1G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=1024
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
else
  echo "[1/6] Swapfile already active."
fi

# 2. Ensure base tools & Node.js 22 LTS are installed (native TypeScript execution -> zero tsx/pm2 RAM overhead)
echo "[2/6] Checking Node.js 22 LTS..."
sudo apt-get update -y >/dev/null
sudo apt-get install -y curl git unzip >/dev/null
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node version: $(node -v)"

# 3. Verify .env exists
if [ ! -f "$APP_DIR/.env" ]; then
  echo "[3/6] Creating template .env from .env.example (PLEASE FILL IN YOUR KEYS)..."
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
else
  echo "[3/6] Found existing .env."
fi

# 4. Install dependencies & build static Vite frontend
echo "[4/6] Installing packages & building frontend (capped for 512 MB RAM)..."
cd "$APP_DIR"
npm ci --no-audit --no-fund || npm install --no-audit --no-fund
NODE_OPTIONS="--max-old-space-size=384" npm run build

# 5. Create systemd service (0 MB extra daemon overhead vs PM2; auto-starts on boot & crashes)
echo "[5/6] Configuring 24/7 systemd service (artha-quant.service)..."
sudo tee /etc/systemd/system/artha-quant.service >/dev/null <<EOF
[Unit]
Description=Artha Quant Autonomous Upstox Trading Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=$(command -v node) $APP_DIR/server.ts
Restart=always
RestartSec=3
MemoryMax=380M

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable artha-quant
sudo systemctl restart artha-quant

# 6. Verify live health
echo "[6/6] Verifying server health..."
sleep 2
curl -s http://127.0.0.1:3000/api/health || true
echo ""
echo "=== DONE! Artha Quant is running 24/7 even when your laptop is OFF. ==="
echo "Check status : sudo systemctl status artha-quant"
echo "Live logs    : sudo journalctl -u artha-quant -f"
echo "Restart bot  : sudo systemctl restart artha-quant"
