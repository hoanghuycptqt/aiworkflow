"""Google login automation for the broker.

Python port of server/src/services/google-login-worker.mjs core flow.
Drives an invisible_playwright Firefox page through labs.google's NextAuth signin
+ Google OAuth + (optional) 2FA tap-phone approval.

The legacy Chrome worker (~497 LOC) included many edge cases (account chooser
heuristics, 3 strategies for clicking the Sign-in button, etc.). We port the
core happy path first; rare branches can be added if observed in production.
"""

import asyncio
import logging
import random
from typing import Awaitable, Callable, Optional

logger = logging.getLogger("broker.login")

LABS_HOME = "https://labs.google/fx"
LABS_SIGNIN = "https://labs.google/fx/api/auth/signin"
LABS_FLOW = "https://labs.google/fx/tools/flow/"
TWOFA_SCREENSHOT_DIR = "/tmp"
TWOFA_POLL_INTERVAL_S = 5
TWOFA_TIMEOUT_S = 120
# Use `domcontentloaded` — Google's signin page has long-loading 3rd party
# scripts (Google analytics, recaptcha enterprise SDK) that prevent the
# `load` event from firing within 60s. DOMContentLoaded fires as soon as
# the HTML is parsed, well before subresources finish.
LOGIN_NAV_TIMEOUT_MS = 60000
LOGIN_WAIT_UNTIL = "domcontentloaded"
LOGIN_LOOP_MAX_ATTEMPTS = 20  # safety net


async def _delay(min_s: float = 0.5, max_s: float = 1.5) -> None:
    await asyncio.sleep(min_s + random.random() * (max_s - min_s))


async def _is_already_signed_in(context) -> bool:
    """Check labs.google session cookie via CDP-equivalent context.cookies()."""
    cookies = await context.cookies()
    return any(
        c.get("name") == "__Secure-next-auth.session-token"
        and "labs.google" in c.get("domain", "")
        and len(c.get("value", "")) > 10
        for c in cookies
    )


async def _click_sign_in_with_google(page) -> bool:
    """Try to click the Sign in with Google button on labs.google/fx landing.

    IMPORTANT: must use Playwright `locator.click()` — Firefox blocks synthetic
    `el.click()` via page.evaluate from triggering navigation (no user activation).
    The legacy Chrome worker used the same JS approach and it worked there
    because Chrome treats synthetic clicks as activated by default.
    """
    # Strategy 1: exact text "Sign in with Google"
    try:
        loc = page.get_by_text("Sign in with Google", exact=True)
        await loc.first.click(timeout=5000)
        logger.info("clicked Sign in (text-exact strategy)")
        return True
    except Exception as e:
        logger.info(f"text-exact strategy missed: {e}")

    # Strategy 2: role=button name=Sign in
    try:
        loc = page.get_by_role("button", name="Sign in")
        await loc.first.click(timeout=5000)
        logger.info("clicked Sign in (role strategy)")
        return True
    except Exception as e:
        logger.info(f"role strategy missed: {e}")

    # Strategy 3: any element with text "Sign in" or "Sign in with Google"
    try:
        loc = page.locator("text=/^Sign in( with Google)?$/").first
        await loc.click(timeout=5000)
        logger.info("clicked Sign in (locator-regex strategy)")
        return True
    except Exception as e:
        logger.info(f"locator-regex strategy missed: {e}")

    # Strategy 4: coordinate click at top-right (button position on 1280x900)
    try:
        await page.mouse.click(1130, 40)
        logger.info("clicked Sign in (coordinate strategy)")
        return True
    except Exception:
        return False


async def _click_next_button(page) -> bool:
    """Click a 'Next' / 'Tiếp theo' button using locators (no evaluate, CSP-safe)."""
    for selector in (
        'button:has-text("Next")',
        'button:has-text("Tiếp theo")',
        'role=button[name="Next"]',
        'role=button[name="Tiếp theo"]',
    ):
        try:
            await page.locator(selector).first.click(timeout=2000)
            return True
        except Exception:
            continue
    return False


async def _fill_email_if_present(page, email: str) -> bool:
    """No evaluate — CSP-safe. labs.google bans unsafe-eval."""
    loc = page.locator('input[type="email"]:visible')
    try:
        if await loc.count() == 0:
            return False
    except Exception:
        return False
    logger.info("typing email")
    await loc.first.fill(email)
    await _delay(0.5, 1.0)
    await _click_next_button(page)
    await _delay(3.0, 5.0)
    return True


async def _fill_password_if_present(page, password: str) -> bool:
    loc = page.locator('input[type="password"]:visible')
    try:
        if await loc.count() == 0:
            return False
    except Exception:
        return False
    logger.info("typing password")
    await loc.first.fill(password)
    await _delay(0.5, 1.0)
    await _click_next_button(page)
    await _delay(4.0, 6.0)
    return True


async def _detect_2fa(page) -> bool:
    """Detect Google's 2-step verification challenge page.

    No evaluate — uses URL + Playwright text locators (CSP-safe).
    """
    url = page.url
    if any(s in url for s in ("/challenge/dp", "/challenge/ipp", "/challenge/ootp")):
        return True
    for needle in (
        "Check your phone", "Kiểm tra điện thoại",
        "2-Step Verification", "Xác minh 2 bước",
        "Confirm it", "Verify it", "confirm that it", "xác nhận",
        "trying to sign in", "đang cố đăng nhập",
        "Verify it's you", "Xác minh danh tính",
    ):
        try:
            if await page.get_by_text(needle, exact=False).first.count() > 0:
                return True
        except Exception:
            continue
    return False


