import { redirectToLogin } from "@/lib/auth/login-redirect";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { isAppError } from "@/lib/shared/errors";
import { loadIntakeOptions, loadCopyableJobs } from "@/lib/services/job-intake.read";
import { listDrafts, loadDraft } from "@/lib/services/job-draft.service";
import { FEATURES } from "@/lib/shared/flags";
import { NewJobWizard } from "./_client";
import { StartScreen } from "./start-screen";

export default async function NewJobPage({ searchParams }: { searchParams: Promise<{ draft?: string; route?: string }> }) {
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");
  // J7b: a planner builds and saves drafts; only the Production Head and Admin create the job.
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.PLANNER)) redirect("/jobs");
  const canRelease = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  const sp = await searchParams;
  const options = await loadIntakeOptions(actor);
  // Lean Core freeze: only Pressure Vessel is offered. createJobAction and releaseDraft refuse
  // any other family server-side.
  if (!FEATURES.multiFamilyIntake) options.families = options.families.filter((f) => f.code === "PRESSURE_VESSEL");

  const draftId = Number(sp.draft);
  if (sp.draft && Number.isInteger(draftId) && draftId > 0) {
    try {
      const draft = await loadDraft(actor, draftId);
      if (draft.status !== "DRAFT") {
        return (
          <div className="card" style={{ padding: 16 }}>
            <p style={{ marginTop: 0 }}>
              {draft.status === "RELEASED" ? "This draft was already turned into a job." : "This draft was discarded."}
            </p>
            {draft.releasedJobId != null && <Link className="btn btn-accent" href={`/jobs/${draft.releasedJobId}/release`}>Release the BOM</Link>}{" "}
            {draft.releasedJobId != null && <Link className="btn" href={`/jobs/${draft.releasedJobId}`}>Open the job</Link>}{" "}
            <Link className="btn" href="/jobs/new">Start a new job</Link>
          </div>
        );
      }
      return (
        <NewJobWizard
          options={options}
          canRelease={canRelease}
          initialDraft={{ id: draft.id, payload: draft.payload, sourceJobId: draft.sourceJobId }}
        />
      );
    } catch (e) {
      if (!isAppError(e)) throw e;
      return (
        <div className="card" style={{ padding: 16 }}>
          <p style={{ marginTop: 0 }}>That draft cannot be found, or it belongs to someone else.</p>
          <Link className="btn" href="/jobs/new">Back to the start</Link>
        </div>
      );
    }
  }

  if (sp.route === "template" || sp.route === "master") {
    return <NewJobWizard options={options} canRelease={canRelease} route={sp.route} />;
  }

  const [drafts, jobs] = await Promise.all([listDrafts(actor), loadCopyableJobs(actor)]);
  return (
    <StartScreen
      drafts={drafts.map((d) => ({
        id: d.id,
        label: d.label,
        updatedAt: d.updatedAt.toISOString(),
        sourceJobNumber: d.sourceJobId != null ? (jobs.find((j) => j.id === d.sourceJobId)?.jobNumber ?? null) : null,
      }))}
      jobs={jobs}
      routeVersions={options.families.reduce((n, f) => n + f.versions.length, 0)}
      kitTypes={options.equipmentTypes.filter((t) => t.kit.length > 0 && options.families.some((f) => f.id === t.familyId)).length}
      canRelease={canRelease}
    />
  );
}
