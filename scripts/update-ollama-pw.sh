#!/usr/bin/env bash
#
# update-ollama-pw.sh — rotate the nginx basic-auth password for the public
# Ollama endpoint (https://thhflow.com/ollama/). Reads the NEW password from
# STDIN (so it never appears in argv / `ps`), writes the htpasswd file, and
# gracefully reloads nginx.
#
# Runs as ROOT via a narrow sudoers rule. Install on the VPS (one-time) as a
# root-owned file OUTSIDE the git-managed app dir so a deploy can't tamper with
# a root-executed script:
#
#   sudo install -m 0755 -o root -g root scripts/update-ollama-pw.sh /usr/local/sbin/vcw-ollama-pw
#   echo 'truonghoanghuy ALL=(root) NOPASSWD: /usr/local/sbin/vcw-ollama-pw' | sudo tee /etc/sudoers.d/vcw-ollama-pw
#   sudo chmod 0440 /etc/sudoers.d/vcw-ollama-pw && sudo visudo -c
#
# Invoked by the Express admin route:  sudo -n /usr/local/sbin/vcw-ollama-pw   (password on stdin)
set -euo pipefail

HTPASSWD_FILE="${OLLAMA_HTPASSWD_FILE:-/etc/nginx/.ollama_htpasswd}"
HTPASSWD_USER="${OLLAMA_HTPASSWD_USER:-flowadmin}"

# Read the whole stdin as the new password (may contain spaces; trailing newline trimmed).
PW="$(cat)"
PW="${PW%$'\n'}"
if [ -z "$PW" ]; then
    echo "empty password" >&2
    exit 1
fi

# apr1 (Apache MD5) hash — supported by nginx auth_basic; password fed via stdin, not argv.
HASH="$(printf '%s' "$PW" | openssl passwd -apr1 -stdin)"

umask 027
printf '%s:%s\n' "$HTPASSWD_USER" "$HASH" > "$HTPASSWD_FILE"
chown root:www-data "$HTPASSWD_FILE" 2>/dev/null || true
chmod 640 "$HTPASSWD_FILE"

# Validate config then reload (graceful — no dropped connections).
nginx -t
systemctl reload nginx

echo "ok"
