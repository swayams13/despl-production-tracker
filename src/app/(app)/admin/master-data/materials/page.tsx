import { redirect } from "next/navigation";
import { getActor, hasRole } from "@/lib/authz";
import { loadMaterialGrades } from "@/lib/services/master-data.read";
import { IMPORT_VIEW_ROLES, MASTER_DATA_READ_ROLES } from "@/lib/services/master-data.service";
import { RefusalCard } from "../_refusal";
import { MasterDataTabs } from "../_tabs";
import { filterMaterials, parseMaterialFilters } from "../_filters";
import { MaterialsView } from "./_materials";

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ...MASTER_DATA_READ_ROLES)) return <RefusalCard title="Materials" />;

  const filters = parseMaterialFilters(await searchParams);
  const all = await loadMaterialGrades(actor);
  const totals = {
    all: all.rows.length,
    draft: all.rows.filter((r) => r.status === "DRAFT").length,
    reviewed: all.rows.filter((r) => r.status === "REVIEWED").length,
    approved: all.rows.filter((r) => r.status === "APPROVED").length,
    noDensity: all.rows.filter((r) => r.densityGcc == null).length,
  };
  return (
    <MaterialsView
      rows={filterMaterials(all.rows, filters)}
      totals={totals}
      filters={filters}
      can={{ edit: all.canEdit, approve: all.canApprove, revise: all.canRevise }}
      sections={<MasterDataTabs active="materials" showImport={hasRole(actor, ...IMPORT_VIEW_ROLES)} />}
    />
  );
}
