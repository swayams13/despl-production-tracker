import { createHash } from "node:crypto";
import { withTenant } from "@/lib/db";
import { assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  buildImportPlan,
  type BlockTarget,
  type ExistingBom,
  type ImportPlan,
  type Issue,
  type ParsedTracker,
  type TrackerHeader,
} from "@/lib/shared/job-import";
import { parseTrackerWorkbook } from "./job-import.parse";

/**
 * Lean Core L2.10 (part A): load a DESPL tracker sheet into a job, in the
 * M2 importer's shape. Stateless: Check (read-only) returns the report plus the
 * file hash and the plan fingerprint; Load sends both back, and apply refuses a
 * different file or a plan that changed since (for example, someone added an
 * item in between).
 *
 * Writes equipment (one per block you do not map to an existing one), BOM items
 * and procurement events, in one transaction with one audit row. Idempotent: an
 * item already in the equipment is left as it is. Never touches a unit,
 * component, operation or step.
 */

export const IMPORT_ROLES = [ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.PLANNER] as const;
export const IMPORT_MAX_NEW_NAME = 120;

/** What the user chose for one block of the sheet. Exactly one of the two. */
export interface BlockChoice {
  blockNo: number;
  equipmentId?: number;
  newName?: string;
}

export interface TargetEquipment {
  id: number;
  name: string;
  blockNo: number | null;
  itemCount: number;
}

export interface ImportTarget {
  jobId: number;
  jobNumber: string;
  projectName: string | null;
  equipment: TargetEquipment[];
}

export interface BlockReport {
  blockNo: number;
  label: string | null;
  firstRow: number;
  itemCount: number;
  target: BlockTarget;
  /** True when the choice came from the defaults, not from the user. */
  suggested: boolean;
}

export interface ItemReport {
  blockNo: number;
  row: number;
  itemNo: number;
  partName: string;
  qty: string;
  unit: string | null;
  action: ImportPlan["items"][number]["action"];
  events: number;
}

export interface TrackerReport {
  fileSha256: string;
  planFingerprint: string;
  target: ImportTarget;
  header: TrackerHeader;
  blocks: BlockReport[];
  items: ItemReport[];
  counts: ImportPlan["counts"];
  carried: ImportPlan["carried"];
  issues: Issue[];
  /** No error that stops the load; per-row errors only skip those rows. */
  canApply: boolean;
}

export interface ApplyReport {
  fileSha256: string;
  written: { equipment: number; items: number; events: number };
  /** The plan that was loaded, for the confirmation line; never the issue list again. */
  counts: ImportPlan["counts"];
  carried: ImportPlan["carried"];
}

const sha256 = (b: Buffer | Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function guard(actor: Actor) {
  assertNotClientUser(actor);
  requireRole(actor, ...IMPORT_ROLES);
}

export async function loadImportTarget(actor: Actor, jobId: number): Promise<ImportTarget> {
  guard(actor);
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      select: {
        id: true,
        jobNumber: true,
        projectName: true,
        equipments: { select: { id: true, name: true, blockNo: true, _count: { select: { bomItems: true } } }, orderBy: { id: "asc" } },
      },
    });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });
    return {
      jobId: job.id,
      jobNumber: job.jobNumber,
      projectName: job.projectName,
      equipment: job.equipments.map((e) => ({ id: e.id, name: e.name, blockNo: e.blockNo, itemCount: e._count.bomItems })),
    };
  });
}

/** Defaults when the user has not chosen: the one equipment of a one-equipment job, a block-number match, else a new equipment named like the seed does. */
function defaultTarget(parsed: ParsedTracker, target: ImportTarget, blockNo: number): BlockTarget {
  const block = parsed.blocks.find((b) => b.blockNo === blockNo)!;
  if (block.label) {
    const same = target.equipment.find((e) => e.name.trim().toLowerCase() === block.label!.trim().toLowerCase());
    if (same) return { equipmentId: same.id };
  }
  if (parsed.blocks.length === 1 && target.equipment.length === 1) return { equipmentId: target.equipment[0].id };
  const byBlock = target.equipment.find((e) => e.blockNo === blockNo);
  if (byBlock) return { equipmentId: byBlock.id };
  return { newName: block.label ?? `${target.jobNumber}-B${blockNo}` };
}

