import { randomUUID } from "node:crypto";
import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { ROLES, requireRole, assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createJobSchema,
  updateJobDatesSchema,
  updateJobDetailsSchema,
  setJobStatusSchema,
  type CreateJobInput,
  type UpdateJobDatesInput,
  type UpdateJobDetailsInput,
  type SetJobStatusInput,
} from "@/lib/shared/schemas";
import type { RuleDecision } from "@/lib/shared/include-when";
import { flushRuleDecisions, lineConfig, LineRules, loadQuestionDefs } from "./config-rules";
import { notifyJobCreated } from "./notifications.service";
import { assertShellCoursesAnswered, generatedJointTypesToPlan } from "./assembly.service";
import { resolveAssemblyTemplateVersion } from "./assembly-template.resolve";
import { resolveComponentTypeCodes, unrecognisedCodes } from "./bom.service";
import { bindExistingInspectionSteps, type BindExistingResult } from "./assembly-qcp-match";

/**
 * Job intake (docs/superpowers/specs/2026-08-22-job-intake-design.md).
 *
 * Creating a job is not one insert. A usable job needs, atomically: the Job
 * row, its OWN copy of the pinned template's processes and edges, at least one
 * Equipment, its Unit serials, and an audit record. Get any of that wrong and
 * the job renders in the list, then breaks on every screen that reads the
 * spine.
 *
 * Scheduling is deliberately NOT part of this transaction — see the note on
 * the return type.
 */

export interface CreateJobResult {
  jobId: number;
  publicId: string;
  processCount: number;
  edgeCount: number;
  unitCount: number;
  qcpItemCount: number;
  bomItemCount: number;
  /** J7a: weld-map joints copied from a previous line (unconfirmed). */
  weldMapJointCount: number;
  /**
   * J5a: a job is created without floor rows. Components, operations and assembly steps are
   * generated when the line's BOM revision is released (bom-release.service.ts); a copied BOM
   * waits there as DRAFT revision 1.
   */
  /**
   * QCP source items whose linked process code has no counterpart in the new
   * job's route. Reported, never silently dropped — the wizard lists them.
   */
  unmatchedQcpProcessCodes: string[];
  /** J2: includeWhen decisions recorded in config_rule_decisions, and how many rested on a missing answer or an unreadable rule. */
  ruleDecisionCount: number;
  flaggedRuleCount: number;
  /** J3a: edges of a line's own route that pointed at a job-level process the job's route lacks (not copied). */
  droppedEdgeCount: number;
}

export async function createJob(actor: Actor, input: CreateJobInput): Promise<CreateJobResult> {
  const parsed = createJobSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, (tx) => createJobTx(tx, actor, parsed));
}

/**
 * J7a: everything createJob does, inside a transaction the caller holds. `parsed` is already
 * createJobSchema output and the role check is the caller's (createJob, releaseDraft and the
 * rolled-back previewJob each make their own). Nothing here commits.
 */
