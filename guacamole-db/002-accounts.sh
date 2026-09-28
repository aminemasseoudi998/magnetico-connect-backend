#!/bin/bash
#
# Runs once, when the guac-db volume is first created (after 001-schema.sql,
# Guacamole's official PostgreSQL schema with its default guacadmin/guacadmin).
#
#   1. The default "guacadmin" becomes YOUR admin: GUAC_ADMIN_USER /
#      GUAC_ADMIN_PASSWORD from infra/.env. Use it to open the Guacamole
#      dashboard (http://localhost:8085/guacamole).
#   2. A separate service account for the portal backend:
#      GUAC_SERVICE_USER / GUAC_SERVICE_PASSWORD (same values in backend/.env).
#      The backend syncs servers and per-user accounts with it, so changing
#      your own admin password never breaks the portal.
#
# Password hash = SHA-256(password || UPPER(hex(salt))) — Guacamole's format.

set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v admin_user="$GUAC_ADMIN_USER" \
  -v admin_password="$GUAC_ADMIN_PASSWORD" \
  -v service_user="$GUAC_SERVICE_USER" \
  -v service_password="$GUAC_SERVICE_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. guacadmin -> your admin, with your password.
UPDATE guacamole_entity SET name = :'admin_user'
 WHERE name = 'guacadmin' AND type = 'USER';

WITH s AS (SELECT gen_random_bytes(32) AS salt)
UPDATE guacamole_user u
   SET password_salt = s.salt,
       password_hash = sha256(convert_to(:'admin_password' || upper(encode(s.salt, 'hex')), 'UTF8')),
       password_date = CURRENT_TIMESTAMP
  FROM s, guacamole_entity e
 WHERE e.entity_id = u.entity_id AND e.type = 'USER' AND e.name = :'admin_user';

-- 2. Portal backend service account, with the same system permissions.
INSERT INTO guacamole_entity (name, type) VALUES (:'service_user', 'USER');

WITH s AS (SELECT gen_random_bytes(32) AS salt)
INSERT INTO guacamole_user (entity_id, password_hash, password_salt, password_date, full_name)
SELECT e.entity_id,
       sha256(convert_to(:'service_password' || upper(encode(s.salt, 'hex')), 'UTF8')),
       s.salt,
       CURRENT_TIMESTAMP,
       'Magnetico portal (service account — do not use)'
  FROM guacamole_entity e, s
 WHERE e.name = :'service_user' AND e.type = 'USER';

INSERT INTO guacamole_system_permission (entity_id, permission)
SELECT svc.entity_id, p.permission
  FROM guacamole_entity svc
  JOIN guacamole_entity adm ON adm.name = :'admin_user' AND adm.type = 'USER'
  JOIN guacamole_system_permission p ON p.entity_id = adm.entity_id
 WHERE svc.name = :'service_user' AND svc.type = 'USER';
SQL

echo "guac-db: admin '$GUAC_ADMIN_USER' and service account '$GUAC_SERVICE_USER' ready"
