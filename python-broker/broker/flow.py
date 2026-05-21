"""Google Flow specific helpers — mint token, browser-side fetch, page lifecycle."""

import asyncio
import json
import random

# reCAPTCHA Enterprise site key for labs.google/fx/tools/flow (mirror connector.js:136).
RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV"
FLOW_URL = "https://labs.google/fx/tools/flow/"


async def simulate_gesture(page) -> None:
    """Brief mouse + scroll signal — Phase 0 confirmed this raises trust score consistency."""
    try:
        viewport = page.viewport_size or {"width": 1280, "height": 900}
        for _ in range(2):
            x = 50 + random.randint(0, max(1, viewport["width"] - 100))
            y = 50 + random.randint(0, max(1, viewport["height"] - 100))
            await page.mouse.move(x, y, steps=random.randint(4, 8))
            await asyncio.sleep(0.05 + random.random() * 0.08)
        await page.evaluate("window.scrollBy(0, Math.floor(Math.random() * 200) - 100)")
        await asyncio.sleep(0.08 + random.random() * 0.12)
    except Exception:
        # gestures are best-effort — never fail mint on a gesture hiccup
        pass


async def mint_recaptcha_token(page, action: str) -> str:
    """Mint a fresh single-use reCAPTCHA Enterprise token via grecaptcha.enterprise.execute."""
    await simulate_gesture(page)
    return await page.evaluate(
        """async ([siteKey, act]) => grecaptcha.enterprise.execute(siteKey, {action: act})""",
        [RECAPTCHA_SITE_KEY, action],
    )


async def flow_fetch_in_page(page, url: str, bearer: str, body: dict) -> dict:
    """Execute the Google Flow API call inside the browser page.

    Running fetch from page context carries the right cookies + Origin header,
    which is required for the reCAPTCHA token to be accepted by the backend.
    Mirror connector.js browserFetch() at line 663-700.
    """
    return await page.evaluate(
        """async ({url, bearer, body}) => {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Authorization': 'Bearer ' + bearer,
                },
                body: body,
                credentials: 'include',
            });
            const text = await res.text();
            return { status: res.status, ok: res.ok, body: text };
        }""",
        {"url": url, "bearer": bearer, "body": json.dumps(body)},
    )


async def wait_for_grecaptcha(page, timeout_ms: int = 15000) -> None:
    """Block until grecaptcha.enterprise.execute is callable on the page."""
    await page.wait_for_function(
        """() => typeof grecaptcha !== 'undefined'
              && typeof grecaptcha.enterprise !== 'undefined'
              && typeof grecaptcha.enterprise.execute === 'function'""",
        timeout=timeout_ms,
    )


async def is_signin_redirect(page) -> bool:
    """Detect Google session expiry redirect."""
    url = page.url
    return "accounts.google.com" in url or "/signin" in url