export async function createJobTx(tx: Tx, actor: Actor, parsed: CreateJobInput): Promise<CreateJobResult> {
  {
    // ── Validate everything before writing anything ──────────────────────
    const duplicate = await tx.job.findFirst({
      where: { tenantId: actor.tenantId, jobNumber: parsed.jobNumber },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppError(ERROR_CODES.DUPLICATE_JOB_NUMBER, {
        jobNumber: parsed.jobNumber,
        existingJobId: duplicate.id,
      });
    }

    const client = await tx.client.findFirst({
      where: { id: parsed.clientId, tenantId: actor.tenantId },
    });
    if (!client) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Client", clientId: parsed.clientId });

    const family = await tx.productFamily.findFirst({
      where: { id: parsed.familyId, tenantId: actor.tenantId },
    });
    if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId: parsed.familyId });

    const version = await tx.processTemplateVersion.findFirst({
      where: { id: parsed.templateVersionId, template: { tenantId: actor.tenantId } },
      include: { template: true, processes: true, edges: true },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        entity: "ProcessTemplateVersion",
        templateVersionId: parsed.templateVersionId,
      });
    }
    if (version.status !== "PUBLISHED") {
      // Filtering the dropdown is not enforcement.
      throw new AppError(ERROR_CODES.TEMPLATE_VERSION_NOT_PUBLISHED, {
        templateVersionId: version.id,
        status: version.status,
      });
    }
    if (version.template.familyId !== parsed.familyId) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { templateVersionId: version.id, familyId: parsed.familyId },
        "That process route belongs to a different type of equipment.",
      );
    }
    if (version.processes.length === 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { templateVersionId: version.id },
        "That process route has no processes.",
      );
    }

    if (parsed.calendarId != null) {
      const cal = await tx.workCalendar.findFirst({
        where: { id: parsed.calendarId, tenantId: actor.tenantId },
      });
      if (!cal) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "WorkCalendar", calendarId: parsed.calendarId });
    }

    // J3a: a line runs the job's own route unless it names another published
    // version (of its own family) — then that line gets its own UNIT-grain processes.
    const otherVersionIds = [
      ...new Set(
        parsed.equipments.map((b) => b.templateVersionId).filter((v): v is number => v != null && v !== version.id),
      ),
    ];
    const otherVersions = otherVersionIds.length
      ? await tx.processTemplateVersion.findMany({
          where: { id: { in: otherVersionIds }, template: { tenantId: actor.tenantId } },
          include: { template: true, processes: true, edges: true },
        })
      : [];
    for (const vid of otherVersionIds) {
      const v = otherVersions.find((x) => x.id === vid);
      if (!v) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", templateVersionId: vid });
      if (v.status !== "PUBLISHED") {
        throw new AppError(ERROR_CODES.TEMPLATE_VERSION_NOT_PUBLISHED, { templateVersionId: v.id, status: v.status });
      }
      if (v.processes.length === 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          { templateVersionId: v.id },
          "That process route has no processes.",
        );
      }
    }
    const versionById = new Map([[version.id, version], ...otherVersions.map((v) => [v.id, v] as const)]);
    const versionOf = (b: { templateVersionId?: number | null }) => versionById.get(b.templateVersionId ?? version.id)!;
    const onJobRoute = parsed.equipments.map((b) => versionOf(b).id === version.id);

    // J6 (D21): lot-then-serial waits for the decision on where serials begin.
    if (parsed.equipments.some((b) => b.trackingMode === "LOT_THEN_SERIAL")) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { field: "trackingMode" },
        "Lot then serial is not available yet. Track this line as serial units, or as one lot.",
      );
    }

    const typeIds = parsed.equipments
      .map((e) => e.equipmentTypeId)
      .filter((x): x is number => x != null);
    if (typeIds.length > 0) {
      const types = await tx.equipmentTypeRef.findMany({
        where: { id: { in: typeIds }, tenantId: actor.tenantId },
      });
      if (types.length !== new Set(typeIds).size) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "EquipmentTypeRef", equipmentTypeIds: typeIds });
      }
      const typeById = new Map(types.map((t) => [t.id, t]));
      const wrongFamily = parsed.equipments.flatMap((b) => {
        const t = b.equipmentTypeId != null ? typeById.get(b.equipmentTypeId) : undefined;
        return t && t.familyId !== versionOf(b).template.familyId ? [t] : [];
      });
      if (wrongFamily.length > 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          { equipmentTypeCodes: wrongFamily.map((t) => t.code) },
          "An equipment type does not belong to this job's type of equipment.",
        );
      }
    }

    const usedProcesses = [...versionById.values()].flatMap((v) => v.processes);
    const templateCodes = new Set(usedProcesses.map((p) => p.code));
    const unknownExclusions = parsed.excludedProcessCodes.filter((c) => !templateCodes.has(c));
    if (unknownExclusions.length > 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        entity: "TemplateProcess",
        processCodes: unknownExclusions,
      });
    }

    // AUD-033: TemplateProcess.optional is the template author's own record of
    // which processes are conditional (schema doc: "Conditional processes
    // (e.g. PWHT) can be excluded per job"). Excluding anything else drops it
    // silently — no ProcessPlan, nothing to gate, nothing to verify.
    const nonOptionalExclusions = [
      ...new Set(
        usedProcesses.filter((tp) => parsed.excludedProcessCodes.includes(tp.code) && !tp.optional).map((tp) => tp.code),
      ),
    ];
    if (nonOptionalExclusions.length > 0) {
      throw new AppError(ERROR_CODES.PROCESS_NOT_OPTIONAL, { processCodes: nonOptionalExclusions });
    }

    // A permanent scope change deserves a reason on record (audit's own fix
    // recommendation) — captured in this transaction's audit event, not a new
    // column (see PR notes on whether that's needed eventually).
    if (parsed.excludedProcessCodes.length > 0 && !parsed.exclusionReason) {
      throw new AppError(ERROR_CODES.EXCLUSION_REASON_REQUIRED);
    }

    // J2: each line's answers, filtered through its family's questions, and the
    // includeWhen decision for every process (configure time, once).
    // J3a: a process row has a scope. Job-level rows (every JOB-grain process, and the
    // UNIT-grain ones of lines on the job's route) are dropped only when EVERY line they
    // serve drops them; a line on its own route decides its own rows.
    const familyIds = [...new Set(parsed.equipments.map((b) => versionOf(b).template.familyId))];
    const questionsByFamily = new Map(
      await Promise.all(
        familyIds.map(async (f) => [f, await loadQuestionDefs(tx, actor.tenantId, f)] as const),
      ),
    );
    const lineQuestions = parsed.equipments.map((b) => questionsByFamily.get(versionOf(b).template.familyId)!);
    const blockConfigs = parsed.equipments.map((b, i) => lineConfig(lineQuestions[i], b.equipmentTypeId, b.config));
    const probes = parsed.equipments.map((b, i) =>
      LineRules.fromConfig(0, 0, lineQuestions[i], b.equipmentTypeId, blockConfigs[i]),
    );
    // J4a/J5a: the seams follow the shell courses, so the answer is checked before the job exists
    // even though the steps are only made at BOM release.
    for (const [i, b] of parsed.equipments.entries()) {
      const av = await resolveAssemblyTemplateVersion(tx, actor.tenantId, versionOf(b).template.familyId, b.equipmentTypeId ?? null);
      if (!av) continue;
      const seamTypes = generatedJointTypesToPlan(av.steps.filter((st) => probes[i].peek(st.includeWhen).included), []);
      if (seamTypes.length > 0) assertShellCoursesAnswered(seamTypes, blockConfigs[i]);
    }
    type ScopedProcess = {
      tp: (typeof version.processes)[number];
      /** Index into parsed.equipments for a line's own route; null = the job-level set. */
      line: number | null;
      /** The lines this row serves (their answers decide it). */
      lines: number[];
      rule?: { included: boolean; perLine: { line: number; d: RuleDecision }[] };
    };
    const scoped: ScopedProcess[] = [];
    const allLines = parsed.equipments.map((_, i) => i);
    const routeLines = allLines.filter((i) => onJobRoute[i]);
    for (const tp of version.processes) {
      if (tp.grain === "JOB") scoped.push({ tp, line: null, lines: allLines });
      else if (routeLines.length > 0) scoped.push({ tp, line: null, lines: routeLines });
    }
    for (const i of allLines) {
      if (onJobRoute[i]) continue;
      for (const tp of versionOf(parsed.equipments[i]).processes) {
        if (tp.grain === "UNIT") scoped.push({ tp, line: i, lines: [i] });
      }
    }
    for (const sp of scoped) {
      const tp = sp.tp;
      if (tp.includeWhen == null) continue;
      const perLine = sp.lines.map((line) => ({
        line,
        // AUD-033: a rule never removes a mandatory process; the ignored rule is flagged for the planner
        d: tp.optional
          ? probes[line].peek(tp.includeWhen)
          : {
              included: true,
              flagged: true,
              reason: { rule: tp.includeWhen, clauses: [], missing: [], invalid: "rule ignored: this process is mandatory" },
            },
      }));
      sp.rule = { included: perLine.some((x) => x.d.included), perLine };
    }

    // ── Write ────────────────────────────────────────────────────────────
    return audited(tx, actor, async () => {
      const job = await tx.job.create({
        data: {
          tenantId: actor.tenantId,
          // Opaque id for client-facing URLs — sequential ids leak order volume.
          publicId: randomUUID(),
          clientId: parsed.clientId,
          familyId: parsed.familyId,
          templateVersionId: version.id,
          calendarId: parsed.calendarId,
          jobNumber: parsed.jobNumber,
          clientOrderNo: parsed.clientOrderNo,
          projectName: parsed.projectName,
          poRef: parsed.poRef,
          designCode: parsed.designCode,
          orderDate: parsed.orderDate,
          committedDeliveryDate: parsed.committedDeliveryDate,
          targetDispatchDate: parsed.targetDispatchDate,
          priority: parsed.priority,
          remarks: parsed.remarks,
        },
      });

      // Equipment lines and their units first: a line on its own route needs its id for its processes.
      let unitCount = 0;
      const equipmentIds: number[] = [];
      const blockUnits: {
        equipmentId: number;
        familyId: number;
        equipmentTypeId: number | null;
        unitIds: number[];
        rules: LineRules;
        answers: Record<string, unknown>;
      }[] = [];
      for (const [i, block] of parsed.equipments.entries()) {
        const lineVersion = versionOf(block);
        const equipment = await tx.equipment.create({
          data: {
            jobId: job.id,
            equipmentTypeId: block.equipmentTypeId,
            name: block.name,
            blockNo: block.blockNo,
            remarks: block.remarks,
            config: Object.keys(blockConfigs[i]).length > 0 ? (blockConfigs[i] as never) : undefined,
            templateVersionId: lineVersion.id,
            trackingMode: block.trackingMode ?? "SERIAL",
          },
        });
        equipmentIds.push(equipment.id);
        const rules = LineRules.fromConfig(job.id, equipment.id, lineQuestions[i], block.equipmentTypeId ?? null, blockConfigs[i]);
        const units = await tx.unit.createManyAndReturn({
          // J6: a lot is one unit carrying the line's quantity.
          data:
            block.trackingMode === "LOT"
              ? [{ equipmentId: equipment.id, serialNo: `${job.jobNumber}-LOT${i + 1}`, jobId: job.id, qtyPlanned: block.lotQty! }]
              : block.serials.map((serialNo) => ({ equipmentId: equipment.id, serialNo, jobId: job.id })),
          select: { id: true },
        });
        blockUnits.push({
          equipmentId: equipment.id,
          familyId: lineVersion.template.familyId,
          equipmentTypeId: block.equipmentTypeId ?? null,
          unitIds: units.map((u) => u.id),
          rules,
          answers: blockConfigs[i],
        });
        unitCount += units.length;
      }

      const excluded = new Set(parsed.excludedProcessCodes);
      await tx.jobProcess.createMany({
        data: scoped.map((sp) => {
          const tp = sp.tp;
          return {
            jobId: job.id,
            equipmentId: sp.line == null ? null : equipmentIds[sp.line],
            templateProcessId: tp.id,
            seq: tp.seq,
            code: tp.code,
            name: tp.name,
            departmentId: tp.defaultDepartmentId,
            durationMinDays: tp.durationMinDays,
            durationMaxDays: tp.durationMaxDays,
            qtyBands: tp.qtyBands ?? undefined,
            envelopeFinishByMinDays: tp.envelopeFinishByMinDays,
            envelopeFinishByMaxDays: tp.envelopeFinishByMaxDays,
            envelopeStartByMinDays: tp.envelopeStartByMinDays,
            envelopeStartByMaxDays: tp.envelopeStartByMaxDays,
            workOrderStages: tp.workOrderStages,
            provisional: tp.provisional,
            // Lean Core L1.1: copied at intake so later template edits cannot
            // change a running job (invariant 9).
            grain: tp.grain,
            requiresQc: tp.requiresQc,
            included: !excluded.has(tp.code) && (sp.rule?.included ?? true),
            // J2: the reason is kept when a rule decided or flagged it (a manual exclusion has its own audit reason)
            inclusionReason:
              !excluded.has(tp.code) && sp.rule
                ? ({
                    byRule: true,
                    lines: sp.rule.perLine.map(({ line, d }) => ({
                      line: line + 1,
                      included: d.included,
                      flagged: d.flagged,
                      missing: d.reason.missing,
                      ...(d.reason.invalid ? { invalid: d.reason.invalid } : {}),
                    })),
                  } as never)
                : undefined,
          };
        }),
      });

      const jobProcesses = await tx.jobProcess.findMany({
        where: { jobId: job.id },
        select: { id: true, code: true, equipmentId: true },
        orderBy: { id: "asc" },
      });
      const scopeKey = (equipmentId: number | null, code: string) => `${equipmentId ?? "job"}:${code}`;
      const jpIdByScope = new Map(jobProcesses.map((p) => [scopeKey(p.equipmentId, p.code), p.id]));
      // A QCP item names a process by code; it links every row of that code (the job-level one first).
      const jpIdsByCode = new Map<string, number[]>();
      for (const p of jobProcesses) jpIdsByCode.set(p.code, [...(jpIdsByCode.get(p.code) ?? []), p.id]);

      // Edges are copied for ALL processes, including excluded ones.
      // lib/schedule/exclude.ts::bypassExcluded splices an excluded node out by
      // composing lag = lagPX + duration(X) + lagXS across it, so an excluded
      // process must keep both its edges and its durations. Dropping either
      // would treat it as taking zero days and drag every successor early —
      // that function's own comment calls this invariant #10 territory.
      // J3a: the job's edges join job-level rows; a line on its own route has
      // its UNIT-grain rows wired to each other and to the job-level rows of the
      // same code (an edge to a code the job route lacks is dropped, counted below).
      const edgeData: {
        jobId: number;
        processId: number;
        predecessorId: number;
        type: (typeof version.edges)[number]["type"];
        lagDays: number;
        enforcement: (typeof version.edges)[number]["enforcement"];
      }[] = [];
      let droppedEdgeCount = 0;
      const wire = (v: typeof version, line: number | null) => {
        const tpById = new Map(v.processes.map((p) => [p.id, p]));
        const resolve = (tpId: number) => {
          const tp = tpById.get(tpId)!;
          // Lines on the job route and JOB-grain processes resolve to the job-level set.
          return jpIdByScope.get(scopeKey(line != null && tp.grain === "UNIT" ? equipmentIds[line] : null, tp.code));
        };
        for (const e of v.edges) {
          // The job's own route owns edges between two JOB-grain processes; a line's route never re-adds them.
          if (line != null && tpById.get(e.processId)!.grain === "JOB" && tpById.get(e.predecessorId)!.grain === "JOB") continue;
          const processId = resolve(e.processId);
          const predecessorId = resolve(e.predecessorId);
          if (processId == null || predecessorId == null) {
            droppedEdgeCount++;
            continue;
          }
          edgeData.push({ jobId: job.id, processId, predecessorId, type: e.type, lagDays: e.lagDays, enforcement: e.enforcement });
        }
      };
      wire(version, null);
      for (const i of allLines) if (!onJobRoute[i]) wire(versionOf(parsed.equipments[i]), i);
      await tx.jobProcessEdge.createMany({ data: edgeData });

      await notifyJobCreated(
        tx,
        actor,
        { id: job.id, jobNumber: job.jobNumber, projectName: job.projectName },
        scoped.map((sp) => sp.tp.defaultDepartmentId),
      );

      // J2: every line's includeWhen decision for the rows it serves goes on the ledger.
      for (const sp of scoped) {
        for (const { line, d } of sp.rule?.perLine ?? []) blockUnits[line].rules.record("TEMPLATE_PROCESS", sp.tp.id, d);
      }

      const qcp = parsed.qcpTemplateSourceId
        ? await cloneQcpTemplate(tx, parsed.qcpTemplateSourceId, job.id, jpIdsByCode, actor.tenantId, blockUnits.map((b) => b.rules))
        : { qcpTemplateId: null, itemCount: 0, unmatchedProcessCodes: [] as string[], skipped: [] as { srNo: string; sequence: number }[] };

      // J5a: the copied lines wait as DRAFT revision 1; BOM release makes the floor rows.
      // J7a: per line. The job-level source still feeds the first line when that line names none.
      let bomCount = 0;
      const bomUploads: { line: string; fileName: string | null; lines: number }[] = [];
      let weldMapJointCount = 0;
      for (const [i, block] of parsed.equipments.entries()) {
        const bomSource = block.copyBomFromEquipmentId ?? (block.bomFromKit ? null : i === 0 ? parsed.copyBomFromEquipmentId : null);
        if (bomSource != null) bomCount += (await copyBom(tx, bomSource, equipmentIds[i], actor.tenantId, job.id, actor.userId)).count;
        if (block.bomFromKit) bomCount += await kitBom(tx, block, equipmentIds[i], actor.tenantId, job.id, actor.userId);
        if (block.bomLines?.length) {
          bomCount += await uploadedBom(tx, block.bomLines, equipmentIds[i], actor.tenantId, job.id, actor.userId);
          bomUploads.push({ line: block.name, fileName: block.bomFileName ?? null, lines: block.bomLines.length });
        }
        if (block.copyWeldMapFromEquipmentId != null) {
          weldMapJointCount += await copyWeldMap(tx, block.copyWeldMapFromEquipmentId, equipmentIds[i], actor.tenantId, job.id);
        }
      }

      await flushRuleDecisions(tx, blockUnits.map((b) => b.rules));
      const ruleDecisionCount = await tx.configRuleDecision.count({ where: { jobId: job.id } });
      const flaggedRuleCount = await tx.configRuleDecision.count({ where: { jobId: job.id, flagged: true } });

      const result: CreateJobResult = {
        jobId: job.id,
        publicId: job.publicId,
        processCount: scoped.length,
        edgeCount: edgeData.length,
        unitCount,
        qcpItemCount: qcp.itemCount,
        bomItemCount: bomCount,
        weldMapJointCount,
        unmatchedQcpProcessCodes: qcp.unmatchedProcessCodes,
        ruleDecisionCount,
        flaggedRuleCount,
        droppedEdgeCount,
      };

      return {
        result,
        audit: {
          action: "job.create",
          entityType: "Job",
          entityId: job.id,
          after: {
            jobNumber: job.jobNumber,
            clientId: job.clientId,
            familyId: job.familyId,
            templateVersionId: job.templateVersionId,
            committedDeliveryDate: job.committedDeliveryDate,
            targetDispatchDate: job.targetDispatchDate,
            processCount: result.processCount,
            equipmentCount: parsed.equipments.length,
            unitCount: result.unitCount,
            bomItemCount: result.bomItemCount,
            ...(bomUploads.length > 0 ? { bomUploads } : {}),
            ruleDecisionCount: result.ruleDecisionCount,
            flaggedRuleCount: result.flaggedRuleCount,
            droppedEdgeCount: result.droppedEdgeCount,
            excludedProcessCodes: parsed.excludedProcessCodes,
            exclusionReason: parsed.exclusionReason,
          },
          eventType: "JobCreated",
          eventPayload: {
            jobId: job.id,
            jobNumber: job.jobNumber,
            familyId: job.familyId,
            excludedProcessCodes: parsed.excludedProcessCodes,
            exclusionReason: parsed.exclusionReason,
          },
        },
      };
    });
  }
}

