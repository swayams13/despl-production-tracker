// Dependency-free (relative imports only) so tsx scripts can share it with the
// service: importing assembly.service.ts pulls in the app's db and auth layers.
import type { Prisma } from "../../generated/prisma/client";

/**
 * Lean Core J1: the PUBLISHED assembly template version for an equipment line.
 * The equipment type's own template wins; otherwise the family-level template
 * (equipmentTypeId null) is the fallback. An untyped line never reads a
 * type-anchored template, so adding a type cannot change what untyped jobs get.
 * Null when neither has a published version with steps.
 */
export async function resolveAssemblyTemplateVersion(
  tx: Prisma.TransactionClient,
  tenantId: number,
  familyId: number,
  equipmentTypeId: number | null,
) {
  const owners = equipmentTypeId != null ? [equipmentTypeId, null] : [null];
  for (const owner of owners) {
    const template = await tx.assemblyTemplate.findFirst({
      where: { tenantId, familyId, equipmentTypeId: owner },
      orderBy: { id: "asc" },
    });
    if (!template) continue;
    const version = await tx.assemblyTemplateVersion.findFirst({
      where: { templateId: template.id, status: "PUBLISHED", steps: { some: {} } },
      orderBy: { version: "desc" },
      include: { steps: { orderBy: { seq: "asc" } } },
    });
    if (version) return version;
  }
  return null;
}
