-- Real audit trail (append-only).
CREATE TYPE "AuditSeverity" AS ENUM ('info', 'warn', 'crit');

CREATE TABLE "audit_events" (
  "id"           UUID NOT NULL,
  "at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_id"     UUID,
  "actor_label"  TEXT NOT NULL,
  "action"       TEXT NOT NULL,
  "severity"     "AuditSeverity" NOT NULL DEFAULT 'info',
  "target_type"  TEXT NOT NULL,
  "target_id"    TEXT,
  "target_label" TEXT NOT NULL,
  "details"      JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_events_at_idx" ON "audit_events"("at");
CREATE INDEX "audit_events_target_type_target_id_idx" ON "audit_events"("target_type", "target_id");
