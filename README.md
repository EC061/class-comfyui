# ComfyUI classroom lab

A self-hosted classroom management application and authenticated execution gateway for shared ComfyUI GPU servers. Students use browsers; inference runs on centrally managed GPU workers. The application owns identities, classes, rosters, sessions, jobs, quotas, and audit records. ComfyUI owns no student accounts.

## Architecture and deployment boundary

```text
Internet HTTPS
  -> remote reverse proxy: TLS, X-Real-IP, one server block per hostname
     -> external FRPS -> external FRPC (separate machine), two plain-TCP tunnels
        -> management-host:8080 --- Next.js (comfy-admin hostname)
           management-host:8090 --- Gateway + scheduler (comfy hostname)
                                  |             |
                                  +-- SQLite ---+
                                      /data
                                         |
                              private ComfyUI GPU workers
```

This revision replaces the prototype's disconnected memory stores and unused PostgreSQL/Redis services with **one persistent SQLite database in WAL mode**. Web and gateway run on the **same management host** and mount the same directory. GPU workers can be on other hosts. No Kubernetes or database server is needed.

The typed repository uses separate entity tables, JSON records, indexed generated columns, foreign keys, case-insensitive email uniqueness, and class-local student-ID uniqueness. `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, and a 10-second busy timeout apply to every connection. Writes use short `BEGIN IMMEDIATE` transactions; no network calls happen while a write transaction is held. Schema versions use `user_version`; a newer unknown schema fails closed.

WAL supports concurrent readers and serializes writers across the web and gateway processes. **Use a local ext4/XFS/APFS filesystem, never NFS/SMB or a distributed volume.** SQLite WAL requires all database processes to be on the same host; see [SQLite's WAL documentation](https://www.sqlite.org/wal.html). Multiple web processes can share this database. Run **one gateway service**: a database lease prevents duplicate scheduler leaders, but live WebSocket delivery is local to the gateway process. Multi-host management/active-active gateways require a different database and event transport.

## Repository

```text
apps/web/                 Next.js 16 App Router, management APIs and UI
apps/gateway/src/         authenticated HTTP/WebSocket gateway
  scheduler.ts            durable fair scheduling, capacity, recovery
  storage.ts              streaming output archival and input staging
packages/database/src/    typed SQLite repository, migration, seed, backup
packages/auth/src/        token cryptography and CSV parsing/reconciliation
packages/config/src/      validated canonical URLs and limits
packages/shared/src/      shared schemas and security helpers
tests/integration/        real APIs + SQLite + SMTP + mock worker tests
tests/e2e/                Playwright against production application builds
scripts/                  runtime entrypoint and disposable test services
```

## Ports

| Service                      | Container/internal port                   | Published production port |
| ---------------------------- | ----------------------------------------- | ------------------------- |
| Next.js                      | 3000                                      | **0.0.0.0:8080**          |
| Gateway                      | 8081                                      | **0.0.0.0:8090**          |
| SQLite                       | filesystem only                           | none                      |
| ComfyUI worker               | typically 8188 on the private GPU network | never public              |
| Mailpit, local override only | 1025 SMTP / 8025 UI                       | 127.0.0.1:8025            |

Your external FRPC opens **one plain-TCP tunnel per published port** — 8080 for the management hostname and 8090 for the gateway hostname — so routing is by port, not by `Host`. FRPC is not part of this stack and must not be run from it. There is no local reverse proxy: the remote one in front of FRPS is the only proxy, and each application is published directly on its tunnel port.

Because FRPC runs on a **different machine**, both ports bind all interfaces rather than loopback. They carry plain HTTP, terminate no TLS, and **trust the `X-Real-IP` your remote proxy sets**, so they must be reachable **only** from the FRPC host: restrict them with a host firewall, a private network segment, or a Docker network scoped to that host. Anything that can reach them directly can forge a client address and evade IP rate limits. Note that Docker's published ports bypass UFW and firewalld, so write the rule in the iptables `DOCKER-USER` chain. Firewall each GPU worker so only the gateway host and administrators can reach it.

## Production configuration

All deployment configuration lives in `docker-compose.yml`, which is **git-ignored**; the tracked `docker-compose.example.yml` is the template. **No `.env` file is required**. The gateway inherits the web service's complete environment using a YAML anchor, so there is one visible set of configuration values. `docker compose config` expands it.

Copy the template once, then edit the copy. Future `git pull` updates only the example, never your deployed configuration:

```bash
cp docker-compose.example.yml docker-compose.yml
```

One-time migration for hosts deployed before this change: back up your edited `docker-compose.yml`, restore the tracked file (`git checkout -- docker-compose.yml`), pull, then copy your backup back over `docker-compose.yml`.

Before starting, edit:

- `image`: your lowercase `ghcr.io/<owner>/<repository>:<tag>` (shared YAML anchor).
- `PUBLIC_URL`: the exact management origin, e.g. `https://comfy-admin.example.edu`.
- `COMFY_PUBLIC_URL`: a separate gateway origin, e.g. `https://comfy.example.edu`.
- `AUTH_SECRET`, `WORKSPACE_JWT_SECRET`, `ADMIN_REGISTRATION_CODE`: three independent random secrets, at least 32 characters each. Placeholder/development secrets prevent production startup.
- All SMTP fields: host, port, user, password, secure, sender name and sender email.
- The `./data:/data` bind mount if you want a different **local** storage directory. Keep the same mount in web, gateway and migrate.

