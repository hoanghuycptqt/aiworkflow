"""Read cookies directly from a Firefox profile sqlite — recovery path when
the in-context refresh produces a dead session.

Background: ephemeral broker mode never touches /app/firefox-profile (that's
the standalone Firefox dir populated by `scripts/manual-login.sh`). When
broker's `refresh_cookies()` re-navigates Flow with cached `.env` cookies,
NextAuth may rotate `__Secure-next-auth.session-token` to a JWT that's
already-dead (race, partial OAuth refresh failure, …). Once that rotated
JWT lands in `.env` it self-perpetuates: every subsequent /session call
returns ACCESS_TOKEN_REFRESH_NEEDED.

The standalone profile, untouched by broker, still holds the original
JWT-A from the last manual-login. As long as that JWT is within its
~60-day NextAuth maxAge ceiling (and Google hasn't actually revoked the
underlying refresh_token), reading cookies from disk and re-seeding
mcp-server/.env restores a working session — no 2FA re-login needed.

This module is pure sqlite + stdlib so it can be called from any
sync/async context. It deliberately does NOT touch the Playwright
session — that's the broker session's job.
"""

from __future__ import annotations

import logging
import os
import shutil
import sqlite3
import tempfile
from pathlib import Path

from broker.profile_snapshot import PROFILE_BASE, profile_dir_for

logger = logging.getLogger("broker.profile_cookies")

# Mac single-account fallback — manual-login.sh writes here. On VPS we pass
# an account_id and use BROKER_PROFILE_BASE/<account_id> instead (see
# resolve_profile_dir).
DEFAULT_PROFILE_DIR = "/app/firefox-profile"


def resolve_profile_dir(account_id: str | None) -> str:
    """Pick the profile dir to read cookies from.

    - If BROKER_PROFILE_BASE is set AND an account_id is provided, use the
      per-account path (VPS multi-user mode, populated by login-time
      profile_snapshot.save_cookies_to_profile).
    - Otherwise fall back to the single shared Mac profile dir
      (populated by python-broker/scripts/manual-login.sh).
    """
    if PROFILE_BASE and account_id:
        return profile_dir_for(account_id)
    return DEFAULT_PROFILE_DIR

# Same filter manual-login.sh uses (scripts/manual-login.sh:76-78). Matching
# means cookies extracted here are byte-equivalent to a manual re-login.
_HOSTS_FILTER = (
    "host LIKE '%labs.google%' "
    "OR host LIKE '%.google.com%' "
    "OR host = 'accounts.google.com' "
    "OR host = 'labs.google'"
)

_REQUIRED_COOKIE = "__Secure-next-auth.session-token"


def read_profile_cookies(profile_dir: str = DEFAULT_PROFILE_DIR) -> dict:
    """Read cookies from `profile_dir`/cookies.sqlite (+ -wal/-shm if present).

    Snapshots all three sqlite files to a temp dir before opening, so this
    is safe to call while a standalone Firefox is concurrently writing to
    the same profile (the WAL contains uncommitted writes; sqlite needs
    the matching `.sqlite-wal` to reconstruct them).

    Returns:
        {"status": "ok", "cookies": "name=val; …"} on success.
        {"status": "no_profile"} when profile dir or cookies.sqlite missing
            (typical when login-time save_cookies_to_profile never ran
            for this account, or on VPS where BROKER_PROFILE_BASE/<id>
            doesn't exist yet).
        {"status": "no_session_token"} when sqlite has no
            `__Secure-next-auth.session-token` row (login never completed
            in this profile).
    """
    profile = Path(profile_dir)
    sqlite_path = profile / "cookies.sqlite"
    if not profile.is_dir() or not sqlite_path.is_file():
        logger.info(f"profile cookies: no profile at {profile_dir}")
        return {"status": "no_profile"}

    with tempfile.TemporaryDirectory() as tmpdir:
        snap = Path(tmpdir) / "cookies.sqlite"
        shutil.copy2(sqlite_path, snap)
        # Copy WAL + SHM if present so sqlite can reconstruct any
        # uncommitted writes from a live Firefox session.
        for suffix in ("-wal", "-shm"):
            src = profile / f"cookies.sqlite{suffix}"
            if src.is_file():
                shutil.copy2(src, Path(tmpdir) / f"cookies.sqlite{suffix}")

        con = sqlite3.connect(str(snap))
        try:
            cur = con.cursor()
            cur.execute(
                f"SELECT name, value, host FROM moz_cookies WHERE {_HOSTS_FILTER} ORDER BY id"
            )
            rows = cur.fetchall()
        finally:
            con.close()

    # Dedup by name, preferring the `.labs.google` host over a `.google.com`
    # shadow — mirrors cookies.stringify_cookies. A standalone Firefox profile
    # (slow-path reload) can hold the session-token under BOTH domains; NextAuth
    # rotation writes the fresh value scoped to labs.google, leaving the
    # .google.com copy stale. Emitting the stale one (it sorts first by id)
    # froze `expires` in the past — the 2026-05-24 02:00Z 10s-loop incident.
    by_name: dict[str, str] = {}
    labs_seen: set[str] = set()
    for name, value, host in rows:
        if not name:
            continue
        is_labs = (host or "").lower().endswith("labs.google")
        if name not in by_name or (is_labs and name not in labs_seen):
            by_name[name] = value
            if is_labs:
                labs_seen.add(name)

    if _REQUIRED_COOKIE not in by_name:
        logger.info(
            f"profile cookies: {_REQUIRED_COOKIE} missing — login incomplete?"
        )
        return {"status": "no_session_token"}

    cookie_string = "; ".join(f"{name}={value}" for name, value in by_name.items())
    logger.info(
        f"profile cookies: extracted {len(by_name)} cookies "
        f"({len(rows)} rows, {len(cookie_string)} chars)"
    )
    return {"status": "ok", "cookies": cookie_string}
