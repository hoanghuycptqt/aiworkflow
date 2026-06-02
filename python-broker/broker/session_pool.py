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
import os
import time
from enum import Enum
from typing import Any, Optional

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from broker.config import (
    BROWSER_ENGINE,
    IDLE_TIMEOUT_S,
    PAGE_NAV_TIMEOUT_MS,
    ROTATION_THRESHOLD,
)
from broker.cookies import parse_cookie_string, stringify_cookies
from broker.flow import (
    FLOW_URL,
    flow_fetch_in_page,
    is_signin_redirect,
    mint_recaptcha_token,
    wait_for_grecaptcha,
)

logger = logging.getLogger("broker.session")

# Plan v5.0: when BROKER_PROFILE_DIR is set, broker uses persistent Firefox
# profile (cookies/extensions/cache persist across restarts in a Docker volume).
# Default empty → existing ephemeral context + cookie injection (VPS preserves).
PROFILE_DIR = os.environ.get("BROKER_PROFILE_DIR", "")
USE_PERSISTENT_PROFILE = bool(PROFILE_DIR)


def _make_browser_cm(persistent: bool) -> Any:
    """Construct the stealth-Firefox async context manager for the active engine.

    Both engines honour the same contract, so all downstream session logic
    (new_context / add_cookies / goto / mint) is identical regardless of engine:
      - ephemeral  → __aenter__() returns a Browser (we open the context manually)
      - persistent → __aenter__() returns a BrowserContext (cookies live in the
                     profile dir on disk)

    camoufox (VPS, aarch64): launched headful with an EXTERNAL Xvfb (DISPLAY=:99
    from the systemd unit). We deliberately avoid headless="virtual" — that makes
    Camoufox spawn its own 1×1 Xvfb (daijro/camoufox#458) which is too small to
    render Flow / the reCAPTCHA challenge reliably.

    invisible_playwright (Mac/legacy, x86_64): unchanged behaviour.

    Imported lazily so the module loads even when only one engine is installed.
    """
    if BROWSER_ENGINE == "camoufox":
        from camoufox.async_api import AsyncCamoufox

        if persistent:
            return AsyncCamoufox(
                headless=False, persistent_context=True, user_data_dir=PROFILE_DIR
            )
        return AsyncCamoufox(headless=False)

    from invisible_playwright.async_api import InvisiblePlaywright

    return InvisiblePlaywright(profile_dir=PROFILE_DIR) if persistent else InvisiblePlaywright()


def _make_login_cm(profile_dir: str) -> Any:
    """Persistent-context CM at an EXPLICIT per-account profile dir.

    Unlike _make_browser_cm(persistent=True) — which uses the GLOBAL
    BROKER_PROFILE_DIR — this targets a specific dir (BROKER_PROFILE_BASE/<account>)
    so the VPS Telegram login writes Firefox's real, coherent login state (cookies +
    IndexedDB + ...) into the SAME dir reload-via-firefox later launches at. That
    profile-dir match is what lets the ~20h reload self-heal without a re-login.
    __aenter__() returns a BrowserContext for both engines (cookies live on disk).
    launch_persistent_context verified working under FEX-Emu 2026-06-02.
    """
    if BROWSER_ENGINE == "camoufox":
        from camoufox.async_api import AsyncCamoufox

        return AsyncCamoufox(headless=False, persistent_context=True, user_data_dir=profile_dir)
    from invisible_playwright.async_api import InvisiblePlaywright

    return InvisiblePlaywright(profile_dir=profile_dir)


def _wipe_profile_dir(path: str) -> None:
    """Clean-slate a per-account persistent profile dir before a fresh login.

    A crashed/partial prior login can leave a half-written session-token in the
    dir, which would make perform_login's `_is_already_signed_in` short-circuit and
    return stale cookies. Wiping guarantees the persistent login is a real fresh
    login. Safe: the dir only ever holds login/reload state, never ops data.
    """
    import shutil

    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)


# launch_persistent_context is flaky under FEX-Emu: it frequently HANGS at
# __aenter__ (Firefox launches, Juggler never binds) and a leftover hung Firefox
# poisons the next attempt. Empirically it binds on the x11vnc-attached display
# (:100) — NOT the bare headful :99 — and recovers within ~2 tries IF every leftover
# Firefox is SIGKILLed between attempts. So the persistent Telegram login runs on
# BROKER_LOGIN_DISPLAY with retry + aggressive cleanup + a page-health check.
# Characterized 2026-06-02: :99 → 4-6/6 hang; :100 → reliably OK by attempt 2.
LOGIN_DISPLAY = os.environ.get("BROKER_LOGIN_DISPLAY", ":100")
# A hung launch is a TRUE hang (Firefox up, Juggler never binds) — it won't recover,
# so fail it fast and retry. Real launches bind in ~18s, so 45s is ample headroom.
PERSIST_LAUNCH_TIMEOUT_S = 45
PERSIST_LAUNCH_MAX_ATTEMPTS = 5


