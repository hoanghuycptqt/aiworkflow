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
LOGIN_NAV_TIMEOUT_MS = 30000
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

    Mirrors worker's 3 strategies: text scan → role-based → coordinate fallback.
    """
    # Strategy 1: text search across leaf elements
    clicked = await page.evaluate("""
        () => {
            const els = [...document.querySelectorAll('*')];
            for (const el of els) {
                if (el.children.length > 5) continue;
                const t = (el.textContent || '').trim();
                if ((t === 'Sign in with Google' || t === 'Sign in') && t.length < 40) {
                    el.click();
                    return true;
                }
            }
            return false;
        }
    """)
    if clicked:
        logger.info("clicked Sign in (text strategy)")
        return True

    # Strategy 2: Playwright locator with text role
    try:
        loc = page.get_by_role("button", name="Sign in")
        await loc.first.click(timeout=3000)
        logger.info("clicked Sign in (role strategy)")
        return True
    except Exception:
        pass

    # Strategy 3: coordinate click at top-right (button position on 1280x900)
    try:
        await page.mouse.click(1130, 40)
        logger.info("clicked Sign in (coordinate strategy)")
        return True
    except Exception:
        return False


async def _fill_email_if_present(page, email: str) -> bool:
    has_email = await page.evaluate(
        """() => {
            const el = document.querySelector('input[type="email"]');
            return !!(el && el.offsetParent !== null);
        }"""
    )
    if not has_email:
        return False
    logger.info("typing email")
    await page.fill('input[type="email"]', email)
    await _delay(0.5, 1.0)
    await page.evaluate(
        """() => {
            const btn = [...document.querySelectorAll('button')]
                .find(b => /Next|Tiếp theo/.test(b.textContent || ''));
            if (btn) btn.click();
        }"""
    )
    await _delay(3.0, 5.0)
    return True


async def _fill_password_if_present(page, password: str) -> bool:
    has_pwd = await page.evaluate(
        """() => {
            const el = document.querySelector('input[type="password"]');
            return !!(el && el.offsetParent !== null);
        }"""
    )
    if not has_pwd:
        return False
    logger.info("typing password")
    await page.fill('input[type="password"]', password)
    await _delay(0.5, 1.0)
    await page.evaluate(
        """() => {
            const btn = [...document.querySelectorAll('button')]
                .find(b => /Next|Tiếp theo/.test(b.textContent || ''));
            if (btn) btn.click();
        }"""
    )
    await _delay(4.0, 6.0)
    return True


async def _detect_2fa(page) -> bool:
    """Detect Google's 2-step verification challenge page."""
    url = page.url
    if any(s in url for s in ("/challenge/dp", "/challenge/ipp", "/challenge/ootp")):
        return True
    return await page.evaluate(
        """() => {
            const t = document.body?.innerText || '';
            return [
                'Check your phone', 'Kiểm tra điện thoại',
                '2-Step Verification', 'Xác minh 2 bước',
                'Confirm it', 'Verify it', 'confirm that it', 'xác nhận',
                'trying to sign in', 'đang cố đăng nhập',
                "Verify it's you", 'Xác minh danh tính',
            ].some(s => t.includes(s));
        }"""
    )


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
    await page.goto(LABS_HOME, wait_until="networkidle", timeout=LOGIN_NAV_TIMEOUT_MS)
    await _delay(2.0, 3.0)
    if await _is_already_signed_in(page.context):
        logger.info("already signed in — skipping login")
        await page.goto(LABS_FLOW, wait_until="networkidle", timeout=LOGIN_NAV_TIMEOUT_MS)
        return await _serialize_cookies(page.context)

    # 2. Click Sign in with Google
    clicked = await _click_sign_in_with_google(page)
    if clicked:
        try:
            await page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass
        await _delay(2.0, 3.0)

    # If still on labs.google after click, post NextAuth signin form.
    if "labs.google" in page.url:
        logger.info("still on labs.google — using NextAuth signin form fallback")
        await page.goto(LABS_SIGNIN, wait_until="networkidle", timeout=LOGIN_NAV_TIMEOUT_MS)
        await _delay(1.0, 2.0)
        # Try clicking a Google provider button on signin page
        await page.evaluate(
            """() => {
                const forms = [...document.querySelectorAll('form')];
                for (const f of forms) {
                    const action = (f.action || '').toLowerCase();
                    if (action.includes('google') || action.includes('signin')) {
                        const btn = f.querySelector('button') || f.querySelector('input[type=submit]');
                        if (btn) { btn.click(); return; }
                        f.submit(); return;
                    }
                }
            }"""
        )
        await _delay(3.0, 5.0)

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
