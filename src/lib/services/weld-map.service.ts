import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import type { JointType } from "@/generated/prisma/client";
import { withJob, type Tx } from "@/lib/db";
import { assertNotClientUser, hasRole, requireRole, ROLES, type Actor } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import type { Cell } from "@/lib/shared/job-import";
import {
  JOINT_TYPE_LABEL,
  jointsFromTags,
  parseWeldMapGrid,
  planWeldMap,
  type ExistingJoint,
  type PlanRow,
  type TagMode,
  type WeldMapIssue,
  type WeldMapPlan,
} from "@/lib/shared/weld-map";
import { canonicalizeXlsx } from "./xlsx-canonical";

/**
 * Lean Core J4b: a line's weld map and joint register. Joints are per line
 * (`PlannedJoint`, unique on equipment + joint no). Three ways in: an Excel
 * weld map (Check, then Load), a typed list of tags or joint numbers, and the
 * J4a generator from shell courses. Every way is idempotent and none deletes:
 * a joint missing from a new file is reported, never removed. New joints are
 * unconfirmed; they still feed the BOM release (J5) but are flagged until QC or
 * Engineering confirms them.
 */

/** Edit the register. Engineering owns the weld map in practice (default; SJ to ratify). */
export const WELD_MAP_EDIT_ROLES = [ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.ENGINEERING] as const;
/** Confirm joints. QC or Engineering (default; QC head to ratify). */
export const WELD_MAP_CONFIRM_ROLES = [ROLES.QC, ROLES.ENGINEERING] as const;

const MAX_ROWS = 2000;
const sha256 = (b: Buffer | Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const refuse = (reason: string, extra: Record<string, unknown> = {}): never => {
  throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason, ...extra });
};

function guardEdit(actor: Actor) {
  assertNotClientUser(actor);
  requireRole(actor, ...WELD_MAP_EDIT_ROLES);
}
function guardIds(jobId: number, equipmentId: number) {
  if (!Number.isInteger(jobId) || jobId <= 0 || !Number.isInteger(equipmentId) || equipmentId <= 0) refuse("No job or line.");
}

// ---------------------------------------------------------------- read

export interface WeldMapJoint {
  id: number;
  jointNo: string;
  jointType: JointType;
  joins: string | null;
  wpsRef: string | null;
  ndtExtent: string | null;
  source: "IMPORTED" | "GENERATED";
  confirmed: boolean;
  /** Assembly steps expanded from this joint. */
  steps: number;
  /** As-welded records logged against it. */
  welds: number;
}
export interface WeldMapLine {
  id: number;
  name: string;
  units: number;
  joints: WeldMapJoint[];
  /** Plain-language gaps, e.g. a joint type the line's steps need and the map lacks. */
  notices: string[];
}
export interface WeldMapView {
  job: { id: number; jobNumber: string; projectName: string | null };
  lines: WeldMapLine[];
  canEdit: boolean;
  canConfirm: boolean;
}

export async function loadWeldMap(actor: Actor, jobId: number): Promise<WeldMapView> {
  assertNotClientUser(actor);
  if (!Number.isInteger(jobId) || jobId <= 0) refuse("No job.");
  return withJob(actor.tenantId, jobId, async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      select: {
        id: true,
        jobNumber: true,
        projectName: true,
        equipments: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            name: true,
            assemblyTemplateVersionId: true,
            _count: { select: { units: true } },
            plannedJoints: {
              orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
              select: {
                id: true, jointNo: true, jointType: true, joins: true, wpsRef: true, ndtExtent: true, source: true, confirmed: true,
                _count: { select: { assemblySteps: true, weldJoints: true } },
              },
            },
          },
        },
      },
    });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });

    const versionIds = [...new Set(job.equipments.flatMap((e) => (e.assemblyTemplateVersionId ? [e.assemblyTemplateVersionId] : [])))];
    const needed = versionIds.length
      ? await tx.assemblyTemplateStep.findMany({
          where: { versionId: { in: versionIds }, scope: "PER_JOINT", jointType: { not: null } },
          select: { versionId: true, jointType: true },
          distinct: ["versionId", "jointType"],
        })
      : [];

    const lines: WeldMapLine[] = job.equipments.map((e) => {
      const have = new Set(e.plannedJoints.map((j) => j.jointType));
      const notices: string[] = [];
      for (const n of needed.filter((x) => x.versionId === e.assemblyTemplateVersionId)) {
        const t = n.jointType as JointType;
        if (!have.has(t)) {
          const w = JOINT_TYPE_LABEL[t].toLowerCase();
          notices.push(`No ${w} joints on the weld map: ${w} weld steps will not be created.`);
        }
      }
      return {
        id: e.id,
        name: e.name,
        units: e._count.units,
        notices,
        joints: e.plannedJoints.map((j) => ({
          id: j.id, jointNo: j.jointNo, jointType: j.jointType, joins: j.joins, wpsRef: j.wpsRef, ndtExtent: j.ndtExtent,
          source: j.source, confirmed: j.confirmed, steps: j._count.assemblySteps, welds: j._count.weldJoints,
        })),
      };
    });
    return {
      job: { id: job.id, jobNumber: job.jobNumber, projectName: job.projectName },
      lines,
      canEdit: hasRole(actor, ...WELD_MAP_EDIT_ROLES),
      canConfirm: hasRole(actor, ...WELD_MAP_CONFIRM_ROLES),
    };
  });
}

