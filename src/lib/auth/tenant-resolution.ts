import { prisma } from "@/lib/db";

/**
 * Which tenant is this login attempt for?
 *
 * Tenant RLS is fail-closed, so a user lookup needs a tenant id — but at login
 * we do not have a session yet. `organizations` is deliberately the one table
 * with no tenant_id and no RLS policy, which is what makes this lookup possible
 * without handing the application role owner privileges.
 *
 * ponytail: single tenant today, so this returns the only organization. When a
 * second tenant is onboarded, resolve from the request subdomain
 * (despl.tracker.app) or a verified email-domain mapping, and delete the
 * single-org branch. Everything downstream already takes tenantId as input, so
 * only this function changes.
 */
export async function resolveTenantForLogin(_email: string): Promise<number | null> {
  const orgs = await prisma.organization.findMany({ select: { id: true }, take: 2 });
  if (orgs.length === 1) return orgs[0].id;
  return null;
}
