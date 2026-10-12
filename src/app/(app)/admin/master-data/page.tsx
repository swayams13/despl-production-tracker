import { redirect } from "next/navigation";
import { getActor, hasRole } from "@/lib/authz";
import { loadPartFamilies } from "@/lib/services/master-data.read";
import { MASTER_DATA_READ_ROLES } from "@/lib/services/master-data.service";
import { MasterDataList } from "./_list";
import { RefusalCard } from "./_refusal";
import { parsePartFamilyFilters } from "./_filters";

export default async function MasterDataPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ...MASTER_DATA_READ_ROLES)) return <RefusalCard />;

  const filters = parsePartFamilyFilters(await searchParams);
  const list = await loadPartFamilies(actor, filters);
  return <MasterDataList list={list} filters={filters} />;
}