async def _poll_2fa_approval(page) -> bool:
    """Poll URL every 5s up to 120s. Return True on approval."""
    from urllib.parse import urlparse
    attempts = TWOFA_TIMEOUT_S // TWOFA_POLL_INTERVAL_S
    for i in range(attempts):
        await asyncio.sleep(TWOFA_POLL_INTERVAL_S)
        url = page.url
        path = ""
        try:
            path = urlparse(url).path
        except Exception:
            path = url
        logger.info(f"2FA poll {i+1}/{attempts} path={path}")
        if "/consent" in path or "myaccount.google.com" in url or "labs.google" in url:
            logger.info("2FA approved — URL transitioned to consent/myaccount/labs.google")
            return True
        if "rejected" in path:
            logger.warning("2FA rejected by Google")
            return False
        if "/challenge/" not in path and "/signin/" not in path:
            logger.info(f"2FA approved — left challenge/signin pages, path={path}")
            return True
    logger.warning(f"2FA timeout after {TWOFA_TIMEOUT_S}s")
    return False


async def perform_login(
    page,
    email: str,
    password: str,
    on_2fa_screenshot: Callable[[str], Awaitable[None]],
) -> str:
    """Drive a Playwright page through Google signin → labs.google/fx.

    Returns the cookie-string on success.
    Raises on failure (timeout, 2FA reject, etc.).
    """
    # 1. Already signed in?
    logger.info(f"navigating to {LABS_HOME}")
    await page.goto(LABS_HOME, wait_until=LOGIN_WAIT_UNTIL, timeout=LOGIN_NAV_TIMEOUT_MS)
    await _delay(2.0, 3.0)
    if await _is_already_signed_in(page.context):
        logger.info("already signed in — skipping login")
        await page.goto(LABS_FLOW, wait_until=LOGIN_WAIT_UNTIL, timeout=LOGIN_NAV_TIMEOUT_MS)
        return await _serialize_cookies(page.context)

    # 2. Click Sign in with Google — possibly multiple times.
    # labs.google/fx has a 2-step sign-in: a small top-right "Sign in" trigger
    # that opens a centered modal containing the actual "Sign in with Google"
    # OAuth button. We loop the click up to 3 times, waiting for the URL to
    # leave labs.google between attempts. (Screenshot debug 2026-05-21 13:16
    # showed the modal with the OAuth button after the first click.)
    nav_done = False
    for attempt in range(3):
        try:
            async with page.expect_event(
                "framenavigated",
                predicate=lambda fr: "accounts.google.com" in fr.url or "google.com/o/oauth" in fr.url,
                timeout=20000,
            ):
                clicked = await _click_sign_in_with_google(page)
                if not clicked:
                    raise RuntimeError("no sign-in button found")
            nav_done = True
            logger.info(f"OAuth nav triggered after click attempt {attempt + 1} → {page.url[:120]}")
            break
        except Exception as e:
            logger.info(f"click attempt {attempt + 1} didn't trigger OAuth nav: {e}; url={page.url[:120]}")
            await _delay(1.5, 2.5)

    if not nav_done and "labs.google" in page.url:
        # Last-resort fallback: navigate to NextAuth signin and click the Google
        # provider button via locator. No evaluate — CSP would block it.
        logger.info("falling back to NextAuth /api/auth/signin page")
        try:
            await page.goto(LABS_SIGNIN, wait_until="commit", timeout=LOGIN_NAV_TIMEOUT_MS)
            await _delay(2.0, 3.0)
            for selector in (
                'button:has-text("Google")',
                'button:has-text("Sign in with Google")',
                'role=button[name="Google"]',
            ):
                try:
                    await page.locator(selector).first.click(timeout=3000)
                    logger.info(f"clicked NextAuth Google button ({selector})")
                    break
                except Exception:
                    continue
            await _delay(3.0, 5.0)
        except Exception as e:
            logger.warning(f"NextAuth fallback failed: {e}")

    # 3. Main loop: fill email / password / detect 2FA
    two_fa_sent = False
    for attempt in range(LOGIN_LOOP_MAX_ATTEMPTS):
        url = page.url
        logger.info(f"loop {attempt+1}/{LOGIN_LOOP_MAX_ATTEMPTS}: url={url[:120]}")

        # Success condition: redirected back to labs.google with cookies
        if "labs.google" in url:
            await asyncio.sleep(2.0)
            if await _is_already_signed_in(page.context):
                logger.info("login complete — on labs.google with session cookie")
                return await _serialize_cookies(page.context)

        # 2FA first (challenge URL may have email visible → would falsely trigger
        # the account chooser if checked first)
        if await _detect_2fa(page):
            if not two_fa_sent:
                two_fa_sent = True
                screenshot_path = f"{TWOFA_SCREENSHOT_DIR}/2fa-{id(page)}.png"
                try:
                    await page.screenshot(path=screenshot_path)
                    logger.info(f"2FA detected, screenshot saved to {screenshot_path}")
                    await on_2fa_screenshot(screenshot_path)
                except Exception as e:
                    logger.warning(f"2FA screenshot failed: {e}")
            approved = await _poll_2fa_approval(page)
            if not approved:
                raise RuntimeError("2FA timeout or rejected by Google")
            # Continue loop — should now redirect to labs.google
            await asyncio.sleep(2.0)
            continue

        # Email input?
        if await _fill_email_if_present(page, email):
            continue

        # Password input?
        if await _fill_password_if_present(page, password):
            continue

        # No actionable element this iteration — wait and retry
        await _delay(2.0, 3.0)

    raise RuntimeError(f"login loop exhausted after {LOGIN_LOOP_MAX_ATTEMPTS} iterations")


async def _serialize_cookies(context) -> str:
    """Convert Playwright context cookies → DB string format."""
    from broker.cookies import stringify_cookies
    raw = await context.cookies()
    return stringify_cookies(raw)
