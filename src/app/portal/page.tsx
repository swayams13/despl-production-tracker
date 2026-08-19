import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { logout } from "@/app/actions/auth";
import { loadClientPortalView } from "@/lib/services/client-snapshot.read";
import { ClientPortalView } from "@/components/industrial/client-portal-view";

/**
 * Client portal. Reads exclusively through loadClientPortalView, which
 * only ever selects VERIFIED snapshot rows — see
 * docs/superpowers/specs/2026-08-19-client-portal-daily-updates-design.md.
 */
export default async function PortalPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) redirect("/account/password");
  if (actor.clientId === null) redirect("/");

  const jobs = await loadClientPortalView(actor);

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

      <div className="mt-6">
        <ClientPortalView jobs={jobs} />
      </div>
    </main>
  );
}
