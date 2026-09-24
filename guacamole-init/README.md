# First-boot seed for guac-db (official Guacamole schema).
#
# The guacamole image does NOT auto-create its own tables. On a fresh clone:
#
#   1. docker run --rm guacamole/guacamole:1.5.5 \
#        /opt/guacamole/bin/initdb.sh --postgresql > guacamole-init/initdb.sql
#   2. docker compose up -d guac-db guacd guacamole
#
# The *.sql file in THIS folder is executed once by postgres' entrypoint
# (mounted as /docker-entrypoint-initdb.d). Keep this placeholder tracked so
# the mount target always exists; replace it with the generated initdb.sql.
#
# This keeps Guacamole's schema 100% isolated from the Portal DB (portal-db),
# which is managed exclusively by Prisma (backend/prisma/).