// ---------------------------------------------------------------- workbook

/** The reader only ever sees the canonical re-pack of the upload (see xlsx-canonical.ts). */
export function readWeldMapGrid(bytes: Buffer | Uint8Array): Cell[][] {
  const wb = XLSX.read(canonicalizeXlsx(bytes), { type: "buffer", sheetRows: MAX_ROWS });
  const name = wb.SheetNames.find((n) => /weld/i.test(n)) ?? wb.SheetNames[0];
  const ws = name ? wb.Sheets[name] : undefined;
  if (!ws || !ws["!ref"]) return refuse("The workbook has no sheet with data.");
  const full = XLSX.utils.decode_range(ws["!fullref"] ?? ws["!ref"]);
  if (full.e.r - full.s.r + 1 > MAX_ROWS || full.e.c - full.s.c + 1 > 100) {
    refuse(`The sheet is larger than the importer reads (${MAX_ROWS} rows by 100 columns). Remove empty rows and columns and try again.`);
  }
  // range: 0 so that index 0 is Excel row 1 whatever the sheet's first used row is.
  return XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: null, range: 0 });
}

// ---------------------------------------------------------------- shared

async function lockLine(tx: Tx, actor: Actor, jobId: number, equipmentId: number) {
  const line = await tx.equipment.findFirst({ where: { id: equipmentId, jobId, job: { tenantId: actor.tenantId } }, select: { id: true, name: true } });
  if (!line) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Equipment", equipmentId });
  // Two loads on one line serialise here, so a plan is never made on stale rows.
  await tx.$queryRaw`SELECT id FROM equipments WHERE id = ${equipmentId} FOR UPDATE`;
  return line;
}

