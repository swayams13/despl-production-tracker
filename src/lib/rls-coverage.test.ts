import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Every table carrying tenant_id must have RLS enabled AND a tenant_isolation
 * policy. db-guard.ts checks the connected ROLE; nothing checked policy
 * COVERAGE, so a new tenant-root table could ship with no isolation at all and
 * nothing would fail. equipment_type_refs was very nearly that table.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("tenant RLS coverage (DB)", () => {
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
