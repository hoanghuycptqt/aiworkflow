"""FastAPI app exposing the Google Flow broker endpoints over loopback."""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel

from broker.config import AUTH_TOKEN
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


@app.delete("/sessions/{account_id}", dependencies=[Depends(require_auth)])
async def close_session(account_id: str):
    await pool.delete(account_id)
    return {"closed": True}
