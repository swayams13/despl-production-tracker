import { redirectToLogin } from "@/lib/auth/login-redirect";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getActor, hasRole } from "@/lib/authz";
import { FEATURES } from "@/lib/shared/flags";
import { loadSwitchOver, SWITCH_OVER_ROLES } from "@/lib/services/switch-over.read";
import { PageHeader } from "@/components/industrial/page-header";
import { SwitchOverClient } from "./_client";

/**
 * Lean Core L2.10 part B (D22): tick what Excel shows as done, at the switch-over
 * date. Behind `leanFloor`: it writes through recordWork, which is frozen while the switch is off.
 */
export default async function SwitchOverPage({ params }: { params: Promise<{ id: string }> }) {
  if (!FEATURES.leanFloor) notFound();
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");
  const jobId = Number((await params).id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();

  if (!hasRole(actor, ...SWITCH_OVER_ROLES)) {
    return (
      <>
        <PageHeader title="Switch over from Excel" subtitle="Not available for your role" />
        <p className="note" style={{ textAlign: "left" }}>
          Ticking work as already done is for the Production Head and Admins. <Link href={`/jobs/${jobId}`}>Back to the job</Link>
        </p>
      </>
    );
  }
  const view = await loadSwitchOver(actor, jobId).catch(() => null);
  if (!view) notFound();
  return <SwitchOverClient view={view} />;
}
