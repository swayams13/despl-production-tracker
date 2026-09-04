import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";

/**
 * S8 — Packing tab on /jobs/[id]. `Package` is job-wide (its own `jobId` FK,
 * no `equipmentId`), unlike bom.read.ts/assembly.read.ts which scope to one
 * equipment at a time — a crate can hold units from different equipment
 * types on the same job, so units here are queried across the whole job.
 */
export interface PackageUnitRow {
  id: number;
  serialNo: string;
}

export interface PackageRow {
  id: number;
  packageNo: string;
  weightKg: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  preservationNotes: string | null;
  units: PackageUnitRow[];
}

export interface PackingPanel {
  packages: PackageRow[];
  /** Units on this job with no `packageId` yet — the assign-unit picker's source list. */
  unpackedUnits: PackageUnitRow[];
}

export async function loadPackingPanel(actor: Actor, jobId: number): Promise<PackingPanel | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const units = await tx.unit.findMany({
      where: { equipment: { jobId } },
      select: { id: true, serialNo: true, packageId: true },
      orderBy: { serialNo: "asc" },
    });

    const unitsByPackageId = new Map<number, PackageUnitRow[]>();
    const unpackedUnits: PackageUnitRow[] = [];
    for (const u of units) {
      if (u.packageId == null) {
        unpackedUnits.push({ id: u.id, serialNo: u.serialNo });
        continue;
      }
      const list = unitsByPackageId.get(u.packageId);
      const row = { id: u.id, serialNo: u.serialNo };
      if (list) list.push(row);
      else unitsByPackageId.set(u.packageId, [row]);
    }

    const packages = await tx.package.findMany({
      where: { jobId },
      orderBy: { packageNo: "asc" },
      select: {
        id: true,
        packageNo: true,
        weightKg: true,
        lengthMm: true,
        widthMm: true,
        heightMm: true,
        preservationNotes: true,
      },
    });

    return {
      packages: packages.map((p) => ({
        ...p,
        weightKg: p.weightKg != null ? Number(p.weightKg) : null,
        units: unitsByPackageId.get(p.id) ?? [],
      })),
      unpackedUnits,
    };
  });
}