Generate each secret with `openssl rand -hex 32`. The real `docker-compose.yml` is git-ignored, so secrets in it are never committed; alternatively inject Docker secrets/environment values under the same named fields. Do not commit them. Docker secret files are not implicitly read: your private entrypoint/injection mechanism must populate the named environment variables.

The remaining configuration fields control session/verification expiry, per-user active and queued jobs, worker timeouts, upload and archive sizes, user storage quotas, optional retention, and the explicit approved-node list. `SQLITE_PATH=/data/lab.sqlite`, `AUDIT_DATA_DIR=/data/audit`, and `UPLOAD_DATA_DIR=/data/uploads` are persistent paths. `AUTH_SECRET` keys browser-session hashes; rotating it revokes browser sessions. Workspace links are signed with `WORKSPACE_JWT_SECRET` and consumed atomically in SQLite.

## Launch on the management/GPU host

Install Docker Engine with the Compose plugin. Node/pnpm are unnecessary for a prebuilt deployment.

```bash
# From this repository, after copying the example and editing docker-compose.yml:
cp docker-compose.example.yml docker-compose.yml
mkdir -p data
# The image runs as UID/GID 1000. Adjust permissions if your administrator differs.
sudo chown -R 1000:1000 data
chmod 700 data
docker compose config --quiet
docker compose pull
docker compose up -d --wait
curl --fail http://127.0.0.1:8080/api/health
curl --fail http://127.0.0.1:8090/health
docker compose ps
```

Each port serves exactly one site, so no `Host` header is needed to reach it. Compose runs the migration before web/gateway and checks both application health endpoints. A database-open or schema error prevents healthy startup; there is no fallback database or automatic production seed.

Build locally instead of pulling:

```bash
docker build -t class-comfyui:local .
# In your (git-ignored) production docker-compose.yml, set the shared image to class-comfyui:local.
docker compose up -d --wait
```

## Canonical URL, CSRF and origin behavior

Configuration is validated at startup. URLs must be HTTP(S) origins without paths, queries, fragments or credentials. Both services construct security-sensitive links from their configured URL, never `Host`, `Origin` or forwarded-host headers.

Every management mutation and gateway mutation checks exact `Origin` equality. A different scheme, subdomain, suffix, or port is rejected with 403. WebSocket upgrades require the gateway origin too. There is no wildcard CORS or cross-origin credential sharing.

A missing `Origin` is accepted only when **all** of these agree: exact canonical `Host` including port, `Sec-Fetch-Site: same-origin`, and a `Referer` whose origin exactly equals the canonical origin. Host alone is insufficient. API clients should send the configured Origin explicitly. Fetch metadata is browser-controlled; this fallback is for same-origin browser semantics, not an authentication mechanism.

Cookies are host-only, HttpOnly, SameSite=Lax, and Secure when the corresponding configured URL uses HTTPS. Email GET links display a confirmation page; the challenge is consumed by a protected POST. Account, class, and enrollment eligibility are rechecked before signup verification and every gateway request. Disabling signup does not disable an existing student's normal login. Disabling a user or archiving their enrollment removes workspace access, including established WebSockets.

