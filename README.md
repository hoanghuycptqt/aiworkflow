# Video Creator Workflow (VCW)

Nền tảng tự động hóa sản xuất video AI quy mô lớn. Người dùng build workflow dạng DAG trên canvas React Flow; backend topological-sort đồ thị rồi chạy từng node qua các connector kết nối tới Gemini, ChatGPT, Google Flow, OpenRouter. Một MCP server riêng expose Google Flow image/video generation cho các MCP client (Claude/Antigravity).

## Cấu trúc 3 service

- `server/` — Express + Prisma (SQLite) + Socket.IO. Workflow engine, job runner, connectors, Telegram bot, Cookie Harvester.
- `client/` — React 19 + Vite 7 + React Router 7 + `@xyflow/react`. SPA cho workflow canvas.
- `mcp-server/` — Standalone MCP server (stdio) expose Google Flow tools cho MCP client.

## Khởi động local

```bash
npm run install:all      # install root + server + client (mcp-server install riêng)
npm run dev              # server (port 3001) + client (port 5173) concurrent
```

Cần `.env` trong `server/` — xem [server/.env.example](server/.env.example).

## Lệnh hay dùng

| Mục đích | Lệnh |
|---|---|
| Dev cả 2 service | `npm run dev` |
| Chỉ server | `cd server && npm run dev` |
| Chỉ client | `cd client && npm run dev` |
| Lint client | `cd client && npm run lint` |
| Build production client | `npm run build` |
| Prisma push schema | `cd server && npm run db:push` |
| Prisma migration mới | `cd server && npm run db:migrate` |
| MCP server | `cd mcp-server && npm start` |
| Debug MCP qua inspector | `cd mcp-server && npm run inspect` |
| Diagnostic reCAPTCHA trên VPS | `cd server && node test-recaptcha-vps.mjs` |

## Deploy

Push `main` → GitHub Actions tự SSH vào VPS GCP, pull, install, `prisma db push`, build client, `pm2 restart vcw-server`. Cấu hình tại [.github/workflows/deploy.yml](.github/workflows/deploy.yml).

VPS info chi tiết (SSH command, maintenance) — xem section **Deployment** trong [CLAUDE.md](CLAUDE.md).

## Tài liệu

- **[CLAUDE.md](CLAUDE.md)** — Hướng dẫn đầy đủ cho Claude Code / dev: architecture, conventions, deployment, Google Flow connector design constraints.
- **[.claude/agents/](.claude/agents/)** — Custom subagent definitions (vps-devops).
- **Git history**: `git log -- server/src/connectors/google-flow/connector.js` cho incident history reCAPTCHA.

## Không commit

- `.env`, `.env.*` — credentials
- `server/uploads/`, `mcp-server/uploads/` — file user
- `node_modules/`, `*.db` — sinh ra runtime
- `cert/` — SSL certs
