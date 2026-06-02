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
import logging
import os
import signal
import time
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


def _read_session_token(profile_dir: str) -> str | None:
    """Current `__Secure-next-auth.session-token` value in the profile, or None.

    Reuses read_profile_cookies' safe-snapshot read (copies sqlite+WAL+SHM before
    opening), so it's safe to call repeatedly while Firefox is writing. Used to
    detect rotation (value CHANGES when NextAuth re-grants).
    """
    try:
        res = read_profile_cookies(profile_dir)
    except Exception:
        return None
    if res.get("status") != "ok":
        return None
    for part in res["cookies"].split(";"):
        part = part.strip()
        if part.startswith(_SESSION_TOKEN_NAME + "="):
            return part[len(_SESSION_TOKEN_NAME) + 1:]
    return None


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

    # Capture the session-token BEFORE the reload so we can detect rotation
    # (NextAuth mints a fresh session-token JWT when it re-grants). Polling for
    # the value to CHANGE lets us return as soon as the refresh lands instead of
    # always blocking the full NAV_WAIT_S.
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

        # 3. Poll for rotation OR early death. FEX page-load is ~80-100s and FEX
        #    randomly SIGSEGVs Firefox — a death before the window elapses means we
        #    never got a refresh, so relaunch and retry.
        rotated = False
        died = False
        waited = 0
        while waited < NAV_WAIT_S:
            await asyncio.sleep(POLL_INTERVAL_S)
            waited += POLL_INTERVAL_S
            if proc.returncode is not None:
                died = True
                logger.warning(f"[{account_id}] reload firefox exited at ~{waited}s (FEX crash?)")
                break
            cur = await asyncio.to_thread(_read_session_token, profile_dir)
            if pre_token and cur and cur != pre_token:
                rotated = True
                logger.info(f"[{account_id}] session-token rotated at ~{waited}s")
                break

        if rotated:
            await asyncio.sleep(2)  # let Firefox flush the rotated Set-Cookie to sqlite

        # 4. Snapshot cookies off disk (safe copy of sqlite+WAL+SHM), then tear
        #    Firefox down so it releases the profile lock.
        try:
            cookies_result = await asyncio.to_thread(read_profile_cookies, profile_dir)
        except Exception as e:
            logger.exception(f"profile cookie read failed for {account_id}")
            cookies_result = {"status": "error", "message": f"read_profile_cookies: {e}"}
        await _terminate(proc)

        # Success when the reload settled (rotated, OR Firefox ran the full window
        # without crashing) AND we extracted a usable cookie set. The Node caller
        # re-validates via /session and discards a still-dead session, so returning
        # an un-rotated-but-readable set (e.g. session still fresh, nothing to
        # rotate yet) is safe.
        if cookies_result.get("status") == "ok" and (rotated or not died):
            logger.info(
                f"[{account_id}] firefox reload OK (attempt {attempt}, rotated={rotated}) — "
                f"{len(cookies_result['cookies'])} chars extracted from profile"
            )
            return {
                "status": "ok",
                "cookies": cookies_result["cookies"],
                "profile_dir": profile_dir,
            }

        last_detail = (
            f"attempt {attempt}: died={died} rotated={rotated} read={cookies_result.get('status')}"
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
