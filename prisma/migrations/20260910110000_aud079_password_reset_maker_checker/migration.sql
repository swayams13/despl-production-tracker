-- AUD-079 — admin password reset defeats maker-checker.
--
-- resetUserPassword no longer performs an immediate reset when the target
-- holds QC or ADMIN: it records a PendingPasswordReset row instead, and a
-- DIFFERENT admin must call approvePasswordReset to actually perform it.
-- No plaintext password is ever stored on this table (SPEC S9) — only who
-- requested/approved and when.

-- CreateEnum
CREATE TYPE "PendingPasswordResetStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "pending_password_resets" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "target_user_id" INTEGER NOT NULL,
    "requested_by" INTEGER NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "PendingPasswordResetStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by" INTEGER,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "pending_password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_password_resets_tenant_id_idx" ON "pending_password_resets"("tenant_id");

-- CreateIndex
CREATE INDEX "pending_password_resets_target_user_id_idx" ON "pending_password_resets"("target_user_id");

-- AddForeignKey
ALTER TABLE "pending_password_resets" ADD CONSTRAINT "pending_password_resets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_password_resets" ADD CONSTRAINT "pending_password_resets_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_password_resets" ADD CONSTRAINT "pending_password_resets_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_password_resets" ADD CONSTRAINT "pending_password_resets_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant RLS on the new tenant-root table (see rls-coverage.test.ts), same
-- fail-closed shape as every other tenant-grain table (AUD-001).
ALTER TABLE "pending_password_resets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "pending_password_resets"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);