/**
 * Set/change an existing job's planning dates (order/committed/target
 * dispatch) after creation. A freshly created job commonly has none of these
 * set — createJob() deliberately doesn't require them (see the note on
 * scheduleNewJobAction) — so this is the only way to give the scheduler
 * something to anchor on afterwards. Same role gate as createJob: a client
 * user never edits these, and the app enforces it here, not just in the UI.
 */
export async function updateJobDates(actor: Actor, input: UpdateJobDatesInput) {
  const parsed = updateJobDatesSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const before = await tx.job.findFirst({
      where: { id: parsed.jobId, tenantId: actor.tenantId },
      select: { orderDate: true, committedDeliveryDate: true, targetDispatchDate: true },
    });
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId: parsed.jobId });

    return audited(tx, actor, async () => {
      const job = await tx.job.update({
        where: { id: parsed.jobId },
        data: {
          orderDate: parsed.orderDate,
          committedDeliveryDate: parsed.committedDeliveryDate,
          targetDispatchDate: parsed.targetDispatchDate,
        },
      });

      return {
        result: {
          jobId: job.id,
          orderDate: job.orderDate,
          committedDeliveryDate: job.committedDeliveryDate,
          targetDispatchDate: job.targetDispatchDate,
        },
        audit: {
          action: "job.update_dates",
          entityType: "Job",
          entityId: job.id,
          before,
          after: {
            orderDate: job.orderDate,
            committedDeliveryDate: job.committedDeliveryDate,
            targetDispatchDate: job.targetDispatchDate,
          },
          eventType: "JobDatesUpdated",
          eventPayload: { jobId: job.id },
        },
      };
    });
  });
}

