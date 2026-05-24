"""FastAPI app exposing the Google Flow broker endpoints over loopback."""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel

from broker.config import AUTH_TOKEN
from broker.profile_cookies import read_profile_cookies, resolve_profile_dir
from broker.profile_snapshot import save_cookies_to_profile
from broker.session_pool import SessionPool, SigninRedirectError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("broker.app")

pool = SessionPool()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("broker starting; auth=%s rotation=15 idle=10m",
                "enabled" if AUTH_TOKEN else "disabled")
    yield
    logger.info("broker shutting down; closing all sessions")
    await pool.close_all()


app = FastAPI(title="vcw-flow-broker", lifespan=lifespan)


# ── Auth (defense-in-depth on top of loopback bind) ────────────────────────

async def require_auth(authorization: str | None = Header(default=None)) -> None:
    if not AUTH_TOKEN:
        return  # auth disabled (dev)
    expected = f"Bearer {AUTH_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad token")


# ── Request models ─────────────────────────────────────────────────────────

class InitRequest(BaseModel):
    cookies: str = ""


class RecaptchaRequest(BaseModel):
    action: str  # IMAGE_GENERATION or VIDEO_GENERATION


class FlowFetchRequest(BaseModel):
    url: str
    bearer: str
    body: dict


class LoginRequest(BaseModel):
    email: str
    password: str


# ── Endpoints ──────────────────────────────────────────────────────────────

@app.get("/healthz")
def healthz():
    return {"ok": True, "sessions": pool.list_active()}


@app.post("/sessions/{account_id}/init", dependencies=[Depends(require_auth)])
async def init_session(account_id: str, req: InitRequest):
    sess = await pool.get_or_create(account_id, req.cookies)
    try:
        async with sess.lock:
            await sess.ensure_ready()
        return {"ready": True, "request_count": sess.request_count}
    except SigninRedirectError as e:
        # Caller should refresh cookies in DB and retry init.
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.exception(f"init failed for {account_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sessions/{account_id}/recaptcha-token", dependencies=[Depends(require_auth)])
async def get_recaptcha_token(account_id: str, req: RecaptchaRequest):
    sess = await pool.get_or_create(account_id)
    try:
        token, count = await sess.mint_token(req.action)
        return {"token": token, "request_count": count}
    except SigninRedirectError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.exception(f"mint_token failed for {account_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sessions/{account_id}/flow-fetch", dependencies=[Depends(require_auth)])
async def flow_fetch(account_id: str, req: FlowFetchRequest):
    sess = await pool.get_or_create(account_id)
    try:
        result = await sess.flow_fetch(req.url, req.bearer, req.body)
        return result
    except SigninRedirectError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.exception(f"flow_fetch failed for {account_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sessions/{account_id}/reload", dependencies=[Depends(require_auth)])
async def reload_session(account_id: str):
    sess = await pool.get_or_create(account_id)
    try:
        await sess.reload()
        return {"ready": True, "request_count": sess.request_count}
    except SigninRedirectError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.exception(f"reload failed for {account_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sessions/{account_id}/harvest-cookies", dependencies=[Depends(require_auth)])
async def harvest_cookies(account_id: str):
    sess = await pool.get_or_create(account_id)
    try:
        cookies = await sess.harvest_cookies()
        return {"cookies": cookies}
    except SigninRedirectError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.exception(f"harvest_cookies failed for {account_id}")
        raise HTTPException(status_code=500, detail=str(e))


class SaveCookiesToProfileRequest(BaseModel):
    cookies: str


