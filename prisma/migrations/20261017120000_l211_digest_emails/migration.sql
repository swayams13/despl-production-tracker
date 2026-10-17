-- Lean Core L2.11 — the morning digest email's retry guard.
-- One row per recipient per digest day, written after the SMTP server accepted
-- the message. The cron skips any recipient who already has a row, so a retry
-- or a manual re-run never mails anyone twice, and a "Send now" earlier in the
-- day (which only creates in-app notifications) cannot suppress the email.
-- New table, no backfill. Tenant-root RLS as notifications; append-only for the
-- app role (no UPDATE/DELETE), the same shape as work_requests.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "digest_emails" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "digest_date" DATE NOT NULL,
    "recipient_id" INTEGER NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "digest_emails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "digest_emails_tenant_id_digest_date_recipient_id_key"
  ON "digest_emails"("tenant_id", "digest_date", "recipient_id");
CREATE INDEX "digest_emails_recipient_id_idx" ON "digest_emails"("recipient_id");

ALTER TABLE "digest_emails" ADD CONSTRAINT "digest_emails_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digest_emails" ADD CONSTRAINT "digest_emails_recipient_id_fkey"
  FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "digest_emails" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "digest_emails"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);

REVOKE UPDATE, DELETE, TRUNCATE ON "digest_emails" FROM despl_app;
