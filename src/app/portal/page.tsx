import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { logout } from "@/app/actions/auth";

/**
 * Client portal — placeholder.
 *
 * Day 1 establishes only the ACCESS BOUNDARY: a client user lands here, can
 * reach nothing else, and reads exclusively through their visibility policy.
 * The order view (headline progress → per-equipment drill-down → unit timeline
 * and TPI call dates) is built on day 3, reading ProgressSnapshot.
 *
 * Nothing here is exposed externally until DESPL's team reviews the design.
 *
 * `mustChangePassword` interstitial (Task 1.3): `/portal` lives OUTSIDE the
 * (app) route group, so it doesn't inherit that layout's redirect — every
 * client user (`clientId !== null`) lands here straight from `login()`, so
 * without this check a forced-change client user could reach the portal
 * without ever changing their temp password. `/account/password` also lives
 * outside (app), so there is no self-redirect loop.
 */
export default async function PortalPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) redirect("/account/password");
  if (actor.clientId === null) redirect("/");

  const clientId = actor.clientId;
  const view = await withTenant(actor.tenantId, async (tx) => {
    const client = await tx.client.findFirst({
      where: { id: clientId },
      include: { visibilityPolicy: true, _count: { select: { jobs: true } } },
    });
    return client;
  });

  return (
    <main className="mx-auto max-w-3xl px-5 py-8">
      <header className="flex items-start justify-between gap-4 border-b border-[var(--hairline)] pb-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Your orders</h1>
          <p className="mt-1 text-sm text-[var(--muted-fg)]">{actor.name}</p>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:bg-[var(--surface-sunken)]"
          >
            Sign out
          </button>
        </form>
      </header>

      <div className="mt-6 rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-5">
        <p className="text-sm">
          {view?._count.jobs ?? 0} order(s) on record. Progress reporting is published on a{" "}
          <strong>{view?.visibilityPolicy?.cadence.toLowerCase() ?? "weekly"}</strong> basis.
        </p>
        <p className="mt-3 text-sm text-[var(--muted-fg)]">
          The order progress view is in preparation and will appear here.
        </p>
      </div>
    </main>
  );
}
