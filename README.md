# Magnetico infra

Current scope: **Google sign-in via Keycloak** + the **Portal database**.
Guacamole, guacd, the billing daemon and nginx come later.

| Service       | Image                            | Host port                     |
| ------------- | -------------------------------- | ----------------------------- |
| `portal-db`   | `postgres:16`                    | `5432`                        |
| `keycloak-db` | `postgres:16`                    | —                             |
| `keycloak`    | `quay.io/keycloak/keycloak:26.3` | `8180` → `http://localhost:8180/auth` |

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