@app.post("/sessions/{account_id}/cookies-from-profile", dependencies=[Depends(require_auth)])
async def cookies_from_profile(account_id: str):
    """Extract cookies directly from a persistent Firefox profile on disk.

    Recovery path used by `mcp-server/lib/token-refresh.js` (Mac) and
    `server/src/services/cookie-harvester.js` (VPS) when the normal
    refresh produces a dead session — NextAuth rotated
    `__Secure-next-auth.session-token` to a JWT that can't be refreshed.

    Profile location:
    - VPS (BROKER_PROFILE_BASE set): reads `{BROKER_PROFILE_BASE}/{account_id}`,
      which `save_cookies_to_profile` populated at the last successful login.
    - Mac (BROKER_PROFILE_BASE unset): reads `/app/firefox-profile`, populated
      by scripts/manual-login.sh (single-account dev setup).

    Either way the dir is NEVER touched by the broker's normal ephemeral
    session pool, so its JWT stays at the post-login state until the next
    login overwrites it.

    Returns:
        {"status": "ok", "cookies": "name=val; …"}
        {"status": "no_profile"}        — dir/sqlite missing
        {"status": "no_session_token"}  — sqlite exists but login never completed
    """
    profile_dir = resolve_profile_dir(account_id)
    try:
        return await asyncio.to_thread(read_profile_cookies, profile_dir)
    except Exception as e:
        logger.exception(f"cookies_from_profile failed for {account_id} ({profile_dir})")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sessions/{account_id}/save-cookies-to-profile", dependencies=[Depends(require_auth)])
async def save_cookies_to_profile_endpoint(account_id: str, req: SaveCookiesToProfileRequest):
    """Persist a cookieString to the per-account profile dir for later recovery.

    Called by `server/src/services/google-login-agent.js` immediately after a
    successful broker login. Spawns a short-lived persistent_context Firefox,
    runs add_cookies, navigates to about:blank (forces Firefox to flush its
    cookie store to sqlite), and closes. The profile dir is then ready for
    `cookies-from-profile` to read on dead-JWT recovery.

    No-op (returns `no_profile_base`) when BROKER_PROFILE_BASE is unset,
    which is the Mac docker default — manual-login.sh handles that case
    instead of this endpoint.

    Returns:
        {"status": "ok", "profile_dir": "...", "cookies_count": N}
        {"status": "no_profile_base"}  — env var not set, snapshot disabled
        {"status": "error", "message": "..."}
    """
    if not req.cookies or len(req.cookies) < 50:
        raise HTTPException(status_code=400, detail="cookies too short / missing")
    try:
        return await save_cookies_to_profile(account_id, req.cookies)
    except Exception as e:
        logger.exception(f"save_cookies_to_profile failed for {account_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sessions/{account_id}/refresh-cookies", dependencies=[Depends(require_auth)])
async def refresh_cookies(account_id: str, req: InitRequest):
    """Refresh cookies for an account: re-navigate Flow page and return fresh cookies.

    Replaces the Chrome refreshCookies() in google-login-agent.js. Caller passes
    the current DB cookies (so a brand-new session can be seeded if the broker
    has cold-started since the last refresh).

    Returns {status: "ok", cookies}, OR {status: "needs_relogin"} on signin redirect.
    """
    sess = await pool.get_or_create(account_id, req.cookies)
    try:
        cookies = await sess.refresh_cookies()
        return {"status": "ok", "cookies": cookies}
    except SigninRedirectError as e:
        return {"status": "needs_relogin", "message": str(e)}
    except Exception as e:
        logger.exception(f"refresh_cookies failed for {account_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sessions/{account_id}/login", dependencies=[Depends(require_auth)])
async def start_login(account_id: str, req: LoginRequest):
    """Begin a background login flow. Returns immediately with {started: true}.

    Caller should poll GET /sessions/{id}/login-status for progress. When the
    state becomes "awaiting_2fa", screenshot_path is set and caller is expected
    to relay the screenshot via Telegram/Gemini and wait for user approval on
    their phone. When the state becomes "completed" or "failed", the flow is
    done.
    """
    sess = await pool.get_or_create(account_id)
    try:
        await sess.start_login(req.email, req.password)
        return {"started": True, "state": sess.login_state.value}
    except Exception as e:
        logger.exception(f"start_login failed for {account_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/sessions/{account_id}/login-status", dependencies=[Depends(require_auth)])
async def login_status(account_id: str):
    sess = await pool.get_or_create(account_id)
    return sess.login_status_snapshot()


@app.delete("/sessions/{account_id}", dependencies=[Depends(require_auth)])
async def close_session(account_id: str):
    await pool.delete(account_id)
    return {"closed": True}