Each tunnel terminates at a single application, so a wrong or missing `Host` cannot cross between the management and gateway sites; `Origin` equality, not `Host`, is what enforces CSRF. Both applications strip/ignore forged identity headers and enforce their own request-body limits, so no local proxy is needed for those. The rate limiter keys on `X-Real-IP`, which only the remote proxy sets — see the FRP section for the server-block requirements, and keep 8080/8090 closed to everything but the FRPC host. In a shared FRPC/NAT deployment, IP rate limits apply to that shared ingress address; email/account-specific limits apply separately.

## First administrator and SMTP

1. Open `PUBLIC_URL/register/admin`.
2. Enter your email and the secret administrator registration code.
3. Open the email sent through your SMTP server, then click **Verify**.
4. Subsequent logins use `/login` and need only email ownership, not the registration code.

Multiple admins are supported. A transaction prevents disabling/demoting the last active admin. SMTP failures return an error; authentication links are never logged or returned in API responses. Use **Admin → Settings → Send test email** to check delivery. For port 587 use `SMTP_SECURE=false` (STARTTLS when offered); use `true` for implicit TLS, normally port 465. Configure your provider's SPF/DKIM/DMARC and authorized sender.

## Classes, rosters and signup URLs

1. **Admin → Classes → Create**: set name, course code, term, description and unique slug.
2. Open the class's **Roster** tab and choose its university CSV file (or paste CSV).
3. **Preview** shows row counts/states and missing enrollments. Invalid or duplicate rows block confirmation. Choose individual missing enrollments to archive; omission alone never removes anyone.
4. **Confirm import** commits the preview transactionally. Conflicting email/student-ID matches roll back the entire import. Preview/import records are persisted; previews expire after an hour.
5. Open **Signup → Generate student signup link**, then **Copy URL** or **Email unregistered students**.

Expected headers:

```csv
OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator
#100000001,Example,Alice,student1@example.edu,#
```

All fixtures are fabricated. Parsing supports quoted fields, BOM, whitespace, and escaped quotes; rejects malformed CSV, missing/duplicate headers, invalid IDs/emails and duplicate identities. Emails are compared case-insensitively. Changing a roster email detaches the previous account and requires verification of the new address. Reimporting an archived enrollment preserves its archive status; an admin may explicitly reactivate it.

Signup tokens contain 192 random bits and only their SHA-256 hashes are stored. The URL is shown once; keep your copied URL or regenerate it. Regeneration revokes the old URL **and outstanding signup challenges** immediately. Disable/enable controls preserve existing accounts/enrollments. Invitation requests validate the complete canonical URL, recheck the token while sending, email only unregistered non-archived entries, and record sent/failed deliveries. After a partial SMTP failure, retrying may resend successful invitations; there is no exactly-once delivery promise.

Students open the class link, enter their roster email, and verify ownership through SMTP. Possession of the signup link is insufficient. A global user can join another class through that class's roster-gated link without creating a duplicate user. `/register` directs students to their instructor's class link.

## Workers and simultaneous users

Register each GPU endpoint once under **Admin → Workers**: name, plain HTTP base URL, GPU name, VRAM, CPU architecture, capability tags, and concurrency. Start with `maxConcurrentJobs=1`. Use tags such as `a6000,48gb,flux` or `4090,24gb,sdxl`. Worker URL changes are blocked while jobs are active. The gateway reads worker changes from the shared database without restart and polls `/system_stats` and `/queue`.

The gateway returns a platform job UUID immediately after durable queue admission. Jobs are FIFO within a user and prioritized by the user's least recent dispatch, so one user cannot repeatedly jump ahead. An atomic transaction reserves worker capacity and checks the per-user active limit across all classes. Worker selection considers enabled/healthy state, capacity, required tags, least load and least recent assignment. The optional `required_tags` array in `/prompt` selects capabilities.

Default quotas allow **one active plus three waiting jobs per user**. Quota checks, ticket redemption, and scheduler leases use SQLite transactions across processes. A worker doing an unrecognized external job is not assigned more platform work. All workers should be dedicated to this gateway.

The management dashboard issues a signed, 60-second workspace ticket tied to user/class/enrollment. The gateway consumes its database record exactly once and creates its own persistent cookie. Browser identity headers and ComfyUI client IDs never choose the execution identity.

## WebUI isolation and supported workflows

