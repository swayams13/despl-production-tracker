import { prisma } from "@/lib/db";

/** The one real tenant this deployment serves today — see the doc comment below. */
const SINGLE_TENANT_CODE = "DESPL";

/**
 * Which tenant is this login attempt for?
 *
 * Tenant RLS is fail-closed, so a user lookup needs a tenant id — but at login
 * we do not have a session yet. `organizations` is deliberately the one table
 * with no tenant_id and no RLS policy, which is what makes this lookup possible
 * without handing the application role owner privileges.
 *
 * ponytail: single tenant today, so this resolves the one known tenant by its
 * seeded code (matches `prisma/seed.ts`'s `code: "DESPL"`) rather than by
 * counting rows — counting broke every login the moment unrelated rows existed
 * (e.g. leaked `TEST-*`/`DELAY-*` fixtures from a DB-gated test run pointed at
 * the wrong database; see progress.md, 16 Aug 2026). Resolving by code ignores
 * such rows instead of being defeated by their mere existence. When a second
 * REAL tenant is onboarded, resolve from the request subdomain
 * (despl.tracker.app) or a verified email-domain mapping, and delete the
 * single-tenant branch. Everything downstream already takes tenantId as input,
 * so only this function changes.
 */
export async function resolveTenantForLogin(_email: string): Promise<number | null> {
  const org = await prisma.organization.findUnique({ where: { code: SINGLE_TENANT_CODE } });
  return org?.id ?? null;
}
