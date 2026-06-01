#!/usr/bin/env bash
# One-time setup for the Camoufox-based broker on the aarch64 VPS.
# Idempotent — safe to re-run. Run as the service user (truonghoanghuy) so the
# Camoufox binary caches under that user's HOME (~/.cache/camoufox), which is
# where the systemd unit (HOME=/home/truonghoanghuy) expects it.
set -euo pipefail

BROKER_DIR="${BROKER_DIR:-/opt/vcw/app/python-broker}"

echo "[setup] BROKER_DIR=$BROKER_DIR  USER=$(whoami)  HOME=$HOME  ARCH=$(uname -m)"
cd "$BROKER_DIR"

# 1. Python 3.11+ (Ubuntu 24.04 ships 3.12 — already adequate).
PYBIN="$(command -v python3.12 || command -v python3.11 || command -v python3)"
echo "[setup] Using $PYBIN ($($PYBIN --version))"

# 2. Create venv if missing.
if [ ! -d venv ]; then
    echo "[setup] Creating venv..."
    "$PYBIN" -m venv venv
fi

# 3. Install deps — core + the camoufox extra (pinned 0.4.11 = Firefox 135).
echo "[setup] Installing broker + camoufox extra..."
./venv/bin/pip install --upgrade pip --quiet
./venv/bin/pip install -e '.[camoufox]' --quiet

# 4. Fetch the Camoufox Firefox binary (auto-selects lin.arm64 via platform.machine()).
if ! ./venv/bin/python -c "import camoufox" 2>/dev/null; then
    echo "[setup] camoufox import failed — pip install may have failed" >&2
    exit 1
fi
CACHE_DIR="$(./venv/bin/python -m camoufox path 2>/dev/null || true)"
# Linux launchable binary is camoufox-bin (pkgman LAUNCH_FILE['lin']); a
# byte-identical 'camoufox' alias sits beside it. Use the canonical name.
BIN="$CACHE_DIR/camoufox-bin"
if [ -z "$CACHE_DIR" ] || [ ! -x "$BIN" ]; then
    echo "[setup] Fetching Camoufox Firefox binary (~700MB incl. GeoIP)..."
    ./venv/bin/python -m camoufox fetch
    CACHE_DIR="$(./venv/bin/python -m camoufox path)"
    BIN="$CACHE_DIR/camoufox-bin"
fi

echo "[setup] Camoufox binary: $BIN"
file "$BIN" | grep -qi 'aarch64\|ARM' \
    && echo "[setup] OK: native aarch64 binary" \
    || echo "[setup] WARNING: binary is NOT aarch64 — check the fetch" >&2

# The profile-snapshot moz_cookies schema is hardcoded for Firefox 135 (camoufox
# pip 0.4.11). If the bundled Firefox ever differs (camoufox upstream is moving
# to FF150), Firefox WIPES our cookie snapshot on reload — so assert FF135 and
# fail loud rather than silently breaking the slow-path JWT refresh.
VER="$(./venv/bin/python -m camoufox version 2>&1 || true)"
echo "[setup] $VER"
echo "$VER" | grep -q 'v135\.' \
    || { echo "[setup] FATAL: expected a Firefox 135 build, got: $VER" >&2
         echo "[setup] moz_cookies DDL would mismatch — pin the camoufox pip/fetch to FF135." >&2
         exit 1; }

echo "[setup] DONE."
echo
echo "Next: ensure Xvfb :99 is running, then start the broker via systemd:"
echo "  sudo systemctl start xvfb && sudo systemctl start vcw-flow-broker"
