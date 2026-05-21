"""
Phase 0 smoke test for invisible_playwright + Google Flow reCAPTCHA Enterprise.

Goal: prove invisible_playwright Firefox can mint working reCAPTCHA tokens for
Google Flow's batchGenerateImages endpoint at a 403 rate materially lower than
the current Chrome-based connector on the VPS.

Usage on VPS:
    cd /opt/vcw/app/python-broker
    ./venv/bin/python scripts/smoke_test.py --project-id <YOUR_PROJECT_UUID> [--iters 20]

The project ID is the same UUID used in the Workflow Builder's Google Flow node
config (`config.projectId`). Find it via:
    sqlite3 /opt/vcw/app/server/prisma/dev.db \\
        "SELECT nodesData FROM Workflow WHERE nodesData LIKE '%projectId%' LIMIT 1;"

Outputs a single JSON line per iteration to stdout and a summary at the end.
Exit code 0 if pass criteria met (>= 15/20 success), else 1.
"""

import argparse
import json
import os
import random
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from typing import Any

# Constants (mirror server/src/connectors/google-flow/connector.js)
RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV"
TOOL = "PINHOLE"
API_BASE = "https://aisandbox-pa.googleapis.com"
FLOW_URL = "https://labs.google/fx/tools/flow/"

# Default banana2 model + portrait 9:16 (same defaults as connector.js)
IMAGE_MODEL = "NARWHAL"  # banana2 (Nano Banana 2)
ASPECT_RATIO = "IMAGE_ASPECT_RATIO_PORTRAIT"


