# Magnetico Portal Backend

Node.js + TypeScript API for the Magnetico metered-access portal.
**Fastify** for HTTP, **Prisma ORM** against the **Portal Postgres** — the only
database this service ever touches. Guacamole keeps its own isolated Postgres;
the backend talks to Guacamole solely through signed JSON-auth tokens
(`POST /api/sessions`) and never connects to its DB.

Auth is currently **stubbed** (prompt.md step 4): every `/api/*` route except
`/api/health` acts as a fake dev user. Real Keycloak JWT verification lands in
step 11; the route contract (`request.user.id`) already matches it.

## Prerequisites

- Node.js 20+, npm
- Docker + Docker Compose (for the databases, Guacamole, and the full stack)
- Ports: `4000` (API), `5432` (Portal DB via compose), `8085` (Guacamole via
  compose). If a port is taken, override it — see [Troubleshooting](#troubleshooting).

## Run A — full stack with Docker Compose (recommended)

From `infra/`:

```bash
docker compose up -d --build
```

This starts `portal-db`, `guac-db`, `guacd`, `guacamole`, `portal-backend`
and `billing-daemon`. Two one-time setup steps remain:

```bash
# 1. Portal schema (empty volume on first boot — without this every endpoint 500s)
cd ../backend
DATABASE_URL="postgresql://magnetico:magnetico@localhost:5432/portal?schema=public" \
  npx prisma migrate deploy

# 2. Demo data: stub user + 2 entitled resources + 500.00 topup
DATABASE_URL="postgresql://magnetico:magnetico@localhost:5432/portal?schema=public" \
  npm run prisma:seed
```

The Guacamole DB seeds itself from `infra/guacamole-init/initdb.sql` on first
boot; nothing to run there. Default logins: Guacamole `guacadmin`/`guacadmin`
(change in compose), API acts as `dev@magnetico.local`.

Real (non-stub) session tokens additionally need a shared secret visible to
both services before `up`:

```bash
export GUAC_JSON_AUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
export GUAC_CONNECTION_PARAMS='{"1": {"hostname": "<ssh-host>", "port": "22", "username": "ops", "password": "<pw>"}}'
docker compose up -d guacamole portal-backend
```

Without the secret, `POST /api/sessions` returns a dev stub token (`.stub`
suffix) — fine for endpoint work, useless for real Guacamole logins.

## Run B — backend on the host (local dev)

```bash
cd backend
cp .env.example .env   # then edit values as needed
npm install
npm run dev            # tsx watch on src/server.ts → http://localhost:4000
```

`src/server.ts` loads `backend/.env` automatically (`dotenv/config`, first
import); **shell variables still win** over the file. Point `DATABASE_URL` at
whichever Postgres you use (compose `portal-db` on `:5432`, or a local one),
then migrate + seed as in Run A (use `npm run prisma:migrate`, i.e.
`migrate dev`, while iterating on the schema).

Production-ish local run: `npm run build && npm start`.

## Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Portal Postgres. Never the Guacamole DB. |
| `PORT` | no | `4000` | HTTP listen port. |
| `LOG_LEVEL` | no | `info` | Fastify log level. |
| `STUB_USER_ID` / `STUB_KEYCLOAK_SUB` / `STUB_EMAIL` / `STUB_DISPLAY_NAME` | no | dev user | Fake identity attached by the stub auth middleware. Seed uses the same values — keep them in sync. Removed in step 11 (real JWT). |
| `GUAC_BASE_URL` | no | `http://localhost:8085/guacamole` | Guacamole base used to build `guacUrl`. Must match Guacamole's **published host port** (`8085:8080` in compose). |
| `HOLD_MINUTES_DEFAULT` | no | `60` | Hold window (`rate × minutes`, capped by balance) when an entitlement sets no `max_session_min`. |
| `GUAC_JSON_AUTH_SECRET` | no | — (stub tokens) | 128-bit key as 32 hex digits. Must equal Guacamole's `JSON_SECRET_KEY`. Generate: `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`. |
| `GUAC_CONNECTION_PARAMS` | iff secret set | `{}` | JSON map `guac_connection_id → {hostname, port, …}`. Hostnames must resolve **from the Guacamole container**. Missing entry → `POST /api/sessions` 500s (`connection_unconfigured`). |

Dev-only escape hatch: any request header `x-user-id: <uuid>` overrides the
stub identity (multi-user entitlement testing without Keycloak; deleted in
step 11).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Hot-reload API on `:4000`. |
| `npm run build` / `npm start` | Compile to `dist/` / run the build. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run prisma:generate` | Regenerate the Prisma client after schema edits. |
| `npm run prisma:migrate` | `migrate dev` — schema iteration (dev DB only). |
| `npm run prisma:seed` | Stub user + demo resources/entitlements + 500.00 topup. |

## Endpoints

All under `/api/*`, stub-authenticated except `/api/health`. Interactive
docs: **`GET /docs`** (Swagger UI, spec at `/docs/json`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Public liveness probe. |
| `GET` | `/api/me` | Echoes the attached identity (stub debug helper). |
| `GET` | `/api/resources` | Entitled, active resources for the user. |
| `POST` | `/api/sessions` `{resourceId}` | Entitlement + balance check → `pending` session + `hold` → `{sessionId, guacToken, guacUrl}`. Errors: `404` unknown, `403` inactive/no-entitlement, `402` insufficient, `500` token misconfiguration. |
| `GET` | `/api/sessions/history` | Past sessions with resource + `finalCharge` (`?limit`, 1–200). |
| `GET` | `/api/wallet/balance` | Derived balance: `SUM(topup)+SUM(refund)−SUM(charge)`; holds excluded. |
| `POST` | `/api/wallet/topup` `{amount}` | Appends a `topup` leg (stub credit — real PSP later). |
| `GET` | `/api/wallet/transactions` | Full ledger + balance (`?limit`, 1–500). |

Ledger rule (enforced by convention, relied on by the billing daemon):
`ledger_entries` is **append-only** — only `INSERT`, never `UPDATE`/`DELETE`;
all amounts are positive magnitudes, the sign lives in `type`.

## Verify it works

```bash
curl localhost:4000/api/health                       # {"ok":true}
curl localhost:4000/api/resources                    # 2 demo resources (after seed)
curl localhost:4000/api/wallet/balance               # {"balance":500} (fresh seed)
open http://localhost:4000/docs                      # Swagger UI
```

## Troubleshooting

- **`P2021 table public.users does not exist`** — migrations never ran against
  that database (classic fresh-volume symptom). Run `migrate deploy` with the
  right `DATABASE_URL`.
- **`EADDRINUSE :4000`** — the compose backend and a host backend can't share
  the port. Run one: `docker compose stop portal-backend` or stop the host
  process.
- **Ports already taken** (`:5432`, `:8080`) — this repo's compose publishes
  `5432` and `8085`; if those clash too, remap `ports:` in
  `infra/docker-compose.yml` and adjust `DATABASE_URL` / `GUAC_BASE_URL`.
- **Token ends with `.stub`** — `GUAC_JSON_AUTH_SECRET` is unset: expected in
  pure-endpoint dev, wrong if you want real Guacamole logins.
- **`guac_token_failed / connection_unconfigured`** — secret is set but
  `GUAC_CONNECTION_PARAMS` has no entry for that resource's
  `guac_connection_id`.
- **Frontend 500s on `/` or `/resources`** — its server components call this
  API; fix the backend first, then rebuild/restart the frontend. The frontend
  runs separately (`frontend/`, `:3000`); the dashboard is `/`, there is no
  `/dashboard` route.
