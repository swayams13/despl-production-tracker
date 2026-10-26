import { redirectToLogin } from "@/lib/auth/login-redirect";
import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { IMPORT_APPLY_ROLES, IMPORT_VIEW_ROLES, MASTER_DATA_READ_ROLES } from "@/lib/services/master-data.service";
import { RefusalCard } from "../_refusal";
import { MasterDataTabs } from "../_tabs";
import { MasterImport } from "./_import";

export default async function MasterImportPage() {
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ...MASTER_DATA_READ_ROLES)) return <RefusalCard title="Import" />;
  if (!hasRole(actor, ...IMPORT_VIEW_ROLES)) {
    return (
      <RefusalCard
        title="Import"
        message="Checking and loading the Standard Parts Master workbook is for Engineering, the Production Head and Admins. You can read master data."
      />
    );
  }
  return (
    <MasterImport
      canApply={hasRole(actor, ...IMPORT_APPLY_ROLES)}
      isHead={hasRole(actor, ROLES.PRODUCTION_HEAD)}
      sections={<MasterDataTabs active="import" showImport />}
    />
  );
}
