-- Servers are configured from the admin console: connection target,
-- encrypted credentials, protocol/policy settings and access mode live on
-- the resource row. The old env-based guac_connection_id mapping is gone.

ALTER TABLE "resources"
  ADD COLUMN "description"     TEXT,
  ADD COLUMN "hostname"        TEXT,
  ADD COLUMN "port"            INTEGER,
  ADD COLUMN "username"        TEXT,
  ADD COLUMN "password_enc"    TEXT,
  ADD COLUMN "private_key_enc" TEXT,
  ADD COLUMN "passphrase_enc"  TEXT,
  ADD COLUMN "settings"        JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "max_session_min" INTEGER,
  ADD COLUMN "open_to_all"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archived_at"     TIMESTAMPTZ(6),
  ADD COLUMN "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing rows predate per-server configuration: give them a placeholder
-- target and take them out of service until an admin configures them.
UPDATE "resources"
   SET "hostname" = '',
       "port"     = CASE WHEN "protocol" = 'rdp' THEN 3389 ELSE 22 END,
       "active"   = false;

ALTER TABLE "resources"
  ALTER COLUMN "hostname" SET NOT NULL,
  ALTER COLUMN "port"     SET NOT NULL,
  DROP COLUMN "guac_connection_id";

ALTER TABLE "sessions"
  ADD COLUMN "rate_per_minute" DECIMAL(12,4),
  ADD COLUMN "end_reason"   TEXT,
  ADD COLUMN "last_seen_at" TIMESTAMPTZ(6);
