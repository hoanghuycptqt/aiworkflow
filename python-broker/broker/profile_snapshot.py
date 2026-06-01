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
      2. This module writes the cookies DIRECTLY into a minimal moz_cookies
         sqlite at BROKER_PROFILE_BASE/<account_id>/cookies.sqlite — no
         Firefox launch involved (launch_persistent_context fails in both
         Docker and systemd-on-VPS due to user-namespace sandbox restrictions).
         Schema is a subset of Firefox's real moz_cookies, just enough for
         the cookies-from-profile reader's SELECT.
      3. Normal broker ops continue to use the ephemeral session pool —
         they NEVER touch the per-account profile dir. The dir stays at
         the post-login state until the next login overwrites it.
      4. cookies-from-profile endpoint reads this sqlite on dead-JWT
         recovery (identical to Mac flow).

Opt-in: this module is a no-op when env var ``BROKER_PROFILE_BASE`` is
unset (so Mac docker stays unchanged — Mac uses the legacy single-profile
path at /app/firefox-profile via manual-login.sh, not this).
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import time
from pathlib import Path

from broker.config import BROWSER_ENGINE
from broker.cookies import parse_cookie_string

logger = logging.getLogger("broker.profile_snapshot")

PROFILE_BASE = os.environ.get("BROKER_PROFILE_BASE", "")

# The moz_cookies schema MUST match the bundled Firefox of the active browser
# engine byte-for-byte. If it doesn't, Firefox detects a schema mismatch on the
# next launch, DROPS our snapshot, and recreates the table with its native
# schema — wiping the rotated session-token (observed 2026-05-25 VPS test with
# the minimal-columns version). The two engines bundle different Firefoxes and
# their moz_cookies schemas differ in the trailing columns:
#
#   invisible_playwright → Firefox 150: ...sameSite, schemeMap,
#       isPartitionedAttributeSet, updateTime   (NO rawSameSite)
#   camoufox 0.4.11       → Firefox 135: ...sameSite, rawSameSite, schemeMap,
#       isPartitionedAttributeSet               (NO updateTime)
#
# Verified by dumping `.schema moz_cookies` from a freshly-launched profile of
# each engine. If the engine or its bundled Firefox version changes, re-dump and
# update here.
_FF150_DDL = """
CREATE TABLE IF NOT EXISTS moz_cookies (
    id INTEGER PRIMARY KEY,
    originAttributes TEXT NOT NULL DEFAULT '',
    name TEXT,
    value TEXT,
    host TEXT,
    path TEXT,
    expiry INTEGER,
    lastAccessed INTEGER,
    creationTime INTEGER,
    isSecure INTEGER,
    isHttpOnly INTEGER,
    inBrowserElement INTEGER DEFAULT 0,
    sameSite INTEGER DEFAULT 0,
    schemeMap INTEGER DEFAULT 0,
    isPartitionedAttributeSet INTEGER DEFAULT 0,
    updateTime INTEGER,
    CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes)
)
"""

_FF135_DDL = """
CREATE TABLE IF NOT EXISTS moz_cookies (
    id INTEGER PRIMARY KEY,
    originAttributes TEXT NOT NULL DEFAULT '',
    name TEXT,
    value TEXT,
    host TEXT,
    path TEXT,
    expiry INTEGER,
    lastAccessed INTEGER,
    creationTime INTEGER,
    isSecure INTEGER,
    isHttpOnly INTEGER,
    inBrowserElement INTEGER DEFAULT 0,
    sameSite INTEGER DEFAULT 0,
    rawSameSite INTEGER DEFAULT 0,
    schemeMap INTEGER DEFAULT 0,
    isPartitionedAttributeSet INTEGER DEFAULT 0,
    CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes)
)
"""

