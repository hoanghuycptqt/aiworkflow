# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Video Creator Workflow (VCW) is a bulk video-production automation platform. Users build DAG-shaped workflows on a React Flow canvas; the backend topologically sorts the graph and runs each node through a connector that talks to an AI service (Gemini, ChatGPT, Google Flow, OpenRouter) or performs a utility step (file upload/download, delay, text template, text extraction). A separate MCP server exposes Google Flow's image/video generation directly to MCP clients (Claude/Antigravity).

The Google Flow connector's design constraints are load-bearing — there's a history of subtle regressions (commits `acc3a26`, `6f03021`). See the [Google Flow connector](#google-flow-connector--read-this-before-touching-it) section below and `git log -- server/src/connectors/google-flow/connector.js` for incident context.

## Repository Layout

This is a multi-package repo with three Node services and no monorepo tool:

- `server/` — Express + Prisma (SQLite) + Socket.IO API. Workflow engine, job runner, connectors, Telegram bot, Google login agent, Cookie Harvester cron. ESM (`"type": "module"`).
- `client/` — React 19 + Vite 7 + React Router 7 + `@xyflow/react` (React Flow) + `socket.io-client`. SPA served as static files via nginx in prod.
- `mcp-server/` — Standalone MCP server exposing Google Flow generation/upscale as tools over stdio. Has its own Prisma schema; reads credentials from the shared SQLite DB.
- `nginx/`, `scripts/`, `ecosystem.config.cjs` — VPS deployment artifacts.
- `.github/workflows/deploy.yml` — On push to `main`, SSH into the GCP VPS, pull, install, `prisma db push`, build client, `pm2 restart`.

## Common Commands

Install everything: `npm run install:all` (root + server + client; mcp-server installs separately).

Dev (server + client concurrently): `npm run dev` from repo root.
- Server alone: `cd server && npm run dev` (uses `node --watch`, port 3001).
- Client alone: `cd client && npm run dev` (Vite, port 5173).

Database (run from `server/`):
- `npm run db:generate` — Regenerate Prisma client.
- `npm run db:push` — Push schema to SQLite without creating a migration (used by CI/CD on deploy).
- `npm run db:migrate` — Create a dev migration.

Client lint: `cd client && npm run lint` (ESLint flat config; no server-side linter is configured).

Client build: `npm run build` (root) or `cd client && npm run build` — output goes to `client/dist/`.

MCP server: `cd mcp-server && npm start`. To debug interactively: `npm run inspect` (launches `@modelcontextprotocol/inspector`).

reCAPTCHA / Google Flow VPS diagnostic: `cd server && node test-recaptcha-vps.mjs` (uses the `sqlite3` CLI for ESM compatibility on the VPS — do not rewrite to use the Prisma client there).

No automated test suite exists. Verify changes by running `npm run dev` and exercising the affected flow in the browser/MCP client.

## Architecture

### Workflow Engine ([server/src/services/workflow-engine.js](server/src/services/workflow-engine.js))

A workflow is `nodesData` + `edgesData` JSON stored on the `Workflow` Prisma model — exactly what React Flow emits. Execution:

1. `executeWorkflow(executionId, userId)` loads the graph, then `buildExecutionGraph` runs **Kahn's topological sort**. Isolated nodes (zero in *and* out edges) are skipped; cycles throw.
2. A per-execution `jobDir` is created under `uploads/jobs/<workflowName>_<timestamp>/` and passed to every connector via `context._jobDir` — connectors write artifacts there.
3. Each node's input is the merged outputs of its upstream nodes (or `context._input` for source nodes). Config values support `{{nodeId.field}}` template substitution resolved against `context`.
4. The connector for `node.data.type` is looked up in the registry, given input/credentials/config/context, and its output is stored in `context[nodeId]` for downstream nodes.
5. Status updates are written to `NodeExecution` rows and emitted over Socket.IO to `user:<userId>` and `execution:<executionId>` rooms.
6. Cancellation is checked by re-reading the `WorkflowExecution.status` between nodes — setting it to `cancelled` aborts the run cooperatively.

### Job Batches ([server/src/services/job-runner.js](server/src/services/job-runner.js))

`Job` is a *parameterization* of a workflow (e.g. "Scene 1 inputs"). `runJobBatch` creates a `JobBatch` row, spawns one `WorkflowExecution` per job, and runs them in `parallel` (with `concurrency` limit) or `sequential` mode. Batch progress is aggregated by counting child execution statuses.

### Connectors ([server/src/connectors/](server/src/connectors/))

All connectors extend `BaseConnector` and are registered in [registry.js](server/src/connectors/registry.js) by node type string (`ai-text`, `google-flow-image`, `google-flow-video`, `chatgpt-note`, `file-upload`, `file-download`, `delay`, `text-template`, `text-extractor`). Each exposes static `metadata` (name, icon, category, configSchema) consumed by the frontend palette, and an async `execute(input, credentials, config, context)` returning the output object.

To add a node type: create `connectors/<name>/connector.js` extending `BaseConnector`, register it in `registry.js`, and the React Flow palette will pick up the metadata automatically.

### Google Flow connector — read this before touching it

reCAPTCHA Enterprise is defeated by a **stealth Firefox driven through the Python broker** ([python-broker/](python-broker/)) — NOT Chrome/Puppeteer anymore (the old Chrome path in commits `acc3a26`/`6f03021` is history; the engine moved to `invisible_playwright` on 2026-05-21, see memory `google-flow-broker-live`). [server/src/connectors/google-flow/connector.js](server/src/connectors/google-flow/connector.js) is now a thin Node client: it gets the bearer from `/fx/api/auth/session`, asks the broker to mint a reCAPTCHA token, and does the generation fetch **inside the broker's warm Firefox page** (`flow-fetch`). The broker ([python-broker/broker/session_pool.py](python-broker/broker/session_pool.py)) owns the browser. Load-bearing invariants — do NOT change without reading `git log` + memory `recaptcha-incident-history`:

- **Warm browser, rotate the CONTEXT not the process**: one Firefox process per Google account stays alive; the context rotates at `ROTATION_THRESHOLD` (15) requests to stay under the stochastic ~20-25 reCAPTCHA cliff (Phase 0). Idle close is the only mid-life process teardown.
- **NEVER close the browser on a 403 reCAPTCHA retry** (`6f03021`): reuse the warm browser, just mint a fresh token. Closing destroys trust score → self-reinforcing cold-launch loop (78% fail rate observed).
- **Reload, never close, on a sticky/SDK glitch**: `_mint_with_settle` does an in-place `page.reload()` (≤3) when grecaptcha is missing (`broker-grecaptcha-mint-race`, `recaptcha-page-reload-recovery`).
- **Cookie domain integrity**: cookies are seeded under BOTH `.google.com` AND `.labs.google`; on readback prefer the `.labs.google` copy (`cookies.stringify_cookies`) — the `.google.com` shadow can be a stale pre-rotation JWT (2026-05-24 10s-loop incident).
- **Dead-browser self-heal** (ARM/FEX): `_is_dead_browser_error`/`_is_alive` + teardown+relaunch+retry in `mint_token`/`flow_fetch` recover from FEX node-driver pipe drops.

### Two deployments of the broker (keep them straight)

The SAME `python-broker` + `invisible_playwright` Firefox runs in two distinct systems — see memories `system-thhflow-vps` and `system-mcp-server-mac`, and `HANDOFF-NEW-SESSION.md`:

1. **thhflow (production web platform)** — Oracle Ampere **ARM64 VPS** `149.118.130.165`. The x86_64 Firefox runs **under FEX-Emu** (binfmt), `engine=invisible`, systemd `vcw-flow-broker`. Auth driven by the Express server's connector + `cookie-harvester` (currently disabled). Camoufox was tried here and **fails reCAPTCHA** — invisible-under-FEX is the only working engine.
2. **mcp-server** — the user's **Mac**, broker in Docker via **Rosetta 2**. Auth driven by `mcp-server/lib/*` (warm-forever browser, auto-refresh-on-401, slow Firefox-at-profile refresh) — the rock-solid reference whose robustness is being ported to the VPS.

`browser-manager.js` (Puppeteer/Chrome) is legacy for the dead `google-login-agent.js` path; the live Flow connector uses the broker, not browser-manager. On Linux the broker's Firefox renders headful on Xvfb `:99` (`headless:false` is required; never true-headless for Flow).

### Auth & Real-time

- JWT auth ([server/src/middleware/auth.middleware.js](server/src/middleware/auth.middleware.js)). Admin routes additionally pass through `requireAdmin`.
- Socket.IO authenticates via `socket.handshake.auth.token`, joins `user:<userId>` automatically, and clients can join `execution:<id>` / `batch:<id>` rooms for live progress.
- The Telegram webhook route (`POST /api/telegram/webhook`) is mounted **before** `authMiddleware` — Telegram POSTs directly with no auth. Don't move it under the protected mount.

### Cookie Harvester ([server/src/services/cookie-harvester.js](server/src/services/cookie-harvester.js)) — thhflow VPS only

Per-account cron (started from `server/src/index.js`) that refreshes Google Flow cookies/tokens and stores them in the `Credential` table (`provider='google-flow'`, in `metadata.sessionCookies` + `token`). Two-tier: fast `/fx/api/auth/session` (~1h access_token) → slow `/reload-via-firefox` (standalone Firefox at `BROKER_PROFILE_BASE/<accountId>`, ~20h NextAuth maxAge). **Currently DISABLED** via `DISABLE_COOKIE_HARVESTER=true` (so in steady state the bearer is kept fresh only by the connector's per-execute `ensureFreshToken`) — re-enabling + wiring its slow path into the hot request path is the main robustness port (see `HANDOFF-NEW-SESSION.md`). This is the VPS's own credential store — the Mac mcp-server does NOT read these DB rows (it has its own `.env`).

### MCP Server ([mcp-server/](mcp-server/)) — the Mac system (separate from thhflow VPS)

The standalone stdio MCP server on the user's **Mac** (NOT on the VPS). Stdio transport — **all logs go to `console.error`** (`console.log` corrupts the protocol; that's also why `lib/db.js` parses `.env` manually instead of dotenv). Tools: `list-credentials`, `generate-image`, `generate-video`, `upscale-image`, `upscale-video`. It keeps its OWN credentials in `mcp-server/.env` (`GOOGLE_FLOW_TOKEN`/`GOOGLE_FLOW_SESSION_COOKIES`), refreshed reactively on HTTP 401 by `lib/token-refresh.js` (fast `/session` → slow `lib/firefox-refresh.js` at the persistent profile). It drives the broker in **Docker via Rosetta 2**. This is the rock-solid reference being ported to the VPS — see memory `system-mcp-server-mac`.

### Frontend

- [client/src/App.jsx](client/src/App.jsx) — Router + theme bootstrap (localStorage → prefers-color-scheme → dark default, with live OS theme sync when no explicit choice).
- `client/src/services/api.js` — REST client. `socket.js` — Socket.IO client. `nodeTypes.js` — React Flow node-type registry mirrored against the server's connector metadata.
- The Workflow Builder canvas lives in `client/src/components/WorkflowBuilder/`.

## Deployment

**Production VPS** — migrated 2026-06-01 from GCP x86_64 to an **Oracle Cloud Ampere A1 ARM64** instance (the old GCP box `instance-template-20260309-…` may still exist briefly as rollback; decommission per `HANDOFF-NEW-SESSION.md`). Details + full migration story: memory `system-thhflow-vps`, `migration-arm-camoufox-progress`, `MIGRATION-ARM-CAMOUFOX.md`.
- Public IP: `149.118.130.165` · Arch: **aarch64** (Ubuntu 24.04) · Domain: `thhflow.com` (matbao registrar, A→IP)
- App dir: `/opt/vcw/app` · System user: `truonghoanghuy` · nginx 443 (Sectigo cert `/etc/ssl/thhflow`, valid 2027-03) + Xvfb `:99`
- **Broker = `invisible_playwright` x86_64 stealth Firefox running under FEX-Emu** (binfmt x86_64 auto-emulation on ARM), systemd `vcw-flow-broker` (`venv-x86`, `DISPLAY=:99`, `HOME=/home/truonghoanghuy`, `BROKER_BROWSER_ENGINE=invisible`). FEX rootfs `~truonghoanghuy/.local/share/fex-emu/RootFS/Ubuntu_24_04`; Firefox cache `~/.cache/invisible-playwright/firefox-7` (placed manually — invisible's `fetch` aborts on aarch64).

**SSH into the VPS:**
```bash
ssh -i "<repo>/cert/ssh-key-2026-06-01.key" truonghoanghuy@149.118.130.165   # chmod 600 the key first
```

**VPS maintenance:**
- Server: `pm2 restart vcw-server --update-env` · `pm2 logs vcw-server --lines 100`
- Broker (FEX): `sudo systemctl restart vcw-flow-broker` · `sudo tail -f /opt/vcw/logs/broker-error.log` (broker INFO logs go to **stderr→broker-error.log**, not broker.log) · `curl 127.0.0.1:8002/healthz`
- Kill stuck Firefox: `pkill -f firefox-7/firefox` (the FEX-emulated browser; there is no Chrome anymore)

CI/CD is push-to-`main`. [.github/workflows/deploy.yml](.github/workflows/deploy.yml) SSHes in (secrets `VPS_HOST`=new IP, `VPS_USER`=truonghoanghuy, `VPS_SSH_KEY`=`github-actions-deploy`), runs `git pull && npm run install:all && prisma db push && vite build && pm2 restart`, and **restarts `vcw-flow-broker` when `python-broker/` changed** (+ healthz check). The broker venv (`venv-x86`) is editable-installed, so code changes apply on git-pull+restart; **broker DEPENDENCY changes need a manual `pip install` in venv-x86 under FEX**. PM2 app `vcw-server`; logs `/opt/vcw/logs/`.

The legacy `CHROME_PATH` env is dead (no Chrome on the VPS). Telegram runs in webhook mode (`https://thhflow.com/api/telegram/webhook`).

**The other system — `mcp-server` on the Mac** is a SEPARATE deployment (Docker broker via Rosetta 2), not on the VPS. See memory `system-mcp-server-mac`. Don't conflate the two.

## Conventions Worth Knowing

- Server is ESM (`"type": "module"`) — use `import`, not `require`. Same for `mcp-server/`.
- Prisma client is a single instance exported from `server/src/index.js` as `prisma` and the Socket.IO server as `io`. Import from there rather than instantiating new clients.
- Node IDs in workflows are React Flow's; node *type* lives at `node.data.type` (NOT `node.type`, which is the React Flow visual type).
- File uploads live under `server/uploads/` (gitignored). Per-execution artifacts go in `uploads/jobs/<workflow>_<ts>/`. Chrome profiles in `uploads/.cp/` and `uploads/.google-profiles/`.
- Vietnamese is fine in user-facing strings and commit messages — the project is primarily Vietnamese-language.