/**
 * Revise a job's own descriptive/reference fields (client PO, project name,
 * design code, priority, remarks) after creation. Same role gate and direct-
 * update-plus-audit-log pattern as updateJobDates — a plain correction, not a
 * versioned one (invariant #6's "new version with a reason" is for records
 * with real-world consequences already logged elsewhere, e.g. a submitted MTC;
 * these fields carry none of that).
 */
export async function updateJobDetails(actor: Actor, input: UpdateJobDetailsInput) {
  const parsed = updateJobDetailsSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const before = await tx.job.findFirst({
      where: { id: parsed.jobId, tenantId: actor.tenantId },
      select: { clientOrderNo: true, projectName: true, poRef: true, designCode: true, priority: true, remarks: true },
    });
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId: parsed.jobId });

    return audited(tx, actor, async () => {
      const job = await tx.job.update({
        where: { id: parsed.jobId },
        data: {
          clientOrderNo: parsed.clientOrderNo,
          projectName: parsed.projectName,
          poRef: parsed.poRef,
          designCode: parsed.designCode,
          priority: parsed.priority,
          remarks: parsed.remarks,
        },
      });

      return {
        result: {
          jobId: job.id,
          clientOrderNo: job.clientOrderNo,
          projectName: job.projectName,
          poRef: job.poRef,
          designCode: job.designCode,
          priority: job.priority,
          remarks: job.remarks,
        },
        audit: {
          action: "job.update_details",
          entityType: "Job",
          entityId: job.id,
          before,
          after: {
            clientOrderNo: job.clientOrderNo,
            projectName: job.projectName,
            poRef: job.poRef,
            designCode: job.designCode,
            priority: job.priority,
            remarks: job.remarks,
          },
          eventType: "JobDetailsUpdated",
          eventPayload: { jobId: job.id },
        },
      };
    });
  });
}

