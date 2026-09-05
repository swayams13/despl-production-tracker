import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadQcpTemplateLibraryAdmin, loadQcpCodeRefOptions } from "@/lib/services/job-intake.read";
import { QcpTemplateLibraryClient } from "./_client";

export default async function QcpTemplatesPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/dashboard");

  const [templates, qcpCodes] = await Promise.all([
    loadQcpTemplateLibraryAdmin(actor),
    loadQcpCodeRefOptions(actor),
  ]);

  return <QcpTemplateLibraryClient templates={templates} qcpCodes={qcpCodes} />;
}
