import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { logout } from "@/app/actions/auth";

/**
 * Day 1 landing page.
 *
 * Deliberately plain — its job is to prove the stack end to end: a session
 * cookie resolves to an actor, the actor's tenant scopes a database read
 * through RLS, and real seeded DESPL data comes back. The department
 * workspaces and dashboards land on day 3.
 */
export default async function Home() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const data = await withTenant(actor.tenantId, async (tx) => {
    const jobs = await tx.job.findMany({
      include: {
        client: true,
        family: true,
        equipments: { include: { _count: { select: { units: true, bomItems: true } } } },
        _count: { select: { processes: true } },
      },
      orderBy: { jobNumber: "asc" },
    });
    const departments = await tx.department.count();
    const routes = await tx.routeTemplate.count();
    return { jobs, departments, routes };
  });

  const equipmentCount = data.jobs.reduce((n, j) => n + j.equipments.length, 0);

  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--hairline)] pb-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">DESPL Production Tracker</h1>
          <p className="mt-1 text-sm text-[var(--muted-fg)]">
            {actor.name} · {actor.roles.join(", ")}
            {actor.departmentIds.length > 0
              ? ` · scoped to ${actor.departmentIds.length} department(s)`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/component-gallery"
            className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:bg-[var(--surface-sunken)]"
          >
            Component gallery
          </a>
          <form action={logout}>
            <button
              type="submit"
              className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:bg-[var(--surface-sunken)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Jobs", data.jobs.length],
          ["Equipments", equipmentCount],
          ["Departments", data.departments],
          ["Component routes", data.routes],
        ].map(([label, value]) => (
          <div
            key={label as string}
            className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-4"
          >
            <div className="text-xs text-[var(--muted-fg)]">{label}</div>
            <div className="tabular mt-1 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Jobs</h2>
        <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--hairline)] text-left text-xs text-[var(--muted-fg)]">
              <tr>
                <th className="px-4 py-2 font-medium">Job</th>
                <th className="px-4 py-2 font-medium">Family</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 text-right font-medium">Equip.</th>
                <th className="px-4 py-2 text-right font-medium">Units</th>
                <th className="px-4 py-2 text-right font-medium">BOM</th>
                <th className="px-4 py-2 text-right font-medium">Processes</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((job) => {
                const units = job.equipments.reduce((n, e) => n + e._count.units, 0);
                const bom = job.equipments.reduce((n, e) => n + e._count.bomItems, 0);
                return (
                  <tr key={job.id} className="border-b border-[var(--hairline)] last:border-0">
                    <td className="px-4 py-2 font-medium">{job.jobNumber}</td>
                    <td className="px-4 py-2 text-[var(--muted-fg)]">{job.family.name}</td>
                    <td className="px-4 py-2 text-[var(--muted-fg)]">
                      {job.projectName ?? "—"}
                    </td>
                    <td className="tabular px-4 py-2 text-right">{job.equipments.length}</td>
                    <td className="tabular px-4 py-2 text-right">{units}</td>
                    <td className="tabular px-4 py-2 text-right">{bom}</td>
                    <td className="tabular px-4 py-2 text-right">{job._count.processes}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--muted-fg)]">
          Every row above was read under tenant row-level security as{" "}
          <code className="rounded bg-[var(--surface-sunken)] px-1">despl_web</code>, a
          non-owner database role. Each job carries its own editable copy of the 36-process
          spine, materialised from the pinned pressure-vessel template version.
        </p>
      </section>
    </main>
  );
}