- History and queue are constructed from the authenticated user's selected class records; worker-global history/queue never reaches the browser.
- Every output/input download checks owner and class. Guessing another job UUID or filename grants no access.
- Uploads receive random immutable filenames, are stored under user/class directories, and are transferred to the selected worker when dispatched. Another user's uploads never appear in LoadImage choices.
- Saved workflows and UI settings use class/user-scoped SQLite records, including relative directory listings, overwrite protection, and workflow renames. Users cannot access another user's `userdata` by changing URL paths.
- WebSocket progress is routed using a server-generated upstream client ID and matching job ID. Completion events use authorized, archived output aliases. Worker-global binary previews are intentionally suppressed.
- Save-node prefixes are rewritten into the job's unique worker directory. API prompt and workflow JSON remain associated with the submitting user.
- Only vetted frontend assets, model catalogs, and explicit APIs are served. Global mutation APIs, ComfyUI Manager install APIs, arbitrary custom routes, and unapproved node classes are denied.

**A shared ComfyUI Python process is not an OS sandbox for arbitrary custom nodes.** `COMFY_ALLOWED_NODES` is an explicit allowlist of reviewed built-in image-generation nodes, including common SDXL/Flux components. Review a custom node's filesystem/network/subprocess behavior before adding it. Never enable arbitrary file readers, shell execution, or server administration nodes for students. If a course requires untrusted Python/custom nodes, run separate worker containers/VMs per trust boundary. Keep the same reviewed node/model set on interchangeable workers; model or node incompatibility is a visible failed job, not a silent retry.

The managed endpoints include `/prompt`, `/ws`, `/queue`, `/interrupt`, `/history`, `/view`, `/upload/image`, `/object_info`, `/system_stats`, `/settings`, `/userdata`, and `/v2/userdata` (also under `/api/` where applicable). Arbitrary extension APIs, upload-mask editing, and worker-global history deletion are not exposed. Frontend builds that require additional APIs need an explicitly authorized adapter, not transparent fallback proxying. Do not reuse one browser profile for different students; browser-local caches/extensions are outside server-side isolation.

## Completion, recovery and auditing

The scheduler records `QUEUED → DISPATCHING → RUNNING → COMPLETED/FAILED/CANCELLED/LOST`. Completion requires terminal worker history; polling timeout never means success. Running jobs can reconnect to their recorded worker/prompt after gateway restart. If the gateway crashes between dispatch and saving the worker prompt ID, the job becomes `LOST` and is **not automatically resubmitted**: the worker may already be executing it. Inspect its queue before manually retrying. No distributed system can promise exactly-once execution against an upstream without idempotent submission.

Cancellation removes only the requesting user's pending platform jobs. `/interrupt` is sent upstream only when that job is the sole running worker prompt; cancellation never interrupts a different student's concurrent prompt. A timeout retains the slot until completion/cancellation is known, or marks the job lost and lets worker health detect remaining external work.

Outputs are streamed from worker `/view` into the central audit directory with backpressure, byte limits, SHA-256, MIME type and original filename. There is no shared-worker-filesystem assumption. Supported history manifests can contain images, video or audio files; every referenced file is archived before publishing the history. Generation status and archive status are independent. A failed archive is visible and can be retried from the job page without generating again.

```text
/data/audit/<class-slug>/<OrgDefinedId-or-user-UUID>/YYYY/MM/DD/<job-UUID>/
  job.json
  api_prompt.json           # original submitted prompt
  execution_prompt.json     # managed save prefixes
  workflow.json             # when supplied
  outputs_manifest.json
  outputs/<random-UUID>.<extension>
```

**Admin → class → Jobs / Outputs → job** shows student identity, worker, status, timing, prompt, workflow, authorized downloads and checksums. Global job filters include email/student ID, class (via class page), status, date, worker and MIME prefix. Students see only their own jobs. **Audit** shows administrative events with actor/target and safe metadata; student audit requests never return classmates' events.

Retention is off by default. When enabled, completed terminal jobs older than the configured number of days lose their archive files and get archive status `EXPIRED`; identity/job metadata remains. Uploads have a separate per-user storage quota and are retained for saved workflows. Remove obsolete inputs during planned maintenance, not while jobs reference them.

## Backups and upgrades

Create a SQLite online backup (never copy just `lab.sqlite` while WAL is active):

```bash
mkdir -p data/backups
docker compose run --rm migrate backup /data/backups/lab-backup.sqlite
```

