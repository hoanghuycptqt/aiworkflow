"""Entrypoint: `python -m broker` → uvicorn on 127.0.0.1:8002 by default."""

import uvicorn

from broker.config import HOST, PORT


def main():
    uvicorn.run(
        "broker.app:app",
        host=HOST,
        port=PORT,
        log_level="info",
        access_log=False,  # too noisy; we log meaningful events inside session_pool
        # No reload — uvicorn workers don't play nice with the global SessionPool state.
    )


if __name__ == "__main__":
    main()
