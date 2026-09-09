# Class ComfyUI — self-hosted classroom management for centrally hosted ComfyUI

Production-ready platform for a university GPU lab (RTX A6000 48GB / RTX 4090 24GB).
Students use ComfyUI in a browser; **no local inference**. ComfyUI is an execution
backend only — this platform is the source of truth for users, sessions, admins,
classes, rosters, enrollments, auth, workers, jobs, quotas, and auditing.

```
                    Internet
                       | HTTPS/TLS
                      FRPS
                       | FRPC
                    HTTP only (127.0.0.1:8080)
                   nginx reverse proxy
                    /             \
        comfy-admin.*          comfy.*
            web:3000          gateway:8081
                    \             /
                  PostgreSQL + Redis
                         |
              A6000-01 A6000-02 4090-01 (ComfyUI, never direct to students)
```

## 1. Architecture

- `apps/web` — Next.js 14 App Router management frontend + API (`:3000` internally).
- `apps/gateway` — ComfyUI auth gateway: `/auth/exchange`, `/prompt` interception,
  `/ws` proxy, worker scheduling, output archival (`:8081` internally).
- `packages/database` — Drizzle schema + idempotent DDL + seed.
- `packages/auth` — tokens (hashed at rest), HS256 workspace JWT, admin-code check,
  rate limiter, roster CSV parser/reconciler.
- `packages/shared` — Zod schemas, header stripping, path sanitization.
- `packages/config` — `PUBLIC_URL`/`COMFY_PUBLIC_URL` parsing, strict origin logic.
- `deploy/nginx/default.conf` — host-based routing, WebSocket upgrade, HTTP only.
- `deploy/frp/frpc.example.toml` — TLS/public exposure via FRPS/FRPC (not in Compose).
- Postgres 17 + Redis 7 via Compose (no host ports by default; only nginx `:8080`).

## 2. Ports

| Service               | Internal | Host                         |
| --------------------- | -------- | ---------------------------- |
| nginx                 | :80      | **8080** (only public entry) |
| web                   | :3000    | internal                     |
| gateway               | :8081    | internal                     |
| postgres              | :5432    | none                         |
| redis                 | :6379    | none                         |
| ComfyUI workers       | :8188    | none (never direct)          |
| mailpit (dev profile) | :8025    | 8025                         |

## 3–4. PUBLIC_URL / strict origin behavior

- `PUBLIC_URL` (e.g. `https://comfy-admin.example.edu`) is the **single canonical**
  externally visible URL of the Next.js app, configured in `docker-compose.yml`.
- Allowed browser origin = `new URL(PUBLIC_URL).origin` — exactly one value.
- No `ALLOWED_ORIGINS=*`, no Host/Origin reflection, no suffix/substring matching.
- State-changing `/api/*` requests (`POST/PATCH/PUT/DELETE`) require exact `Origin`
  match → else `403`. When `Origin` is absent, strict canonical-host fallback applies
  (see `packages/config/src/index.ts:isAllowedBrowserOrigin`).
- CORS (if used) allows only the canonical origin, never `*` with credentials.
- All login/verification/signup links, redirects, and canonical links are built from
  `PUBLIC_URL` via `appUrl()` — never from `Host`/`X-Forwarded-Host`/`Origin`.
- `COMFY_PUBLIC_URL` (e.g. `https://comfy.example.edu`) is the separate gateway
  boundary; the gateway enforces its own expected origin identically.
- Local dev: `PUBLIC_URL=http://localhost:8080`, `COMFY_PUBLIC_URL=http://comfy.localhost:8080`.
  Production enforcement is not weakened for dev.

## 5. How to edit Docker Compose environment

All config lives in `docker-compose.yml` `environment:` blocks — no `.env` file
required. Copy the file privately for production or inject the same named fields
via Docker secrets/env. Fields marked `MUST_CHANGE`/`CHANGE_ME` must be replaced.
Image defaults to `ghcr.io/OWNER/REPO:latest` — replace with your repo path.