async function existingJoints(tx: Tx, equipmentId: number): Promise<ExistingJoint[]> {
  const rows = await tx.plannedJoint.findMany({
    where: { equipmentId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { jointNo: true, jointType: true, joins: true, wpsRef: true, ndtExtent: true, confirmed: true, _count: { select: { assemblySteps: true, weldJoints: true } } },
  });
  return rows.map((r) => ({
    jointNo: r.jointNo, jointType: r.jointType, joins: r.joins, wpsRef: r.wpsRef, ndtExtent: r.ndtExtent, confirmed: r.confirmed,
    used: r._count.assemblySteps + r._count.weldJoints,
  }));
}

const fingerprint = (plan: WeldMapPlan) =>
  sha256(JSON.stringify(plan.rows.filter((r) => r.action === "ADD" || r.action === "UPDATE").map((r) => [r.jointNo, r.action, r.jointType, r.joins, r.wpsRef, r.ndtExtent])));

// ---------------------------------------------------------------- Check and Load

export interface WeldMapReport {
  fileSha256: string;
  planFingerprint: string;
  line: { id: number; name: string };
  rows: PlanRow[];
  notInFile: string[];
  counts: WeldMapPlan["counts"];
  issues: WeldMapIssue[];
  /** Nothing is refused and there is something to load. */
  canApply: boolean;
}
export interface WeldMapApplied {
  added: number;
  updated: number;
  unchanged: number;
}

export async function dryRunWeldMap(actor: Actor, target: { jobId: number; equipmentId: number }, bytes: Buffer): Promise<WeldMapReport> {
  guardEdit(actor);
  guardIds(target.jobId, target.equipmentId);
  const parsed = parseWeldMapGrid(readWeldMapGrid(bytes));
  const { line, plan } = await withJob(actor.tenantId, target.jobId, async (tx) => {
    const l = await lockLine(tx, actor, target.jobId, target.equipmentId);
    return { line: l, plan: planWeldMap(parsed.rows, await existingJoints(tx, target.equipmentId)) };
  });
  const fatal = parsed.issues.some((i) => i.code === "HEADER_NOT_FOUND" || i.code === "NO_ROWS");
  return {
    fileSha256: sha256(bytes),
    planFingerprint: fingerprint(plan),
    line,
    rows: plan.rows,
    notInFile: plan.notInFile,
    counts: plan.counts,
    issues: parsed.issues,
    canApply: !fatal && plan.counts.refused === 0 && plan.counts.add + plan.counts.update > 0,
  };
}

export async function applyWeldMap(
  actor: Actor,
  target: { jobId: number; equipmentId: number },
  bytes: Buffer,
  opts: { expected: { fileSha256: string; planFingerprint: string }; fileName: string },
): Promise<WeldMapApplied> {
  guardEdit(actor);
  guardIds(target.jobId, target.equipmentId);
  if (sha256(bytes) !== opts.expected.fileSha256) refuse("This is not the file that was checked. Check it again.");
  const parsed = parseWeldMapGrid(readWeldMapGrid(bytes));
  if (parsed.issues.some((i) => i.code === "HEADER_NOT_FOUND")) refuse("The file has no Joint no column.");

  return withJob(actor.tenantId, target.jobId, async (tx) => {
    const line = await lockLine(tx, actor, target.jobId, target.equipmentId);
    const have = await existingJoints(tx, target.equipmentId);
    const plan = planWeldMap(parsed.rows, have);
    const refused = plan.rows.filter((r) => r.action === "REFUSED");
    if (refused.length) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: refused[0].reason, joint: refused[0].jointNo, joints: refused.map((r) => r.jointNo) });
    }
    if (fingerprint(plan) !== opts.expected.planFingerprint) {
      throw new AppError(ERROR_CODES.STALE_WRITE, { reason: "The weld map changed since the check, so the plan is different now. Check the file again." });
    }
    const adds = plan.rows.filter((r) => r.action === "ADD");
    const updates = plan.rows.filter((r) => r.action === "UPDATE");
    if (adds.length + updates.length === 0) return { added: 0, updated: 0, unchanged: plan.counts.same };

    const top = await tx.plannedJoint.aggregate({ where: { equipmentId: target.equipmentId }, _max: { sortOrder: true } });
    let order = (top._max.sortOrder ?? -1) + 1;
    for (const a of adds) {
      await tx.plannedJoint.create({
        data: {
          jobId: target.jobId, equipmentId: target.equipmentId, jointNo: a.jointNo, jointType: a.jointType, joins: a.joins, wpsRef: a.wpsRef,
          ndtExtent: a.ndtExtent, source: "IMPORTED", confirmed: false, sortOrder: order++,
        },
      });
    }
    for (const u of updates) {
      await tx.plannedJoint.update({
        where: { equipmentId_jointNo: { equipmentId: target.equipmentId, jointNo: u.jointNo } },
        data: { jointType: u.jointType, joins: u.joins, wpsRef: u.wpsRef, ndtExtent: u.ndtExtent, ...(u.unconfirms ? { confirmed: false } : {}) },
      });
    }
    await recordAudit(tx, actor, {
      action: "weldMap.apply",
      entityType: "Equipment",
      entityId: target.equipmentId,
      before: updates.map((u) => ({ jointNo: u.jointNo, ...Object.fromEntries(u.changes.map((c) => [c.field, c.from])), wasConfirmed: u.unconfirms })),
      after: {
        line: line.name,
        fileName: opts.fileName,
        fileSha256: opts.expected.fileSha256,
        added: adds.map((a) => ({ jointNo: a.jointNo, jointType: a.jointType })),
        updated: updates.map((u) => ({ jointNo: u.jointNo, ...Object.fromEntries(u.changes.map((c) => [c.field, c.to])), needsConfirming: u.unconfirms })),
        notInFile: plan.notInFile,
        source: "IMPORTED",
        confirmed: false,
      },
      eventType: "WeldMapLoaded",
      eventPayload: { jobId: target.jobId, equipmentId: target.equipmentId, added: adds.length, updated: updates.length },
    });
    return { added: adds.length, updated: updates.length, unchanged: plan.counts.same };
  });
}

