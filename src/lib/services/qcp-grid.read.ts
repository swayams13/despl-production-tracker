import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";

/**
 * Job detail — QCP / Hold points tab (§4.3, §9.6). One row per CHECKPOINT
 * item (SECTION rows are headers, not data), for one selected unit — grid
 * is per-unit because status/age genuinely vary by unit (`QcpExecution` is
 * recorded per (item, unit)); the mockup's job-wide table with no unit
 * column doesn't survive contact with real per-unit execution data, same
 * reasoning as the Gantt/BOM tabs' unit/equipment selectors.
 *
 * Status/age logic mirrors `loadOpenHoldPoints` (workspace.read.ts) and
 * `loadStageDetail`'s hold-point block, but is not restricted to
 * `blocksCompletion` items or to a single stage's backing processes — every
 * checkpoint in the job's QCP template is a real ITP row here, cleared ones
 * included (workspace only lists what's still open).
 */
export interface QcpGridRow {
  qcpItemId: number;
  srNo: string;
  activity: string;
  /** The blocking-priority party code (H > W > R > others), the mockup's "Class" column. */
  classCode: string;
  acceptanceCriteria: string | null;
  qcCode: string | null;
  tpiCode: string | null;
  status: string;
  ageDays: number;
  /** AUD-003: latest execution is NA but waiverApprovedBy is still null — a
   * Production Head/Admin must call approveQcpWaiver before this actually
   * clears. Distinct from "Cleared" so the grid never implies a witness
   * waiver was signed off when it wasn't. */
  pendingWaiver: boolean;
}

export interface QcpSection {
  section: string;
  title: string;
  rows: QcpGridRow[];
}

export interface QcpUnitOption {
  id: number;
  serialNo: string;
}

export interface QcpGrid {
  unitId: number;
  serialNo: string;
  units: QcpUnitOption[];
  sections: QcpSection[];
}

const CLASS_PRIORITY = ["H", "W", "RW", "R&A", "R", "P"];
/** A code outside the known list ranks last, never first (indexOf's -1 would otherwise sort it ahead of "H"). */
function classPriorityRank(code: string): number {
  const i = CLASS_PRIORITY.indexOf(code);
  return i === -1 ? CLASS_PRIORITY.length : i;
}

