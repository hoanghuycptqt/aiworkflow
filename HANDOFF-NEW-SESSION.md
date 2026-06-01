# HANDOFF — VCW ARM migration done; next-session tasks

**Date:** 2026-06-01. **Author:** migration session. **Read this first in the new session.**

## 0. Current state (migration COMPLETE)

`thhflow.com` production now runs entirely on the **new Oracle Ampere ARM64 VPS** `149.118.130.165` (user `truonghoanghuy`, SSH key `cert/ssh-key-2026-06-01.key`). Image **and** video generation both verified working end-to-end.

- **Broker:** `python-broker` runs **invisible_playwright (x86_64 stealth Firefox) under FEX‑Emu** (binfmt auto-emulation on aarch64), `engine=invisible`, systemd unit `vcw-flow-broker` (`venv-x86`, `DISPLAY=:99`, `HOME=/home/truonghoanghuy`). Camoufox was tried and **fails reCAPTCHA Enterprise** (grecaptcha never initializes) — do not use it. FEX runs the *proven* engine.
- **Self-heal:** broker recovers from FEX node-driver pipe drops (`mint_token`/`flow_fetch` detect a dead browser → teardown + relaunch + retry; `_is_dead_browser_error`/`_is_alive` in `session_pool.py`).
- **Code:** branch `migrate/camoufox-arm` **merged to `main`** (HEAD `60a6ad6`); box tracks `main`; CI (`deploy.yml`) restarts the broker on `python-broker/` changes and works against the new box (`VPS_HOST` updated; `VPS_USER`/`VPS_SSH_KEY` unchanged — the `github-actions-deploy` pubkey was added to the box).
- **Old GCP VPS** (`instance-template-20260309-20260309-113128-a`, `34.21.142.187`) is **still running, untouched, as rollback** — NOT yet deleted.
- **Rollback safety on new box:** `/opt/vcw/app/server/prisma/dev.db.pre-cutover`; old broker unit `vcw-flow-broker.service.camoufox.bak`.
- **FEX spike scratch:** `/opt/fex-spike` (~455M) on the box can be deleted.

Full migration narrative: see memory `migration-arm-camoufox-progress` and `MIGRATION-ARM-CAMOUFOX.md`.

---

## TASK 1 — Delete the old GCP VPS

Pre-delete checklist (verify the new box has been solid for ~24h first):
1. `dig +short thhflow.com` → `149.118.130.165` (DNS fully propagated; matbao registrar, TTL 120).
2. New box healthy: `https://thhflow.com` 200; broker `/healthz` ok; a real image **and** video generation succeed; survives a reboot (`sudo reboot`, wait, re-check broker+server+nginx+xvfb all `active`).
3. Telegram webhook → new box (`getWebhookInfo` url = `https://thhflow.com/api/telegram/webhook`, no error).
4. CI: push a trivial commit to `main`, confirm `deploy.yml` deploys green to the new box.

Then decommission (GCP):
```bash
# optional final snapshot for archival
gcloud compute disks snapshot <old-boot-disk> --zone=asia-southeast1-a --snapshot-names=vcw-old-final
gcloud compute instances delete instance-template-20260309-20260309-113128-a --zone=asia-southeast1-a
```
After deletion, remove the rollback artifacts on the new box (`dev.db.pre-cutover`, `vcw-flow-broker.service.camoufox.bak`, `/opt/fex-spike`).

---

## TASK 2 — Compare token/cookie/reCAPTCHA: VPS thhflow vs mcp-server (Mac)

Both run the **same `python-broker`** + the same `invisible_playwright` Firefox, both run **EPHEMERAL** (cookie-injection per context; `BROKER_PROFILE_DIR=""` on both — persistent_context was abandoned in Docker). They differ in the *auth/refresh wrapper* around the broker.

| Dimension | VPS thhflow (ARM/FEX) | mcp-server (Mac/Rosetta) |
|---|---|---|
| Runtime | x86_64 invisible FF under **FEX-Emu**, systemd; Xvfb :99. FEX-only failure: node-driver pipe drop (self-heal added). | x86_64 invisible FF under **Rosetta** in Docker; Xvfb+noVNC in entrypoint. ~2-3× slower (90s nav). |
| Bearer (`access_token`, ~1h) | `Credential.token` (DB). Refreshed **just-in-time per `execute()`** by `ensureFreshToken()` (connector.js): fast Node GET `/fx/api/auth/session` with DB cookies. **No slow escalation; silently keeps old token on failure.** | `GOOGLE_FLOW_TOKEN` (.env). Refreshed **reactively on HTTP 401** via `refreshToken()` (token-refresh.js): **fast → slow** two-tier. |
| Cookies | `Credential.metadata.sessionCookies` (DB). Harvester two-tier (fast /session + slow /reload-via-firefox at `BROKER_PROFILE_BASE/<id>`) — **CURRENTLY DISABLED** (`DISABLE_COOKIE_HARVESTER=true`). Steady state survives only on `ensureFreshToken`. | `GOOGLE_FLOW_SESSION_COOKIES` (.env). Two-tier **always on**: fast `/session`; on `ACCESS_TOKEN_REFRESH_NEEDED` → slow `refreshViaFirefox` (standalone FF at `/app/firefox-profile`) rotates JWT, saves both. |
| reCAPTCHA mint | Identical: broker `_mint_with_settle` → `grecaptcha.enterprise.execute`, in-place reload on SDK-miss, rotation @**15**. | Identical, rotation @**12** + latency rotation @5s. |
| Login / re-login | **Automated Telegram-2FA** (login.py state machine) — but only if harvester enabled, and **breaks on new-device PASSKEY** → manual noVNC (tunnel-only). | **Manual noVNC only** (`manual-login.sh`, one command). |
| Failure recovery | 403→fresh mint(warm); SigninRedirect→409; FEX dead-driver self-heal. **No inline slow-path on 401/dead-session.** | 401→fast→slow refresh inline; dead-session bounce; SDK-miss reload; **ACCESS_TOKEN_REFRESH_NEEDED ground-truth discard**; terminal→clear pointer to manual-login.sh. |

