-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'engineer', 'analyst');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'engineer',
ADD COLUMN     "team" TEXT;
