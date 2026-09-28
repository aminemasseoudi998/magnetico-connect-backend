# Magnetico Portal Backend

Node.js + TypeScript API for the Magnetico metered-access portal.
**Fastify** for HTTP, **Prisma ORM** against the **Portal Postgres** — the only
database this service touches. Guacamole has its own database, which this
backend keeps in sync through Guacamole's REST API.

Auth is **Keycloak** (realm `magnetico`, brokering Google): every `/api/*`
route except `/api/health` and `/api/tunnel` needs
`Authorization: Bearer <access token>`, verified against the realm JWKS
(issuer, audience `magnetico-portal`, expiry). The token's `sub` is upserted
into `users`, and its realm role (`admin` or `user`) is copied onto the row
on every request. `/api/admin/*` rejects anyone without `admin` (403).

## Remote access (Guacamole)

```
browser ──ws + one-time ticket──▶ backend /api/tunnel ──ws + user's Guacamole token──▶ Guacamole ──▶ guacd ──SSH/RDP──▶ server
```

- **Admins configure servers** through `/api/admin/servers`: host, port,
  username, password or SSH key, protocol options, access (everyone or chosen
  users), rate and session limit. Credentials are encrypted at rest with
  AES-256-GCM (`SERVER_CREDENTIALS_KEY`) and never returned by the API.
- **Two-way sync with Guacamole** (services/guacamole.ts `syncAll`): portal
  edits are pushed immediately; a pass every 30 s (and on each
  `GET /api/admin/servers`, and `POST /api/admin/servers/sync`) pulls what
  admins added, edited or deleted in the Guacamole UI. A fingerprint of each
  connection as last synced tells which side changed; Guacamole wins a tie.
  Connections added in Guacamole become **drained** servers
  (`guacImported`, rate `GUAC_IMPORT_RATE`, no access) until an admin prices
  them. Only SSH/RDP are imported; unmanaged Guacamole parameters are kept in
  `settings.extraParams`.
- **Each portal user has a Guacamole account** (username = email, password =
  HMAC of the user id under `SERVER_CREDENTIALS_KEY`, never stored or shown).
  It holds no permission at rest: READ on the one connection is granted when a
  session opens and withdrawn when it ends. A password changed by hand in
  Guacamole is reset automatically.
- **Users** list servers with `GET /api/resources` (never the address), then
  `POST /api/sessions` → access + credit check, hold, **single-use 60-second
  ticket**. The browser opens `GET /api/tunnel?ticket=…` (origin-checked); the
  backend logs in as the user's Guacamole account and **proxies the display
  stream** — the browser never holds a Guacamole token or a credential.
  Guacamole's Active sessions / History show the user's email.
- **The backend is the meter**: billing starts at the first frame once the
  connection is confirmed (a failure within 3 s is never billed), per second
  at the rate locked at open, one `charge` row at the end. Credit is reserved
  in chunks (`HOLD_MINUTES_DEFAULT`) and topped up while the session runs.
- Sessions end with a reason (`user_closed`, `balance_exhausted`,
  `time_limit`, `admin_terminated`, `account_suspended`, `server_removed`,
  `server_closed`, `connection_failed`, `never_connected`, `interrupted`); a
  sweeper settles orphans every minute.

**Session recording.** A server with "Record sessions" on gets
`recording-path=${HISTORY_PATH}/${HISTORY_UUID}`: guacd writes each session
(screen, not keystrokes) to `infra/recordings/<history uuid>/recording`.
Users are told before and during the session. Admins replay it in Admin →
Sessions (`GET /api/admin/sessions/:id/recording`, every view audited) or in
Guacamole's History. Recordings are never deleted automatically — watch the
disk.

**Watching live sessions.** Admins join a user's live session read-only
(Admin → Sessions → Watch): the backend asks Guacamole for a share key on a
read-only sharing profile ("Magnetico monitor (read-only)", created per
connection) and proxies it on `GET /api/tunnel/watch` (one-time ticket from
`POST /api/admin/sessions/:id/watch`). guacd enforces read-only; the joiner
gets the full current screen. The user sees "An administrator is watching";
every watch is audited; watchers are closed when the session ends.

**Server health.** Per server, `settings.monitoring`: `ssh` (agentless — one
persistent SSH connection with the server's own credentials runs a read-only
`/proc` command; Linux) or `exporter` (scrapes `settings.exporterUrl`, a
Prometheus node_exporter or windows_exporter). CPU, memory, disk, network,
load and uptime are sampled every 10 s while a session is live or someone is
looking, every 60 s otherwise; kept in memory (~30 min). Shown on the user's
session page, in the admin watch view and in Admin → Servers.

