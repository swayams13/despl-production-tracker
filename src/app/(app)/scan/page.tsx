import { redirectToLogin } from "@/lib/auth/login-redirect";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { withTenant } from "@/lib/db";
import { getActor } from "@/lib/authz";
import { FEATURES } from "@/lib/shared/flags";

/**
 * Lean Core L2.2: Scan. Phones scan the traveller QR with their camera app,
 * which opens /u/<publicId> directly; this page is the keyboard path (a
 * serial typed or read by a USB scanner). The serial is looked up here and
 * only the opaque id goes in the URL. Behind `leanFloor` with its target.
 */
export default async function ScanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!FEATURES.leanFloor) notFound();
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");

  const sp = await searchParams;
  const raw = Array.isArray(sp.serial) ? sp.serial[0] : sp.serial;
  const serial = raw?.trim() ?? "";

  const matches = serial
    ? await withTenant(actor.tenantId, (tx) =>
        tx.unit.findMany({
          where: { serialNo: { equals: serial, mode: "insensitive" } },
          select: { publicId: true, serialNo: true, job: { select: { jobNumber: true, projectName: true } } },
          orderBy: { id: "asc" },
          take: 10,
        }),
      )
    : [];
  if (matches.length === 1) redirect(`/u/${matches[0].publicId}`);

  return (
    <>
      <div className="page-h">
        <h1>Scan</h1>
        <span className="sub">Type a serial, or scan a traveller with a USB scanner.</span>
      </div>
      <form action="/scan" method="get" className="card" style={{ padding: 16, display: "grid", gap: 10, maxWidth: 420 }}>
        <label htmlFor="serial" style={{ fontSize: "var(--fs-sm, 12px)", fontWeight: 600 }}>
          Unit serial
        </label>
        <input
          id="serial"
          name="serial"
          className="ws-detail"
          defaultValue={serial}
          autoFocus
          autoCapitalize="characters"
          autoComplete="off"
          placeholder="e.g. 320SR05"
        />
        <button className="btn btn-accent" type="submit" style={{ minHeight: 44 }}>
          Open unit
        </button>
      </form>
      {serial && matches.length === 0 && (
        <p className="note" role="status">
          No unit has the serial {serial}. Check the traveller and try again.
        </p>
      )}
      {matches.length > 1 && (
        <div className="card" style={{ marginTop: 14, padding: 16, maxWidth: 420 }}>
          <p style={{ margin: "0 0 8px" }}>More than one unit has that serial. Pick the job:</p>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
            {matches.map((m) => (
              <li key={m.publicId}>
                <Link className="btn" style={{ display: "block", minHeight: 44 }} href={`/u/${m.publicId}`}>
                  {m.serialNo} · {m.job.jobNumber}
                  {m.job.projectName ? ` · ${m.job.projectName}` : ""}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
