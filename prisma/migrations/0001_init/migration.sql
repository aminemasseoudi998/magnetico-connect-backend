-- Portal DB initial migration (0001_init).
-- Matches backend/prisma/schema.prisma. Guacamole's own tables live in the
-- SEPARATE guac-db database and are never created here.

CREATE TYPE "Protocol" AS ENUM ('ssh', 'rdp');
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE "SessionStatus" AS ENUM ('pending', 'active', 'closed', 'killed', 'reconciled');
CREATE TYPE "LedgerType" AS ENUM ('topup', 'hold', 'charge', 'refund');

CREATE TABLE "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "keycloak_sub" TEXT NOT NULL UNIQUE,
  "email" TEXT NOT NULL UNIQUE,
  "display_name" TEXT NOT NULL,
  "status" "UserStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE "resources" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL UNIQUE,
  "protocol" "Protocol" NOT NULL,
  "tier" TEXT NOT NULL,
  "guac_connection_id" TEXT NOT NULL,
  "rate_per_minute" DECIMAL(12,4) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE "entitlements" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "resource_id" UUID NOT NULL REFERENCES "resources"("id") ON DELETE CASCADE,
  "max_session_min" INTEGER,
  "allowed_hours" TEXT,
  "granted_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  UNIQUE ("user_id", "resource_id")
);
CREATE INDEX "entitlements_user_id_idx" ON "entitlements" ("user_id");
CREATE INDEX "entitlements_resource_id_idx" ON "entitlements" ("resource_id");

CREATE TABLE "sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "resource_id" UUID NOT NULL REFERENCES "resources"("id") ON DELETE RESTRICT,
  "hold_amount" DECIMAL(12,4) NOT NULL,
  "status" "SessionStatus" NOT NULL DEFAULT 'pending',
  "guac_history_ref" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "ended_at" TIMESTAMPTZ(6),
  "final_charge" DECIMAL(12,4),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "sessions_user_id_status_idx" ON "sessions" ("user_id", "status");
CREATE INDEX "sessions_resource_id_idx" ON "sessions" ("resource_id");

-- APPEND-ONLY by convention: the backend must only INSERT here, never
-- UPDATE or DELETE. No DB trigger is added yet (see hardening notes, step 14).
CREATE TABLE "ledger_entries" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" UUID REFERENCES "sessions"("id") ON DELETE SET NULL,
  "type" "LedgerType" NOT NULL,
  "amount" DECIMAL(12,4) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "ledger_entries_user_id_created_at_idx" ON "ledger_entries" ("user_id", "created_at");
CREATE INDEX "ledger_entries_session_id_idx" ON "ledger_entries" ("session_id");
