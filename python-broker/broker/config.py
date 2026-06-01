"""Env-driven config for the broker."""

import os


HOST = os.environ.get("BROKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("BROKER_PORT", "8002"))

# Shared secret between Node client and broker — defense-in-depth on top of loopback bind.
# Empty string disables auth (dev mode). In prod set via systemd EnvironmentFile.
AUTH_TOKEN = os.environ.get("BROKER_AUTH_TOKEN", "")

# Rotation threshold — confirmed via Phase 0 testing (stochastic cliff 20-25, safe @ 15).
ROTATION_THRESHOLD = int(os.environ.get("BROKER_ROTATION_THRESHOLD", "15"))

# Idle close timeout (seconds). Default 10-min matches the Chrome connector.
# Set <= 0 to DISABLE idle close (broker stays warm forever) — the Mac MCP
# does this (BROKER_IDLE_TIMEOUT_S=0 in docker-compose) to avoid cold-relaunch
# churn on a single-user box with spare RAM. Context still rotates @
# ROTATION_THRESHOLD regardless, so trust score stays fresh.
IDLE_TIMEOUT_S = int(os.environ.get("BROKER_IDLE_TIMEOUT_S", str(10 * 60)))

# Page nav timeout — Firefox cold-launch + Xvfb + heavy Flow SPA can exceed 30s on
# the VPS. Phase 2 e2e observed ~16-20s typical cold-start; 60s provides headroom.
PAGE_NAV_TIMEOUT_MS = int(os.environ.get("BROKER_PAGE_NAV_TIMEOUT_MS", "60000"))