def fetch_credential(db_path: str) -> dict[str, Any]:
    """Read one google-flow credential from SQLite."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT id, token, metadata FROM Credential WHERE provider='google-flow' LIMIT 1"
    ).fetchone()
    conn.close()
    if not row:
        sys.exit(f"No google-flow credential in {db_path}")
    meta = json.loads(row["metadata"] or "{}")
    return {
        "id": row["id"],
        "token": row["token"],
        "session_cookies": meta.get("sessionCookies", ""),
        "user_email": meta.get("userEmail", "unknown"),
    }


def parse_cookies(cookie_string: str) -> list[dict[str, Any]]:
    """Parse 'name=val; name=val' into Playwright cookie dicts on .google.com and .labs.google."""
    if not cookie_string:
        return []
    out = []
    for part in cookie_string.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        name, _, value = part.partition("=")
        name = name.strip()
        value = value.strip()
        if not name:
            continue
        # Mirror connector.js setCookie behavior — inject on both domains.
        for domain in (".google.com", ".labs.google"):
            out.append({
                "name": name,
                "value": value,
                "domain": domain,
                "path": "/",
                "secure": True,
                "httpOnly": False,
            })
    return out


def simulate_gesture(page) -> None:
    """Brief mouse motion + scroll to register interaction signal (mirror _simulateUserGesture)."""
    try:
        viewport = page.viewport_size or {"width": 1280, "height": 900}
        for _ in range(2):
            x = 50 + random.randint(0, max(1, viewport["width"] - 100))
            y = 50 + random.randint(0, max(1, viewport["height"] - 100))
            page.mouse.move(x, y, steps=random.randint(4, 8))
            time.sleep(0.05 + random.random() * 0.08)
        page.evaluate("window.scrollBy(0, Math.floor(Math.random() * 200) - 100)")
        time.sleep(0.08 + random.random() * 0.12)
    except Exception as e:
        print(f"  gesture: {e}", file=sys.stderr)


def mint_recaptcha_token(page, action: str = "IMAGE_GENERATION") -> str:
    """Call grecaptcha.enterprise.execute on the warm page."""
    simulate_gesture(page)
    return page.evaluate(
        """async ([siteKey, act]) => grecaptcha.enterprise.execute(siteKey, {action: act})""",
        [RECAPTCHA_SITE_KEY, action],
    )


def flow_fetch_in_browser(page, url: str, bearer: str, body: dict) -> dict:
    """Execute the API call inside the browser page (carries cookies + origin)."""
    return page.evaluate(
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


def build_generate_body(project_id: str, prompt: str, recaptcha_token: str,
                        batch_id: str, session_id: str) -> dict:
    """Mirror the body shape in connector.js batchGenerateImages."""
    recaptcha_context = {
        "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
        "token": recaptcha_token,
    }
    request = {
        "clientContext": {
            "recaptchaContext": recaptcha_context,
            "projectId": project_id,
            "tool": TOOL,
            "sessionId": session_id,
        },
        "imageModelName": IMAGE_MODEL,
        "imageAspectRatio": ASPECT_RATIO,
        "structuredPrompt": {"parts": [{"text": prompt}]},
        "seed": random.randint(1, 2147483647),
    }
    return {
        "clientContext": {
            "recaptchaContext": recaptcha_context,
            "projectId": project_id,
            "tool": TOOL,
            "sessionId": session_id,
        },
        "mediaGenerationContext": {"batchId": batch_id},
        "useNewMedia": True,
        "requests": [request],
    }


def run(args) -> int:
    # Lazy import so --help works without invisible_playwright installed
    from invisible_playwright import InvisiblePlaywright

    cred = fetch_credential(args.db)
    print(f"[smoke] credential id={cred['id']}, email={cred['user_email']}, "
          f"token={cred['token'][:30]}..., cookies={len(cred['session_cookies'])} chars",
          file=sys.stderr)

    profile_dir = Path(args.profile).resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    print(f"[smoke] profile: {profile_dir}", file=sys.stderr)

    # Note: invisible_playwright's exact persistent-context API isn't documented
    # in the README — try common signatures and fall back.
    iters = args.iters
    prompts = [
        "a serene mountain landscape at sunrise",
        "a cute orange cat sleeping on a windowsill",
        "abstract geometric pattern in blue and gold",
        "a steaming bowl of ramen on a wooden table",
        "a vintage red bicycle leaning against a brick wall",
    ]

    results: list[dict] = []
    with InvisiblePlaywright() as browser:
        # invisible_playwright returns a Browser object; create a context per session
        context = browser.new_context()
        cookies = parse_cookies(cred["session_cookies"])
        if cookies:
            context.add_cookies(cookies)
            print(f"[smoke] injected {len(cookies)} cookies", file=sys.stderr)

        page = context.new_page()
        print(f"[smoke] navigating to {FLOW_URL}...", file=sys.stderr)
        page.goto(FLOW_URL, wait_until="load", timeout=30000)

        # Check redirect to signin
        cur = page.url
        if "accounts.google.com" in cur or "/signin" in cur:
            sys.exit(f"[smoke] REDIRECT to signin: {cur}. DB cookies stale — login + harvest first.")

        # Wait for grecaptcha SDK
        print("[smoke] waiting for grecaptcha.enterprise...", file=sys.stderr)
        page.wait_for_function(
            """() => typeof grecaptcha !== 'undefined'
                  && typeof grecaptcha.enterprise !== 'undefined'
                  && typeof grecaptcha.enterprise.execute === 'function'""",
            timeout=15000,
        )
        print("[smoke] SDK ready", file=sys.stderr)

        success = 0
        recaptcha_403 = 0
        other_fail = 0
        for i in range(iters):
            prompt = random.choice(prompts)
            try:
                t0 = time.time()
                token = mint_recaptcha_token(page, "IMAGE_GENERATION")
                t_token = time.time() - t0
                token_len = len(token) if token else 0

                body = build_generate_body(
                    project_id=args.project_id,
                    prompt=prompt,
                    recaptcha_token=token,
                    batch_id=str(uuid.uuid4()),
                    session_id=f";{int(time.time() * 1000)}",
                )
                url = f"{API_BASE}/v1/projects/{args.project_id}/flowMedia:batchGenerateImages"
                t1 = time.time()
                res = flow_fetch_in_browser(page, url, cred["token"], body)
                t_api = time.time() - t1

                is_recaptcha_403 = (res["status"] == 403 and "reCAPTCHA" in res["body"])
                ok = res["ok"]
                if ok:
                    success += 1
                elif is_recaptcha_403:
                    recaptcha_403 += 1
                else:
                    other_fail += 1

                row = {
                    "iter": i + 1,
                    "status": res["status"],
                    "ok": ok,
                    "recaptcha_403": is_recaptcha_403,
                    "token_len": token_len,
                    "t_token_s": round(t_token, 2),
                    "t_api_s": round(t_api, 2),
                    "body_preview": res["body"][:200] if not ok else "",
                }
                results.append(row)
                print(json.dumps(row))
                sys.stdout.flush()

                # Pause between iterations (mirror connector.js 5s gap)
                if i < iters - 1:
                    time.sleep(args.delay)

            except Exception as e:
                other_fail += 1
                row = {"iter": i + 1, "error": str(e)[:300]}
                results.append(row)
                print(json.dumps(row))
                sys.stdout.flush()

        # Cleanup
        try:
            context.close()
        except Exception:
            pass

    summary = {
        "iters": iters,
        "success": success,
        "recaptcha_403": recaptcha_403,
        "other_fail": other_fail,
        "success_rate": round(success / iters, 3),
        "pass": success >= max(int(iters * 0.75), 1),
    }
    print("\n=== SUMMARY ===", file=sys.stderr)
    print(json.dumps(summary, indent=2))
    return 0 if summary["pass"] else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default="/opt/vcw/app/server/prisma/dev.db",
                    help="Path to VCW SQLite DB (default: VPS prod path)")
    ap.add_argument("--project-id", required=True,
                    help="Google Flow project UUID (from Workflow Builder node config)")
    ap.add_argument("--profile", default="./profile-smoke",
                    help="Persistent profile dir (default: ./profile-smoke)")
    ap.add_argument("--iters", type=int, default=20, help="Number of iterations (default: 20)")
    ap.add_argument("--delay", type=float, default=5.0,
                    help="Seconds between iterations (default: 5)")
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
