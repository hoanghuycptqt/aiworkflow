#!/usr/bin/env bash
# Manual login workflow — Mac broker (Docker Desktop).
#
# Use when mcp-server/.env cookies have expired (NextAuth maxAge ~60 days,
# manifests as broker returning `needs_relogin` or MCP gen tools failing with
# 401/403 even after token-refresh attempts).
#
# Flow:
#   1. This script launches a STANDALONE Firefox process in the container at
#      /app/firefox-profile (a path that persists across container restarts
#      via the docker-compose volume mount).
#   2. You open http://localhost:6080/vnc.html — you'll see the Firefox window
#      at labs.google/fx/tools/flow (or the signin page if cookies expired).
#   3. Click "Sign in with Google", enter email/password/2FA. Cookies save to
#      /app/firefox-profile/cookies.sqlite automatically.
#   4. When done, this script extracts cookies → updates mcp-server/.env →
#      kills the standalone Firefox → resets broker session so next MCP call
#      picks up fresh cookies.
#
# Usage:  ./manual-login.sh
# Interrupt:  Ctrl+C at the "Press Enter when done logging in" prompt.

set -e

BROKER_CONTAINER="vcw-broker-mac"
PROFILE_DIR="/app/firefox-profile"
MCP_ENV_HOST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/mcp-server/.env"

if ! docker ps --format '{{.Names}}' | grep -q "^${BROKER_CONTAINER}$"; then
    echo "❌ Container '${BROKER_CONTAINER}' is not running. Start it first:"
    echo "   cd python-broker && docker compose up -d"
    exit 1
fi
if [ ! -f "$MCP_ENV_HOST" ]; then
    echo "❌ mcp-server/.env not found at $MCP_ENV_HOST"
    exit 1
fi

echo "==> Killing any leftover standalone Firefox holding the profile..."
docker exec "$BROKER_CONTAINER" bash -c "pkill -9 -f 'profile ${PROFILE_DIR}' 2>/dev/null || true"
sleep 2

echo "==> Closing current broker session so it releases its (different) profile..."
TOKEN=$(grep '^BROKER_AUTH_TOKEN=' "$(dirname "${BASH_SOURCE[0]}")/../.env" | cut -d= -f2)
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:8002/sessions/minababy17012004_gmail_com" >/dev/null || true

echo "==> Launching standalone Firefox in container (no Playwright)..."
docker exec -d "$BROKER_CONTAINER" bash -c \
    "DISPLAY=:99 HOME=/root /root/.cache/invisible-playwright/firefox-7/firefox \
     --no-remote --profile ${PROFILE_DIR} \
     https://labs.google/fx/tools/flow > /tmp/firefox-manual.log 2>&1"
sleep 4

if ! docker exec "$BROKER_CONTAINER" pgrep -f "profile ${PROFILE_DIR}" >/dev/null; then
    echo "❌ Firefox failed to start. Check: docker exec ${BROKER_CONTAINER} cat /tmp/firefox-manual.log"
    exit 1
fi
echo "✅ Standalone Firefox running."
echo
echo "🌐 Open this URL in your browser: http://localhost:6080/vnc.html"
echo "   (Click 'Connect' if noVNC prompts — no password.)"
echo
echo "📋 In the Firefox window inside noVNC:"
echo "   1. Click 'Sign in with Google'"
echo "   2. Enter email + password + 2FA on your phone"
echo "   3. Wait for the Flow page to load with you logged in"
echo
read -rp "==> Press Enter once you've completed login (or Ctrl+C to abort)... "

echo "==> Snapshotting cookies.sqlite (avoids the live Firefox lock)..."
docker exec "$BROKER_CONTAINER" bash -c "cp ${PROFILE_DIR}/cookies.sqlite /tmp/cookies-snapshot.sqlite"

echo "==> Building cookie string..."
COOKIES=$(docker exec "$BROKER_CONTAINER" bash -c \
    "sqlite3 /tmp/cookies-snapshot.sqlite \"SELECT name || '=' || value FROM moz_cookies \
     WHERE host LIKE '%labs.google%' OR host LIKE '%.google.com%' \
     OR host LIKE 'accounts.google.com' OR host LIKE 'labs.google' ORDER BY id;\" \
     | tr '\n' ';' | sed 's/;$//' | sed 's/;/; /g'")

if [ -z "$COOKIES" ] || ! echo "$COOKIES" | grep -q '__Secure-next-auth.session-token'; then
    echo "❌ No __Secure-next-auth.session-token found in profile cookies."
    echo "   Login may not have completed. Re-run script and try again."
    exit 1
fi
echo "✅ Cookies extracted ($(echo -n "$COOKIES" | wc -c) chars)."

echo "==> Backing up mcp-server/.env to .env.bak-$(date +%s)..."
cp "$MCP_ENV_HOST" "${MCP_ENV_HOST}.bak-$(date +%s)"

echo "==> Updating GOOGLE_FLOW_SESSION_COOKIES in mcp-server/.env..."
python3 - <<PY
import re, sys
with open("$MCP_ENV_HOST") as f: content = f.read()
new = re.sub(r'^GOOGLE_FLOW_SESSION_COOKIES=.*$',
             'GOOGLE_FLOW_SESSION_COOKIES=' + """$COOKIES""", content, flags=re.M)
with open("$MCP_ENV_HOST", 'w') as f: f.write(new)
PY

echo "==> Killing standalone Firefox..."
docker exec "$BROKER_CONTAINER" bash -c "pkill -SIGTERM -f 'profile ${PROFILE_DIR}' 2>/dev/null; sleep 2; pkill -9 -f 'profile ${PROFILE_DIR}' 2>/dev/null; true"

echo
echo "✅ Done. Next step: RELOAD Claude Desktop / Antigravity to pick up fresh"
echo "   cookies in mcp-server/.env. The broker will inject these on next MCP"
echo "   gen call."
