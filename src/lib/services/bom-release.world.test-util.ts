/**
 * J5c test fixture: a disposable tenant with a family, an approved part type with routes, an assembly sequence and a
 * QC plan, plus `job()` (createJob + a DRAFT revision 1 holding the given BOM lines). Copied from the J5a
 * bom-release.test.ts fixture so the J5c tests can share it. Test-only (imported by *.test.ts).
 */
import type { PrismaClient } from "@/generated/prisma/client";

export function makeWorldKit(owner: PrismaClient) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;
  const pwht = { all: [{ key: "pwht", op: "truthy" }] };
  const bump = () => ++n;
  type Bom = { itemNo: number; partName: string; typeId?: number | null; variant?: string | null; qtyPer?: number };

  /** A disposable tenant: family, route, assembly sequence, QC plan, approved/draft/raw part types with routes. */
  async function world(label: string) {
    const { ROLES } = await import("@/lib/authz");
    const { createJob } = await import("./job-intake.service");
    const org = await owner.organization.create({ data: { code: `TEST-J5A-${label}-${stamp}-${bump()}`, name: `j5a ${label}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const mkUser = (name: string) =>
      owner.user.create({ data: { tenantId, email: `${uniq("u")}@test.local`, username: uniq("u"), passwordHash: "x", name, mustChangePassword: false } });
    const [admin, eng, sj, planner, qc, sup, clientU] = await Promise.all(["Admin", "Eng", "SJ", "Planner", "QC", "Sup", "ClientU"].map(mkUser));
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    await owner.templateProcess.create({ data: { versionId: tv.id, seq: 1, code: "10", name: "P10", defaultDepartmentId: dept.id } });
    await owner.configQuestion.create({ data: { tenantId, familyId: family.id, key: "pwht", label: "PWHT", type: "BOOLEAN" } });

    // part types: an approved pressure part, an unapproved one, a raw form
    const mkType = (code: string, kind: "PART_FAMILY" | "RAW_FORM", status?: "APPROVED" | "DRAFT") =>
      owner.componentTypeRef.create({ data: { tenantId, code, name: code === "SHL" ? "Shell course" : code, kind } }).then(async (t) => {
        if (status) await owner.partFamily.create({ data: { tenantId, componentTypeId: t.id, status, pressureRetaining: code === "SHL", approvedById: status === "APPROVED" ? sj.id : null, approvedAt: status === "APPROVED" ? new Date() : null } });
        return t;
      });
    const shl = await mkType("SHL", "PART_FAMILY", "APPROVED");
    const drf = await mkType("DRF", "PART_FAMILY", "DRAFT");
    const plt = await mkType("PLT", "RAW_FORM");
    const opCut = await owner.operationRef.create({ data: { tenantId, code: "CUTTING", name: "Cutting", defaultDepartmentId: dept.id } });
    const opWeld = await owner.operationRef.create({ data: { tenantId, code: "WELDING", name: "Welding", defaultDepartmentId: dept.id } });
    const route = async (typeId: number, variant: string, steps: { seq: number; op: number; includeWhen?: unknown }[], publish = true) => {
      const r = await owner.routeTemplate.create({ data: { tenantId, componentTypeId: typeId, familyId: family.id, name: `${variant}`, variant } });
      if (!publish) return r;
      const v = await owner.routeTemplateVersion.create({ data: { routeId: r.id, version: 1, status: "PUBLISHED" } });
      for (const s of steps) await owner.routeStep.create({ data: { routeVersionId: v.id, seq: s.seq, operationId: s.op, includeWhen: s.includeWhen as never } });
      return r;
    };
    await route(shl.id, "A", [{ seq: 10, op: opCut.id }, { seq: 20, op: opWeld.id, includeWhen: pwht }]);
    await route(shl.id, "B", [{ seq: 10, op: opCut.id }]);
    await route(shl.id, "C", [], false); // a variant with no published version
    await route(plt.id, "A", [{ seq: 10, op: opCut.id }]);
    await route(drf.id, "A", [{ seq: 10, op: opCut.id }]);

    // assembly sequence: per unit, per nozzle joint, per shell component, one inspection, one rule-gated step
    const at = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "Seq" } });
    const av = await owner.assemblyTemplateVersion.create({ data: { templateId: at.id, version: 1, status: "PUBLISHED", publishedAt: new Date() } });
    const step = (seq: number, srNo: string, activity: string, extra: Record<string, unknown> = {}) => ({
      versionId: av.id, seq, groupCode: "A", groupName: "A", srNo, activity, kind: "WORK" as const, defaultDepartmentId: dept.id, ...extra,
    });
    await owner.assemblyTemplateStep.createMany({
      data: [
        step(1, "1", "Mark out"),
        step(2, "2", "Weld nozzle", { scope: "PER_JOINT", jointType: "NOZZLE", role: "WELD", pressurePart: true }),
        step(3, "3", "Fit shell course", { scope: "PER_COMPONENT", componentTypeId: shl.id }),
        step(4, "5", "Final inspection", { kind: "INSPECTION", qcpSrNo: "5" }),
        step(5, "6", "Post heat treatment check", { includeWhen: pwht as never }),
      ],
    });
    const qcp = await owner.qcpTemplate.create({ data: { tenantId, jobLabel: "LIB", vessel: "V" } });
    await owner.qcpItem.create({ data: { tenantId, qcpTemplateId: qcp.id, sequence: 1, srNo: "5", kind: "CHECKPOINT", activity: "qcp 5" } });

    const mk = (u: { id: number; email: string }, roles: string[], clientId: number | null = null) =>
      ({ userId: u.id, tenantId, clientId, name: "x", email: u.email, roles: roles as never, departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false }) as never;
    const actors = {
      admin: mk(admin, [ROLES.ADMIN]),
      eng: mk(eng, [ROLES.ENGINEERING]),
      sj: mk(sj, [ROLES.PRODUCTION_HEAD]),
      planner: mk(planner, [ROLES.PLANNER]),
      qc: mk(qc, [ROLES.QC]),
      sup: mk(sup, [ROLES.SUPERVISOR]),
      client: mk(clientU, [ROLES.CLIENT_VIEWER], client.id),
    };

    /** A job with one line and a DRAFT revision 1 carrying the given BOM lines. */
    async function job(opts: { units?: number; config?: Record<string, unknown> | null; withQcp?: boolean; bom?: Bom[]; equipmentTypeId?: number | null } = {}) {
      const units = opts.units ?? 2;
      const r = await createJob(actors.admin, {
        clientId: client.id, familyId: family.id, templateVersionId: tv.id, calendarId: null, jobNumber: uniq("J5A"),
        clientOrderNo: null, projectName: null, poRef: null, designCode: null, orderDate: null, committedDeliveryDate: null,
        targetDispatchDate: null, priority: "NORMAL", remarks: null, excludedProcessCodes: [], exclusionReason: null,
        equipments: [{ equipmentTypeId: opts.equipmentTypeId ?? null, name: "Vessel", blockNo: 1, remarks: null, config: opts.config ?? null, serials: Array.from({ length: units }, (_, i) => `S${i + 1}-${n}`) }],
        qcpTemplateSourceId: opts.withQcp === false ? null : qcp.id,
        copyBomFromEquipmentId: null,
      } as never);
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
      const rev = await owner.bomRevision.create({ data: { equipmentId: eq.id, revisionNo: 1, status: "DRAFT", jobId: r.jobId } });
      const items = [];
      for (const b of opts.bom ?? []) {
        items.push(await owner.bomItem.create({
          data: { jobId: r.jobId, equipmentId: eq.id, bomRevisionId: rev.id, itemNo: b.itemNo, partName: b.partName, sourceQty: `${b.qtyPer ?? 1} NOS.`, qtyPer: b.qtyPer ?? 1, uom: "NOS.", componentTypeId: b.typeId ?? null, routeVariant: b.variant ?? null },
        }));
      }
      return { jobId: r.jobId, equipmentId: eq.id, revisionId: rev.id, items, target: { equipmentId: eq.id, bomRevisionId: rev.id } };
    }
    return { tenantId, org, family, shl, drf, plt, opCut, opWeld, qcp, actors, job, tv, dept, av };
  }
  return { world, uniq, stamp };
}
