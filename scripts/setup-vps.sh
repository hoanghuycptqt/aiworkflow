#!/bin/bash
# ═══════════════════════════════════════════════════════════
# VPS Setup Script — Video Creator Workflow
# Run as root on a fresh Ubuntu 22.04 VPS
# Usage: bash scripts/setup-vps.sh
# ═══════════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════"
echo "  VCW Server Setup — Ubuntu 22.04"
echo "═══════════════════════════════════════"

# ── 1. System Update ──────────────────────
echo "📦 Updating system..."
apt update && apt upgrade -y

# ── 2. Node.js 22 ─────────────────────────
echo "📦 Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# ── 3. Google Chrome ──────────────────────
echo "📦 Installing Google Chrome..."
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
apt update
apt install -y google-chrome-stable

# ── 4. FFmpeg (ffprobe) ───────────────────
echo "📦 Installing FFmpeg..."
apt install -y ffmpeg

# ── 5. Nginx ──────────────────────────────
echo "📦 Installing Nginx..."
apt install -y nginx

# ── 6. PM2 ────────────────────────────────
echo "📦 Installing PM2..."
npm install -g pm2

# ── 7. Create app user ───────────────────
echo "👤 Creating app user 'vcw'..."
if ! id "vcw" &>/dev/null; then
    useradd -m -s /bin/bash vcw
fi
mkdir -p /opt/vcw/logs
chown -R vcw:vcw /opt/vcw

# ── 8. Clone repository ──────────────────
echo "📥 Cloning repository..."
if [ ! -d "/opt/vcw/app" ]; then
    su - vcw -c "git clone https://github.com/hoanghuycptqt/aiworkflow.git /opt/vcw/app"
else
    echo "   App directory exists, skipping clone."
fi

# ── 9. Install dependencies ──────────────
echo "📦 Installing npm dependencies..."
su - vcw -c "cd /opt/vcw/app && npm run install:all"

# ── 10. Build client ─────────────────────
echo "🔨 Building client..."
su - vcw -c "cd /opt/vcw/app/client && npm run build"

# ── 11. Setup database ───────────────────
echo "🗄️ Setting up database..."
su - vcw -c "cd /opt/vcw/app/server && npx prisma db push"

# ── 12. Configure Nginx ──────────────────
echo "🌐 Configuring Nginx..."
cp /opt/vcw/app/nginx/vcw.conf /etc/nginx/sites-available/vcw
ln -sf /etc/nginx/sites-available/vcw /etc/nginx/sites-enabled/vcw
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── 13. Setup PM2 ────────────────────────
echo "⚡ Starting app with PM2..."
su - vcw -c "cd /opt/vcw/app && pm2 start ecosystem.config.cjs"
su - vcw -c "pm2 save"

# PM2 startup (auto-start on reboot)
pm2 startup systemd -u vcw --hp /home/vcw
su - vcw -c "pm2 save"

# ── Done ──────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  ✅ Setup Complete!"
echo "═══════════════════════════════════════"
echo ""
echo "  Next steps:"
echo "  1. Edit /opt/vcw/app/server/.env with your actual values"
echo "     cp /opt/vcw/app/server/.env.production.example /opt/vcw/app/server/.env"
echo "     nano /opt/vcw/app/server/.env"
echo ""
echo "  2. Update nginx server_name in /etc/nginx/sites-available/vcw"
echo "     Then: nginx -t && systemctl reload nginx"
echo ""
echo "  3. (Optional) Add SSL with certbot:"
echo "     apt install -y certbot python3-certbot-nginx"
echo "     certbot --nginx -d yourdomain.com"
echo ""
echo "  4. Restart server after editing .env:"
echo "     su - vcw -c 'pm2 restart vcw-server'"
echo ""
echo "  Useful commands:"
echo "     pm2 logs vcw-server    — View server logs"
echo "     pm2 status             — Check process status"
echo "     pm2 restart vcw-server — Restart server"
echo "═══════════════════════════════════════"
