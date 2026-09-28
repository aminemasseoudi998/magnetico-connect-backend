# Magnetico infra

Google sign-in via Keycloak, the Portal database, and the remote-access
gateway (guacd + Guacamole). nginx and the billing daemon come later.

| Service       | Image                            | Host port                                  |
| ------------- | -------------------------------- | ------------------------------------------ |
| `portal-db`   | `postgres:16`                    | `5432`                                     |
| `keycloak-db` | `postgres:16`                    | —                                          |
| `keycloak`    | `quay.io/keycloak/keycloak:26.3` | `8180` → `http://localhost:8180/auth`      |
| `guacd`       | `guacamole/guacd:1.6.0`          | — (own network, talks SSH/RDP to servers)  |
| `guac-db`     | `postgres:16`                    | — (Guacamole's own database)               |
| `guacamole`   | `guacamole/guacamole:1.6.0`      | `127.0.0.1:8085` — admin dashboard, loopback only |

## 1. Google OAuth client (one time)

Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID**
(type *Web application*). Authorized redirect URI:

```
http://localhost:8180/auth/realms/magnetico/broker/google/endpoint
```

## 2. Start

```bash
cd infra
cp .env.example .env        # GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / PORTAL_CLIENT_SECRET
docker compose up -d
```

The realm `magnetico` is imported from `keycloak/magnetico-realm.json` on first
boot (placeholders filled from `.env`). **The import only runs when the realm
does not exist yet.** After editing the JSON or the secrets, reset with
`docker compose down -v && docker compose up -d` (this wipes both databases),
or change the setting in the admin console.

## 3. Wire the apps

| File                   | Values                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `backend/.env`         | `KEYCLOAK_ISSUER=http://localhost:8180/auth/realms/magnetico`                              |
| `frontend/.env`  | `KEYCLOAK_ISSUER` (same), `KEYCLOAK_CLIENT_SECRET` = `PORTAL_CLIENT_SECRET`, `APP_URL=http://localhost:3000` |

Use the **same host** (`localhost`) everywhere: it is part of the token `iss`.

## Roles: user vs admin

- **Admins are the emails in `ADMIN_EMAILS`** (`infra/.env`, comma-separated).
  They get the realm role `admin` at every Google sign-in and land on `/admin`.
  Remove an email and that person is a normal user from their next sign-in.
- Everyone else gets **`user`** (realm default role) and lands on `/`.
- The list is the source of truth: an `admin` role assigned by hand in the
  Keycloak console is removed at that person's next sign-in unless their
  email is in the list.
- An admin only gets the admin console; there is no switch to the user
  dashboard. To use both, use two Google accounts.

## Users never see Keycloak

The login button sends people through Keycloak with `kc_idp_hint=google`, so
they go straight to Google's sign-in and back to the app. First and last name
are optional in the realm's user profile, so Keycloak's "update account
information" form never appears, even for Google accounts without a last name.

## Remote access: guacd + Guacamole

- **Guacamole has its own database (`guac-db`) and an admin dashboard:**
  `http://localhost:8085/guacamole`, log in with `GUAC_ADMIN_USER` /
  `GUAC_ADMIN_PASSWORD` from `infra/.env`. Loopback only — never publish it.
- **Two-way sync between Admin → Servers and Guacamole's connections**
  (every 30 s, on each Admin → Servers page load, and with the
  **Sync with Guacamole** button):
  - added in the portal → created in Guacamole (group **Magnetico**);
  - added in Guacamole (any group, SSH or RDP) → appears in Admin → Servers
    as **Drained** and "Imported from Guacamole": set its price and access,
    then put it in service;
  - edited on either side → copied to the other (both sides edited within the
    same 30 s: Guacamole wins);
  - deleted on either side → deleted on the other (live sessions ended,
    billing history kept).
  Price, access, tier and limits exist only in the portal. Guacamole
  parameters the portal has no field for (recording, SFTP…) are kept as-is.
- **Each portal user has a Guacamole account** (username = their email,
  random password nobody sees). It has no permissions at rest: the backend
  grants access to one connection when a session opens and removes it when
  it ends. Guacamole's **Active sessions** and **History** show who used what.
- Users never open Guacamole: the portal proxies their sessions, and they
  don't know their Guacamole password.
- **guacd** is the only container that connects to your servers, on its own
  `remote-access` network with no route to the portal DB or Keycloak.
  Addresses are resolved from guacd: LAN/internet hosts as usual, a server on
  this Docker host as `host.docker.internal`.
- Accounts are created **once**, when the `guac-db` volume is first
  initialised (`guacamole-db/002-accounts.sh`): your admin + the backend's
  service account (`GUAC_SERVICE_USER` / `GUAC_SERVICE_PASSWORD`, same values in
  `backend/.env`). To change them later, change them in the Guacamole UI (your
  admin) or recreate the volume: `docker compose rm -sf guacamole guac-db &&
  docker volume rm magnetico_guac-db-data && docker compose up -d` (servers
  come back automatically at the next sync; history is lost).
- Guacamole stores connection passwords in `guac-db` — that is how Guacamole
  works. The portal keeps its own encrypted copy as the source of truth.
- **Session recordings**: servers with "Record sessions" on are recorded by
  guacd into `infra/recordings/` (bind mount, git-ignored), one folder per
  session. Replay them in Admin → Sessions or in Guacamole's History. They
  are not deleted automatically — clean up old folders to save disk space.
- Logs when a connection fails: `docker compose logs -f guacd guacamole`.