Generate secrets:

```bash
openssl rand -base64 48  # AUTH_SECRET
openssl rand -base64 48  # WORKSPACE_JWT_SECRET (must match web+gateway)
openssl rand -base64 32  # ADMIN_REGISTRATION_CODE
openssl rand -base64 32  # POSTGRES_PASSWORD
```

## 6. Secrets

Never committed. Never logged. Never returned client-side. Signup tokens and
verification/session tokens are stored **hashed (SHA-256)**. Admin code lives only
in env. SMTP credentials server-side only. Audit metadata redacts secret-like keys.

## 7. First admin

1. Set `ADMIN_REGISTRATION_CODE` in Compose, `up` the stack.
2. Open `PUBLIC_URL/register/admin`, enter email + code + name.
3. Check SMTP inbox (dev: server logs show link), open `/verify?token=…&email=…`.
4. Account becomes `ADMIN`, redirected to `/admin`.

## 8. SMTP

Compose fields: `SMTP_HOST/PORT/USER/PASSWORD/SECURE/FROM_NAME/FROM_EMAIL`.
Dev without real SMTP logs to console. Admin → Settings shows safe status only
plus **Send Test Email** (`SMTP_TEST_SENT` audit, no secrets echoed).

## 9. Class creation

Admin → Classes → Create (`name, courseCode, term, description, slug` kebab-case).
Example: `Web Programming / CSCI 4300 / Fall 2026 / csci4300-fall-2026`.
Edit/archive/reactivate from class Settings tab (`CLASS_CREATED/UPDATED/ARCHIVED`).

## 10. Roster upload

Class → Roster → paste CSV → **Preview** → **Confirm import**.
Format: `OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator`
(`#811883567,Yedla,Abhinav,student@example.edu,#`). Trims, lowercases email,
strips leading `#`, ignores EOL indicator, validates email/ID, detects duplicates,
transactional commit (any invalid/duplicate aborts with zero writes).
Preview counts NEW/UNCHANGED/UPDATED/INVALID/DUPLICATE/MISSING_FROM_NEW_ROSTER.
Missing rows are never auto-deleted; optional archive after review.

## 11–12. Signup URL generation + emailing

Class → Signup → **Generate student signup link** (server-side, ≥128-bit random,
only SHA-256 stored; plain token shown once). Example:
`https://comfy-admin.example.edu/signup/csci4300-fall-2026/<token>`.
Copy / **Email unregistered students** (each gets course label + link + roster-email
notice) / **Regenerate** (old invalid immediately) / **Disable/Enable**
(`CLASS_SIGNUP_ENABLED/DISABLED/REGENERATED`). Existing enrollments survive.

## 13. Student registration

Student opens link → sees only safe class info → enters university email →
server checks token + active class + enabled signup + active roster row →
SMTP verification → `/verify` → global User created/linked (never duplicated
across classes) → enrollment `ACTIVE` → dashboard → **Open ComfyUI** →
one-time workspace token (30–60s, single-use JTI in Redis) →
`COMFY_PUBLIC_URL/auth/exchange?token=…` → gateway HttpOnly cookie → ComfyUI.
Non-roster emails get a generic denial and **no** verification. Knowing an address
without mailbox access creates nothing.

## 14. ComfyUI worker registration

Admin → Workers → Register (`name, baseUrl, gpuName, vramMb, architecture, tags,
maxConcurrentJobs`). Example `a6000-01 / http://10.0.0.21:8188 / RTX A6000 / 49152`.
`baseUrl` is admin/server-side only, never in student APIs. Health loop polls
`/system_stats` + `/queue` → `ONLINE/BUSY/OFFLINE/DISABLED`; one worker failing
never downs the platform. Tags (`a6000,4090,48gb,flux,sdxl,video`) feed selection:
online → enabled → capacity → tags → least-loaded → round-robin.

## 15. Output auditing

