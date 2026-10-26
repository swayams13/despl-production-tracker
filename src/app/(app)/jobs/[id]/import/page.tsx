import { redirectToLogin } from "@/lib/auth/login-redirect";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getActor, hasRole } from "@/lib/authz";
import { IMPORT_ROLES, loadImportTarget } from "@/lib/services/job-import.service";
import { PageHeader } from "@/components/industrial/page-header";
import { TrackerImport } from "./_import";

/**
 * Lean Core L2.10 part A: load a DESPL tracker sheet (the DE0463 / DE0467 format)
 * into this job: equipment, BOM items and procurement events.
 */
export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");
  const jobId = Number((await params).id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();

  if (!hasRole(actor, ...IMPORT_ROLES)) {
    return (
      <>
        <PageHeader title="Load tracker sheet" subtitle="Not available for your role" />
        <p className="note" style={{ textAlign: "left" }}>
          Loading a tracker sheet is for Planning, the Production Head and Admins. <Link href={`/jobs/${jobId}`}>Back to the job</Link>
        </p>
      </>
    );
  }
  const target = await loadImportTarget(actor, jobId).catch(() => null);
  if (!target) notFound();
  return <TrackerImport target={target} />;
}
