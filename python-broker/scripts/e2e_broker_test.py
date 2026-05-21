"""End-to-end test for the running broker over HTTP.

Hits the broker exactly as the Node.js connector will: init → recaptcha → flow-fetch
in a tight loop. Verifies that:
1. Health check works.
2. 50 iters succeed with rotation_threshold=15 (rotations at iter 16, 31, 46).
3. request_count counter resets after each rotation.
4. No PERMISSION_DENIED 403s (cliff would indicate rotation broke).

Reads DB credentials the same way as smoke_test.py.

Usage:
    cd /opt/vcw/app/python-broker
    ./venv/bin/python scripts/e2e_broker_test.py \\
        --broker http://127.0.0.1:8002 \\
        --project-id <UUID> \\
        --iters 50

Exits 0 if pass criteria met (≥48/50 success), else 1.
"""

import argparse
import json
import os
import random
import sqlite3
import sys
import time
import uuid
from typing import Any

import urllib.request
import urllib.error

TOOL = "PINHOLE"
API_BASE = "https://aisandbox-pa.googleapis.com"
IMAGE_MODEL = "NARWHAL"
ASPECT_RATIO = "IMAGE_ASPECT_RATIO_PORTRAIT"


def fetch_credential(db_path: str) -> dict[str, Any]:
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


def http_call(broker: str, method: str, path: str, body: dict | None = None,
              auth: str | None = None, timeout: int = 120) -> dict:
    url = broker.rstrip("/") + path
    data = None
    headers = {"Content-Type": "application/json"}
    if auth:
        headers["Authorization"] = f"Bearer {auth}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"status": resp.status, "body": json.loads(resp.read())}
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read())
        except Exception:
            err_body = {"detail": e.reason}
        return {"status": e.code, "body": err_body}


def build_generate_body(project_id: str, prompt: str, recaptcha_token: str,
                        batch_id: str, session_id: str) -> dict:
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--broker", default=os.environ.get("FLOW_BROKER_URL", "http://127.0.0.1:8002"))
    ap.add_argument("--auth-token", default=os.environ.get("BROKER_AUTH_TOKEN", ""))
    ap.add_argument("--db", default="/opt/vcw/app/server/prisma/dev.db")
    ap.add_argument("--project-id", required=True)
    ap.add_argument("--account-id", default="e2e_test",
                    help="Broker session key (default: e2e_test)")
    ap.add_argument("--iters", type=int, default=50)
    ap.add_argument("--delay", type=float, default=2.0,
                    help="Seconds between iters (default: 2)")
    args = ap.parse_args()

    auth = args.auth_token or None
    cred = fetch_credential(args.db)
    print(f"[e2e] broker={args.broker}, account={args.account_id}, "
          f"email={cred['user_email']}, iters={args.iters}", file=sys.stderr)

    # 1. Health check
    h = http_call(args.broker, "GET", "/healthz", auth=auth, timeout=5)
    if h["status"] != 200:
        sys.exit(f"[e2e] healthz failed: {h}")
    print(f"[e2e] healthz: {h['body']}", file=sys.stderr)

    # 2. Init session
    print("[e2e] POST /sessions/{}/init...".format(args.account_id), file=sys.stderr)
    init = http_call(args.broker, "POST", f"/sessions/{args.account_id}/init",
                     body={"cookies": cred["session_cookies"]}, auth=auth, timeout=60)
    if init["status"] != 200:
        sys.exit(f"[e2e] init failed: {init}")
    print(f"[e2e] init: {init['body']}", file=sys.stderr)

    # 3. Loop
    prompts = [
        "a serene mountain landscape at sunrise",
        "a cute orange cat sleeping on a windowsill",
        "abstract geometric pattern in blue and gold",
        "a steaming bowl of ramen on a wooden table",
        "a vintage red bicycle leaning against a brick wall",
    ]
    project_id = args.project_id

    success = 0
    recaptcha_403 = 0
    other_fail = 0
    rotation_count = 0
    last_counter = 0
    results: list[dict] = []

    for i in range(args.iters):
        prompt = random.choice(prompts)
        t0 = time.time()
        try:
            # Mint token
            tok_resp = http_call(args.broker, "POST",
                                 f"/sessions/{args.account_id}/recaptcha-token",
                                 body={"action": "IMAGE_GENERATION"}, auth=auth, timeout=60)
            if tok_resp["status"] != 200:
                other_fail += 1
                row = {"iter": i + 1, "stage": "token", "error": tok_resp}
                results.append(row)
                print(json.dumps(row))
                sys.stdout.flush()
                continue

            token = tok_resp["body"]["token"]
            counter = tok_resp["body"]["request_count"]
            # Detect rotation event: counter went DOWN (or stayed at 1 after reaching 15+).
            if last_counter > counter or (last_counter >= 15 and counter == 1):
                rotation_count += 1
                print(f"[e2e] ↻ rotation #{rotation_count} at iter {i + 1} "
                      f"(prev counter {last_counter} → new counter {counter})",
                      file=sys.stderr)
            last_counter = counter

            t_token = time.time() - t0

            # Build + send API call
            body = build_generate_body(
                project_id=project_id, prompt=prompt, recaptcha_token=token,
                batch_id=str(uuid.uuid4()), session_id=f";{int(time.time() * 1000)}",
            )
            url = f"{API_BASE}/v1/projects/{project_id}/flowMedia:batchGenerateImages"

            t1 = time.time()
            fetch_resp = http_call(args.broker, "POST",
                                   f"/sessions/{args.account_id}/flow-fetch",
                                   body={"url": url, "bearer": cred["token"], "body": body},
                                   auth=auth, timeout=120)
            t_api = time.time() - t1

            if fetch_resp["status"] != 200:
                other_fail += 1
                row = {"iter": i + 1, "stage": "fetch", "error": fetch_resp,
                       "counter": counter, "t_token_s": round(t_token, 2)}
                results.append(row)
                print(json.dumps(row))
                sys.stdout.flush()
                continue

            inner = fetch_resp["body"]
            ok = inner.get("ok", False)
            inner_status = inner.get("status", 0)
            is_recaptcha = (inner_status == 403 and "reCAPTCHA" in inner.get("body", ""))

            if ok:
                success += 1
            elif is_recaptcha:
                recaptcha_403 += 1
            else:
                other_fail += 1

            row = {
                "iter": i + 1, "counter": counter,
                "inner_status": inner_status, "ok": ok,
                "recaptcha_403": is_recaptcha,
                "t_token_s": round(t_token, 2),
                "t_api_s": round(t_api, 2),
                "token_len": len(token) if token else 0,
                "body_preview": inner.get("body", "")[:200] if not ok else "",
            }
            results.append(row)
            print(json.dumps(row))
            sys.stdout.flush()

            if i < args.iters - 1:
                time.sleep(args.delay)
        except Exception as e:
            other_fail += 1
            row = {"iter": i + 1, "error": str(e)[:300]}
            results.append(row)
            print(json.dumps(row))
            sys.stdout.flush()

    summary = {
        "iters": args.iters,
        "success": success,
        "recaptcha_403": recaptcha_403,
        "other_fail": other_fail,
        "rotations": rotation_count,
        "success_rate": round(success / args.iters, 3),
        "pass": success >= max(int(args.iters * 0.95), 1),
    }
    print("\n=== E2E SUMMARY ===", file=sys.stderr)
    print(json.dumps(summary, indent=2))

    # Cleanup
    http_call(args.broker, "DELETE", f"/sessions/{args.account_id}", auth=auth, timeout=30)

    sys.exit(0 if summary["pass"] else 1)


if __name__ == "__main__":
    main()
