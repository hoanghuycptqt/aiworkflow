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

[server/src/connectors/google-flow/connector.js](server/src/connectors/google-flow/connector.js) uses Puppeteer-controlled native Chrome to defeat reCAPTCHA. The current behavior is the product of multiple production incidents (commits `acc3a26`, `6f03021`). Do NOT change any of the following without consulting `git log -- server/src/connectors/google-flow/connector.js`:

- **Persistent Chrome profiles** in `uploads/.google-profiles/` kept warm via a `_chromePool` (10-min idle timeout) to accumulate reCAPTCHA trust score. Do not switch to ephemeral profiles.
- **Self-heal on launch**: `SingletonLock`/`SingletonSocket`/`SingletonCookie` are deleted before every launch — Chrome leaves these behind on crash and silently fails to start next time.
- **Cookie domain integrity**: `setCookie` is only called when the profile has no existing cookies on disk; otherwise the saved `.google.com` cookies are preserved. Setting them under `labs.google` tanks the trust score.
- **Session recovery**: redirect to a login page triggers a cookie wipe + reload from the `CookieHarvester` DB.
- **NEVER close Chrome on a 403 retry** (`6f03021` fix): the 403-retry path must reuse the warm browser and only fetch a fresh reCAPTCHA token. Closing Chrome destroys trust score and creates a self-reinforcing cold-launch loop (observed 78% fail rate on VPS). 10-min idle timeout is the ONLY mid-life close path.

### Browser Manager ([server/src/services/browser-manager.js](server/src/services/browser-manager.js))

Centralizes all Puppeteer launches. Two important details:

- Profiles live under `uploads/.cp/p<N>` (short paths) to stay under macOS's 104-byte Unix socket limit for Chrome's `SingletonSocket`.
- On Linux without `$DISPLAY`, it auto-starts Xvfb on `:99` (1280×1024×24). The `headless: false` mode is required by Google Flow — never switch to true headless for that connector.

Two entry points: `acquireBrowser(key, opts)` for per-user keyed instances (close-and-relaunch semantics) and `launchTempBrowser(opts)` for one-off validators.

### Auth & Real-time

- JWT auth ([server/src/middleware/auth.middleware.js](server/src/middleware/auth.middleware.js)). Admin routes additionally pass through `requireAdmin`.
- Socket.IO authenticates via `socket.handshake.auth.token`, joins `user:<userId>` automatically, and clients can join `execution:<id>` / `batch:<id>` rooms for live progress.
- The Telegram webhook route (`POST /api/telegram/webhook`) is mounted **before** `authMiddleware` — Telegram POSTs directly with no auth. Don't move it under the protected mount.

### Cookie Harvester ([server/src/services/cookie-harvester.js](server/src/services/cookie-harvester.js))

Cron started from `server/src/index.js` after listen. Refreshes Google Flow cookies/tokens on a schedule and stores them in the `Credential` table (`provider = 'google-flow'`). The MCP server reads the same rows.

### MCP Server ([mcp-server/](mcp-server/))

Stdio transport — **all logs go to `console.error`**; `console.log` corrupts the MCP protocol. Tools: `list-credentials`, `generate-image`, `generate-video`, `upscale-image`, `upscale-video`. `lib/token-refresh.js` keeps Google Flow bearer tokens fresh; `lib/recaptcha.js` shares the same trust-score logic as the server connector.

### Frontend

- [client/src/App.jsx](client/src/App.jsx) — Router + theme bootstrap (localStorage → prefers-color-scheme → dark default, with live OS theme sync when no explicit choice).
- `client/src/services/api.js` — REST client. `socket.js` — Socket.IO client. `nodeTypes.js` — React Flow node-type registry mirrored against the server's connector metadata.
- The Workflow Builder canvas lives in `client/src/components/WorkflowBuilder/`.

## Deployment

**VPS infrastructure** (Google Cloud Platform):
- Instance: `instance-template-20260309-20260309-113128-a`
- Zone: `asia-southeast1-a`
- Domain: `thhflow.com`
- App directory on VPS: `/opt/vcw/app`
- System user: `truonghoanghuy`
- Environment: Ubuntu + Xvfb (headless browser) + Nginx reverse proxy

**SSH into the VPS:**
```bash
gcloud compute ssh instance-template-20260309-20260309-113128-a --zone=asia-southeast1-a --tunnel-through-iap
```

**VPS maintenance commands** (run after SSH):
- Restart server: `pm2 restart vcw-server --update-env`
- Tail logs: `pm2 logs vcw-server --lines 100`
- Kill stuck Chrome: `pkill -f chrome`

CI/CD is push-to-`main` only. Workflow in [.github/workflows/deploy.yml](.github/workflows/deploy.yml) SSHes into the VPS, runs `git pull && npm run install:all && prisma db push && vite build && pm2 restart ecosystem.config.cjs --update-env`. PM2 app name is `vcw-server`; logs are at `/opt/vcw/logs/`. Nginx config template is at [nginx/vcw.conf](nginx/vcw.conf).

Two env templates exist: [server/.env.example](server/.env.example) (local — Telegram polling mode, no `CHROME_PATH`) and [server/.env.production.example](server/.env.production.example) (VPS — Telegram webhook mode, `CHROME_PATH=/usr/bin/google-chrome`). The Chrome path is critical; the wrong one silently breaks all browser-driven connectors.

## Conventions Worth Knowing

- Server is ESM (`"type": "module"`) — use `import`, not `require`. Same for `mcp-server/`.
- Prisma client is a single instance exported from `server/src/index.js` as `prisma` and the Socket.IO server as `io`. Import from there rather than instantiating new clients.
- Node IDs in workflows are React Flow's; node *type* lives at `node.data.type` (NOT `node.type`, which is the React Flow visual type).
- File uploads live under `server/uploads/` (gitignored). Per-execution artifacts go in `uploads/jobs/<workflow>_<ts>/`. Chrome profiles in `uploads/.cp/` and `uploads/.google-profiles/`.
- Vietnamese is fine in user-facing strings and commit messages — the project is primarily Vietnamese-language.
