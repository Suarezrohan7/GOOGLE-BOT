#!/usr/bin/env bash
set -euo pipefail

# Artha Quant - Automatic Free HTTPS + Upstox WhatsApp 1-Tap Notifier Setup for AWS (3.110.6.180)
# Usage:
#   bash setup-whatsapp-https.sh                  (tries zero-signup 3-110-6-180.sslip.io)
#   bash setup-whatsapp-https.sh mybot.duckdns.org (uses custom free DuckDNS subdomain)

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="${1:-3-110-6-180.sslip.io}"

echo "=== Setting up HTTPS WhatsApp Notifier Webhook on $DOMAIN ==="

# 1. Install Caddy cleanly (zero interactive prompts)
if ! command -v caddy >/dev/null 2>&1; then
  echo "[1/5] Installing Caddy reverse proxy..."
  sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update -y >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update -y >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y caddy >/dev/null
else
  echo "[1/5] Caddy already installed."
fi

# 2. Configure webhook-only Caddyfile (keeps trading dashboard private/local-only!)
echo "[2/5] Writing Caddy webhook-only HTTPS config for $DOMAIN..."
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
    @upstox_public {
        path /api/upstox/notifier-webhook /api/upstox/callback
    }
    handle @upstox_public {
        reverse_proxy 127.0.0.1:3000
    }
    handle / {
        respond "Artha Quant Upstox Webhook Gateway Active (Dashboard is Local-Only)" 200
    }
    handle {
        respond "Forbidden (Dashboard is Local-Only)" 403
    }
}
EOF

sudo systemctl enable caddy
sudo systemctl restart caddy

# 3. Update .env to enable public WhatsApp webhook mode
echo "[3/5] Updating $APP_DIR/.env for HTTPS WhatsApp webhook..."
ENV_FILE="$APP_DIR/.env"
sed -i '/^UPSTOX_PUBLIC_WEBHOOK=/d;/^APP_URL=/d;/^UPSTOX_REDIRECT_URI=/d' "$ENV_FILE"
cat >> "$ENV_FILE" <<EOF
APP_URL="https://${DOMAIN}"
UPSTOX_REDIRECT_URI="https://${DOMAIN}/api/upstox/callback"
UPSTOX_PUBLIC_WEBHOOK="true"
EOF
sudo systemctl restart artha-quant

# 4. Verify live HTTPS SSL certificate & webhook endpoint
echo "[4/5] Verifying HTTPS SSL endpoint (ports 80 & 443 must be open in AWS Lightsail Networking)..."
sleep 5
if curl -fsS --max-time 15 "https://${DOMAIN}/api/upstox/notifier-webhook"; then
  echo ""
  echo "[5/5] HTTPS Webhook VERIFIED LIVE!"
  echo "Set these exact URLs in Upstox Developer Console (My Apps -> Trading View -> Edit):"
  echo "  Redirect URL              : https://${DOMAIN}/api/upstox/callback"
  echo "  Notifier Webhook Endpoint : https://${DOMAIN}/api/upstox/notifier-webhook"
  echo "  OTP Settings              : Toggle OFF (optional, for instant 1-tap approval)"
else
  echo ""
  echo "WARN: HTTPS check failed on https://${DOMAIN}/api/upstox/notifier-webhook"
  echo "1. Open AWS Lightsail -> Networking -> Firewall -> Add HTTP (80) & HTTPS (443)."
  echo "2. If sslip.io SSL hit rate limit, create a free subdomain on https://www.duckdns.org pointing to 3.110.6.180 and re-run:"
  echo "   bash setup-whatsapp-https.sh YOURNAME.duckdns.org"
  exit 1
fi