/**
 * S19: `Job.status` had no writer anywhere in `src/` — every real job sits
 * at the DB default `ACTIVE` forever, which makes `job-health.ts`'s own
 * `CANCELLED`/`COMPLETE`/`ON_HOLD` branches dead code in practice. Same role
 * gate as `updateJobDates`/`updateJobDetails`.
 *
 * Guards only the COMPLETE transition: refuses if any `ProcessPlan` on the
 * job's CURRENT `ScheduleRun`(s) — `isCurrent: true`, scoped per equipment
 * since a multi-equipment job can carry more than one — is not itself
 * COMPLETE. Excluded processes never get a `ProcessPlan` row at all
 * (`envelope.ts` filters them out), so they need no special-casing here.
 * ACTIVE/ON_HOLD/CANCELLED carry no such guard — pausing or cancelling a job
 * with open work is a real, unguarded management decision, not a data-
 * integrity question the way "complete" is.
 */
export async function setJobStatus(actor: Actor, input: SetJobStatusInput): Promise<{ jobId: number; status: string }> {
  const { jobId, status } = setJobStatusSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: jobId, tenantId: actor.tenantId },
      select: { id: true, status: true },
    });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });
    if (job.status === status) return { jobId: job.id, status: job.status }; // no-op, nothing to audit

    if (status === "COMPLETE") {
      const incomplete = await tx.processPlan.count({
        where: { scheduleRun: { jobId, isCurrent: true }, status: { not: "COMPLETE" } },
      });
      if (incomplete > 0) {
        throw new AppError(ERROR_CODES.JOB_HAS_INCOMPLETE_PLANS, { jobId, incompletePlanCount: incomplete });
      }
    }

    return audited(tx, actor, async () => {
      const updated = await tx.job.update({ where: { id: jobId }, data: { status } });
      return {
        result: { jobId: updated.id, status: updated.status },
        audit: {
          action: "job.setStatus",
          entityType: "Job",
          entityId: jobId,
          before: { status: job.status },
          after: { status: updated.status },
          eventType: "JobStatusChanged",
          eventPayload: { jobId, from: job.status, to: updated.status },
        },
      };
    });
  });
}

