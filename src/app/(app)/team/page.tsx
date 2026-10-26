import { redirectToLogin } from "@/lib/auth/login-redirect";
import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { FEATURES } from "@/lib/shared/flags";

/**
 * Lean Core L2.5: /team is the viewer's own department; a Production Head or
 * Admin (no department of their own) lands on the first floor department and
 * switches from there. Behind `leanFloor` like the rest of the L2 screens.
 */
export default async function TeamIndex({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!FEATURES.leanFloor) notFound();
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");

  const dept = await withTenant(actor.tenantId, (tx) =>
    tx.department.findFirst({
      where: { tenantId: actor.tenantId, ...(actor.departmentIds.length ? { id: { in: actor.departmentIds } } : {}) },
      orderBy: [{ isOfficeDept: "asc" }, { name: "asc" }],
      select: { code: true },
    }),
  );
  if (!dept) notFound();
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === "string") q.set(k, v);
  redirect(`/team/${dept.code.toLowerCase()}${q.size ? `?${q}` : ""}`);
}
