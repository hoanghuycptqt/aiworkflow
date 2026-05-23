#!/bin/bash
# Docker entrypoint for vcw-broker-mac.
# Starts Xvfb virtual display :99 in background, then execs the broker.
# Xvfb is needed for headful Firefox inside the container.
set -e

# Start Xvfb: display :99, screen 0, 1280x900x24bpp, no TCP/Unix sockets.
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp -nolisten unix &

# Give Xvfb a moment to bind the display before broker tries to launch Firefox.
# 1s is plenty on modern hardware; first launch waits on grecaptcha anyway.
sleep 1

# Replace shell with broker process so it inherits PID 1 (proper signal handling
# from Docker stop/restart). Xvfb child orphans on exec, but container exit reaps it.
exec "$@"
