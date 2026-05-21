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
from enum import Enum
from typing import Any, Optional

from broker.config import IDLE_TIMEOUT_S, PAGE_NAV_TIMEOUT_MS, ROTATION_THRESHOLD
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


class LoginState(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    AWAITING_2FA = "awaiting_2fa"
    COMPLETED = "completed"
    FAILED = "failed"


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
        # Login state machine (Phase 3b)
        self.login_state: LoginState = LoginState.IDLE
        self.login_screenshot_path: Optional[str] = None
        self.login_error: Optional[str] = None
        self.login_cookies: Optional[str] = None
        self._login_task: Optional[asyncio.Task] = None

    async def ensure_ready(self) -> None:
        """Lazy launch browser + initial context. Caller MUST hold self.lock.

        On any failure (e.g. _open_context goto timeout), clean up the partially
        launched InvisiblePlaywright + browser before bubbling the exception so
        subsequent retries don't leak driver/Firefox processes. Production
        observed 4 orphan playwright/driver/node processes + Firefox stuck in
        D-state pinning the broker at the systemd 1.5G memory ceiling.
        """
        if self._closed:
            raise RuntimeError(f"session {self.account_id} is closed")
        if self.ready and self.browser and self.context and self.page:
            return

        # Drop any orphan from a previous failed attempt before starting fresh.
        await self._teardown_invisible(reason="pre-launch cleanup")

        logger.info(f"[{self.account_id}] launching invisible_playwright Firefox")
        # Import inside method so module loads even before invisible_playwright is installed.
        from invisible_playwright.async_api import InvisiblePlaywright

        cm = InvisiblePlaywright()
        self._invisible_cm = cm
        try:
            self.browser = await cm.__aenter__()
            await self._open_context()
            self.ready = True
        except Exception:
            # _open_context (or __aenter__) raised. Tear down before bubbling
            # so the next retry starts from a clean slate.
            await self._teardown_invisible(reason="ensure_ready failure")
            raise

    async def _teardown_invisible(self, reason: str = "") -> None:
        """Best-effort cleanup of browser + InvisiblePlaywright wrapper. Idempotent."""
        cm = self._invisible_cm
        if cm is None and self.browser is None:
            return
        if reason:
            logger.info(f"[{self.account_id}] tearing down invisible_playwright ({reason})")
        if cm is not None:
            try:
                await cm.__aexit__(None, None, None)
            except Exception as e:
                logger.warning(f"[{self.account_id}] teardown error: {e}")
        self._invisible_cm = None
        self.browser = None
        self.context = None
        self.page = None
        self.ready = False

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
        await self.page.goto(FLOW_URL, wait_until="networkidle", timeout=PAGE_NAV_TIMEOUT_MS)

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
            await self.page.reload(wait_until="networkidle", timeout=PAGE_NAV_TIMEOUT_MS)
            await wait_for_grecaptcha(self.page)
            self.last_used = time.monotonic()
            self._restart_idle_timer()

    async def refresh_cookies(self) -> str:
        """Navigate the Flow page (via ensure_ready) and return current context cookies.

        Replaces the Chrome refreshCookies() in google-login-agent.js. Used by
        the cron harvester to detect cookie expiry and harvest the Set-Cookie
        rotations Google sends on a Flow page load.

        Raises SigninRedirectError if:
        - the navigation lands on accounts.google.com / signin (DB cookies stale),
        - OR the harvested cookies have no NextAuth session-token (unauthenticated
          landing page that doesn't redirect — observed when DB cookies cleared).

        Caller should trigger full re-login on SigninRedirectError.
        """
        async with self.lock:
            await self.ensure_ready()
            # ensure_ready navigates exactly once. A second navigate on empty
            # cookies stalls networkidle and times out (observed 2026-05-21).
            # If the session is warm and we want a forced Set-Cookie rotation,
            # use a page.reload() which is cheaper than new_context + goto.
            try:
                await self.page.reload(wait_until="networkidle", timeout=PAGE_NAV_TIMEOUT_MS)
            except Exception as e:
                # Reload timeout: continue with whatever cookies the page already has.
                logger.warning(f"[{self.account_id}] reload during refresh failed: {e}; using existing context cookies")

            cookies = await self._harvest_cookies_locked()
            # Detect "unauthenticated but URL didn't redirect" — Google sometimes
            # renders a landing page on labs.google/fx without redirecting to
            # accounts.google.com when there are no auth cookies.
            if "__Secure-next-auth.session-token=" not in cookies:
                raise SigninRedirectError(
                    f"[{self.account_id}] no NextAuth session-token in cookies — auth required"
                )

            self.last_used = time.monotonic()
            self._restart_idle_timer()
            return cookies

    async def _harvest_cookies_locked(self) -> str:
        """Read current cookies — caller must hold self.lock."""
        from broker.cookies import stringify_cookies
        raw = await self.context.cookies()
        return stringify_cookies(raw)

    async def harvest_cookies(self) -> str:
        """Read current cookies from the browser context and return DB-format string."""
        async with self.lock:
            await self.ensure_ready()
            raw = await self.context.cookies()
            return stringify_cookies(raw)

    # ─── Phase 3b: full login + 2FA state machine ──────────────────────

    async def start_login(self, email: str, password: str) -> None:
        """Kick off a background login task. Returns immediately.

        Caller polls `login_state` (via the broker /login-status endpoint) to
        know when 2FA is required or login is finished.
        """
        if self.login_state in (LoginState.RUNNING, LoginState.AWAITING_2FA):
            raise RuntimeError(f"login already in progress (state={self.login_state})")
        self.login_state = LoginState.RUNNING
        self.login_screenshot_path = None
        self.login_error = None
        self.login_cookies = None
        self._login_task = asyncio.create_task(self._run_login(email, password))

    async def _run_login(self, email: str, password: str) -> None:
        from broker.login import perform_login
        # CRITICAL: hold the Session lock for the ENTIRE login flow (including the
        # 2FA wait, up to ~120s). Without this, a concurrent refresh_cookies /
        # mint_token / flow_fetch call would acquire the lock between our setup
        # and perform_login's page.goto, then call _teardown_invisible inside
        # ensure_ready, killing the browser mid-login — observed 2026-05-21 12:49
        # as "Target page, context or browser has been closed".
        try:
            async with self.lock:
                await self._teardown_invisible(reason="login starts fresh")
                from invisible_playwright.async_api import InvisiblePlaywright
                self._invisible_cm = InvisiblePlaywright()
                self.browser = await self._invisible_cm.__aenter__()
                self.context = await self.browser.new_context()
                page = await self.context.new_page()

                async def on_2fa(path: str) -> None:
                    self.login_screenshot_path = path
                    self.login_state = LoginState.AWAITING_2FA

                cookies_str = await perform_login(page, email, password, on_2fa)

                # Promote login session as the working context for runtime ops.
                self.page = page
                self.request_count = 0
                self.ready = True
                self.cookies = parse_cookie_string(cookies_str)

            self.login_cookies = cookies_str
            self.login_state = LoginState.COMPLETED
            self._restart_idle_timer()
            logger.info(f"[{self.account_id}] login flow COMPLETED ({len(cookies_str)} cookie chars)")
        except Exception as e:
            self.login_error = str(e)
            self.login_state = LoginState.FAILED
            logger.warning(f"[{self.account_id}] login flow FAILED: {e}")
            # Failed login leaves the browser in a half-broken state — tear it
            # down so the next attempt starts clean. Acquire the lock again
            # since we released it on exception (the `async with` above exited).
            try:
                async with self.lock:
                    await self._teardown_invisible(reason="login failed cleanup")
            except Exception as cleanup_err:
                logger.warning(f"[{self.account_id}] failed-login cleanup error: {cleanup_err}")

    def login_status_snapshot(self) -> dict:
        return {
            "state": self.login_state.value,
            "screenshot_path": self.login_screenshot_path,
            "error": self.login_error,
            "cookies": self.login_cookies if self.login_state == LoginState.COMPLETED else None,
        }

    # ─── Idle timer ─────────────────────────────────────────────────────

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
        await self._teardown_invisible(reason="session close")
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
