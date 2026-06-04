"""Launch a standalone Firefox at the per-account persistent profile dir,
let it navigate Google Flow so NextAuth's page-level refresh runs inside
the real-browser context, then read back the rotated cookies from sqlite.

Why this exists (vs. the simpler `refresh_cookies` in session_pool, which
uses broker's ephemeral session pool):

  When DB cookies are past NextAuth's `session.maxAge` (~20h on labs.google),
  `/fx/api/auth/session` returns ACCESS_TOKEN_REFRESH_NEEDED and refuses to
  hand out a fresh access_token. Broker's ephemeral context can't unstick
  this — it only has the .env-injected cookies (NextAuth session-token +
  Google account cookies) but no real browser state (no Service Worker
  registrations, no full IndexedDB, no fingerprint coherence). A page
  navigation in that minimal context tries OAuth silent refresh and often
  fails ("error=Verification").

  Standalone Firefox at the persistent profile dir behaves like a real
  user's browser: it sends the Google account cookies (SID, SAPISID,
  HSID, ...) to `accounts.google.com`, the OAuth silent-refresh callback
  succeeds, NextAuth mints a brand-new session-token JWT with a fresh
  `expires` field, and Firefox writes the rotated cookies back into
  cookies.sqlite. We then read them off disk via the existing
  read_profile_cookies path.

Used by:
  - server/src/services/cookie-harvester.js as the slow path after the
    fast `/session` call fails (VPS, per-account profile dirs).
  - (Future) mcp-server/lib/firefox-refresh.js could migrate from its
    `docker exec` shell-out to this endpoint for symmetry.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import time
import urllib.error
import urllib.request
from pathlib import Path

from broker.config import BROWSER_ENGINE
from broker.profile_cookies import read_profile_cookies, resolve_profile_dir
from broker.profile_snapshot import is_enabled as profile_snapshot_enabled

logger = logging.getLogger("broker.profile_reload")

# Standalone-Firefox binary used for the slow-path JWT refresh. Both engines
# ship a real Gecko binary that honours `--no-remote --profile <dir> <url>`
# (verified on aarch64: camoufox's binary populates cookies.sqlite identically
# to vanilla Firefox). The default path differs per engine; HOME differs between
# Mac docker (root) and VPS systemd (truonghoanghuy), so derive at runtime.
# Override with the FIREFOX_BIN env var if the binary moves.
_HOME = Path(os.environ.get("HOME", "/root"))
if BROWSER_ENGINE == "camoufox":
    # Resolve the launchable binary via camoufox's own path logic (drift-proof):
    # on Linux the executable is camoufox-bin (pkgman LAUNCH_FILE['lin']), shipped
    # alongside a byte-identical 'camoufox' alias. Fall back to the literal
    # cache path if the import API ever changes.
    try:
        from camoufox.pkgman import launch_path as _camoufox_launch_path

        _DEFAULT_FIREFOX_BIN = str(_camoufox_launch_path())
    except Exception:
        _DEFAULT_FIREFOX_BIN = str(_HOME / ".cache/camoufox/camoufox-bin")
else:
    _DEFAULT_FIREFOX_BIN = str(_HOME / ".cache/invisible-playwright/firefox-7/firefox")
FIREFOX_BIN = os.environ.get("FIREFOX_BIN", _DEFAULT_FIREFOX_BIN)
FLOW_URL = "https://labs.google/fx/tools/flow"
# Display where Xvfb runs — broker systemd unit / docker entrypoint both
# set this to :99. Firefox won't launch without a display target.
DISPLAY = os.environ.get("DISPLAY", ":99")

# Max time to let Firefox sit at Flow per attempt before giving up on a reload.
# Under FEX-Emu the x86_64 Firefox cold-loads the Flow SPA in ~80-100s (measured
# 2026-06-02 — the old 25s read cookies BEFORE the page had even finished loading,
# so the slow path could never observe a rotation). We poll for the session-token
# to rotate and return as soon as it does, so this is a ceiling, not a fixed sleep.
NAV_WAIT_S = 120

# Poll cadence while waiting for the rotation / detecting an early FEX crash.
POLL_INTERVAL_S = 12

# How many times to relaunch Firefox if it segfaults early (FEX randomly SIGSEGVs
# the browser, especially on a freshly-written cookies-only profile's first launch).
RELOAD_MAX_ATTEMPTS = 3

# How long to wait for Firefox to actually exit after SIGTERM before
# escalating to SIGKILL.
KILL_GRACE_S = 4

_SESSION_TOKEN_NAME = "__Secure-next-auth.session-token"

# NextAuth /session endpoint + request shape. Mirrors
# server/src/services/flow-session.js getAccessToken EXACTLY (UA, Referer, and the
# alive/dead classification) so the broker's liveness verdict can never drift from
# the connector's ground truth. Pure stdlib (urllib) — the broker must pick up NO
# new dependency here (broker dep changes need a manual pip install under FEX; see
# CLAUDE.md deploy notes).
_SESSION_API = "https://labs.google/fx/api/auth/session"
_SESSION_HEADERS = {
    "Accept": "*/*",
    "Content-Type": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
    ),
    "Referer": "https://labs.google/fx/vi/tools/flow/",
}


def _session_token_from_cookie_string(cookie_string: str) -> str | None:
    """Extract the `__Secure-next-auth.session-token` value from a cookie string."""
    for part in cookie_string.split(";"):
        part = part.strip()
        if part.startswith(_SESSION_TOKEN_NAME + "="):
            return part[len(_SESSION_TOKEN_NAME) + 1:]
    return None


def _read_session_token(profile_dir: str) -> str | None:
    """Current `__Secure-next-auth.session-token` value in the profile, or None.

    Reuses read_profile_cookies' safe-snapshot read (copies sqlite+WAL+SHM before
    opening), so it's safe to call repeatedly while Firefox is writing. Used only to
    LOG rotation (value CHANGES when NextAuth re-grants) — rotation is NOT the success
    signal; see _session_alive.
    """
    try:
        res = read_profile_cookies(profile_dir)
    except Exception:
        return None
    if res.get("status") != "ok":
        return None
    return _session_token_from_cookie_string(res["cookies"])


def _session_alive(cookies: str) -> bool | None:
    """Validate `cookies` against NextAuth's /session — the ground-truth liveness
    check, identical to the connector's getAccessToken (flow-session.js).

    Returns:
        True  — live session (no ACCESS_TOKEN_REFRESH_NEEDED error, access_token present).
        False — dead session (the error signal / no access_token / HTTP 4xx rejection).
        None  — transient (network error / 5xx / unparseable): caller should keep
                waiting, NOT treat as a hard dead.

    WHY this exists (2026-06-04 incident): a session-token *rotation* is NOT proof of
    a successful re-auth. Under FEX the first rotation (~12s) is frequently the early
    error-embedding JWE — NextAuth ran before the page/ServiceWorker/IndexedDB settled
    and baked ACCESS_TOKEN_REFRESH_NEEDED into the new token; the SUCCESSFUL re-grant
    lands a few seconds later (~20s). reload_profile_via_firefox used to return on the
    first rotation, handing the connector a still-dead token → a false "needs re-login".
    Validating each candidate against /session and waiting for a live one fixes it.
    """
    req = urllib.request.Request(_SESSION_API, headers={**_SESSION_HEADERS, "Cookie": cookies})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        # 4xx → the session is rejected (dead); 5xx → transient (keep waiting).
        return False if 400 <= e.code < 500 else None
    except Exception:
        return None
    try:
        data = json.loads(body)
    except Exception:
        return None
    if data.get("error") == "ACCESS_TOKEN_REFRESH_NEEDED":
        return False
    if not data.get("access_token"):
        return False
    return True


async def reload_profile_via_firefox(account_id: str) -> dict:
    """Spawn Firefox at the per-account profile dir, refresh via page nav,
    extract cookies, kill Firefox. Pure-subprocess — no Playwright.

    Returns:
        {"status": "ok", "cookies": "...", "profile_dir": "..."}   on success.
        {"status": "no_profile_base"}    when BROKER_PROFILE_BASE is unset
            (legacy Mac single-account: caller should use the
            cookies-from-profile static read instead).
        {"status": "no_profile"}         when the profile dir / sqlite is
            missing (caller never logged in this account here).
        {"status": "error", "message": "..."}  on subprocess / IO error.
            Caller should fall through to a full re-login path.
    """
    if not profile_snapshot_enabled():
        return {"status": "no_profile_base"}

    profile_dir = resolve_profile_dir(account_id)
    if not Path(profile_dir).is_dir() or not (Path(profile_dir) / "cookies.sqlite").is_file():
        return {"status": "no_profile"}

    if not Path(FIREFOX_BIN).is_file():
        return {"status": "error", "message": f"firefox binary not found at {FIREFOX_BIN}"}

    # Capture the session-token BEFORE the reload purely so we can LOG when it
    # rotates. Rotation is NOT the success signal (see _session_alive): the first
    # rotation under FEX is often a dead error-JWE. We succeed only on a token that
    # /session validates ALIVE, and keep Firefox running until then.
    pre_token = await asyncio.to_thread(_read_session_token, profile_dir)

    env = {**os.environ, "DISPLAY": DISPLAY}
    log_path = f"/tmp/firefox-reload-{account_id}.log"
    last_detail = "no attempts ran"

    for attempt in range(1, RELOAD_MAX_ATTEMPTS + 1):
        # 1. Kill any stale Firefox holding this profile (prior attempt, concurrent
        #    reload, manual login, …) so we get a clean launch.
        await _pkill_profile_firefox(profile_dir)
        await asyncio.sleep(0.5)

        # 2. Spawn. Detach stdin; output → a log file so a chatty Firefox can't
        #    deadlock on a full pipe. The child dups the fd, so closing logf here
        #    (via the with-block) is fine — Firefox keeps writing to its own copy.
        try:
            with open(log_path, "wb") as logf:
                proc = await asyncio.create_subprocess_exec(
                    FIREFOX_BIN,
                    "--no-remote",
                    "--profile", profile_dir,
                    FLOW_URL,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=logf,
                    stderr=asyncio.subprocess.STDOUT,
                    env=env,
                    start_new_session=True,
                )
        except Exception as e:
            logger.exception(f"firefox spawn failed for {account_id} (attempt {attempt})")
            last_detail = f"spawn: {e}"
            continue

        logger.info(
            f"[{account_id}] firefox pid={proc.pid} reloading {FLOW_URL} at {profile_dir} "
            f"(attempt {attempt}/{RELOAD_MAX_ATTEMPTS}, wait ≤{NAV_WAIT_S}s)"
        )

        # 3. Poll until the recovered session VALIDATES ALIVE, Firefox dies, or the
        #    budget runs out. Each poll: snapshot cookies off disk (safe copy of
        #    sqlite+WAL+SHM while Firefox writes) and check /session. We return on a
        #    LIVE token — NOT on the first rotation, which under FEX is usually the
        #    early dead error-JWE (2026-06-04 incident). Firefox stays alive across
        #    polls so the successful re-grant has time to land.
        died = False
        rotation_logged = False
        alive_cookies = None
        last_cookies = None
        waited = 0
        while waited < NAV_WAIT_S:
            await asyncio.sleep(POLL_INTERVAL_S)
            waited += POLL_INTERVAL_S
            if proc.returncode is not None:
                died = True
                logger.warning(f"[{account_id}] reload firefox exited at ~{waited}s (FEX crash?)")
                break
            res = await asyncio.to_thread(read_profile_cookies, profile_dir)
            if res.get("status") != "ok":
                continue
            cookies = res["cookies"]
            last_cookies = cookies
            cur_token = _session_token_from_cookie_string(cookies)
            if not rotation_logged and pre_token and cur_token and cur_token != pre_token:
                rotation_logged = True
                logger.info(f"[{account_id}] session-token rotated at ~{waited}s — validating /session…")
            verdict = await asyncio.to_thread(_session_alive, cookies)
            if verdict is True:
                alive_cookies = cookies
                logger.info(
                    f"[{account_id}] session validated ALIVE at ~{waited}s "
                    f"(rotated={rotation_logged}) — {len(cookies)} chars"
                )
                break
            # verdict is False (still dead) or None (transient /session error): keep
            # Firefox alive and poll again. The good re-grant may not have landed yet.

        # 4a. Validated-alive token → flush, re-read the freshest on-disk copy, tear
        #     Firefox down (releases the profile lock), return success.
        if alive_cookies is not None:
            await asyncio.sleep(1)  # let Firefox flush any final Set-Cookie to sqlite
            fresh = await asyncio.to_thread(read_profile_cookies, profile_dir)
            await _terminate(proc)
            cookies = fresh["cookies"] if fresh.get("status") == "ok" else alive_cookies
            logger.info(f"[{account_id}] firefox reload OK (attempt {attempt}, validated alive)")
            return {"status": "ok", "cookies": cookies, "profile_dir": profile_dir, "validated": True}

        await _terminate(proc)

        # 4b. No live token within the budget, but Firefox ran without crashing and we
        #     have a readable set → hand it back UNVALIDATED so the connector makes the
        #     final call. It re-validates via /session and, if genuinely dead (the
        #     ~2-month boundary: Google revoked the grant, or the profile's own Google
        #     account cookies expired), surfaces the real "needs re-login". A crash
        #     (died) instead falls through to a clean relaunch.
        if last_cookies is not None and not died:
            logger.warning(
                f"[{account_id}] reload settled but /session never validated alive within "
                f"{NAV_WAIT_S}s — returning unvalidated cookies for the connector to arbitrate"
            )
            return {"status": "ok", "cookies": last_cookies, "profile_dir": profile_dir, "validated": False}

        last_detail = (
            f"attempt {attempt}: died={died} read={'ok' if last_cookies else 'none'} validated=False"
        )
        logger.warning(f"[{account_id}] reload attempt {attempt} unproductive ({last_detail}) — retrying")

    return {"status": "error", "message": f"reload exhausted after {RELOAD_MAX_ATTEMPTS} attempts: {last_detail}"}


async def _pkill_profile_firefox(profile_dir: str) -> None:
    """Kill any Firefox process whose argv mentions this profile dir.

    Best-effort: pkill returns 1 if nothing matched (no leftover Firefox);
    we squash any exit code via `|| true` in the shell invocation.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "bash", "-c",
            f"pkill -9 -f 'profile {profile_dir}' || true",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except Exception as e:
        logger.warning(f"pkill-profile-firefox {profile_dir} error (non-fatal): {e}")


async def _terminate(proc) -> None:
    """SIGTERM, wait briefly, then SIGKILL if still running. Idempotent."""
    if proc.returncode is not None:
        return
    try:
        # send to the whole session so any spawned content-process dies too.
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except Exception as e:
        logger.warning(f"SIGTERM error for pid {proc.pid}: {e}")
    try:
        await asyncio.wait_for(proc.wait(), timeout=KILL_GRACE_S)
        return
    except asyncio.TimeoutError:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except Exception as e:
        logger.warning(f"SIGKILL error for pid {proc.pid}: {e}")
    try:
        await asyncio.wait_for(proc.wait(), timeout=3.0)
    except asyncio.TimeoutError:
        logger.warning(f"firefox pid {proc.pid} did not exit after SIGKILL")
