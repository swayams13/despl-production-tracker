import QRCode from "qrcode";
import { withTenant } from "@/lib/db";
import { assertClientScope, assertNotClientUser, type Actor } from "@/lib/authz";
import { unitUrl } from "@/lib/shared/traveller";
import { loadJobSpines } from "./spine.read";

/**
 * Lean Core L2.9: everything the traveller print view needs, one entry per unit.
 * Stages are the job's own, per unit, from the same canonical view the board and
 * spines read (loadJobSpines). Tenant scope comes from withTenant plus the
 * explicit job lookup; units are read through the job, never by id alone.
 */
export interface Traveller {
  unitId: number;
  serialNo: string;
  url: string;
  qrSvg: string;
  stages: Array<{ stageNo: number; name: string }>;
}

export interface TravellerSheet {
  jobNumber: string;
  clientName: string;
  description: string;
  travellers: Traveller[];
}

export async function loadTravellers(actor: Actor, jobId: number, origin: string): Promise<TravellerSheet | null> {
  assertNotClientUser(actor);
  const base = await withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: jobId },
      select: {
        clientId: true,
        jobNumber: true,
        projectName: true,
        client: { select: { name: true } },
        family: { select: { name: true } },
        equipments: { select: { name: true, _count: { select: { units: true } } }, orderBy: { id: "asc" } },
      },
    });
    if (!job) return null;
    assertClientScope(actor, job.clientId);
    const units = await tx.unit.findMany({
      where: { jobId },
      select: { id: true, publicId: true, serialNo: true },
      orderBy: { serialNo: "asc" },
    });
    return { job, units };
  });
  if (!base) return null;

  const spines = (await loadJobSpines(actor, jobId)) ?? [];
  const stagesOf = new Map(spines.map((s) => [s.unitId, s.segments.map((g) => ({ stageNo: g.stageNo, name: g.stageName }))]));

  const travellers = await Promise.all(
    base.units.map(async (u) => {
      const url = unitUrl(origin, u.publicId);
      return {
        unitId: u.id,
        serialNo: u.serialNo,
        url,
        qrSvg: await QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M" }),
        stages: stagesOf.get(u.id) ?? [],
      };
    }),
  );

  const eq = base.job.equipments;
  const total = eq.reduce((n, e) => n + e._count.units, 0);
  const description = [base.job.projectName ?? eq[0]?.name ?? base.job.family.name, total > 1 ? `× ${total}` : null].filter(Boolean).join(" ");
  return { jobNumber: base.job.jobNumber, clientName: base.job.client.name, description, travellers };
}
