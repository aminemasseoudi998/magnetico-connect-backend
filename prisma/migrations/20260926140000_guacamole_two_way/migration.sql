-- Two-way sync with Guacamole: remember what was last synced, and mark
-- servers that were created from a Guacamole connection.
ALTER TABLE "resources"
  ADD COLUMN "guac_fingerprint" TEXT,
  ADD COLUMN "guac_imported" BOOLEAN NOT NULL DEFAULT false;
