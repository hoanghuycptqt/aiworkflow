# linux/amd64 explicit — invisible_playwright ships x86_64 Firefox binaries only.
# Rosetta 2 on Apple Silicon will emulate this. ~30-50% slower than native, acceptable.
FROM --platform=linux/amd64 python:3.11-slim-bookworm

# Firefox runtime deps + Xvfb (headful display) + git (invisible_playwright via git+...)
# + curl (for healthcheck) + ca-certificates (TLS).
# Plan v5.0 additions: fluxbox (lightweight WM), x11vnc + novnc + websockify
# (web-based VNC access to Firefox UI for manual login flow), procps + psmisc
# (process management used by entrypoint script).
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        git \
        libdbus-glib-1-2 \
        libgtk-3-0 \
        libasound2 \
        libxtst6 \
        libxt6 \
        libx11-xcb1 \
        libpci3 \
        ca-certificates \
        curl \
        fluxbox \
        x11vnc \
        novnc \
        websockify \
        procps \
        psmisc \
        dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CRITICAL (Round 12 finding): requirements.txt only lists invisible_playwright.
# pyproject.toml has the full deps (FastAPI/uvicorn/pydantic) but pip install -r
# requirements.txt alone won't pull them. Install all deps explicitly so the image
# is self-contained. Layer-cacheable because pyproject + requirements rarely change.
COPY pyproject.toml requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir fastapi 'uvicorn[standard]' pydantic

# invisible_playwright Firefox patched binary (~113MB) — pre-downloaded on host
# to bypass slow `invisible_playwright fetch` CLI under Rosetta 2 emulation
# (observed 16+ min hang during initial container build 2026-05-23).
#
# Tarball contents extract to /root/.cache/invisible-playwright/firefox-7/ which
# matches what `invisible_playwright.download.cache_dir_for_version("firefox-7")`
# expects — `ensure_binary()` finds the binary, skips re-download.
#
# Acquired from upstream:
#   curl -L -o firefox-stealth-linux-x86_64.tar.gz \
#     https://github.com/feder-cr/invisible_playwright/releases/download/firefox-7/firefox-150.0.1-stealth-linux-x86_64.tar.gz
# Place in build context (this dir). Excluded from git (.gitignore).
COPY firefox-stealth-linux-x86_64.tar.gz /tmp/firefox.tar.gz
RUN mkdir -p /root/.cache/invisible-playwright/firefox-7 && \
    tar -xzf /tmp/firefox.tar.gz -C /root/.cache/invisible-playwright/firefox-7 && \
    rm /tmp/firefox.tar.gz && \
    test -x /root/.cache/invisible-playwright/firefox-7/firefox || \
        (echo "ERROR: firefox binary not found after extraction" && ls -la /root/.cache/invisible-playwright/firefox-7/ && exit 1)

# Copy broker code last (changes most frequently → small invalidation surface).
COPY broker ./broker

# Xvfb wrapper script — starts virtual display :99, then execs the broker.
COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Defaults — overridden by docker-compose env section.
# BROKER_HOST=0.0.0.0 so port forward from compose works (broker.config defaults to 127.0.0.1).
ENV BROKER_HOST=0.0.0.0 \
    BROKER_PORT=8002 \
    DISPLAY=:99

EXPOSE 8002 6080

# /healthz is NOT auth-protected (broker/app.py:66-68) → no token needed in curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fs http://127.0.0.1:8002/healthz || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "broker"]