Gateway intercepts `POST /prompt` (auth, enrollment, quota, job record, schedule,
forward, capture `prompt_id`, poll `/history`, stream `/view` → central
`/data/audit/<slug>/<orgId>/<yyyy>/<mm>/<dd>/<jobId>/{job.json,api_prompt.json,outputs/,outputs_manifest.json}`
with SHA-256/size/MIME, streaming (no giant-video buffering). Job statuses
`QUEUED/DISPATCHING/RUNNING/COMPLETED/FAILED/CANCELLED/LOST` + separate
`archiveStatus`. Class → Student → Job → Outputs/Prompt/Workflow/Worker in Audit UI;
students see only their own (server-side enforced).

## 16. GHCR

`.github/workflows/docker.yml` builds `linux/amd64,linux/arm64` via QEMU/Buildx,
logs into GHCR, tags `latest` (default branch only), `sha-<commit>`, `v1/v1.2/v1.2.3`.
PR builds never push `latest`. Compose pulls `ghcr.io/OWNER/REPO:latest` — replace
`OWNER/REPO`. One image, three commands: `web | gateway | migrate`, non-root.

## 17. FRP

Public TLS terminates at FRPS. FRPC (campus side) forwards to `127.0.0.1:8080`
(nginx). See `deploy/frp/frpc.example.toml` (no secrets/real hosts). FRP is not
part of Compose. nginx `server_name` routes `comfy-admin.*` → web, `comfy.*` →
gateway, with WebSocket upgrade and no TLS block.

## 18. Backups

- Postgres: `docker compose exec postgres pg_dump -U comfy comfy > backup.sql`
- Audit data: snapshot the `audit-data` volume (`/data/audit`).
- Redis: RDB via `redisdata` volume (sessions/quotas/JTIs are ephemeral).

## 19. Upgrades

1. Private copy of Compose with your secrets. 2. `docker compose pull && docker
compose up -d migrate && docker compose up -d`. 3. Verify `/api/health` on both
   services. Image tags are immutable (`sha-*`, semver); `latest` tracks default branch.

## 20. Troubleshooting

- `403 Origin check failed` → `PUBLIC_URL` must exactly equal the browser origin
  (scheme+host+port). Dev uses `http://localhost:8080`.
- Signup link invalid → regenerated/disabled, wrong class, or archived class.
- `No eligible class` → email not in an active signup-enabled roster.
- No GPU worker → check Workers tab health, `baseUrl` reachability, `enabled`.
- Mail not arriving → Settings → Send Test Email; check `SMTP_*` fields.
- `DATABASE_URL ... CHANGE_ME` → real DB required for multi-instance; single-image
  dev falls back to in-memory store (documented limitation below).

## Launch

```bash
cp docker-compose.yml deploy.private.yml   # keep secrets private (optional)
# edit MUST_CHANGE values, set image to ghcr.io/<owner>/<repo>:latest
docker compose up -d postgres redis
docker compose up -d migrate
docker compose up -d web gateway nginx
curl http://localhost:8080/api/health
```

GPU-server deploy: same Compose on the lab host (or proxy host), workers as
separate ComfyUI services/hosts on the private net, FRPC → `127.0.0.1:8080`,
`PUBLIC_URL=https://comfy-admin.example.edu`, `COMFY_PUBLIC_URL=https://comfy.example.edu`.

## Tests

```bash
pnpm install
pnpm test            # vitest: origin, roster, auth, queue, signup-security, comfy-mock, acceptance
pnpm typecheck
pnpm --filter @class-comfyui/web build
pnpm --filter @class-comfyui/gateway build
```

## Limitations (honest)

- Web and gateway each keep an in-memory fallback when `DATABASE_URL` is a
  placeholder/unreachable so builds/tests run without infra; production with a real
  Postgres uses it as source of truth (Drizzle schema + DDL shipped). True
  distributed rate-limit/JTI via Redis is wired for production but single-instance
  memory is used in dev.
- No Kubernetes (per spec). No real GPU in CI — mock ComfyUI covers the contract;
  run the acceptance scenario against real workers before term start.
