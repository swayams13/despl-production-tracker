import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadIntakeOptions } from "@/lib/services/job-intake.read";
import { FEATURES } from "@/lib/shared/flags";
import { NewJobWizard } from "./_client";

export default async function NewJobPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/jobs");

  const options = await loadIntakeOptions(actor);
  // Lean Core freeze: only Pressure Vessel is offered. createJobAction refuses
  // any other family server-side.
  if (!FEATURES.multiFamilyIntake) options.families = options.families.filter((f) => f.code === "PRESSURE_VESSEL");
  return <NewJobWizard options={options} />;
}
