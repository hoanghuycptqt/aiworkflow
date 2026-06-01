"""Deterministic test for the in-place grecaptcha reload-recovery added to
Session._mint_with_settle (2026-05-29).

⚠️  DO NOT run against a broker serving live traffic. The Session teardown's
    fallback `pkill -9` (_force_kill_browser_processes) is CONTAINER-WIDE, not
    session-scoped — it kills ALL Firefox in the container, including the warm
    production session (which now lives indefinitely since idle close is
    disabled). Run only when the pool is idle, or point it at a throwaway
    container.


Triggers the exact failure branch deterministically by injecting a one-shot
TimeoutError into wait_for_grecaptcha (the warm-stale symptom from the 19:06
incident), instead of poking live page state (which flakes with Firefox
"Target closed"). Python resolves the module global `wait_for_grecaptcha` at
call time, so monkeypatching broker.session_pool.wait_for_grecaptcha is seen by
_mint_with_settle.

Flow:
  1. warm up with one real mint (baseline; proves the session is healthy)
  2. patch wait_for_grecaptcha to raise TimeoutError ONCE
  3. mint again → _mint_with_settle attempt 0 hits the injected timeout →
     recoverable → page.reload() (REAL) → attempt 1 calls the REAL
     wait_for_grecaptcha → if reload restored the SDK it returns → mint succeeds

PASS requires BOTH: a non-empty token from the second mint AND the
"reloading page in place" warning having fired. The attempt-1 wait is the real
one, so a PASS proves reload actually brings grecaptcha back on the live page —
not just that the retry loop spins.

Run inside the container:
  docker cp scripts/test_reload_recovery.py vcw-broker-mac:/app/test_reload_recovery.py
  docker exec -w /app -e DISPLAY=:99 -e HOME=/root vcw-broker-mac \
      python test_reload_recovery.py
"""

import asyncio
import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

_captured: list[str] = []


class _Capture(logging.Handler):
    def emit(self, record):
        _captured.append(record.getMessage())


logging.getLogger("broker.session").addHandler(_Capture())

import broker.session_pool as sp  # noqa: E402
from broker.cookies import parse_cookie_string  # noqa: E402
from playwright.async_api import TimeoutError as PWTimeout  # noqa: E402


def _read_env_cookies(path: str = "/app/mcp-env") -> str:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("GOOGLE_FLOW_SESSION_COOKIES="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


async def main() -> int:
    cookies_str = _read_env_cookies()
    if not cookies_str:
        print("RESULT=FAIL reason=no_cookies_in_/app/mcp-env")
        return 1

    sess = sp.Session("test_reload_recovery", parse_cookie_string(cookies_str))
    try:
        # 1. Baseline real mint — also confirms a healthy, ready session.
        tok0, _ = await sess.mint_token("IMAGE_GENERATION")
        print(f"INFO baseline_mint_token_len={len(tok0) if tok0 else 0}")

        # 2. Inject a one-shot timeout into the SDK-wait, then restore the real one.
        real_wait = sp.wait_for_grecaptcha
        state = {"fired": False}

        async def flaky_wait(page, timeout_ms: int = 15000):
            if not state["fired"]:
                state["fired"] = True
                raise PWTimeout("Page.wait_for_function: Timeout 15000ms exceeded (INJECTED)")
            return await real_wait(page, timeout_ms=timeout_ms)

        sp.wait_for_grecaptcha = flaky_wait

        # 3. Second mint must recover via the reload branch.
        tok1, count = await sess.mint_token("IMAGE_GENERATION")
        sp.wait_for_grecaptcha = real_wait  # restore

        reload_fired = any("reloading page in place" in m for m in _captured)
        tlen = len(tok1) if tok1 else 0
        print(f"INFO recovery_mint_token_len={tlen} request_count={count} "
              f"reload_fired={reload_fired} injected_timeout_consumed={state['fired']}")

        if tlen > 0 and reload_fired:
            print("RESULT=PASS reason=recovered_via_in_place_reload")
            return 0
        if tlen > 0 and not reload_fired:
            print("RESULT=INCONCLUSIVE reason=minted_but_reload_branch_did_not_fire")
            return 2
        print("RESULT=FAIL reason=no_token_after_injected_timeout")
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"RESULT=FAIL reason=exception:{type(e).__name__}:{str(e).splitlines()[0]}")
        return 1
    finally:
        try:
            if sess._idle_task:
                sess._idle_task.cancel()
        except Exception:
            pass
        try:
            await sess._teardown_invisible(reason="test done")
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