async def _kill_all_invisible_firefox() -> None:
    """SIGKILL every invisible-playwright Firefox so a hung/leftover process can't
    poison the next launch_persistent_context (the FEX Juggler cascade). Safe during
    a login: the login holds the Session lock, so no ops browser is running."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "bash", "-c", "pkill -9 -f 'firefox-7/firefox' 2>/dev/null || true",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except Exception as e:
        logger.warning(f"kill-all-firefox error (non-fatal): {e}")


async def _page_responsive(page) -> bool:
    """True if the page's Juggler binding works. A broken persistent context throws
    'browsingContext is undefined' / 'loadURI' → not responsive. Transient errors
    (mid Firefox startup-nav) are re-probed. Non-navigating (evaluate) so it doesn't
    race Firefox's own startup navigation the way a goto('about:blank') does."""
    for _ in range(4):
        try:
            await asyncio.wait_for(page.evaluate("1+1"), timeout=8.0)
            return True
        except Exception as e:
            if any(m in str(e) for m in ("browsingContext", "loadURI", "Target", "closed")):
                return False
            await asyncio.sleep(1.5)
    return False


def _is_dead_browser_error(e: Exception) -> bool:
    """True when the error means the browser/driver connection is gone (not a
    page-level glitch). These are unrecoverable in-place — the only fix is a
    full teardown + relaunch. Seen under FEX emulation when the playwright node
    driver drops its pipe mid-session ("Connection closed while reading from the
    driver" / "WriteUnixTransport closed ... handler is closed"), and on abrupt
    Firefox death ("Target page, context or browser has been closed").
    """
    s = str(e)
    return any(m in s for m in (
        "Connection closed while reading from the driver",
        "handler is closed",
        "Transport closed",
        "Target page, context or browser has been closed",
        "Target closed",
        "Browser closed",
        "has been closed",
    ))


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
        self._login_page: Optional[Any] = None  # holds page during _run_login for failure debug
        self._context_opened_at: float = 0.0  # monotonic time of last _open_context completion

    def _is_alive(self) -> bool:
        """Best-effort liveness of the live browser/driver. Returns False when the
        driver pipe dropped or the page died, so ensure_ready relaunches instead
        of handing back a dead page (the FEX node-driver-drop failure mode)."""
        try:
            if self.browser is not None:
                return self.browser.is_connected()  # ephemeral: Browser handle
            # persistent: no Browser handle — fall back to page liveness
            return self.page is not None and not self.page.is_closed()
        except Exception:
            return False

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
        if self.ready and self.browser and self.context and self.page and self._is_alive():
            return

        # Drop any orphan from a previous failed attempt before starting fresh.
        await self._teardown_invisible(reason="pre-launch cleanup")

        mode = "persistent" if USE_PERSISTENT_PROFILE else "ephemeral"
        logger.info(f"[{self.account_id}] launching {BROWSER_ENGINE} Firefox ({mode} mode)")

        # Persistent mode → wrapper returns BrowserContext directly (no separate
        # Browser handle). Ephemeral mode → returns Browser; we create the
        # ephemeral context manually in _open_context. See _make_browser_cm.
        cm = _make_browser_cm(USE_PERSISTENT_PROFILE)
        self._invisible_cm = cm
        try:
            result = await cm.__aenter__()
            if USE_PERSISTENT_PROFILE:
                # result is BrowserContext (persistent — cookies in profile dir).
                # No separate Browser handle in this mode.
                self.context = result
                self.browser = None
                # Reuse existing page if wrapper opened one, else create new.
                self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()
                await self._navigate_and_check_signin()
            else:
                # Ephemeral mode (existing flow). result is Browser.
                self.browser = result
                await self._open_context()
            self.ready = True
        except Exception:
            # _open_context (or __aenter__) raised. Tear down before bubbling
            # so the next retry starts from a clean slate.
            await self._teardown_invisible(reason="ensure_ready failure")
            raise

    async def _navigate_and_check_signin(self) -> None:
        """Goto FLOW_URL, raise SigninRedirectError if signin needed, wait grecaptcha.

        Shared between persistent + ephemeral _open_context. The signin redirect
        message differs by mode: in persistent mode, instruct user to login via
        noVNC; in ephemeral mode, refer to CookieHarvester (VPS workflow).
        """
        logger.info(f"[{self.account_id}] goto {FLOW_URL}")
        await self.page.goto(FLOW_URL, wait_until="load", timeout=PAGE_NAV_TIMEOUT_MS)
        if await is_signin_redirect(self.page):
            url = self.page.url
            if USE_PERSISTENT_PROFILE:
                raise SigninRedirectError(
                    f"[{self.account_id}] signin redirect at {url} — open "
                    "http://localhost:6080/vnc.html in browser and complete Google login "
                    "manually via Firefox UI. Profile persists after login (1-time setup, "
                    "~60 days until next manual login)."
                )
            raise SigninRedirectError(
                f"[{self.account_id}] signin redirect at {url} — DB cookies stale, "
                "refresh via CookieHarvester"
            )
        await wait_for_grecaptcha(self.page)
        self.request_count = 0
        self._context_opened_at = time.monotonic()
        logger.info(f"[{self.account_id}] context ready, counter reset")

    async def _teardown_invisible(self, reason: str = "") -> None:
        """Best-effort cleanup of browser + InvisiblePlaywright wrapper. Idempotent.

        If `__aexit__` hangs (observed 2026-05-21 16:15 production: Firefox
        stuck after Page.goto timeout caused __aexit__ to wait forever, holding
        Session.lock and leaking driver+Firefox processes until systemd memory
        ceiling), we abandon the await after 10s and force-kill the driver
        subprocess group. The OS reaps Firefox children.
        """
        cm = self._invisible_cm
        if cm is None and self.browser is None:
            return
        if reason:
            logger.info(f"[{self.account_id}] tearing down invisible_playwright ({reason})")
        if cm is not None:
            try:
                await asyncio.wait_for(cm.__aexit__(None, None, None), timeout=10.0)
            except asyncio.TimeoutError:
                logger.warning(
                    f"[{self.account_id}] teardown __aexit__ hung >10s — "
                    "force-killing driver subprocess"
                )
                await self._force_kill_browser_processes()
            except Exception as e:
                logger.warning(f"[{self.account_id}] teardown error: {e}")
        self._invisible_cm = None
        self.browser = None
        self.context = None
        self.page = None
        self.ready = False

    async def _force_kill_browser_processes(self) -> None:
        """SIGKILL any orphan playwright/driver/node + Firefox processes.

        Last resort when __aexit__ hangs. Uses pkill on patterns specific to
        invisible_playwright's binary layout. The driver subprocess is the
        parent of Firefox; killing it makes the kernel reap the browser.
        """
        import shutil
        if not shutil.which("pkill"):
            logger.warning(f"[{self.account_id}] pkill not available; cannot force-kill")
            return
        # Both engines drive Firefox via the playwright node driver and create
        # /tmp/playwright_firefoxdev_profile-* temp dirs, so those patterns match
        # either engine. The browser-process basename differs: camoufox launches
        # "camoufox-bin" (master + content procs, -appDir .cache/camoufox);
        # invisible_playwright launches firefox out of its firefox-4/-7 cache dir.
        patterns = [
            "playwright/driver/node",
            "playwright_firefoxdev_profile",
            "camoufox-bin",        # camoufox (VPS, aarch64)
            ".cache/camoufox",     # camoufox content procs (-appDir)
            "firefox-4/firefox",   # invisible_playwright (Mac/legacy)
            "firefox-7/firefox",   # invisible_playwright (newer cache tag)
        ]
        proc = await asyncio.create_subprocess_exec(
            "pkill", "-9", "-f", "|".join(patterns).replace("|", "\\|"),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        # pkill returns 0 if it killed something, 1 if nothing matched. Either is fine.
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            proc.kill()
        # Fallback: pkill each pattern individually (in case the OR pattern didn't work)
        for pat in patterns:
            try:
                p = await asyncio.create_subprocess_exec(
                    "pkill", "-9", "-f", pat,
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(p.wait(), timeout=3.0)
            except Exception:
                pass
        logger.info(f"[{self.account_id}] force-killed orphan browser processes")

    async def _open_context(self) -> None:
        """(Re)open BrowserContext, inject cookies, navigate, wait for grecaptcha SDK.

        Ephemeral mode only. Persistent mode (BROKER_PROFILE_DIR set) uses
        a different rotation strategy — see `_rotate_persistent`.
        """
        if USE_PERSISTENT_PROFILE:
            raise RuntimeError(
                "_open_context called in persistent mode — use _rotate_persistent instead. "
                "This is a code path bug; please report."
            )
        if self.context is not None:
            try:
                await self.context.close()
            except Exception as e:
                logger.warning(f"[{self.account_id}] error closing old context: {e}")

        # bypass_csp=True is REQUIRED — labs.google's strict CSP would otherwise
        # block our page.evaluate() / wait_for_function() calls with "call to
        # eval() blocked by CSP" (observed 2026-05-21 13:21 on login flow).
        self.context = await self.browser.new_context(bypass_csp=True)
        if self.cookies:
            await self.context.add_cookies(self.cookies)
            logger.info(f"[{self.account_id}] injected {len(self.cookies)} cookies")

        self.page = await self.context.new_page()
        await self._navigate_and_check_signin()

    async def _rotate_persistent(self) -> None:
        """Persistent-mode rotation: full re-launch of InvisiblePlaywright wrapper.

        Cannot do `browser.new_context()` because persistent mode has no separate
        Browser handle — the wrapper returns BrowserContext directly. To rotate,
        we teardown + re-enter the wrapper, which reads the same profile dir from
        disk. Cookies persist on disk (in user_data_dir), only in-memory context
        state is fresh.

        Cost: ~12-15s (vs ~2s ephemeral rotation) since Firefox process restarts.
        Mitigated by disabling idle close (`BROKER_IDLE_TIMEOUT_S=0`) — rotation
        only happens at the quota cliff, never at idle.
        """
        logger.info(f"[{self.account_id}] persistent rotation: tearing down + relaunching")
        await self._teardown_invisible(reason="persistent rotation")
        # ready=False so ensure_ready re-enters the full launch sequence.
        self.ready = False
        await self.ensure_ready()

    async def _rotate_if_needed(self) -> None:
        """Pre-emptively rotate context to stay below the ~20-25 stochastic cliff."""
        if self.request_count >= ROTATION_THRESHOLD:
            logger.info(
                f"[{self.account_id}] rotation threshold hit "
                f"({self.request_count}/{ROTATION_THRESHOLD}); rotating context"
            )
            if USE_PERSISTENT_PROFILE:
                await self._rotate_persistent()
            else:
                await self._open_context()

    async def _context_has_session_token(self) -> bool:
        """True if the live browser context still holds a NextAuth session-token.

        Used by _mint_with_settle to tell a recoverable SDK glitch (reload fixes
        it) from a dead session (reload won't). Fail-open on a cookie-read hiccup
        — a transient read error shouldn't block legitimate reload recovery.
        """
        try:
            cookies = await self.context.cookies()
        except Exception:
            return True
        return any(c.get("name") == "__Secure-next-auth.session-token" for c in cookies)

    async def _mint_with_settle(self, action: str) -> str:
        """Mint a token, recovering IN-PLACE when grecaptcha is missing.

        Root cause (2026-05-29): the grecaptcha Enterprise SDK can be absent on
        the page at mint time even though _navigate_and_check_signin marked the
        session ready. Two observed triggers, same symptom:

          1. Fresh launch: the Flow SPA does a late client-side redirect (e.g.
             locale /fx/tools/flow → /fx/vi/tools/flow) a few seconds AFTER
             `load` fires — after the initial wait_for_grecaptcha passed. A mint
             racing it hits "Execution context was destroyed" / "grecaptcha is
             not defined".
          2. Warm reuse: on a session reused after some idle, the SDK is gone and
             wait_for_grecaptcha times out (15s) on a blank/stale document.

        ensure_ready() short-circuits on a ready session (`if self.ready ...:
        return`), so it never re-asserts grecaptcha. Previously both triggers
        bubbled up and forced the Node side to broker.close() + relaunch the whole
        ephemeral Firefox — ~10s of cold launch per recovery. (Note: this broker
        runs ephemeral, BROKER_PROFILE_DIR="" — every ensureSession is a fresh
        injected context, so the cost here is latency + Firefox teardown, NOT the
        persistent-profile trust-score loss that motivates the VPS Chrome path's
        "never close on retry" rule. The in-place reload still follows the spirit
        of memory recaptcha-page-reload-recovery: reload to recover a sticky SDK,
        don't tear the browser down.) Here we reload the page in place to re-init
        grecaptcha and retry on the same context.

        Signin is re-checked each attempt: a redirect to accounts.google.com that
        lands AFTER the initial navigate (stale cookies surfacing late) was
        previously misreported as an SDK error. Raising SigninRedirectError routes
        it to a 409 → genuine cookie refresh on the Node side.
        """
        last_err: Optional[Exception] = None
        for attempt in range(3):
            if await is_signin_redirect(self.page):
                raise SigninRedirectError(
                    f"[{self.account_id}] post-load signin redirect at {self.page.url} "
                    "— cookies stale, refresh required"
                )
            try:
                # wait_for_grecaptcha polls, so it blocks through an in-flight
                # redirect until the SDK reloads on the destination page.
                await wait_for_grecaptcha(self.page)
                return await mint_recaptcha_token(self.page, action)
            except PlaywrightError as e:
                last_err = e
                detail = str(e)
                # All three mean "SDK not callable on the current document" — a
                # page.reload() re-initialises grecaptcha without dropping the
                # warm browser/context (reload, never close — see docstring).
                recoverable = (
                    isinstance(e, PlaywrightTimeoutError)
                    or "Execution context was destroyed" in detail
                    or "grecaptcha is not defined" in detail
                )
                if attempt < 2 and recoverable:
                    # Fast-escalate a genuinely-dead session: if the live context
                    # has lost its NextAuth session-token the page is
                    # unauthenticated, so no number of reloads brings grecaptcha
                    # back — they'd just burn ~45s before bubbling. Surface a
                    # signin redirect (→ 409) so the Node side runs real cookie
                    # recovery now (mirrors refresh_cookies' session-token guard).
                    if not await self._context_has_session_token():
                        raise SigninRedirectError(
                            f"[{self.account_id}] grecaptcha unavailable and no "
                            "NextAuth session-token in context — auth required "
                            "(skipping reload retries)"
                        ) from e
                    logger.warning(
                        f"[{self.account_id}] grecaptcha unavailable at mint "
                        f"({detail.splitlines()[0]}); reloading page in place "
                        f"(attempt {attempt + 1}/3)"
                    )
                    try:
                        await self.page.reload(
                            wait_until="load", timeout=PAGE_NAV_TIMEOUT_MS
                        )
                    except Exception:
                        pass  # best-effort; wait_for_grecaptcha on retry is the real gate
                    await asyncio.sleep(0.3)
                    continue
                raise
        # range(3) always returns or raises above; this is defensive only.
        raise last_err  # type: ignore[misc]

    async def mint_token(self, action: str) -> tuple[str, int]:
        """Mint reCAPTCHA token. Returns (token, post_increment_request_count).

        Counter increments because every token consumes a quota slot whether or not
        it's later accepted by the backend.
        """
        async with self.lock:
            for attempt in range(2):
                try:
                    await self.ensure_ready()
                    await self._rotate_if_needed()
                    token = await self._mint_with_settle(action)
                    self.request_count += 1
                    self.last_used = time.monotonic()
                    self._restart_idle_timer()
                    return token, self.request_count
                except Exception as e:
                    if attempt == 0 and _is_dead_browser_error(e):
                        logger.warning(
                            f"[{self.account_id}] browser/driver died during mint "
                            f"({str(e).splitlines()[0]}); tearing down + relaunching"
                        )
                        await self._teardown_invisible(reason="dead-browser recovery (mint)")
                        self.ready = False
                        continue
                    raise
            raise RuntimeError("unreachable")  # loop returns or raises above

    async def flow_fetch(self, url: str, bearer: str, body: dict) -> dict:
        """Browser-side API fetch — see broker.flow.flow_fetch_in_page.

        Self-heals a dead browser/driver (FEX node-driver pipe drop, abrupt
        Firefox death): tears down + relaunches + retries once. The retry pays a
        cold-launch (~30s under FEX) but the alternative is every subsequent call
        failing on a stale closed page until idle-close (the 2026-06-01 video bug).
        """
        async with self.lock:
            for attempt in range(2):
                try:
                    await self.ensure_ready()
                    result = await flow_fetch_in_page(self.page, url, bearer, body)
                    self.last_used = time.monotonic()
                    self._restart_idle_timer()
                    return result
                except Exception as e:
                    if attempt == 0 and _is_dead_browser_error(e):
                        logger.warning(
                            f"[{self.account_id}] browser/driver died during flow_fetch "
                            f"({str(e).splitlines()[0]}); tearing down + relaunching"
                        )
                        await self._teardown_invisible(reason="dead-browser recovery (flow_fetch)")
                        self.ready = False
                        continue
                    raise
            raise RuntimeError("unreachable")  # loop returns or raises above

    async def reload(self) -> None:
        """Reload the Flow page — for sticky-failure recovery on the same context.

        Note: Phase 0 showed context rotation is more reliable than reload for
        post-cliff recovery, but reload is still useful for transient SDK errors
        that don't trip the quota.
        """
        async with self.lock:
            await self.ensure_ready()
            # See _open_context comment: networkidle hangs on Google domains.
            await self.page.reload(wait_until="load", timeout=PAGE_NAV_TIMEOUT_MS)
            await wait_for_grecaptcha(self.page)
            self.last_used = time.monotonic()
            self._restart_idle_timer()

    async def refresh_cookies(self) -> str:
        """Navigate the Flow page and return current context cookies.

        Fast-path: if there's no NextAuth session-token in the seeded cookies
        OR in the cookies after the initial navigate, return SigninRedirectError
        immediately without doing an expensive reload. Observed 2026-05-21 12:55
        production cascade: refresh stuck waiting 60s on reload before realising
        the page was unauthenticated, then triggering retries that piled up.

        Returns cookie-string on success. Raises SigninRedirectError when the
        caller should escalate to full re-login.
        """
        async with self.lock:
            # Quick check before touching the browser: if the seeded cookies
            # have no session-token, we already know we'll need to re-login.
            # Persistent mode: `self.cookies` is always empty (cookies in profile),
            # so skip this check — go straight to ensure_ready, profile state will
            # surface signin redirect if cookies expired.
            if USE_PERSISTENT_PROFILE:
                seeded_has_session = True
            else:
                seeded_has_session = any(
                    c.get("name") == "__Secure-next-auth.session-token" for c in self.cookies
                )
            if not seeded_has_session:
                raise SigninRedirectError(
                    f"[{self.account_id}] DB cookies have no NextAuth session-token — auth required"
                )

            await self.ensure_ready()
            cookies = await self._harvest_cookies_locked()
            if "__Secure-next-auth.session-token=" not in cookies:
                raise SigninRedirectError(
                    f"[{self.account_id}] no NextAuth session-token in context — auth required"
                )

            # Skip reload if ensure_ready just navigated — cookies are already
            # fresh from Google's Set-Cookie on the initial response. Reloading
            # within 30s typically just stalls page.reload until timeout (the
            # page is still loading subresources from the first nav).
            context_age = time.monotonic() - self._context_opened_at
            if context_age < 30:
                logger.info(
                    f"[{self.account_id}] context age {context_age:.1f}s — "
                    "skipping reload, cookies are fresh"
                )
            else:
                try:
                    await self.page.reload(wait_until="load", timeout=PAGE_NAV_TIMEOUT_MS)
                    cookies = await self._harvest_cookies_locked()
                except Exception as e:
                    logger.warning(
                        f"[{self.account_id}] reload during refresh failed: {e}; "
                        "using cookies from before reload"
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

    async def _open_persistent_login_context(self, profile_dir: str):
        """Open a WORKING persistent BrowserContext at profile_dir for the login.

        launch_persistent_context under FEX hangs / yields broken pages
        intermittently (see _kill_all_invisible_firefox). Retry on LOGIN_DISPLAY with
        aggressive cleanup + a cheap page-health probe until we get a context whose
        page can navigate. Returns (cm, context, page). Raises if all attempts fail.
        Caller must hold self.lock and have set DISPLAY=LOGIN_DISPLAY.
        """
        for attempt in range(1, PERSIST_LAUNCH_MAX_ATTEMPTS + 1):
            # Kill leftovers (a prior hung Firefox cascades the next launch) and
            # clean-slate the dir so perform_login does a real fresh login.
            await _kill_all_invisible_firefox()
            await asyncio.sleep(3)
            await asyncio.to_thread(_wipe_profile_dir, profile_dir)
            cm = _make_login_cm(profile_dir)
            try:
                ctx = await asyncio.wait_for(cm.__aenter__(), timeout=PERSIST_LAUNCH_TIMEOUT_S)
            except Exception as e:
                logger.warning(
                    f"[{self.account_id}] persistent launch attempt "
                    f"{attempt}/{PERSIST_LAUNCH_MAX_ATTEMPTS} failed at enter "
                    f"({type(e).__name__}: {str(e).splitlines()[0][:80]}) — retrying"
                )
                try:
                    await asyncio.wait_for(cm.__aexit__(None, None, None), timeout=10.0)
                except Exception:
                    pass
                continue
            # Acquire a FRESH page — NOT ctx.pages[0]: the default new-tab page churns
            # during startup, so reading pages[0] races ("list index out of range") and
            # goto('about:blank') on it races Firefox's own startup nav ("interrupted by
            # another navigation"). A brand-new page avoids both. Then probe it with a
            # non-navigating evaluate; a broken context ("browsingContext is undefined")
            # makes new_page()/probe throw → retry the whole launch.
            try:
                page = await asyncio.wait_for(ctx.new_page(), timeout=20.0)
            except Exception as e:
                logger.warning(
                    f"[{self.account_id}] persistent launch attempt {attempt} new_page "
                    f"failed ({str(e).splitlines()[0][:80]}) — retrying"
                )
                try:
                    await asyncio.wait_for(cm.__aexit__(None, None, None), timeout=10.0)
                except Exception:
                    pass
                continue
            if not await _page_responsive(page):
                logger.warning(
                    f"[{self.account_id}] persistent launch attempt {attempt} page not "
                    f"responsive (broken context) — retrying"
                )
                try:
                    await asyncio.wait_for(cm.__aexit__(None, None, None), timeout=10.0)
                except Exception:
                    pass
                continue
            logger.info(
                f"[{self.account_id}] persistent login context ready on {LOGIN_DISPLAY} "
                f"(attempt {attempt})"
            )
            return cm, ctx, page
        raise RuntimeError(
            f"persistent login context unavailable after {PERSIST_LAUNCH_MAX_ATTEMPTS} "
            f"attempts on {LOGIN_DISPLAY}"
        )

    async def _run_login(self, email: str, password: str) -> None:
        from broker.login import perform_login
        from broker.profile_snapshot import is_enabled as _profile_enabled, profile_dir_for

        # VPS (BROKER_PROFILE_BASE set): run the login DIRECTLY in the per-account
        # persistent profile dir so Firefox writes a real, coherent login (cookies +
        # IndexedDB + browser state) into the SAME dir reload-via-firefox later
        # launches at. This is the fix for the profile-dir mismatch that broke the
        # ~20h self-heal: the old flow logged into an ephemeral context and wrote a
        # DEGRADED synthetic cookie snapshot to the profile dir (wrong host/httpOnly/
        # sameSite → Firefox rendered logged-out → reload could never rotate). With
        # the login running IN the dir, the profile is a native real login; reload
        # just re-grants + rotates there. (Mac: BROKER_PROFILE_BASE unset → ephemeral,
        # unchanged.)  launch_persistent_context is FEX-flaky → _open_persistent_login_context
        # retries on LOGIN_DISPLAY with aggressive cleanup (see that helper).
        _use_profile = _profile_enabled()
        _profile_dir = profile_dir_for(self.account_id) if _use_profile else None
        # CRITICAL: hold the Session lock for the ENTIRE login flow (including the
        # 2FA wait, up to ~120s). Without this, a concurrent refresh_cookies /
        # mint_token / flow_fetch call would acquire the lock between our setup
        # and perform_login's page.goto, then call _teardown_invisible inside
        # ensure_ready, killing the browser mid-login — observed 2026-05-21 12:49
        # as "Target page, context or browser has been closed".
        # FEX-resilience: the playwright node-driver pipe drops randomly under FEX
        # ("Target ... has been closed"), killing the browser mid-login. The mint /
        # flow_fetch paths already relaunch+retry on this; the login flow must too —
        # otherwise a single early crash (observed: dies at the signin/identifier page,
        # before any email/password/2FA input) fails the whole Telegram login. Crashes
        # happen before user input, so relaunching a fresh browser and restarting
        # perform_login is safe; a rare mid-2FA-wait death just re-sends a fresh 2FA
        # screenshot on the retry.
        # Persistent login must run on LOGIN_DISPLAY (x11vnc-attached) — Juggler hangs
        # on the bare :99. Override DISPLAY for the duration; restore in finally so
        # ephemeral ops go back to :99. Safe: the login holds the lock (no concurrent ops).
        _saved_display = os.environ.get("DISPLAY")
        if _use_profile:
            os.environ["DISPLAY"] = LOGIN_DISPLAY
        LOGIN_MAX_BROWSER_ATTEMPTS = 3
        try:
            async with self.lock:
                cookies_str = None
                for attempt in range(LOGIN_MAX_BROWSER_ATTEMPTS):
                    await self._teardown_invisible(
                        reason="login starts fresh" if attempt == 0
                        else f"dead-browser relaunch (login attempt {attempt + 1})"
                    )
                    if _use_profile:
                        # Robust persistent launch: retry on LOGIN_DISPLAY with
                        # aggressive cleanup + page-health check (FEX flakiness). The
                        # helper wipes the dir each attempt (clean-slate fresh login).
                        self._invisible_cm, self.context, page = (
                            await self._open_persistent_login_context(_profile_dir)
                        )
                        self.browser = None
                    else:
                        self._invisible_cm = _make_browser_cm(persistent=False)
                        self.browser = await self._invisible_cm.__aenter__()
                        self.context = await self.browser.new_context(bypass_csp=True)
                        page = await self.context.new_page()
                    self._login_page = page  # tracked for failure screenshot

                    async def on_2fa(path: str) -> None:
                        self.login_screenshot_path = path
                        self.login_state = LoginState.AWAITING_2FA

                    try:
                        cookies_str = await perform_login(page, email, password, on_2fa)
                        break
                    except Exception as e:
                        if _is_dead_browser_error(e) and attempt < LOGIN_MAX_BROWSER_ATTEMPTS - 1:
                            logger.warning(
                                f"[{self.account_id}] login browser/driver died "
                                f"(attempt {attempt + 1}/{LOGIN_MAX_BROWSER_ATTEMPTS}): "
                                f"{str(e).splitlines()[0]} — relaunching + retrying"
                            )
                            # Reset transient 2FA state so the retry sends a fresh prompt.
                            self.login_state = LoginState.RUNNING
                            self.login_screenshot_path = None
                            continue
                        raise

                self.cookies = parse_cookie_string(cookies_str)
                if _use_profile:
                    # Persistent login: Firefox wrote a real login into the profile
                    # dir. Do NOT promote it as the ops context — ops must stay
                    # EPHEMERAL (context rotation + reCAPTCHA trust score). Tear down
                    # to release the profile-dir lock so reload-via-firefox can
                    # raw-launch Firefox there later; ops re-init ephemeral on demand.
                    await self._teardown_invisible(
                        reason="login done — release persistent profile, ops back to ephemeral"
                    )
                else:
                    # Promote login session as the working context for runtime ops.
                    self.page = page
                    self.request_count = 0
                    self.ready = True

            self.login_cookies = cookies_str
            self.login_state = LoginState.COMPLETED
            self._restart_idle_timer()
            logger.info(f"[{self.account_id}] login flow COMPLETED ({len(cookies_str)} cookie chars)")
        except Exception as e:
            self.login_error = str(e)
            self.login_state = LoginState.FAILED
            logger.exception(f"[{self.account_id}] login flow FAILED: {e}")
            # Capture page state on the login page (not self.page which is the
            # pre-login working page) so we can see where the nav got stuck.
            try:
                if self._login_page is not None and not self._login_page.is_closed():
                    dump_path = f"/tmp/login-fail-{self.account_id}-{int(time.time())}.png"
                    await self._login_page.screenshot(path=dump_path, full_page=False)
                    cur_url = self._login_page.url
                    logger.info(f"[{self.account_id}] failure debug: url={cur_url} screenshot={dump_path}")
            except Exception as dbg_err:
                logger.warning(f"[{self.account_id}] could not capture failure debug: {dbg_err}")
            # Tear down so next attempt starts clean.
            try:
                async with self.lock:
                    await self._teardown_invisible(reason="login failed cleanup")
            except Exception as cleanup_err:
                logger.warning(f"[{self.account_id}] failed-login cleanup error: {cleanup_err}")
        finally:
            # Restore the ops DISPLAY (:99) — only mutated for the persistent login.
            if _use_profile:
                if _saved_display is not None:
                    os.environ["DISPLAY"] = _saved_display
                else:
                    os.environ.pop("DISPLAY", None)

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
        # IDLE_TIMEOUT_S <= 0 disables idle close entirely — the session stays
        # warm forever (Mac single-user preference: trade RAM for zero cold
        # relaunches; context still rotates @ ROTATION_THRESHOLD requests, and
        # explicit broker.close() / Node recovery still tear down on demand).
        if IDLE_TIMEOUT_S <= 0:
            self._idle_task = None
            return
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