**Audit trail.** `audit_events` (append-only, services/audit.ts): server
added/edited/drained/deleted, Guacamole sync imports/edits/deletions, session
terminated, recording viewed, user suspended/reinstated/team changed, credit
granted, first sign-in and role changes seen from Keycloak. Secrets are never
recorded — only that they changed.

NOTE(scale): tickets and the live-session registry are in-process; several
backend replicas need a shared store and sticky tunnels.

## Run (local dev)

Infra first — see `infra/README.md` (`docker compose up -d` starts Postgres,
Keycloak, guacd and Guacamole). Then:

```bash
cd backend
cp .env.example .env        # generate the two keys, see below
npm install
npx prisma generate
npx prisma migrate deploy   # Portal schema
npm run dev                 # tsx watch → http://localhost:4000
```

`src/server.ts` loads `backend/.env` automatically; shell variables win. The
server refuses to start without `SERVER_CREDENTIALS_KEY` and the Guacamole
service account (`GUAC_SERVICE_USER` / `GUAC_SERVICE_PASSWORD`).

Production-ish local run: `npm run build && npm start`.

## Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Portal Postgres. |
| `PORT` / `LOG_LEVEL` | no | `4000` / `info` | Listen port, Fastify log level. |
| `KEYCLOAK_ISSUER` | yes | — | Realm issuer, e.g. `http://localhost:8180/auth/realms/magnetico`. Must equal the token `iss` (same host the frontend uses). |
| `KEYCLOAK_AUDIENCE` | no | `magnetico-portal` | Required `aud` in access tokens. |
| `GUAC_INTERNAL_URL` | no | `http://127.0.0.1:8085/guacamole` | Guacamole as this process reaches it (compose publishes it on loopback only). In compose: `http://guacamole:8080/guacamole`. |
| `GUAC_SERVICE_USER` / `GUAC_SERVICE_PASSWORD` | yes | — | Guacamole service account the backend syncs with. Must equal the values in `infra/.env` (created with the `guac-db` volume). |
| `GUAC_IMPORT_RATE` | no | `1` | MGC/min given to servers imported from Guacamole (they stay drained until an admin reviews them). |
| `RECORDINGS_DIR` | no | `../infra/recordings` | Session recordings folder shared with guacd, as this process sees it. |
| `GUAC_DASHBOARD_URL` | no | `http://localhost:8085/guacamole` | Guacamole dashboard as an admin's browser opens it (links in Admin → Servers). |
| `SERVER_CREDENTIALS_KEY` | yes | — | 64 hex — encrypts server credentials and derives users' Guacamole passwords. Losing it = re-enter every credential. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `TUNNEL_PUBLIC_URL` | no | `ws://localhost:4000/api/tunnel` | Display WebSocket URL as browsers reach it (returned by `POST /api/sessions`). |
| `TUNNEL_ALLOWED_ORIGINS` | no | `http://localhost:3000` | Comma-separated origins allowed to open the tunnel (the frontend). |
| `HOLD_MINUTES_DEFAULT` | no | `60` | Credit reserved per chunk, in minutes of the server's rate; topped up while the session runs. |
| `MIN_SESSION_CREDIT_SECONDS` | no | `60` | Least credit (seconds of the rate) needed to open a session or keep it running. |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Hot-reload API on `:4000`. |
| `npm run build` / `npm start` | Compile to `dist/` / run the build. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run prisma:generate` | Regenerate the Prisma client after schema edits (stop `npm run dev` first on Windows — it locks the engine file). |
| `npm run prisma:migrate` | `migrate dev` — schema iteration (dev DB only). |
| `npm run grant -- <email> [amount]` | Grant a signed-in user every active server, optionally top up. The admin console does the same per server. |

## Endpoints

All under `/api/*`; Bearer-authenticated except `/api/health` and the
ticket-authenticated `/api/tunnel`; `/api/admin/*` is admin-only.
Interactive docs: **`GET /docs`** (Swagger UI, spec at `/docs/json`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Public liveness probe. |
| `GET` | `/api/me` | Current user + role (`admin` \| `user`). |
| `GET` | `/api/resources` | Servers the user may open (user view — no host/credentials). |
| `POST` | `/api/sessions` `{resourceId}` | Access + credit check → pending session + hold → `{session, tunnel: {url, ticket, expiresAt}}`. `402 insufficient_balance`, `403 no_entitlement`/`resource_inactive`, `404`, `409 session_already_open` (+`sessionId`) / `server_not_configured`. |
| `GET` | `/api/sessions/:id` | Live status for the meter: status, hold, `runwaySeconds`, final charge, end reason. |
| `POST` | `/api/sessions/:id/close` | End my session (closes the display, bills connected time). |
| `GET` | `/api/sessions/history` | Past sessions with resource, charge and end reason. |
| `GET` (WS) | `/api/tunnel?ticket=…&width=&height=&dpi=&timezone=` | Remote display stream (Guacamole protocol). |
| `GET` | `/api/wallet/balance` · `/api/wallet/transactions` | Derived balance; full ledger. |
| `POST` | `/api/wallet/topup` `{amount}` | Appends a `topup` (stub credit — real PSP later). |
| `GET/POST` | `/api/admin/servers` | **admin** — list / add servers. |
| `GET/PATCH/DELETE` | `/api/admin/servers/:id` | **admin** — one server + access list / edit (secrets: omitted = keep, `null` = remove) / delete (ends live sessions; archived instead when it has billing history). |
| `POST` | `/api/admin/servers/sync` | **admin** — two-way sync with Guacamole now: `{report: {imported, updatedFromGuacamole, pushed, removed, skipped}}`. |
| `POST` | `/api/admin/servers/test` | **admin** — real throwaway connection through Guacamole (temporary connection, deleted afterwards) with a draft or saved config: `{ok, code, guacStatus?, message?, elapsedMs}`. Nothing saved or billed. |
| `GET` | `/api/admin/sessions?scope=live\|recent` | **admin** — org-wide sessions. |
| `GET` | `/api/admin/sessions/:id/recording/info` · `/recording` | **admin** — recording status; the raw recording (played in-browser). |
| `GET` | `/api/admin/audit?severity=&q=&limit=` | **admin** — audit trail, newest first, with counts per severity. |
| `GET` | `/api/admin/analytics?range=24h\|7d\|30d\|90d&tzOffset=` | **admin** — overview analytics: KPIs vs the previous period, revenue by tier / sessions / connected hours / credit flow per hour or day, session outcomes and lengths, top servers and users, SSH vs RDP, utilization 7×24, unspent credit and fleet health. Health alerts (CPU/RAM ≥ 90 % for 3 readings, disk ≥ 90/95 %, unreachable after 3 failed readings, recovered) are written to the audit log as `server.health_*`, at most once per 30 min per server and kind. |
| `POST` | `/api/admin/sessions/:id/watch` | **admin** — one-time ticket to watch a live session read-only on `GET /api/tunnel/watch`. |
| `GET` | `/api/admin/servers/:id/health` · `/api/sessions/:id/health` | Live server health (admin: any server; user: their live session's server). |
| `POST` | `/api/admin/sessions/:id/terminate` | **admin** — force-end a session (user is told, time used is billed). |
| `GET/PATCH` | `/api/admin/operators[/:id]` | **admin** — accounts; `PATCH {team?, status?}` (suspending ends their live sessions). Roles are managed in Keycloak. |
| `POST` | `/api/admin/operators/:id/credit` | **admin** — grant credit (ledger `topup`). |
| `GET` | `/api/admin/operators/:id/sessions` | **admin** — one user's session history. |

Ledger rule: `ledger_entries` is **append-only** — only `INSERT`; amounts are
positive magnitudes, the sign lives in `type`. `hold` rows are reservations
and never count in the balance.

## Troubleshooting

- **`Configuration error: SERVER_CREDENTIALS_KEY …` at startup** — generate
  the key (table above) into `backend/.env`.
- **Test connection says "Gateway unavailable"** — Guacamole is not running
  or `GUAC_INTERNAL_URL` is wrong: `cd infra && docker compose up -d guacd guacamole`.
- **Test connection "Host not found" for a server on your own machine** — the
  address must work *from the guacd container*: use `host.docker.internal`,
  not `localhost`.
- **`Guacamole refused the service account`** — `GUAC_SERVICE_*` in
  `backend/.env` differ from `infra/.env`, or the `guac-db` volume was created
  with other values (accounts are only created on first init).
- **Server shows "Not synced to Guacamole yet"** — Guacamole was unreachable;
  the backend retries every 30 s. Check `docker compose ps` in `infra`.
- **Browser console: WebSocket closed with 403** — the frontend origin is not
  in `TUNNEL_ALLOWED_ORIGINS`.
- **`EPERM … query_engine-windows.dll.node` on `prisma generate`** — stop
  `npm run dev` first; it holds the file open.
- **401 on every call with a valid-looking token** — `KEYCLOAK_ISSUER`
  differs from the token `iss` (`localhost` vs `127.0.0.1`, missing `/auth`).
- **403 `no_role`** — the Keycloak user has neither `user` nor `admin`.
- **`P2021 table … does not exist`** — run `npx prisma migrate deploy`.