For a consistent backup of database plus all files, stop writers first:

```bash
docker compose stop web gateway
tar -czf lab-data-backup.tar.gz data/
docker compose up -d --wait
```

Keep backups encrypted with restricted access; they contain student records and generated outputs. Test restore on a separate local directory. Preserve the database and its WAL/SHM siblings together for a stopped filesystem backup. To restore an online backup, stop all services, replace the database, remove stale WAL/SHM files only while stopped, restore matching audit/uploads directories, fix UID/GID 1000 permissions, then start.

Upgrade by backing up, selecting a pinned release tag in the Compose image anchor, pulling, and recreating services. Pulling only updates `docker-compose.example.yml`; your git-ignored `docker-compose.yml` is left untouched — diff the example against it to pick up new fields. The migration runs before startup. Do not downgrade an image against a newer schema; restore its matching backup. The old prototype never persisted its management data, so there is no reliable memory-store migration. Existing externally created PostgreSQL data, if any, requires a separate reviewed import; it is not silently discarded or converted.

## GHCR and CI

`ci.yml` performs frozen pnpm install, formatting, real lint, typecheck, integration/unit tests, production builds, Chromium Playwright, Docker build and Compose health checks. Test SMTP and GPU services are loopback-only and use fabricated data.

`docker.yml` uses Buildx to build native `linux/amd64` from the same Dockerfile and publishes `ghcr.io/<owner>/<repo>`. There is deliberately no arm64/QEMU leg: emulation made every publish take 12+ minutes for hardware this stack does not deploy to. Main/default-branch updates publish `latest` and `sha-…`; `v1.2.3` pushes publish `v1`, `v1.2`, and `v1.2.3`. PR builds do not push. Automatic metadata `latest` on release tags is disabled. Enable Actions package-write permissions and grant deployment hosts GHCR read access for private images. This repository does not claim an image is published until the workflow succeeds.

## FRP, TLS and the remote reverse proxy

FRPC, FRPS and the reverse proxy are **external to this repository**. No FRP client, proxy configuration or example ships here and Compose never starts one. This stack serves plain HTTP on two ports and never terminates TLS. Because there is no local proxy, **the remote reverse proxy is a required part of the security model**, not just a router.

Configure two plain-TCP proxies in your own FRPC configuration, one per port, and terminate TLS for both hostnames remotely:

```text
comfy-admin.example.edu  --TLS-->  remote reverse proxy  -->  frps remote port A  ==tcp==>  <management-host>:8080
comfy.example.edu        --TLS-->  remote reverse proxy  -->  frps remote port B  ==tcp==>  <management-host>:8090
```

Do not merge the two hostnames onto one tunnel: the tunnels are what separate the two applications.

### Required per-site configuration

Each of the two remote server blocks must set these. `proxy_set_header` _replaces_ a client-supplied value, which is what makes the first two trustworthy:

```nginx
proxy_set_header Host              $host;          # preserved end to end
proxy_set_header X-Real-IP         $remote_addr;   # sole input to IP rate limiting
proxy_set_header X-Forwarded-Host  "";             # never let a client influence it
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade           $http_upgrade;
proxy_set_header Connection        $http_connection;
proxy_http_version 1.1;
```

`$http_connection` forwards the client's own `Connection` header, which is what a browser WebSocket upgrade sends. The stricter `$connection_upgrade` form needs `map $http_upgrade $connection_upgrade { default upgrade; '' close; }` declared in the `http` block; use whichever your proxy already defines.

On the **gateway** hostname additionally disable buffering and allow long-lived connections — workspaces hold a WebSocket for the lifetime of a job, and outputs stream through:

```nginx
proxy_buffering         off;
proxy_request_buffering off;
proxy_read_timeout      3600s;
proxy_send_timeout      3600s;
client_max_body_size    100m;   # at least MAX_UPLOAD_MB
```

If a WAF sits in front of these hostnames, exempt the gateway's WebSocket endpoint and upload paths; inspection that buffers request bodies breaks streaming uploads and long-lived sockets.

### Do not log URLs for these two hostnames

Sign-in, verification and workspace-exchange links carry **secrets in the URL**. A default access log format that includes `"$request"` or `$request_uri` writes those tokens to disk and to stdout, where anyone with log access can replay them. Give both server blocks a log format that omits the path and query:

