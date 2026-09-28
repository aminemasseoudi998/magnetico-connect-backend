-- Roles are Keycloak's: only `admin` and `user` exist. engineer/analyst -> user.
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
CREATE TYPE "UserRole" AS ENUM ('admin', 'user');

ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole"
  USING (CASE WHEN "role"::text = 'admin' THEN 'admin' ELSE 'user' END)::"UserRole";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user';

DROP TYPE "UserRole_old";