export interface AttachQcpResult extends BindExistingResult {
  qcpTemplateId: number;
  itemCount: number;
  unmatchedProcessCodes: string[];
}

/**
 * JG2: give an existing job a QC plan. Same clone as createJob (items, parties,
 * process links, per-line include rules), then binds the job's NOT_STARTED
 * unbound inspection steps. `requiresQc` on existing rows is not re-derived.
 * One plan per job: a job that has one refuses (replacing is not built).
 */
export async function attachQcpTemplate(
  actor: Actor,
  input: { jobId: number; qcpTemplateSourceId: number },
): Promise<AttachQcpResult> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);
  const { jobId, qcpTemplateSourceId } = input;
  if (!Number.isInteger(jobId) || !Number.isInteger(qcpTemplateSourceId)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { jobId, qcpTemplateSourceId });

  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findFirst({ where: { id: jobId, tenantId: actor.tenantId }, select: { id: true } });
    if (!job) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Job", jobId });
    // Serialise two attaches on one job: the loser then sees the winner's template.
    await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
    if ((await tx.qcpTemplate.count({ where: { jobId } })) > 0) throw new AppError(ERROR_CODES.QCP_ALREADY_ATTACHED, { jobId });

    const jobProcesses = await tx.jobProcess.findMany({ where: { jobId }, select: { id: true, code: true }, orderBy: { id: "asc" } });
    const jpIdsByCode = new Map<string, number[]>();
    for (const p of jobProcesses) jpIdsByCode.set(p.code, [...(jpIdsByCode.get(p.code) ?? []), p.id]);
    const equipments = await tx.equipment.findMany({ where: { jobId }, select: { id: true }, orderBy: { id: "asc" } });
    const lineRules = await Promise.all(equipments.map((e) => LineRules.load(tx, e.id)));

    return audited(tx, actor, async () => {
      const qcp = await cloneQcpTemplate(tx, qcpTemplateSourceId, jobId, jpIdsByCode, actor.tenantId, lineRules);
      await flushRuleDecisions(tx, lineRules);
      const bind = await bindExistingInspectionSteps(tx, jobId, qcp.qcpTemplateId, qcp.skipped);
      const result: AttachQcpResult = {
        qcpTemplateId: qcp.qcpTemplateId,
        itemCount: qcp.itemCount,
        unmatchedProcessCodes: qcp.unmatchedProcessCodes,
        ...bind,
      };
      return {
        result,
        audit: {
          action: "qcp.attach",
          entityType: "Job",
          entityId: jobId,
          before: null,
          after: {
            qcpTemplateId: qcp.qcpTemplateId,
            sourceId: qcpTemplateSourceId,
            itemCount: qcp.itemCount,
            boundSteps: bind.bound,
            leftUnboundSteps: bind.leftUnbound.length,
            unmatchedProcessCodes: qcp.unmatchedProcessCodes,
          },
          eventType: "QcpAttached",
          eventPayload: { jobId, qcpTemplateId: qcp.qcpTemplateId },
        },
      };
    });
  });
}

/**
 * Deep-copy a QCP template onto a new job: parties, items, party codes, and
 * the item→process links rebuilt by matching process CODE (not id).
 *
 * Code-matching is what makes this safe across template versions: if the
 * source QCP was built against a route where a process has since been
 * renumbered, the code still resolves. A code with no counterpart is
 * collected and returned, never silently dropped.
 *
 * QcpExecution rows are NOT copied — those are the source job's actual
 * inspection results.
 */