```nginx
log_format lab '$remote_addr $server_name $request_method $status $request_time';
access_log /var/log/nginx/lab-access.log lab;
```

Keep FRP tokens and server addresses in your private FRP configuration.

## Local development and verification

Use Node 24+ and pnpm 9.12.0. Local URLs use exactly the same origin rules as production.

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Playwright starts the **built** Next.js/gateway processes, a test SMTP inbox, and a mock ComfyUI backend in an isolated temporary data directory. It registers an administrator through the browser, imports a fabricated roster, creates a signup link, registers two separate browser contexts, opens workspaces, submits jobs, verifies output/WS isolation, and restarts both applications to check persistence. Integration coverage also includes 30 simultaneous users, two competing schedulers, separate OS database writers, quotas, rollback, offline/reconnect, and SMTP failures. Mock inference is not a real-GPU performance benchmark.

For an interactive local stack:

```bash
cp docker-compose.example.yml docker-compose.yml
mkdir -p data
# Ensure this directory is writable by UID 1000.
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build --wait
```

Open `http://localhost:8080` and Mailpit at `http://localhost:8025`. The gateway is `http://comfy.localhost:8090`; if your browser does not resolve it, map `comfy.localhost` to `127.0.0.1`. The two sites keep separate hostnames locally so host-only cookies stay isolated exactly as they are in production. The local-only admin code is in `docker-compose.local.yml`. This override must never be used for public deployment. Register a real private worker in the UI, or run `PORT=8188 pnpm exec tsx scripts/mock-comfy.ts` and use an address reachable from the gateway container. No development seed runs automatically; `NODE_ENV=development SQLITE_PATH=/absolute/local/path/lab.sqlite pnpm db:seed` explicitly creates fabricated demo records in an empty database.

## Final real-server verification

On each GPU server, use your existing pinned ComfyUI installation with reviewed nodes/models:

```bash
# Run in the GPU server's ComfyUI virtual environment.
nvidia-smi
python main.py --listen 0.0.0.0 --port 8188
# Allow this port only from the management gateway's private IP.
```

On the management host:

```bash
curl --fail http://10.0.0.21:8188/system_stats
curl --fail http://10.0.0.21:8188/queue
docker compose up -d --wait
curl --fail http://127.0.0.1:8080/api/health
curl --fail http://127.0.0.1:8090/health
```

Replace the example worker IP. Then repeat both checks through the public hostnames to confirm the tunnels and remote TLS are correct. Register A6000/4090 workers, import a fabricated test class, and use two separate browser profiles. Upload different images with the same original filename, save workflows with the same name, and queue one reviewed SDXL/Flux workflow from each profile. Confirm both jobs finish, each history shows only its owner, downloads/checksums appear in admin auditing, and direct worker ports are unreachable from a student network. Restart web/gateway and confirm sessions, classes and completed jobs remain. Install actual course models before this test; the mock does not validate model availability, VRAM capacity or third-party node compatibility.

## Troubleshooting and operational limits

- **403 origin:** check both canonical URLs, the remote proxy's `Host` forwarding, scheme/port, and client Origin. Do not disable origin enforcement.
- **Wrong site answers a hostname:** a tunnel points at the wrong loopback port. Port 8080 is the management site, 8090 the gateway.
- **Startup secret error:** replace all three placeholders with independent secrets of at least 32 characters.
- **SQLite permission/busy errors:** confirm identical local bind mounts and UID 1000 access; ensure no external process holds a long write transaction. Do not delete an active WAL file.
- **SMTP 502:** verify credentials/TLS/provider connectivity in Settings. Errors do not fall back to logging tokens.
- **No metadata worker:** register a healthy backend at least once; workflows cannot be validated against a worker that has never supplied node metadata. Previously cached metadata permits queueing while that worker reconnects.
- **Queued jobs:** inspect worker health, external work, tags and active quotas. Capability tags do not install models.
- **LOST:** inspect the worker's private queue; do not automatically resubmit an ambiguous dispatch.
- **Archive failed:** check free disk space and limits, restore worker history/output access, and use Retry archival.
- **Unsupported node/API:** review it and implement a narrowly authorized adapter. Do not restore the original unrestricted proxy.

Docker Engine and real GPU hardware may not be available in a coding environment. The test results reported by the implementer distinguish executed checks from CI/deployment checks that still need an actual Docker/GPU host.
