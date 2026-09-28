-- Servers are mirrored into Guacamole's own database; remember the connection id.
ALTER TABLE "resources" ADD COLUMN "guac_connection_id" TEXT;