function resolveTargets(parsed: ParsedTracker, target: ImportTarget, choices: BlockChoice[] | null): { targets: Map<number, BlockTarget>; suggested: Set<number> } {
  const targets = new Map<number, BlockTarget>();
  const suggested = new Set<number>();
  const taken = new Set(target.equipment.map((e) => e.name.trim().toLowerCase()));
  const usedNew = new Set<string>();
  for (const b of parsed.blocks) {
    const c = choices?.find((x) => x.blockNo === b.blockNo);
    let t: BlockTarget;
    if (c && (c.equipmentId != null) !== (c.newName != null)) {
      if (c.equipmentId != null) {
        if (!target.equipment.some((e) => e.id === c.equipmentId)) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: `Block ${b.blockNo}: that equipment is not in this job.` });
        }
        t = { equipmentId: c.equipmentId };
      } else {
        const name = c.newName!.trim();
        if (!name || name.length > IMPORT_MAX_NEW_NAME) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: `Block ${b.blockNo}: give the equipment a name of 1 to ${IMPORT_MAX_NEW_NAME} characters.` });
        }
        t = { newName: name };
      }
    } else {
      t = defaultTarget(parsed, target, b.blockNo);
      suggested.add(b.blockNo);
    }
    if ("newName" in t) {
      const key = t.newName.toLowerCase();
      if (taken.has(key) || usedNew.has(key)) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: `Block ${b.blockNo}: the job already has equipment called "${t.newName}". Pick it from the list, or use another name.` });
      }
      usedNew.add(key);
    }
    targets.set(b.blockNo, t);
  }
  return { targets, suggested };
}

async function loadExisting(actor: Actor, targets: Map<number, BlockTarget>): Promise<ExistingBom> {
  const ids = [...targets.values()].flatMap((t) => ("equipmentId" in t ? [t.equipmentId] : []));
  const out: ExistingBom = new Map();
  if (!ids.length) return out;
  const rows = await withTenant(actor.tenantId, (tx) =>
    tx.bomItem.findMany({ where: { equipmentId: { in: ids } }, select: { equipmentId: true, itemNo: true, partName: true } }),
  );
  for (const r of rows) {
    const m = out.get(r.equipmentId) ?? new Map<number, { partName: string }>();
    m.set(r.itemNo, { partName: r.partName });
    out.set(r.equipmentId, m);
  }
  return out;
}

/** The part of the plan a later load must still match: what would be written, nothing else. */
function fingerprint(plan: ImportPlan): string {
  return sha256(
    JSON.stringify({
      equipment: plan.newEquipment,
      items: plan.items.filter((i) => i.action === "CREATE").map((i) => [i.blockNo, i.itemNo, i.target, i.data, i.events]),
    }),
  );
}

export async function dryRunTrackerImport(actor: Actor, jobId: number, bytes: Buffer, choices: BlockChoice[] | null): Promise<TrackerReport> {
  guard(actor);
  const target = await loadImportTarget(actor, jobId);
  const parsed = parseTrackerWorkbook(bytes);
  const fatal = parsed.issues.some((i) => i.severity === "ERROR" && i.code === "HEADER_NOT_FOUND");

  const { targets, suggested } = fatal ? { targets: new Map<number, BlockTarget>(), suggested: new Set<number>() } : resolveTargets(parsed, target, choices);
  const existing = await loadExisting(actor, targets);
  const { plan, issues: planIssues } = buildImportPlan(parsed, targets, existing);

  const issues: Issue[] = [...parsed.issues, ...planIssues];
  const wo = parsed.header.workOrderNo;
  if (wo && !wo.toLowerCase().includes(target.jobNumber.toLowerCase())) {
    issues.push({
      severity: "INFO",
      code: "JOB_NUMBER_MISMATCH",
      row: null,
      message: `The sheet's Work Order No. is "${wo}". It is loaded into ${target.jobNumber} because that is the job you picked; the sheet's number is not used.`,
    });
  }
  const order = { ERROR: 0, WARNING: 1, INFO: 2 } as const;
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.row ?? 1e9) - (b.row ?? 1e9));

  return {
    fileSha256: sha256(bytes),
    planFingerprint: fingerprint(plan),
    target,
    header: parsed.header,
    blocks: parsed.blocks.map((b) => ({
      blockNo: b.blockNo,
      label: b.label,
      firstRow: b.firstRow,
      itemCount: b.items.length,
      target: targets.get(b.blockNo)!,
      suggested: suggested.has(b.blockNo),
    })),
    items: plan.items.map((i) => ({
      blockNo: i.blockNo,
      row: i.row,
      itemNo: i.itemNo,
      partName: i.data.partName,
      qty: i.data.sourceQty,
      unit: i.data.unit,
      action: i.action,
      events: i.events.length,
    })),
    counts: plan.counts,
    carried: plan.carried,
    issues,
    canApply: !fatal && plan.counts.create > 0,
  };
}

