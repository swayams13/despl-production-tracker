import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Every table carrying tenant_id must have RLS enabled AND a tenant_isolation
 * policy. db-guard.ts checks the connected ROLE; nothing checked policy
 * COVERAGE, so a new tenant-root table could ship with no isolation at all and
 * nothing would fail. equipment_type_refs was very nearly that table.
 *
 * AUD-001 (9 Sep 2026): the original version of this test's coverage query
 * filtered on "has a tenant_id column" — which is exactly the class of gap
 * it was blind to. All 28 job-grain tables (job_isolation) had ZERO tenant_id
 * column at all until this session, so this test's own coverage query
 * silently excluded every one of them and passed while cross-tenant read AND
 * write worked live (see audit/11_DATABASE_AUDIT.md §3.3, audit/12_SECURITY_RBAC.md
 * §1). The fix, per the roadmap's own instruction: key the coverage query off
 * job_id instead — every table that carries job_id must have BOTH
 * job_isolation and a tenant_isolation policy. A future migration that adds a
 * new job-owned table without wiring its tenant floor now fails this test
 * instead of reproducing AUD-001 silently.
 *
 * KNOWN_UNPROTECTED_JOB_TABLES was a live, load-bearing allowlist for the 9
 * tables AUD-080 has now enrolled (equipments, job_processes, schedule_runs,
 * qcp_templates, weld_joints, weld_logs, assembly_drawings, dispatch_batches,
 * packages — see prisma/migrations/20260909140000_aud080_job_isolation_
 * remaining_tables through 20260909180000_aud080_tenant_id_autofill_trigger).
 * Per its own instruction ("delete the entry... once the list is empty,
 * delete the allowlist mechanism itself"), the mechanism is removed now that
 * it's empty — a future job-grain table landing with no policy fails this
 * test directly instead of needing a new allowlist entry first.
 */
const KNOWN_UNPROTECTED_JOB_TABLES = new Set<string>([]);

describe.skipIf(!process.env.RUN_DB_TESTS)("tenant RLS coverage (DB)", () => {
  it("every table with a job_id column has RLS enabled, job_isolation, and a tenant_isolation policy (except the tracked AUD-080 gap)", async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        table_name: string;
        rowsecurity: boolean;
        job_policy_count: bigint;
        tenant_policy_count: bigint;
      }>
    >`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rowsecurity,
             (SELECT count(*) FROM pg_policy p
               WHERE p.polrelid = c.oid AND p.polname = 'job_isolation') AS job_policy_count,
             (SELECT count(*) FROM pg_policy p
               WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS tenant_policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'job_id'
        )
      ORDER BY c.relname
    `;

    // 38 as of AUD-001 (9 Sep 2026): the 28 AUD-001 tables + progress_snapshots
    // (tenant-root since before H1, correctly has tenant_isolation but no
    // job_isolation — not a gap) + the 9 tracked AUD-080 tables above. Pinned
    // so a future job-grain table landing with no policy AND no allowlist
    // entry doesn't silently change this count without review.
    expect(rows.length).toBe(38);
    const unprotected = rows.filter((r) => {
      if (KNOWN_UNPROTECTED_JOB_TABLES.has(r.table_name)) return false;
      if (r.table_name === "progress_snapshots") {
        // Tenant-root table, not job_isolation-covered by design — only the
        // tenant policy is required here.
        return !r.rowsecurity || Number(r.tenant_policy_count) === 0;
      }
      return !r.rowsecurity || Number(r.job_policy_count) === 0 || Number(r.tenant_policy_count) === 0;
    });
    expect(
      unprotected.map((r) => r.table_name),
      "job-grain tables missing RLS, job_isolation, or a tenant_isolation policy (and not a tracked AUD-080 exception)",
    ).toEqual([]);
  });

  it("every table with a tenant_id column has RLS enabled and a tenant_isolation policy", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ table_name: string; rowsecurity: boolean; policy_count: bigint }>
    >`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rowsecurity,
             (SELECT count(*) FROM pg_policy p
               WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'tenant_id'
        )
      ORDER BY c.relname
    `;

    expect(rows.length).toBeGreaterThan(0);
    const unprotected = rows.filter((r) => !r.rowsecurity || Number(r.policy_count) === 0);
    expect(
      unprotected.map((r) => r.table_name),
      "tenant-root tables missing RLS or a tenant_isolation policy",
    ).toEqual([]);
  });

  it("includes equipment_type_refs in the protected set", async () => {
    const rows = await prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'equipment_type_refs'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
  });
});
