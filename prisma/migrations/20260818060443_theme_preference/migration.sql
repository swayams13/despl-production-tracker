-- CreateEnum
CREATE TYPE "ThemePreference" AS ENUM ('SYSTEM', 'LIGHT', 'DARK');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "outdoor_mode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "theme_preference" "ThemePreference" NOT NULL DEFAULT 'SYSTEM';