export async function cloneQcpTemplate(
  tx: Tx,
  sourceId: number,
  jobId: number,
  jpIdsByCode: Map<string, number[]>,
  tenantId: number,
  lineRules: LineRules[],
): Promise<{
  qcpTemplateId: number;
  itemCount: number;
  unmatchedProcessCodes: string[];
  /** J2: source items a rule dropped (not cloned); their position still counts when steps bind to items. */
  skipped: { srNo: string; sequence: number }[];
}> {
  const source = await tx.qcpTemplate.findFirst({
    // AUD-078: qcp_templates now carries its own real tenant_id (job-owned
    // rows via the derive trigger, library rows set directly at authoring
    // time) — a bare findUnique would still happily return another
    // tenant's row (the ProcessPlan lesson in _shared.ts), so filter on it.
    where: { id: sourceId, tenantId },
    include: {
      parties: true,
      items: {
        include: {
          partyCodes: true,
          processLinks: { include: { jobProcess: { select: { code: true } } } },
        },
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!source) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "QcpTemplate", qcpTemplateId: sourceId });

  const copy = await tx.qcpTemplate.create({
    data: {
      jobId,
      jobLabel: source.jobLabel,
      vessel: source.vessel,
      revision: source.revision,
      designCode: source.designCode,
    },
  });

  const partyIdMap = new Map<number, number>();
  for (const p of source.parties) {
    const created = await tx.inspectionParty.create({
      data: { qcpTemplateId: copy.id, jobId, code: p.code, name: p.name },
    });
    partyIdMap.set(p.id, created.id);
  }

  const unmatched = new Set<string>();
  const skipped: { srNo: string; sequence: number }[] = [];
  let itemCount = 0;
  for (const item of source.items) {
    // J2: an item with a rule is kept when ANY line's answers keep it; each line's decision is on the ledger.
    if (item.includeWhen != null) {
      const decisions = lineRules.map((l) => l.peek(item.includeWhen));
      // The srNo and sequence ride on the ledger row so the BOM release can rebuild `skipped` later (J5a).
      decisions.forEach((d, i) => lineRules[i].record("QCP_ITEM", item.id, { ...d, reason: { ...d.reason, srNo: item.srNo, sequence: item.sequence } } as RuleDecision));
      if (lineRules.length > 0 && !decisions.some((d) => d.included)) {
        skipped.push({ srNo: item.srNo, sequence: item.sequence });
        continue;
      }
    }
    itemCount++;
    const created = await tx.qcpItem.create({
      data: {
        qcpTemplateId: copy.id,
        jobId,
        sequence: item.sequence,
        srNo: item.srNo,
        kind: item.kind,
        section: item.section,
        activity: item.activity,
        characteristic: item.characteristic,
        extentOfCheck: item.extentOfCheck,
        applicableDocument: item.applicableDocument,
        acceptanceCriteria: item.acceptanceCriteria,
        record: item.record,
        remarks: item.remarks,
      },
    });

    // C7: a from-scratch-authored library item has no real processLinks yet
    // (there was no Job/JobProcess to link against at authoring time) — it
    // carries libraryProcessCodes instead. Falls back to those ONLY when
    // processLinks is empty, so a cloned-from-a-real-job item (today's only
    // path) is completely unaffected.
    const codes =
      item.processLinks.length > 0 ? item.processLinks.map((l) => l.jobProcess.code) : item.libraryProcessCodes;

    for (const pc of item.partyCodes) {
      const newPartyId = partyIdMap.get(pc.inspectionPartyId);
      if (newPartyId == null) continue;
      await tx.qcpItemPartyCode.create({
        data: {
          qcpItemId: created.id,
          jobId,
          inspectionPartyId: newPartyId,
          qcpCodeId: pc.qcpCodeId,
        },
      });
    }

    for (const code of codes) {
      const newJobProcessIds = jpIdsByCode.get(code);
      if (!newJobProcessIds?.length) {
        unmatched.add(code);
        continue;
      }
      for (const newJobProcessId of newJobProcessIds) {
        await tx.qcpItemProcess.create({
          data: { qcpItemId: created.id, jobProcessId: newJobProcessId, jobId },
        });
      }
    }
  }

  return { qcpTemplateId: copy.id, itemCount, unmatchedProcessCodes: [...unmatched], skipped };
}

/**
 * Copy BOM lines from an existing equipment into a new one.
 *
 * Deliberately copies ONLY the BomItem rows. Procurement, MaterialIdentification,
 * Component and ItemTest are execution records belonging to the source job —
 * heat numbers, MTC references, PO numbers. Copying them would fabricate
 * traceability, which is the opposite of what this system exists for.
 * J5a: the copy lands in a new DRAFT BomRevision 1 on the target line, which is
 * what `releaseBomRevision` materialises (components, operations, steps).
 *
 * Fix wave (Important #4): preserves `parentBomItemId` hierarchies, which
 * B4 (Dispatch 8) made the first real writer of. `createMany` can't point a
 * self-referencing FK at a row created in the same batch, so this is a
 * two-pass copy: pass 1 creates every row with `parentBomItemId` left null,
 * tracking a source-id -> target-id map keyed by `itemNo` (the CSV's stable
 * business key, unlike an autoincrement id which obviously can't survive a
 * copy); pass 2, in the same transaction, sets each copy's `parentBomItemId`
 * to the mapped target id wherever the source had one. Without this, a
 * sub-assembly's exploded required qty on the new job silently drops a
 * multiplication level (e.g. child qtyPer 4 under a parent qtyPer 2 becomes
 * `4 x unitCount` instead of `4 x 2 x unitCount`) — wrong for shortage/kit-
 * gating purposes.
 */
async function copyBom(
  tx: Tx,
  sourceEquipmentId: number,
  targetEquipmentId: number,
  tenantId: number,
  jobId: number,
  createdBy: number,
): Promise<{ count: number; createdIds: number[] }> {
  const source = await tx.equipment.findFirst({
    where: { id: sourceEquipmentId, job: { tenantId } },
    include: { bomItems: { orderBy: { itemNo: "asc" } } },
  });
  if (!source) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Equipment", equipmentId: sourceEquipmentId });
  }
  if (source.bomItems.length === 0) return { count: 0, createdIds: [] };

  const revision = await tx.bomRevision.create({
    data: { equipmentId: targetEquipmentId, revisionNo: 1, status: "DRAFT", createdBy, jobId },
  });
  const created = await tx.bomItem.createManyAndReturn({
    data: source.bomItems.map((b) => ({
      equipmentId: targetEquipmentId,
      bomRevisionId: revision.id,
      jobId,
      itemNo: b.itemNo,
      blockNo: b.blockNo,
      partName: b.partName,
      description: b.description,
      material: b.material,
      sourceQty: b.sourceQty,
      qtyPer: b.qtyPer,
      uom: b.uom,
      unit: b.unit,
      componentTypeId: b.componentTypeId,
      routeVariant: b.routeVariant,
      remarks: b.remarks,
    })),
    select: { id: true, itemNo: true },
  });

  const targetIdByItemNo = new Map(created.map((c) => [c.itemNo, c.id]));
  const sourceItemNoById = new Map(source.bomItems.map((b) => [b.id, b.itemNo]));

  for (const b of source.bomItems) {
    if (b.parentBomItemId == null) continue;
    const parentItemNo = sourceItemNoById.get(b.parentBomItemId);
    const targetParentId = parentItemNo != null ? targetIdByItemNo.get(parentItemNo) : undefined;
    const targetChildId = targetIdByItemNo.get(b.itemNo);
    if (targetParentId == null || targetChildId == null) continue; // defensive: shouldn't happen, source's own FK is internally consistent
    await tx.bomItem.update({ where: { id: targetChildId }, data: { parentBomItemId: targetParentId } });
  }

  return { count: source.bomItems.length, createdIds: created.map((c) => c.id) };
}