// ---------------------------------------------------------------- add from tags

export async function addJointsFromTags(
  actor: Actor,
  input: { jobId: number; equipmentId: number; text: string; mode: TagMode; withFlanges: boolean },
): Promise<{ added: string[]; alreadyThere: string[] }> {
  guardEdit(actor);
  guardIds(input.jobId, input.equipmentId);
  const { joints, errors } = jointsFromTags(String(input.text ?? "").slice(0, 4000), input.mode, input.withFlanges);
  if (errors.length) refuse(errors.join(" "));

  return withJob(actor.tenantId, input.jobId, async (tx) => {
    const line = await lockLine(tx, actor, input.jobId, input.equipmentId);
    const have = new Set((await existingJoints(tx, input.equipmentId)).map((j) => j.jointNo));
    const fresh = joints.filter((j) => !have.has(j.jointNo));
    const alreadyThere = joints.filter((j) => have.has(j.jointNo)).map((j) => j.jointNo);
    if (fresh.length === 0) return { added: [], alreadyThere };
    const top = await tx.plannedJoint.aggregate({ where: { equipmentId: input.equipmentId }, _max: { sortOrder: true } });
    let order = (top._max.sortOrder ?? -1) + 1;
    await tx.plannedJoint.createMany({
      data: fresh.map((j) => ({
        jobId: input.jobId, equipmentId: input.equipmentId, jointNo: j.jointNo, jointType: j.jointType, joins: j.joins,
        source: "IMPORTED" as const, confirmed: false, sortOrder: order++,
      })),
    });
    await recordAudit(tx, actor, {
      action: "weldMap.addFromTags",
      entityType: "Equipment",
      entityId: input.equipmentId,
      after: { line: line.name, mode: input.mode, withFlanges: input.withFlanges, typed: input.text.slice(0, 500), added: fresh.map((j) => j.jointNo), alreadyThere, source: "IMPORTED", confirmed: false },
      eventType: "WeldMapJointsAdded",
      eventPayload: { jobId: input.jobId, equipmentId: input.equipmentId, added: fresh.length },
    });
    return { added: fresh.map((j) => j.jointNo), alreadyThere };
  });
}

// ---------------------------------------------------------------- confirm

/** Confirm the named joints of a line, or every unconfirmed one when `jointIds` is omitted. */
export async function confirmWeldMap(
  actor: Actor,
  input: { jobId: number; equipmentId: number; jointIds?: number[] },
): Promise<{ confirmed: string[] }> {
  assertNotClientUser(actor);
  requireRole(actor, ...WELD_MAP_CONFIRM_ROLES);
  guardIds(input.jobId, input.equipmentId);
  return withJob(actor.tenantId, input.jobId, async (tx) => {
    const line = await lockLine(tx, actor, input.jobId, input.equipmentId);
    const where = { equipmentId: input.equipmentId, jobId: input.jobId, confirmed: false, ...(input.jointIds ? { id: { in: input.jointIds } } : {}) };
    const todo = await tx.plannedJoint.findMany({ where, select: { id: true, jointNo: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
    if (input.jointIds && input.jointIds.length) {
      const known = await tx.plannedJoint.count({ where: { equipmentId: input.equipmentId, jobId: input.jobId, id: { in: input.jointIds } } });
      if (known !== new Set(input.jointIds).size) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "PlannedJoint" });
    }
    if (todo.length === 0) return { confirmed: [] };
    await tx.plannedJoint.updateMany({ where: { id: { in: todo.map((t) => t.id) } }, data: { confirmed: true } });
    await recordAudit(tx, actor, {
      action: "weldMap.confirm",
      entityType: "Equipment",
      entityId: input.equipmentId,
      before: { confirmed: false },
      after: { line: line.name, confirmed: true, joints: todo.map((t) => t.jointNo) },
      eventType: "WeldMapConfirmed",
      eventPayload: { jobId: input.jobId, equipmentId: input.equipmentId, joints: todo.length },
    });
    return { confirmed: todo.map((t) => t.jointNo) };
  });
}