export async function loadQcpGrid(actor: Actor, jobId: number, unitId?: number): Promise<QcpGrid | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const units = await tx.unit.findMany({
      where: { equipment: { jobId } },
      select: { id: true, serialNo: true },
      orderBy: { serialNo: "asc" },
    });
    if (units.length === 0) return { unitId: 0, serialNo: "", units: [], sections: [] };
    const targetUnit = units.find((u) => u.id === unitId) ?? units[0];

    const templates = await tx.qcpTemplate.findMany({ where: { jobId }, select: { id: true } });
    if (templates.length === 0) return { unitId: targetUnit.id, serialNo: targetUnit.serialNo, units, sections: [] };
    const templateIds = templates.map((t) => t.id);

    const sectionHeaders = await tx.qcpItem.findMany({
      where: { qcpTemplateId: { in: templateIds }, kind: "SECTION" },
      orderBy: { sequence: "asc" },
      select: { section: true, activity: true },
    });
    const titleBySection = new Map(sectionHeaders.map((s) => [s.section ?? "0", s.activity]));

    const items = await tx.qcpItem.findMany({
      where: { qcpTemplateId: { in: templateIds }, kind: "CHECKPOINT" },
      orderBy: { sequence: "asc" },
      select: {
        id: true,
        srNo: true,
        section: true,
        activity: true,
        acceptanceCriteria: true,
        partyCodes: {
          select: {
            inspectionParty: { select: { code: true } },
            qcpCode: { select: { code: true, requiresCall: true, blocksCompletion: true } },
          },
        },
        processLinks: {
          select: { jobProcess: { select: { id: true, seq: true } } },
          orderBy: { jobProcess: { seq: "asc" } },
          take: 1,
        },
      },
    });
    if (items.length === 0) return { unitId: targetUnit.id, serialNo: targetUnit.serialNo, units, sections: [] };

    const itemIds = items.map((i) => i.id);
    const execs = await tx.qcpExecution.findMany({
      where: { unitId: targetUnit.id, qcpItemId: { in: itemIds } },
      orderBy: { attemptNo: "desc" },
      select: { qcpItemId: true, result: true, recordedAt: true, waiverApprovedBy: true },
    });
    const latestByItem = new Map<number, { result: string; recordedAt: Date; waiverApprovedBy: number | null }>();
    for (const e of execs) if (!latestByItem.has(e.qcpItemId)) latestByItem.set(e.qcpItemId, e);

    const linkedProcessIds = [...new Set(items.map((i) => i.processLinks[0]?.jobProcess.id).filter((x): x is number => x != null))];
    const plans = linkedProcessIds.length
      ? await tx.processPlan.findMany({
          where: { unitId: targetUnit.id, jobProcessId: { in: linkedProcessIds }, scheduleRun: { isCurrent: true } },
          select: { jobProcessId: true, plannedStart: true },
        })
      : [];
    const plannedStartByProcess = new Map(plans.map((p) => [p.jobProcessId, p.plannedStart]));

    const now = new Date();
    const rowsBySection = new Map<string, QcpGridRow[]>();
    for (const item of items) {
      const codesByParty = item.partyCodes.map((pc) => ({ party: pc.inspectionParty.code, code: pc.qcpCode.code, requiresCall: pc.qcpCode.requiresCall }));
      const qcCode = codesByParty.find((c) => !c.party.toUpperCase().includes("TPI"))?.code ?? null;
      const tpiCode = codesByParty.find((c) => c.party.toUpperCase().includes("TPI"))?.code ?? null;
      const classCode = [...codesByParty].sort((a, b) => classPriorityRank(a.code) - classPriorityRank(b.code))[0]?.code ?? "P";
      const requiresCall = codesByParty.some((c) => c.requiresCall);

      const attempt = latestByItem.get(item.id);
      let status: string;
      let ageRef: Date | null;
      // AUD-003: NA is a pending waiver, not a clearance, until
      // waiverApprovedBy is stamped by approveQcpWaiver — same predicate as
      // assertUnitHasNoOpenHoldPoint (_shared.ts).
      const pendingWaiver = attempt?.result === "NA" && attempt.waiverApprovedBy == null;
      if (!attempt) {
        status = requiresCall ? "Awaiting TPI" : "Pending";
        const jpId = item.processLinks[0]?.jobProcess.id;
        ageRef = jpId != null ? (plannedStartByProcess.get(jpId) ?? null) : null;
      } else if (pendingWaiver) {
        status = "Pending waiver";
        ageRef = attempt.recordedAt;
      } else if (attempt.result === "ACCEPTED" || attempt.result === "NA") {
        status = "Cleared";
        ageRef = null;
      } else if (attempt.result === "REJECTED") {
        status = "Reinspect";
        ageRef = attempt.recordedAt;
      } else {
        status = "QC review";
        ageRef = attempt.recordedAt;
      }
      const ageDays = ageRef ? Math.max(0, Math.floor((now.getTime() - ageRef.getTime()) / 864e5)) : 0;

      const row: QcpGridRow = {
        qcpItemId: item.id,
        srNo: item.srNo,
        activity: item.activity,
        classCode,
        acceptanceCriteria: item.acceptanceCriteria,
        qcCode,
        tpiCode,
        status,
        ageDays,
        pendingWaiver,
      };
      const sec = item.section ?? "0";
      const list = rowsBySection.get(sec) ?? [];
      list.push(row);
      rowsBySection.set(sec, list);
    }

    const sections: QcpSection[] = [...rowsBySection.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([section, rows]) => ({ section, title: titleBySection.get(section) ?? `Section ${section}`, rows }));

    return { unitId: targetUnit.id, serialNo: targetUnit.serialNo, units, sections };
  });
}
