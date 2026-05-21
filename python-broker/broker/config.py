"""Env-driven config for the broker."""

import os


HOST = os.environ.get("BROKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("BROKER_PORT", "8002"))

# Shared secret between Node client and broker — defense-in-depth on top of loopback bind.
# Empty string disables auth (dev mode). In prod set via systemd EnvironmentFile.
AUTH_TOKEN = os.environ.get("BROKER_AUTH_TOKEN", "")

# Rotation threshold — confirmed via Phase 0 testing (stochastic cliff 20-25, safe @ 15).
ROTATION_THRESHOLD = int(os.environ.get("BROKER_ROTATION_THRESHOLD", "15"))

# Idle close timeout — matches Chrome connector's 10-min (preserves trust-score architecture).
IDLE_TIMEOUT_S = int(os.environ.get("BROKER_IDLE_TIMEOUT_S", str(10 * 60)))