### Why the MCP "never errors" (the mechanisms to port)
1. **Warm-forever browser** (`BROKER_IDLE_TIMEOUT_S=0`; live container idle ~24h still ready) — no cold-launch churn / trust-score loop. (VPS uses idle=600 → FEX cold-relaunch.)
2. **Auto-refresh-on-401 with slow-path escalation** (handle401 → refreshToken fast→slow) — recovers a ~20h session rollover **inline, without user 2FA**.
3. **`ACCESS_TOKEN_REFRESH_NEEDED` ground-truth detection** — discards the stale token NextAuth still returns (its `expires` is frozen in the past), avoiding the infinite-loop bug (ae23052, reverted 120d17b).
4. **Untouched persistent profile reservoir** (`/app/firefox-profile`) — the slow path rotates the JWT in a REAL browser page-load (not ephemeral injection), dodging the 2026-05-24 "rotate-to-dead-JWT" race.
5. Reload-not-close everywhere; per-account lock; atomic `.env`/DB writes; `_refreshing` concurrency guard.

### VPS gaps (vs MCP)
- Harvester **disabled** → no scheduled refresh + no automated re-login in steady state. **Biggest fragility.** Past ~20h the DB session-token → `ACCESS_TOKEN_REFRESH_NEEDED` and nothing auto-runs the slow Firefox refresh → manual recovery. *(Confirm WHY it was disabled before re-enabling — likely an incident.)*
- `ensureFreshToken` does **only** the fast `/session`, silently keeps the old token, no slow escalation, no `ACCESS_TOKEN_REFRESH_NEEDED` classification.
- New-device PASSKEY breaks automated Telegram login; noVNC is tunnel-only (not one-command).

---

## TASK 3 — Port the MCP's robust Flow-auth to the VPS

**Good news:** the VPS broker **already ships all the capability** — persistent-profile mode (`USE_PERSISTENT_PROFILE`, `_rotate_persistent`), the slow-path endpoints (`/reload-via-firefox`, `/cookies-from-profile`, `/save-cookies-to-profile`), per-account profile reservoir (`BROKER_PROFILE_BASE/<accountId>`), and `broker-client.js` `cookiesFromProfile/saveCookiesToProfile`. Porting is mostly **operational wiring**, not new code.

Priority order (low-risk → higher):
1. **Port `ACCESS_TOKEN_REFRESH_NEEDED` ground-truth discard into `connector.ensureFreshToken`** (mirror `mcp-server/lib/token-refresh.js:~166`). Pure correctness, ~0 risk — stop persisting a stale token.
2. **Add reactive slow-path escalation to `ensureFreshToken`** (mirror MCP `handle401→refreshToken` fast→slow): on `ACCESS_TOKEN_REFRESH_NEEDED`/missing token, call the existing `refreshCookiesViaBroker` (harvester's slow path → `/reload-via-firefox` at the per-account profile) **inline on the hot path**, re-validate, save. Guard with a process-level `_refreshing` flag so a batch doesn't fire N parallel Firefox reloads. This makes the VPS self-heal a ~20h rollover even with the cron down — the single biggest win.
3. **Re-enable the harvester** (`DISABLE_COOKIE_HARVESTER` unset/false) **after** confirming why it was disabled; re-test the Layer-2 `isCookieExpired` re-check + per-account `setTimeout` timing.
4. **Document/script a VPS `manual-login.sh` equivalent** (noVNC at `BROKER_PROFILE_BASE/<id>` on `:99` → snapshot cookies.sqlite → write `Credential.metadata.sessionCookies` → `save-cookies-to-profile`) so passkey-blocked recovery is one command.
5. *(Optional, validate first)* Persistent-profile mode for the live mint context + raise `IDLE_TIMEOUT_S` toward warm-forever — the Docker 181s `launch_persistent_context` timeout was a **Docker seccomp** constraint that **may not apply on the native systemd VPS**; A/B per-account before fleet-wide.

Reference files: `mcp-server/lib/{token-refresh.js,firefox-refresh.js,recaptcha.js,google-flow-api.js}` (the robust reference) vs `server/src/connectors/google-flow/connector.js` (`ensureFreshToken` = port target) + `server/src/services/cookie-harvester.js` (`refreshCookiesViaBroker` to reuse) + `python-broker/broker/{session_pool,profile_reload,app}.py` (capability already present).

---

## Gotchas to remember
- **Camoufox is a dead end** for reCAPTCHA on Flow — don't revisit it.
- The x86_64 Firefox is placed manually (invisible's `fetch` aborts on aarch64); cache `~truonghoanghuy/.cache/invisible-playwright/firefox-7`. FEX rootfs `~/.local/share/fex-emu/RootFS/Ubuntu_24_04`.
- Broker **dep** changes need a manual `pip install` in `venv-x86` under FEX + restart (CI only `git pull` + `systemctl restart`, doesn't reinstall the venv).
- `moz_cookies` DDL is FF-version-pinned (FF150 for invisible) — a Firefox version drift silently wipes the cookie snapshot.
- Soak-test the ~20-25 req/session cliff under FEX (only a few mints done so far).
