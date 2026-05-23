#!/bin/bash
# Docker entrypoint for vcw-broker-mac (Plan v5.0).
#
# Starts a stack of display services in background, then execs the broker:
#   1. Xvfb     — virtual X11 display :99 (where Firefox renders)
#   2. fluxbox  — minimal window manager (lets user move/resize Firefox window)
#   3. x11vnc   — VNC server bridging Xvfb display :99 → port 5900
#   4. noVNC    — websocket proxy serving VNC over HTTP at port 6080
#   5. broker   — Python FastAPI service on port 8002 (PID 1 after exec)
#
# User connects to http://localhost:6080/vnc.html to see Firefox UI inside
# container. Broker drives Firefox via Playwright (persistent context); user
# can interact via VNC simultaneously (X server doesn't lock user input out
# when Playwright is driving).
set -e

# 1. Virtual X display — Firefox renders into this offscreen framebuffer.
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp -nolisten unix &
XVFB_PID=$!

# Wait for Xvfb to actually bind the display socket before launching X clients.
for i in {1..20}; do
    if [ -e /tmp/.X11-unix/X99 ]; then break; fi
    sleep 0.2
done

# 2. Window manager — minimal but enough to drag/resize Firefox window.
DISPLAY=:99 fluxbox &
FLUXBOX_PID=$!

# 3. VNC server bridging display :99 → port 5900 (internal only).
# Flags: -forever (don't exit after first client disconnect), -shared (multiple
# clients OK), -nopw (no password — defense-in-depth via localhost bind),
# -rfbport 5900 (default VNC port), -bg (background daemon), -o /tmp/x11vnc.log.
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -bg -o /tmp/x11vnc.log

# 4. noVNC web frontend — websocket proxy at port 6080 → 5900.
# Lets user connect from any browser without installing a VNC client.
# /usr/share/novnc is shipped by the `novnc` apt package.
websockify --web=/usr/share/novnc 6080 localhost:5900 > /tmp/websockify.log 2>&1 &
WEBSOCKIFY_PID=$!

# Brief settle — lets x11vnc + websockify finish startup before broker boots.
sleep 1

# 5. Exec broker as PID 1 (proper signal handling from Docker stop/restart).
# Xvfb, fluxbox, x11vnc, websockify children orphan on exec but container exit
# reaps them. If broker exits, container exits, kernel cleans up display stack.
exec "$@"
