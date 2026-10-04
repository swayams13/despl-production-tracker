import { Prisma, PrismaClient } from "@/generated/prisma/client";

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
 *
 * Also pins this transaction's session timezone to UTC the same way
 * (final whole-branch review, Finding 4). `scripts/provision-db-role.sql`'s
 * `ALTER ROLE despl_web SET timezone = 'UTC'` only reaches environments
 * someone re-runs it against — Railway, every teammate's local DB, and the
 * demo laptop were all provisioned before that fix existed. A second
 * `set_config('TimeZone', 'UTC', true)` here is self-applying: it runs on
 * every transaction regardless of how the role was originally provisioned,
 * so no environment can silently drift back to the server's own default
 * (see provision-db-role.sql's comment for the exact naive-timestamp bug
 * this closes).
 */
/**
 * `timeoutMs` — task review Important #4 (B4, Phase 4): the client-wide
 * `transactionOptions.timeout` above (20s) is already generous for a normal
 * mutation, but `bom.service.ts`'s `importBomItems` does ~2 round-trips per
 * row (create + audit insert) inside one transaction, and a real BOM
 * workbook runs to hundreds of rows — plausible to exceed 20s over real
 * network latency, which would throw a raw Prisma `P2028` (not an
 * `AppError`) and roll back the WHOLE batch silently, exactly the
 * whole-batch-abort failure mode per-row error reporting was built to avoid.
 * Optional and rarely needed — only a caller doing unusually many writes in
 * one transaction should pass it.
 */
export async function withTenant<T>(
  tenantId: number,
  fn: (tx: Tx) => Promise<T>,
  opts?: { timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`withTenant: invalid tenantId ${tenantId}`);
  }
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      await tx.$executeRaw`SELECT set_config('TimeZone', 'UTC', true)`;
      return fn(tx);
    },
    opts?.timeoutMs || opts?.isolationLevel
      ? { timeout: opts?.timeoutMs, isolationLevel: opts?.isolationLevel }
      : undefined,
  );
}

/**
 * Run work with BOTH tenant and job-level isolation enforced by the
 * database. Same transaction-local set_config discipline as withTenant —
 * see that function's doc comment for why set_config must run inside the
 * $transaction callback.
 *
 * Use this instead of withTenant only when the operation is genuinely
 * scoped to ONE job (component-operation/assembly-step/NCR/stock mutations,
 * process-plan gating, drawing linking, delay filing). Cross-job reads
 * (dashboard, portfolio, job list, my-day, command-center, notifications)
 * must keep using withTenant — the job_isolation RLS policy is fail-open
 * when app.job_id is unset, which is exactly what keeps those working.
 */
export async function withJob<T>(
  tenantId: number,
  jobId: number,
  fn: (tx: Tx) => Promise<T>,
  opts?: { timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new Error(`withJob: invalid jobId ${jobId}`);
  }
  return withTenant(
    tenantId,
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.job_id', ${String(jobId)}, true)`;
      return fn(tx);
    },
    opts,
  );
}

/**
 * Retries a transaction callback on a Postgres serialization failure
 * (SQLSTATE 40001, "could not serialize access due to concurrent update") —
 * the error a `RepeatableRead` transaction is EXPECTED to throw when it
 * loses a real concurrent-write race. Postgres's own docs say the correct
 * response is to retry the whole transaction, not surface it as a 500.
 *
 * Confirmed live (not assumed) against Prisma 6.19.3 + Postgres 16 with two
 * concurrent RepeatableRead transactions racing an update on the same row —
 * Prisma surfaces this in two different shapes depending on whether the
 * conflicting statement was a raw query or a normal Prisma Client call:
 *   - Normal Prisma Client method (tx.model.update/updateMany/etc, what
 *     every gating service here actually uses): `PrismaClientKnownRequestError`
 *     with `code === "P2034"` ("Transaction failed due to a write conflict
 *     or a deadlock. Please retry your transaction"). `meta` here is just
 *     `{ modelName }` — the raw `40001`/Postgres message is NOT preserved.
 *   - A raw query (`$executeRaw`/`$queryRaw`): `PrismaClientKnownRequestError`
 *     with `code === "P2010"` and `meta.code === "40001"`.
 * Both are checked below since `_shared.ts`'s assertions mix `findMany`-style
 * Prisma calls with the occasional raw `SELECT ... FOR UPDATE`.
 */
function isSerializationFailure(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === "P2034") return true;
  if (err.code === "P2010" && (err.meta as { code?: string } | undefined)?.code === "40001") return true;
  return false;
}

export async function withSerializationRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isSerializationFailure(err) || attempt >= maxAttempts) throw err;
    }
  }
}
