import { PrismaClient } from "@/generated/prisma/client";

/**
 * Prisma singleton.
 *
 * Connects via DATABASE_URL as `despl_web`, a NON-OWNER role. That matters:
 *   · tenant RLS policies apply to every query this client makes
 *   · audit_log and domain_events have no UPDATE/DELETE grant (invariant #5)
 * Migrations and prisma/seed.ts use DIRECT_URL (the owner) instead.
 *
 * Never point DATABASE_URL at a superuser — a superuser bypasses both, which
 * is exactly how the previous schema's protections became a silent no-op.
 * `despl_web` is provisioned by scripts/provision-db-role.sql, and
 * `assertDbRole` (src/lib/db-guard.ts, run from src/instrumentation.ts at
 * server startup) enforces this at boot instead of just documenting it.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    // Default (5s) gets tight over a public proxy connection (e.g. one-off
    // admin scripts run against Railway's public URL); the deployed app talks
    // to Postgres over Railway's internal network and never gets close to this.
    transactionOptions: { timeout: 20_000 },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Transaction client — every service function receives one of these. */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Run work with tenant isolation enforced by the database.
 *
 * `set_config(..., true)` is TRANSACTION-LOCAL, so the setting cannot leak
 * across pooled connections — which is why every scoped read and write has to
 * happen inside this transaction rather than on the bare client.
 *
 * RLS is fail-closed: if app.tenant_id is not set, queries return zero rows
 * and inserts are rejected. A missed call here shows up immediately as empty
 * results, never as a silent cross-tenant read.
 */
export async function withTenant<T>(tenantId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`withTenant: invalid tenantId ${tenantId}`);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
    return fn(tx);
  });
}
