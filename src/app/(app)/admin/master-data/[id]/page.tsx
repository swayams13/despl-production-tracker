import { redirectToLogin } from "@/lib/auth/login-redirect";
import { notFound, redirect } from "next/navigation";
import { getActor, hasRole } from "@/lib/authz";
import { loadPartFamily } from "@/lib/services/master-data.read";
import { MASTER_DATA_READ_ROLES } from "@/lib/services/master-data.service";
import { RefusalCard } from "../_refusal";
import { PartFamilyDetailView } from "./_detail";

export default async function PartFamilyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ...MASTER_DATA_READ_ROLES)) return <RefusalCard />;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const detail = await loadPartFamily(actor, id);
  if (!detail) notFound();

  const v = (await searchParams).v;
  return <PartFamilyDetailView detail={detail} variant={typeof v === "string" ? v : null} />;
}
