"""Write cookies to a per-account persistent Firefox profile dir.

Recovery story (mirroring Mac MCP pattern, adapted multi-user for VPS):

  Mac
    manual-login.sh runs a standalone Firefox UI at /app/firefox-profile,
    user logs in via noVNC, profile keeps the alive JWT-A forever. Broker
    ephemeral sessions never touch this dir, so even when broker's auto-
    refresh rotates a session-token to a dead JWT-B in `.env`, the profile
    still has JWT-A on disk → token-refresh.js falls back to reading it.

  VPS (this module)
    Login is automated (Telegram 2FA via broker.startLogin), no noVNC. To
    create the same "untouched" property:
      1. After server-side loginGoogleFlow successfully completes, it calls
         broker /sessions/{id}/save-cookies-to-profile with the cookieString.
      2. This module spawns a SHORT-LIVED persistent_context Firefox at
         BROKER_PROFILE_BASE/<account_id>/, runs add_cookies, navigates
         once to flush the WAL, and closes. Disk is now seeded with JWT-A.
      3. Normal broker ops continue to use the ephemeral session pool —
         they NEVER touch the per-account profile dir. The dir stays at
         the post-login state until the next login overwrites it.
      4. cookies-from-profile endpoint reads from this dir on dead-JWT
         recovery (identical to Mac flow).

Opt-in: this module is a no-op when env var ``BROKER_PROFILE_BASE`` is
unset (so Mac docker stays unchanged — Mac uses the legacy single-profile
path at /app/firefox-profile via manual-login.sh, not this).
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from broker.cookies import parse_cookie_string

logger = logging.getLogger("broker.profile_snapshot")

PROFILE_BASE = os.environ.get("BROKER_PROFILE_BASE", "")


def is_enabled() -> bool:
    """Profile-snapshot is opt-in via BROKER_PROFILE_BASE env var."""
    return bool(PROFILE_BASE)


def profile_dir_for(account_id: str) -> str:
    """Path to the per-account persistent profile dir.

    Caller should check ``is_enabled()`` first — when BROKER_PROFILE_BASE
    is unset this returns a relative path that will fail to mkdir cleanly.
    """
    return str(Path(PROFILE_BASE) / account_id)


async def save_cookies_to_profile(account_id: str, cookies_str: str) -> dict:
    """Write `cookies_str` into the per-account persistent profile dir.

    Implementation: launches a fresh `InvisiblePlaywright` with
    ``profile_dir=`` set (Plan v5.0 persistent mode), calls
    ``context.add_cookies(...)``, navigates to about:blank to flush
    Firefox's cookie write to disk, then closes. The persistent context
    leaves a cookies.sqlite behind, ready for cookies-from-profile to
    read on recovery.

    Returns:
        {"status": "ok", "profile_dir": "...", "cookies_count": N}
        {"status": "no_profile_base"} when BROKER_PROFILE_BASE is unset
            (caller can ignore — disabled-by-default mode)
        {"status": "error", "message": "..."} on Playwright/IO error
            (best-effort — caller should log and continue, not fail login)
    """
    if not is_enabled():
        return {"status": "no_profile_base"}

    cookies = parse_cookie_string(cookies_str or "")
    if not cookies:
        return {"status": "error", "message": "no cookies parsed from input string"}

    profile_dir = profile_dir_for(account_id)
    try:
        Path(profile_dir).mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return {"status": "error", "message": f"mkdir {profile_dir}: {e}"}

    # Import inside the function so the broker process can boot even if
    # invisible_playwright is missing/broken (matches the lazy-import
    # pattern in session_pool.ensure_ready).
    try:
        from invisible_playwright.async_api import InvisiblePlaywright
    except Exception as e:
        return {"status": "error", "message": f"invisible_playwright import: {e}"}

    cm = InvisiblePlaywright(profile_dir=profile_dir)
    try:
        context = await cm.__aenter__()
    except Exception as e:
        logger.exception(f"persistent launch failed for {account_id}")
        return {"status": "error", "message": f"persistent launch: {e}"}

    try:
        # Reuse page if Firefox opened one; else make a fresh one.
        page = context.pages[0] if context.pages else await context.new_page()
        await context.add_cookies(cookies)
        # about:blank navigation is enough to make Firefox flush its
        # cookie store to sqlite — no need to hit labs.google here (we
        # don't want to trigger any NextAuth rotation in the snapshot).
        await page.goto("about:blank")
        logger.info(
            f"[{account_id}] snapshot wrote {len(cookies)} cookie entries "
            f"to {profile_dir}"
        )
    except Exception as e:
        logger.exception(f"snapshot write failed for {account_id}")
        await _safe_aexit(cm, account_id)
        return {"status": "error", "message": f"add_cookies/goto: {e}"}

    await _safe_aexit(cm, account_id)
    return {
        "status": "ok",
        "profile_dir": profile_dir,
        "cookies_count": len(cookies),
    }


async def _safe_aexit(cm, account_id: str) -> None:
    """Close the InvisiblePlaywright wrapper, swallowing errors.

    On rare hangs (observed on Mac docker — see session_pool._teardown_invisible)
    __aexit__ can stall; cap with a timeout so a stuck snapshot doesn't block
    the login response forever.
    """
    try:
        await asyncio.wait_for(cm.__aexit__(None, None, None), timeout=15.0)
    except asyncio.TimeoutError:
        logger.warning(f"[{account_id}] snapshot __aexit__ stalled >15s; abandoning")
    except Exception as e:
        logger.warning(f"[{account_id}] snapshot teardown error: {e}")