_IS_CAMOUFOX = BROWSER_ENGINE == "camoufox"
_MOZ_COOKIES_DDL = _FF135_DDL if _IS_CAMOUFOX else _FF150_DDL


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
    """Write `cookies_str` into the per-account profile dir's cookies.sqlite.

    Implementation: writes a minimal moz_cookies sqlite directly with
    Python's stdlib sqlite3 — no Firefox launch involved. We tried using
    InvisiblePlaywright(profile_dir=...) first, but launch_persistent_context
    fails on both Docker (CLONE_NEWUSER blocked) AND systemd VPS
    (CLONE_NEWPID EPERM) — see Dockerfile / docker-compose comments for the
    Docker case, and VPS smoke test 2026-05-24 for the systemd case.

    The direct sqlite approach is also ~1000x faster (~10ms vs ~10s
    Firefox cold-launch) and avoids any risk of NextAuth rotation during
    the snapshot.

    Returns:
        {"status": "ok", "profile_dir": "...", "cookies_count": N}
        {"status": "no_profile_base"} when BROKER_PROFILE_BASE is unset
            (caller can ignore — disabled-by-default mode)
        {"status": "error", "message": "..."} on parse/IO error
            (best-effort — caller should log and continue, not fail login)
    """
    if not is_enabled():
        return {"status": "no_profile_base"}

    cookies = parse_cookie_string(cookies_str or "")
    if not cookies:
        return {"status": "error", "message": "no cookies parsed from input string"}

    profile_dir = profile_dir_for(account_id)
    # sqlite I/O on a thread to avoid blocking the broker's event loop.
    try:
        result = await asyncio.to_thread(_write_cookies_sqlite, profile_dir, cookies)
    except Exception as e:
        logger.exception(f"snapshot write failed for {account_id}")
        return {"status": "error", "message": f"write_cookies_sqlite: {e}"}

    logger.info(
        f"[{account_id}] snapshot wrote {result['cookies_count']} cookie rows "
        f"to {profile_dir}/cookies.sqlite"
    )
    return {
        "status": "ok",
        "profile_dir": profile_dir,
        "cookies_count": result["cookies_count"],
    }


def _write_cookies_sqlite(profile_dir: str, cookies: list[dict]) -> dict:
    """Synchronous sqlite write — called via asyncio.to_thread.

    Rewrites cookies.sqlite from scratch each call: drops the existing
    moz_cookies (if any) and re-inserts. Snapshot semantics — caller
    overwrites a stale snapshot, doesn't merge.
    """
    Path(profile_dir).mkdir(parents=True, exist_ok=True)
    sqlite_path = Path(profile_dir) / "cookies.sqlite"

    # Wipe any leftover -wal/-shm from a previous Firefox session so they
    # don't confuse our fresh write (we use journal_mode=DELETE here for
    # a single-file artifact).
    for suffix in ("-wal", "-shm"):
        try:
            (Path(profile_dir) / f"cookies.sqlite{suffix}").unlink()
        except FileNotFoundError:
            pass
        except Exception as e:
            logger.warning(f"could not remove {sqlite_path}{suffix}: {e}")

    con = sqlite3.connect(str(sqlite_path))
    try:
        cur = con.cursor()
        # Use WAL mode — Firefox itself uses WAL, and switching DELETE→WAL
        # on first Firefox launch was the trigger for "schema mismatch,
        # recreate" behavior in the 2026-05-25 incident. Matching Firefox
        # up front avoids the wipe.
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute(_MOZ_COOKIES_DDL)
        cur.execute("DELETE FROM moz_cookies")
        now_us = int(time.time() * 1_000_000)
        expiry = int(time.time()) + 60 * 86400  # 60 days, matches NextAuth maxAge
        # Columns we set explicitly; every other column (originAttributes,
        # inBrowserElement, sameSite, rawSameSite/schemeMap, …) takes its DDL
        # default. FF150 has an extra trailing `updateTime` column that FF135
        # lacks — include it only for the invisible_playwright (FF150) engine,
        # else the INSERT references a non-existent column on FF135 (camoufox).
        base = [
            (
                c.get("name", ""),
                c.get("value", ""),
                c.get("domain", ""),
                c.get("path", "/"),
                expiry,
                now_us,
                now_us,
                1 if c.get("secure", True) else 0,
                1 if c.get("httpOnly", False) else 0,
            )
            for c in cookies
        ]
        if _IS_CAMOUFOX:
            cur.executemany(
                "INSERT OR REPLACE INTO moz_cookies "
                "(name, value, host, path, expiry, lastAccessed, creationTime, isSecure, isHttpOnly) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                base,
            )
        else:
            # FF150: append updateTime (Firefox bumps this on each cookie write).
            rows = [row + (now_us,) for row in base]
            cur.executemany(
                "INSERT OR REPLACE INTO moz_cookies "
                "(name, value, host, path, expiry, lastAccessed, creationTime, isSecure, isHttpOnly, updateTime) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
        con.commit()
        return {"cookies_count": len(base)}
    finally:
        con.close()