export async function applyTrackerImport(
  actor: Actor,
  jobId: number,
  bytes: Buffer,
  choices: BlockChoice[] | null,
  opts: { expected: { fileSha256: string; planFingerprint: string }; fileName: string },
): Promise<ApplyReport> {
  guard(actor);
  const target = await loadImportTarget(actor, jobId);
  const parsed = parseTrackerWorkbook(bytes);
  if (sha256(bytes) !== opts.expected.fileSha256) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "This is not the file that was checked. Check it again." });
  }
  const { targets, suggested } = resolveTargets(parsed, target, choices);
  const existing = await loadExisting(actor, targets);
  const { plan } = buildImportPlan(parsed, targets, existing);
  if (fingerprint(plan) !== opts.expected.planFingerprint) {
    throw new AppError(ERROR_CODES.STALE_WRITE, { reason: "The job changed since the check, so the plan is different now. Check the file again." });
  }
  const todo = plan.items.filter((i) => i.action === "CREATE");
  if (!todo.length) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "There is nothing to load: every readable item is already in the job." });

  const written = await withTenant(
    actor.tenantId,
    async (tx) => {
      const job = await tx.job.findFirst({ where: { id: jobId, tenantId: actor.tenantId }, select: { id: true } });
      if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });

      // Re-read inside the write transaction: refuse if an item appeared since the plan was made.
      const equipmentIds = [...new Set(todo.flatMap((i) => ("equipmentId" in i.target ? [i.target.equipmentId] : [])))];
      if (equipmentIds.length) {
        const clash = await tx.bomItem.findFirst({
          where: { equipmentId: { in: equipmentIds }, OR: todo.filter((i) => "equipmentId" in i.target).map((i) => ({ equipmentId: (i.target as { equipmentId: number }).equipmentId, itemNo: i.itemNo })) },
          select: { equipmentId: true, itemNo: true },
        });
        if (clash) throw new AppError(ERROR_CODES.STALE_WRITE, { reason: `Item ${clash.itemNo} was added to the job since the check. Check the file again.` });
      }

      const newIds = new Map<number, number>();
      for (const e of plan.newEquipment) {
        const created = await tx.equipment.create({
          data: { jobId, name: e.name, blockNo: e.blockNo, remarks: `Loaded from tracker sheet ${opts.fileName}, block ${e.blockNo}.` },
          select: { id: true },
        });
        newIds.set(e.blockNo, created.id);
      }

      const itemIds: number[] = [];
      let events = 0;
      for (const it of todo) {
        const equipmentId = "equipmentId" in it.target ? it.target.equipmentId : newIds.get(it.blockNo)!;
        const bom = await tx.bomItem.create({
          data: {
            jobId,
            equipmentId,
            itemNo: it.itemNo,
            blockNo: it.blockNo,
            partName: it.data.partName,
            description: it.data.description,
            material: it.data.material,
            sourceQty: it.data.sourceQty,
            qtyPer: it.data.qtyPer,
            unit: it.data.unit,
            remarks: it.data.remarks,
          },
          select: { id: true },
        });
        itemIds.push(bom.id);
        if (it.events.length) {
          await tx.procurementEvent.createMany({
            data: it.events.map((e) => ({
              jobId,
              bomItemId: bom.id,
              type: e.type,
              qty: e.qty,
              refNo: e.refNo,
              at: new Date(`${e.on}T00:00:00+05:30`),
              by: actor.userId,
            })),
          });
          events += it.events.length;
        }
      }

      await recordAudit(tx, actor, {
        action: "jobImport.apply",
        entityType: "Job",
        entityId: jobId,
        after: {
          fileName: opts.fileName,
          fileSha256: opts.expected.fileSha256,
          planFingerprint: opts.expected.planFingerprint,
          equipmentCreated: plan.newEquipment.map((e) => ({ id: newIds.get(e.blockNo), name: e.name })),
          bomItemIds: itemIds,
          procurementEvents: events,
          blocks: parsed.blocks.map((b) => ({ blockNo: b.blockNo, usedDefault: suggested.has(b.blockNo) })),
        },
        eventType: "TrackerImported",
        eventPayload: { jobId, items: itemIds.length, equipment: plan.newEquipment.length, events },
      });
      return { equipment: plan.newEquipment.length, items: itemIds.length, events };
    },
    { timeoutMs: 120_000 },
  );

  return { fileSha256: opts.expected.fileSha256, written, counts: plan.counts, carried: plan.carried };
}