/**
 * J7b (Build from master): the line's BOM from its equipment type's kit (component type x default
 * quantity) as DRAFT revision 1; Engineering checks it and releases it on the release screen.
 * `ANSWER:<key>` quantities read the line's own numeric answer, anything else uses the default.
 * ponytail: the kit names component TYPES, so these lines carry a type and no material or size; the
 * release screen's mapping and the part-family rules do the rest. NOZZLE_SCHEDULE has no schedule here
 * and uses the default quantity.
 */
async function kitBom(
  tx: Tx,
  block: { equipmentTypeId?: number | null; config?: Record<string, unknown> | null },
  equipmentId: number,
  tenantId: number,
  jobId: number,
  createdBy: number,
): Promise<number> {
  const kit = await tx.equipmentTypeComponent.findMany({
    where: { equipmentTypeId: block.equipmentTypeId!, tenantId },
    orderBy: { id: "asc" },
    include: { componentType: { select: { id: true, name: true } } },
  });
  if (kit.length === 0) return 0;
  const revision = await tx.bomRevision.create({ data: { equipmentId, revisionNo: 1, status: "DRAFT", createdBy, jobId } });
  await tx.bomItem.createMany({
    data: kit.map((k, i) => {
      const answer = k.qtySource.startsWith("ANSWER:") ? Number(block.config?.[k.qtySource.slice(7)]) : NaN;
      const qty = Number.isInteger(answer) && answer > 0 ? answer : k.defaultQty;
      return {
        equipmentId,
        bomRevisionId: revision.id,
        jobId,
        itemNo: i + 1,
        partName: k.componentType.name,
        sourceQty: String(qty),
        qtyPer: qty,
        componentTypeId: k.componentType.id,
        remarks: "From the equipment type's standard kit",
      };
    }),
  });
  return kit.length;
}

/**
 * Wizard upload: the BOM lines read from an Excel file (previewBomUpload) as the line's DRAFT revision 1,
 * made the same way as the kit's and a copied job's so the preview counts equal the real create. A
 * component type code that no longer resolves refuses the whole job (as the BOM panel's import does).
 */
async function uploadedBom(
  tx: Tx,
  lines: NonNullable<CreateJobInput["equipments"][number]["bomLines"]>,
  equipmentId: number,
  tenantId: number,
  jobId: number,
  createdBy: number,
): Promise<number> {
  const codes = [...new Set(lines.flatMap((l) => (l.componentType ? [l.componentType] : [])))];
  const known = await resolveComponentTypeCodes(tx, tenantId, codes);
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length > 0) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { unknown, reason: unrecognisedCodes(unknown) }, unrecognisedCodes(unknown));
  const revision = await tx.bomRevision.create({ data: { equipmentId, revisionNo: 1, status: "DRAFT", createdBy, jobId } });
  await tx.bomItem.createMany({
    data: lines.map(({ componentType, ...l }) => ({
      ...l,
      equipmentId,
      bomRevisionId: revision.id,
      jobId,
      componentTypeId: componentType ? (known.get(componentType) ?? null) : null,
    })),
  });
  return lines.length;
}

/**
 * J7a: copy a previous line's weld map. Only IMPORTED joints (GENERATED seams follow the new line's
 * own shell-courses answer at BOM release). Every copy is unconfirmed: the new job's QC or
 * Engineering confirms it again (J4b). Idempotent by (equipment, joint no) like the importer.
 */
async function copyWeldMap(tx: Tx, sourceEquipmentId: number, targetEquipmentId: number, tenantId: number, jobId: number): Promise<number> {
  const source = await tx.equipment.findFirst({ where: { id: sourceEquipmentId, job: { tenantId } }, select: { id: true } });
  if (!source) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Equipment", equipmentId: sourceEquipmentId });
  const joints = await tx.plannedJoint.findMany({ where: { equipmentId: sourceEquipmentId, source: "IMPORTED" }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
  if (joints.length === 0) return 0;
  const made = await tx.plannedJoint.createMany({
    data: joints.map((j) => ({
      jobId,
      equipmentId: targetEquipmentId,
      jointNo: j.jointNo,
      jointType: j.jointType,
      joins: j.joins,
      wpsRef: j.wpsRef,
      ndtExtent: j.ndtExtent,
      sortOrder: j.sortOrder,
      source: "IMPORTED" as const,
      confirmed: false,
    })),
    skipDuplicates: true,
  });
  return made.count;
}
