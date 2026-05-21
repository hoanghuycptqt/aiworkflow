"""Per-account session pool with rotation @ 15 requests and 10-min idle timeout.

Architectural invariants (from Phase 0 + memory recaptcha-incident-history):
- One Session per Google account email (keyed by sanitized accountId).
- The browser process stays alive — only context rotates at request boundaries.
- request_count counter rotates context BEFORE hitting the stochastic 20-25 cliff.
- Idle 10 min → fully close browser + remove from pool.
- Per-session asyncio.Lock serializes all operations on a given account.
"""

import asyncio
import logging
import time
from typing import Any, Optional

from broker.config import IDLE_TIMEOUT_S, ROTATION_THRESHOLD
from broker.cookies import parse_cookie_string, stringify_cookies
from broker.flow import (
    FLOW_URL,
    flow_fetch_in_page,
    is_signin_redirect,
    mint_recaptcha_token,
    wait_for_grecaptcha,
)

logger = logging.getLogger("broker.session")


class SigninRedirectError(RuntimeError):
    """Raised when the Flow page redirects to Google signin — DB cookies are stale."""


class Session:
    def __init__(self, account_id: str, cookies: list[dict]):
        self.account_id = account_id
        self.cookies = cookies
        self.browser: Optional[Any] = None
        self.context: Optional[Any] = None
        self.page: Optional[Any] = None
        self.request_count = 0
        self.last_used = time.monotonic()
        self.lock = asyncio.Lock()
        self.ready = False
        self._invisible_cm: Optional[Any] = None  # InvisiblePlaywright context manager
        self._idle_task: Optional[asyncio.Task] = None
        self._closed = False

    async def ensure_ready(self) -> None:
        """Lazy launch browser + initial context. Caller MUST hold self.lock."""
        if self._closed:
            raise RuntimeError(f"session {self.account_id} is closed")
        if self.ready and self.browser and self.context and self.page:
            return

        logger.info(f"[{self.account_id}] launching invisible_playwright Firefox")
        # Import inside method so module loads even before invisible_playwright is installed.
        from invisible_playwright.async_api import InvisiblePlaywright

        self._invisible_cm = InvisiblePlaywright()
        self.browser = await self._invisible_cm.__aenter__()
        await self._open_context()
        self.ready = True

    async def _open_context(self) -> None:
        """(Re)open BrowserContext, inject cookies, navigate, wait for grecaptcha SDK."""
        if self.context is not None:
            try:
                await self.context.close()
            except Exception as e:
                logger.warning(f"[{self.account_id}] error closing old context: {e}")

        self.context = await self.browser.new_context()
        if self.cookies:
            await self.context.add_cookies(self.cookies)
            logger.info(f"[{self.account_id}] injected {len(self.cookies)} cookies")

        self.page = await self.context.new_page()
        logger.info(f"[{self.account_id}] goto {FLOW_URL}")
        await self.page.goto(FLOW_URL, wait_until="networkidle", timeout=30000)

        if await is_signin_redirect(self.page):
            url = self.page.url
            raise SigninRedirectError(
                f"[{self.account_id}] signin redirect at {url} — DB cookies stale, "
                "refresh via CookieHarvester"
            )

        await wait_for_grecaptcha(self.page)
        self.request_count = 0
        logger.info(f"[{self.account_id}] context ready, counter reset")

    async def _rotate_if_needed(self) -> None:
        """Pre-emptively rotate context to stay below the ~20-25 stochastic cliff."""
        if self.request_count >= ROTATION_THRESHOLD:
            logger.info(
                f"[{self.account_id}] rotation threshold hit "
                f"({self.request_count}/{ROTATION_THRESHOLD}); rotating context"
            )
            await self._open_context()

    async def mint_token(self, action: str) -> tuple[str, int]:
        """Mint reCAPTCHA token. Returns (token, post_increment_request_count).

        Counter increments because every token consumes a quota slot whether or not
        it's later accepted by the backend.
        """
        async with self.lock:
            await self.ensure_ready()
            await self._rotate_if_needed()
            token = await mint_recaptcha_token(self.page, action)
            self.request_count += 1
            self.last_used = time.monotonic()
            self._restart_idle_timer()
            return token, self.request_count

    async def flow_fetch(self, url: str, bearer: str, body: dict) -> dict:
        """Browser-side API fetch — see broker.flow.flow_fetch_in_page."""
        async with self.lock:
            await self.ensure_ready()
            result = await flow_fetch_in_page(self.page, url, bearer, body)
            self.last_used = time.monotonic()
            self._restart_idle_timer()
            return result

    async def reload(self) -> None:
        """Reload the Flow page — for sticky-failure recovery on the same context.

        Note: Phase 0 showed context rotation is more reliable than reload for
        post-cliff recovery, but reload is still useful for transient SDK errors
        that don't trip the quota.
        """
        async with self.lock:
            await self.ensure_ready()
            await self.page.reload(wait_until="networkidle", timeout=30000)
            await wait_for_grecaptcha(self.page)
            self.last_used = time.monotonic()
            self._restart_idle_timer()

    async def harvest_cookies(self) -> str:
        """Read current cookies from the browser context and return DB-format string."""
        async with self.lock:
            await self.ensure_ready()
            raw = await self.context.cookies()
            return stringify_cookies(raw)

    def _restart_idle_timer(self) -> None:
        if self._idle_task and not self._idle_task.done():
            self._idle_task.cancel()
        self._idle_task = asyncio.create_task(self._idle_close_after(IDLE_TIMEOUT_S))

    async def _idle_close_after(self, seconds: float) -> None:
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError:
            return
        logger.info(f"[{self.account_id}] idle {seconds}s — closing browser")
        await self.close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._idle_task and not self._idle_task.done():
            self._idle_task.cancel()
        try:
            if self._invisible_cm is not None:
                await self._invisible_cm.__aexit__(None, None, None)
        except Exception as e:
            logger.warning(f"[{self.account_id}] error closing browser: {e}")
        self.browser = None
        self.context = None
        self.page = None
        self.ready = False
        self._invisible_cm = None
        logger.info(f"[{self.account_id}] closed")


class SessionPool:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self._global_lock = asyncio.Lock()

    async def get_or_create(self, account_id: str, cookies_str: Optional[str] = None) -> Session:
        async with self._global_lock:
            sess = self.sessions.get(account_id)
            if sess is None or sess._closed:
                cookies = parse_cookie_string(cookies_str or "")
                sess = Session(account_id, cookies)
                self.sessions[account_id] = sess
                logger.info(f"[{account_id}] new session entry created")
            elif cookies_str:
                # Refresh cookies on subsequent init calls (CookieHarvester just refreshed DB)
                sess.cookies = parse_cookie_string(cookies_str)
            return sess

    async def delete(self, account_id: str) -> None:
        async with self._global_lock:
            sess = self.sessions.pop(account_id, None)
        if sess:
            await sess.close()

    def list_active(self) -> list[dict]:
        out = []
        for acc, sess in self.sessions.items():
            if not sess._closed:
                out.append({
                    "account_id": acc,
                    "ready": sess.ready,
                    "request_count": sess.request_count,
                    "idle_s": round(time.monotonic() - sess.last_used, 1),
                })
        return out

    async def close_all(self) -> None:
        for acc in list(self.sessions.keys()):
            await self.delete(acc)
