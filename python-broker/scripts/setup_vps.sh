#!/usr/bin/env bash
# One-time setup for invisible_playwright smoke test on the VPS.
# Idempotent — safe to re-run.
set -euo pipefail

BROKER_DIR="${BROKER_DIR:-/opt/vcw/app/python-broker}"

echo "[setup] BROKER_DIR=$BROKER_DIR"
cd "$BROKER_DIR"

# 1. Python 3.11+ (Ubuntu 22.04 ships 3.10 default; need to apt install if missing)
if ! command -v python3.11 >/dev/null 2>&1; then
    echo "[setup] Installing python3.11..."
    sudo apt-get update
    sudo apt-get install -y python3.11 python3.11-venv python3.11-dev
fi

# 2. Create venv if missing
if [ ! -d venv ]; then
    echo "[setup] Creating venv..."
    python3.11 -m venv venv
fi

# 3. Install deps
echo "[setup] Installing requirements..."
./venv/bin/pip install --upgrade pip --quiet
./venv/bin/pip install -r requirements.txt --quiet

# 4. Fetch invisible_playwright Firefox binary (~100MB)
if ! ./venv/bin/python -c "import invisible_playwright" 2>/dev/null; then
    echo "[setup] invisible_playwright import failed — pip install may have failed"
    exit 1
fi

# Check if binary cached
BIN_PATH="$(./venv/bin/python -m invisible_playwright path 2>/dev/null || true)"
if [ -z "$BIN_PATH" ] || [ ! -f "$BIN_PATH" ]; then
    echo "[setup] Fetching invisible_playwright Firefox binary (~100MB)..."
    ./venv/bin/python -m invisible_playwright fetch
fi

echo "[setup] DONE."
echo "[setup] Binary path: $(./venv/bin/python -m invisible_playwright path)"
echo
echo "Next step:"
echo "  ./venv/bin/python scripts/smoke_test.py --project-id <UUID> --iters 20"
