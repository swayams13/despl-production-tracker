import { redirect, notFound } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadVersionEditor } from "@/lib/services/template.read";
import { isAppError } from "@/lib/shared/errors";
import { VersionEditorClient } from "./_client";

export default async function VersionEditorPage({ params }: { params: Promise<{ versionId: string }> }) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/dashboard");

  const versionId = Number((await params).versionId);
  if (!Number.isInteger(versionId) || versionId <= 0) notFound();

  try {
    const view = await loadVersionEditor(actor, versionId);
    return <VersionEditorClient view={view} />;
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
}
