# vcw-flow-broker

Python side-car service that wraps Google Flow's reCAPTCHA Enterprise interaction
behind a localhost HTTP API. Uses [invisible_playwright](https://github.com/feder-cr/invisible_playwright)
(patched Firefox 150) to defeat reCAPTCHA detection — Phase 0 verified
**100% success rate** with rotation at 15 requests per browser context.

## Why this exists

The Node.js Workflow Engine and Google Flow connectors previously drove Chrome
via Puppeteer (`server/src/connectors/google-flow/connector.js`). On the production
VPS, Chrome's fingerprint plus the cumulative trust-score model in reCAPTCHA
Enterprise lead to recurring `PUBLIC_ERROR_UNUSUAL_ACTIVITY` 403 storms (see
incidents `acc3a26`, `6f03021`, and memory `recaptcha-incident-history`).

The broker isolates the browser-side bits in a Python process where we can use
invisible_playwright's C++-patched Firefox. Phase 0 tests on the production VPS
showed:
- Token minting passes the reCAPTCHA Enterprise backend.
- A stochastic per-context **quota of ~20-25 requests** exists.
- Rotating `BrowserContext` (cheap, ~12s for the first token after rotation)
  fully restores 100% success rate. Idling 90 s does **not** restore.

See `MEMORY.md` entry `invisible-playwright-phase0` for full forensics.

## Architecture

```
Node vcw-server (3001) ──HTTP──▶ Python broker (127.0.0.1:8002)
                                  ├─ SessionPool (per-account)
                                  │   ├─ rotate context @ 15 req
                                  │   └─ idle-close after 10 min
                                  └─ Firefox 150 (invisible_playwright)
```

## Endpoints

| Method | Path | Purpose | Replaces (connector.js) |
|---|---|---|---|
| `GET` | `/healthz` | Liveness + active sessions | — |
| `POST` | `/sessions/{id}/init` | Ensure session ready w/ cookies | `_ensureRecaptchaPage` |
| `POST` | `/sessions/{id}/recaptcha-token` | Mint fresh token (auto-rotates) | `fetchRecaptchaToken` |
| `POST` | `/sessions/{id}/flow-fetch` | Browser-side API fetch | `browserFetch` |
| `POST` | `/sessions/{id}/reload` | Reload page (sticky-failure recovery) | `_reloadRecaptchaPage` |
| `POST` | `/sessions/{id}/harvest-cookies` | Read context cookies → DB string | (new) |
| `DELETE` | `/sessions/{id}` | Close & remove from pool | `_closeRecaptchaBrowser` |

All endpoints except `/healthz` require `Authorization: Bearer $BROKER_AUTH_TOKEN`
if `BROKER_AUTH_TOKEN` env var is set.

## Local development

```bash
cd python-broker
python3.12 -m venv venv          # or python3.11; both >=3.11 supported
./venv/bin/pip install -e .

# Install invisible_playwright Firefox binary (~100MB)
./venv/bin/python -m invisible_playwright fetch
# ⚠️ If `fetch` fails with a checksum dict-miss, see "Known issues" below.

# Run the broker (loopback only by default)
./venv/bin/python -m broker
# → INFO broker starting; auth=disabled rotation=15 idle=10m
```

Hit it with curl:

```bash
curl -s http://127.0.0.1:8002/healthz
# {"ok": true, "sessions": []}

curl -s -X POST http://127.0.0.1:8002/sessions/test_user/init \
    -H 'Content-Type: application/json' \
    -d '{"cookies": "<paste your Google Flow session cookies>"}'
# {"ready": true, "request_count": 0}

curl -s -X POST http://127.0.0.1:8002/sessions/test_user/recaptcha-token \
    -H 'Content-Type: application/json' \
    -d '{"action": "IMAGE_GENERATION"}'
# {"token": "...", "request_count": 1}
```

## Environment variables

| Var | Default | Description |
|---|---|---|
| `BROKER_HOST` | `127.0.0.1` | Bind address — do NOT expose externally |
| `BROKER_PORT` | `8002` | Port |
| `BROKER_AUTH_TOKEN` | (empty) | Optional bearer secret; empty disables auth |
| `BROKER_ROTATION_THRESHOLD` | `15` | Requests before context rotation. Don't raise above 18. |
| `BROKER_IDLE_TIMEOUT_S` | `600` | Seconds of idle before fully closing browser |

## Deployment (VPS)

See plan file `/Users/truonghoanghuy/.claude/plans/quizzical-beaming-catmull.md`
for the full systemd unit. Quick version:

```bash
# One-time setup (Ubuntu 24.04 ships Python 3.12)
sudo apt install -y python3.12 python3.12-venv
cd /opt/vcw/app/python-broker
python3.12 -m venv venv
./venv/bin/pip install -e .
./venv/bin/python -m invisible_playwright fetch  # or workaround below
```

Then create `/etc/systemd/system/vcw-flow-broker.service` (template in plan)
and `systemctl enable --now vcw-flow-broker`.

## Known issues

### `invisible_playwright fetch` CLI is broken (as of 2026-05-21)

`_parse_checksums` mis-parses the `*filename` format in upstream
`checksums.txt`. Workaround:

```bash
# Find the latest release tag the wrapper expects
VERSION=$(./venv/bin/python -c "from invisible_playwright._binary import FIREFOX_VERSION; print(FIREFOX_VERSION)")
TAG=$(./venv/bin/python -c "from invisible_playwright._binary import RELEASE_TAG; print(RELEASE_TAG)")

# Download manually + verify SHA256 against upstream checksums.txt
curl -L "https://github.com/feder-cr/invisible-firefox/releases/download/${TAG}/firefox-linux-x86_64.tar.xz" \
    -o /tmp/firefox.tar.xz
# (compare sha256sum against upstream checksums.txt by hand)
mkdir -p ~/.cache/invisible-playwright/${TAG}
tar -xJf /tmp/firefox.tar.xz -C ~/.cache/invisible-playwright/${TAG}/
```

`ensure_binary()` short-circuits when the file exists, so this is a one-shot
workaround. Upstream patch is on the TODO list.

### Ephemeral profile directory

invisible_playwright launches each `with InvisiblePlaywright()` against a fresh
`/tmp/playwright_firefoxdev_profile-XXXX/` — there is **no** persistent profile
disk dir. The Phase 0 test plan's "skip add_cookies if profile has cookies on
disk" logic from the Chrome connector is unnecessary here; always inject cookies
from the DB on every context open.

### Per-context quota

Each `BrowserContext` has a Google-side quota of approximately 20-25 successful
requests before tokens start being rejected (`PERMISSION_DENIED: reCAPTCHA
evaluation failed`). The broker handles this transparently by rotating the
context at 15 requests. **Don't bypass the counter.** Increase `BROKER_ROTATION_THRESHOLD`
at your own risk.

## Source layout

```
python-broker/
├── pyproject.toml
├── requirements.txt           # legacy single-line install (used by smoke_test before pyproject)
├── README.md                  # this file
├── broker/
│   ├── __init__.py
│   ├── __main__.py            # uvicorn entrypoint
│   ├── app.py                 # FastAPI routes
│   ├── config.py              # env vars
│   ├── cookies.py             # parse + stringify
│   ├── flow.py                # Google Flow helpers
│   └── session_pool.py        # Session + SessionPool (rotation, idle)
└── scripts/
    ├── setup_vps.sh           # idempotent installer (Python venv + binary fetch)
    ├── smoke_test.py          # Phase 0 reproducer (used during validation)
    └── recovery_test.py       # idle-vs-rotate-vs-restart test (Phase 0 round 3)
```
