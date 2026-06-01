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

# How long to let Firefox sit at Flow after launch. NextAuth's silent-OAuth
# refresh dance (load page → call /api/auth/session → if dead, signin/google
# redirect → accounts.google.com OAuth → callback → set new session-token)
# completes well within 10s; 25s gives margin for slow GCE network and the
# Xvfb-bound cold start.
NAV_WAIT_S = 25

# How long to wait for Firefox to actually exit after SIGTERM before
# escalating to SIGKILL.
KILL_GRACE_S = 4


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

    # 1. Kill any stale Firefox holding this profile (concurrent reload,
    #    leftover from a previous failed run, manual-login.sh on Mac, …).
    await _pkill_profile_firefox(profile_dir)
    await asyncio.sleep(0.5)

    # 2. Spawn. Detach stdin/stdout so we don't deadlock on Firefox's
    #    chatty console output filling the pipe buffer.
    env = {**os.environ, "DISPLAY": DISPLAY}
    log_path = f"/tmp/firefox-reload-{account_id}.log"
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
        logger.exception(f"firefox spawn failed for {account_id}")
        return {"status": "error", "message": f"firefox spawn: {e}"}

    logger.info(
        f"[{account_id}] firefox pid={proc.pid} reloading {FLOW_URL} "
        f"at {profile_dir} (wait {NAV_WAIT_S}s)"
    )

    # 3. Wait for NextAuth refresh to complete inside Firefox. We don't
    #    have direct page state visibility (no Playwright control here),
    #    so we just sleep — Firefox writes the rotated session-token to
    #    cookies.sqlite within ~5-10s after Set-Cookie lands.
    await asyncio.sleep(NAV_WAIT_S)

    # 4. Snapshot the now-rotated cookies. Use the existing reader which
    #    copies cookies.sqlite + WAL + SHM to a temp dir before opening,
    #    so we don't fight Firefox over file locks.
    try:
        cookies_result = await asyncio.to_thread(read_profile_cookies, profile_dir)
    except Exception as e:
        logger.exception(f"profile cookie read failed for {account_id}")
        cookies_result = {"status": "error", "message": f"read_profile_cookies: {e}"}

    # 5. Tear down Firefox so we don't leak the process and so the next
    #    reload-via-firefox or manual login can grab the profile lock cleanly.
    await _terminate(proc)

    if cookies_result.get("status") != "ok":
        return {"status": "error", "message": f"post-reload extraction: {cookies_result}"}

    logger.info(
        f"[{account_id}] firefox reload OK — "
        f"{len(cookies_result['cookies'])} chars extracted from profile"
    )
    return {
        "status": "ok",
        "cookies": cookies_result["cookies"],
        "profile_dir": profile_dir,
    }


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
