import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { WorkOrg } from "./work.test-util";

/**
 * Lean Core J4b, DB-gated: the weld-map importer and joint register. Violation cases first
 * (roles, client, other tenant, other job, stale file, type change on a welded joint), then
 * the behaviour: dry run, apply idempotent on (line, joint no), never delete, add from tags,
 * confirm, audit rows.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

const HEAD = ["Joint no", "Type", "Joins", "WPS", "NDT extent", "Remarks"];
function xlsx(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEAD, ...rows]), "Weld map");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

describe.skipIf(!RUN_DB)("J4b weld map (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { addJointsFromTags, applyWeldMap, confirmWeldMap, dryRunWeldMap, loadWeldMap } = await import("./weld-map.service");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  let eng: Actor;
  let head: Actor;
  let admin: Actor;
  let qc: Actor;
  let sup: Actor;
  let client: Actor;
  let bEng: Actor;

  beforeAll(async () => {
    o = await makeWorkOrg(owner, "J4BA");
    b = await makeWorkOrg(owner, "J4BB");
    eng = await o.user("eng", ["ENGINEERING"]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    admin = await o.user("admin", ["ADMIN"]);
    qc = await o.user("qc", ["QC"]);
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    client = { ...(await o.user("cli", ["ENGINEERING"])), clientId: 1 };
    bEng = await b.user("beng", ["ENGINEERING"]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  async function code(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? e.code : String(e);
    }
    return null;
  }
  /** A fresh job with one line and no joints. */
  async function fresh() {
    const j = await o.job({ units: 1 });
    return { jobId: j.job.id, equipmentId: j.equipment.id, t: { jobId: j.job.id, equipmentId: j.equipment.id } };
  }
  const audits = (action: string, equipmentId: number) => owner.auditLog.count({ where: { tenantId: o.tenantId, action, entityId: String(equipmentId) } });
  const nos = async (equipmentId: number) => (await owner.plannedJoint.findMany({ where: { equipmentId }, orderBy: { sortOrder: "asc" } })).map((j) => j.jointNo);
  /** Check then Load, as the screen does. */
  async function load(actor: Actor, t: { jobId: number; equipmentId: number }, bytes: Buffer) {
    const r = await dryRunWeldMap(actor, t, bytes);
    return applyWeldMap(actor, t, bytes, { expected: { fileSha256: r.fileSha256, planFingerprint: r.planFingerprint }, fileName: "wm.xlsx" });
  }

  describe("refusals", () => {
    const file = xlsx([["LS-1", null, "Course 1"]]);
    it.each<[string, () => Actor, string | null]>([
      ["engineering", () => eng, null],
      ["production head", () => head, null],
      ["admin", () => admin, null],
      ["QC cannot edit", () => qc, ERROR_CODES.FORBIDDEN],
      ["supervisor cannot edit", () => sup, ERROR_CODES.FORBIDDEN],
      ["client user", () => client, ERROR_CODES.FORBIDDEN],
    ])("check, add and load: %s", async (_n, who, expected) => {
      const { t } = await fresh();
      expect(await code(dryRunWeldMap(who(), t, file))).toBe(expected);
      expect(await code(addJointsFromTags(who(), { ...t, text: "N1", mode: "NOZZLES", withFlanges: false }))).toBe(expected);
      if (expected) {
        expect(await code(applyWeldMap(who(), t, file, { expected: { fileSha256: "0".repeat(64), planFingerprint: "0".repeat(64) }, fileName: "x.xlsx" }))).toBe(expected);
        expect(await nos(t.equipmentId)).toEqual([]);
      }
    });

    it.each<[string, () => Actor, string | null]>([
      ["QC", () => qc, null],
      ["engineering", () => eng, null],
      ["production head cannot confirm", () => head, ERROR_CODES.FORBIDDEN],
      ["admin cannot confirm", () => admin, ERROR_CODES.FORBIDDEN],
      ["supervisor cannot confirm", () => sup, ERROR_CODES.FORBIDDEN],
      ["client user", () => client, ERROR_CODES.FORBIDDEN],
    ])("confirm: %s", async (_n, who, expected) => {
      const { t } = await fresh();
      await addJointsFromTags(eng, { ...t, text: "N1", mode: "NOZZLES", withFlanges: false });
      expect(await code(confirmWeldMap(who(), t))).toBe(expected);
      const confirmed = await owner.plannedJoint.count({ where: { equipmentId: t.equipmentId, confirmed: true } });
      expect(confirmed).toBe(expected ? 0 : 1);
    });

    it("another tenant, and a line that belongs to another job, are not found", async () => {
      const a = await fresh();
      const other = await fresh();
      const bJob = await b.job({ units: 1 });
      expect(await code(dryRunWeldMap(bEng, a.t, file))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await code(addJointsFromTags(bEng, { ...a.t, text: "N1", mode: "NOZZLES", withFlanges: false }))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await code(confirmWeldMap(bEng, a.t))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await code(loadWeldMap(bEng, a.jobId))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await code(addJointsFromTags(eng, { jobId: a.jobId, equipmentId: other.equipmentId, text: "N1", mode: "NOZZLES", withFlanges: false }))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await code(addJointsFromTags(eng, { jobId: a.jobId, equipmentId: bJob.equipment.id, text: "N1", mode: "NOZZLES", withFlanges: false }))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await nos(a.equipmentId)).toEqual([]);
      expect(await nos(other.equipmentId)).toEqual([]);
    });

    it("a different file than the one checked, and a plan that changed since, are refused", async () => {
      const { t } = await fresh();
      const r = await dryRunWeldMap(eng, t, file);
      const other = xlsx([["LS-1", null, "Different"]]);
      expect(await code(applyWeldMap(eng, t, other, { expected: { fileSha256: r.fileSha256, planFingerprint: r.planFingerprint }, fileName: "x" }))).toBe(ERROR_CODES.VALIDATION_FAILED);
      await addJointsFromTags(eng, { ...t, text: "LS-1", mode: "JOINTS", withFlanges: false }); // someone added it meanwhile
      expect(await code(applyWeldMap(eng, t, file, { expected: { fileSha256: r.fileSha256, planFingerprint: r.planFingerprint }, fileName: "x" }))).toBe(ERROR_CODES.STALE_WRITE);
    });

    it("a file with no joint column cannot be loaded", async () => {
      const { t } = await fresh();
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "S");
      const bytes = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
      const r = await dryRunWeldMap(eng, t, bytes);
      expect(r.canApply).toBe(false);
      expect(r.issues[0].code).toBe("HEADER_NOT_FOUND");
    });

    it("a tag list that cannot be read adds nothing", async () => {
      const { t } = await fresh();
      expect(await code(addJointsFromTags(eng, { ...t, text: "N6-N1", mode: "NOZZLES", withFlanges: true }))).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(await code(addJointsFromTags(eng, { ...t, text: "  ", mode: "NOZZLES", withFlanges: true }))).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(await nos(t.equipmentId)).toEqual([]);
    });
  });

  describe("load", () => {
    it("adds IMPORTED, unconfirmed joints in file order with one audit row; the second load changes nothing", async () => {
      const { t } = await fresh();
      const bytes = xlsx([["LS-1", null, "Course 1", "WPS-1", "RT 100%"], ["NS-N1", "Nozzle", "N1 to shell", null, null], ["SK-1", null, "Skirt to head"]]);
      const r = await dryRunWeldMap(eng, t, bytes);
      expect(r.counts).toMatchObject({ add: 3, update: 0, same: 0, refused: 0 });
      expect(r.canApply).toBe(true);
      expect(await nos(t.equipmentId)).toEqual([]); // a check writes nothing
      expect(await load(eng, t, bytes)).toEqual({ added: 3, updated: 0, unchanged: 0 });
      expect(await nos(t.equipmentId)).toEqual(["LS-1", "NS-N1", "SK-1"]);
      const rows = await owner.plannedJoint.findMany({ where: { equipmentId: t.equipmentId }, orderBy: { sortOrder: "asc" } });
      expect(rows.map((j) => [j.jointType, j.source, j.confirmed, j.wpsRef])).toEqual([
        ["LONG_SEAM", "IMPORTED", false, "WPS-1"],
        ["NOZZLE", "IMPORTED", false, null],
        ["ATTACHMENT", "IMPORTED", false, null],
      ]);
      expect(await audits("weldMap.apply", t.equipmentId)).toBe(1);

      const again = await dryRunWeldMap(eng, t, bytes);
      expect(again.counts).toMatchObject({ add: 0, update: 0, same: 3 });
      expect(again.canApply).toBe(false);
      expect(await applyWeldMap(eng, t, bytes, { expected: { fileSha256: again.fileSha256, planFingerprint: again.planFingerprint }, fileName: "wm.xlsx" })).toEqual({ added: 0, updated: 0, unchanged: 3 });
      expect(await nos(t.equipmentId)).toEqual(["LS-1", "NS-N1", "SK-1"]);
      expect(await audits("weldMap.apply", t.equipmentId)).toBe(1);
    });

    it("never deletes: a joint missing from the next file stays and is reported; a blank cell keeps the old value", async () => {
      const { t } = await fresh();
      await load(eng, t, xlsx([["LS-1", null, "Course 1", "WPS-1"], ["CS-1", null, "Course 1 to 2"]]));
      const r = await dryRunWeldMap(eng, t, xlsx([["CS-1", null, null, "WPS-2"]]));
      expect(r.notInFile).toEqual(["LS-1"]);
      await load(eng, t, xlsx([["CS-1", null, null, "WPS-2"]]));
      expect(await nos(t.equipmentId)).toEqual(["LS-1", "CS-1"]);
      const cs = await owner.plannedJoint.findFirstOrThrow({ where: { equipmentId: t.equipmentId, jointNo: "CS-1" } });
      expect([cs.joins, cs.wpsRef]).toEqual(["Course 1 to 2", "WPS-2"]);
    });

    it("updates joins, WPS and NDT with before and after in the audit row, and a confirmed joint needs confirming again", async () => {
      const { t } = await fresh();
      await load(eng, t, xlsx([["LS-1", null, "Course 1", "WPS-1", "RT"], ["CS-1"]]));
      await confirmWeldMap(qc, t);
      expect(await owner.plannedJoint.count({ where: { equipmentId: t.equipmentId, confirmed: true } })).toBe(2);
      expect(await load(head, t, xlsx([["LS-1", null, "Course 1 rolled", "WPS-9", "RT 100%"], ["CS-1"]]))).toEqual({ added: 0, updated: 1, unchanged: 1 });
      const ls = await owner.plannedJoint.findFirstOrThrow({ where: { equipmentId: t.equipmentId, jointNo: "LS-1" } });
      expect([ls.joins, ls.wpsRef, ls.ndtExtent, ls.confirmed]).toEqual(["Course 1 rolled", "WPS-9", "RT 100%", false]);
      expect((await owner.plannedJoint.findFirstOrThrow({ where: { equipmentId: t.equipmentId, jointNo: "CS-1" } })).confirmed).toBe(true);
      const row = await owner.auditLog.findFirstOrThrow({ where: { tenantId: o.tenantId, action: "weldMap.apply", entityId: String(t.equipmentId) }, orderBy: { id: "desc" } });
      expect(row.before).toEqual([{ jointNo: "LS-1", joins: "Course 1", wpsRef: "WPS-1", ndtExtent: "RT", wasConfirmed: true }]);
      expect(row.after).toMatchObject({ updated: [{ jointNo: "LS-1", joins: "Course 1 rolled", wpsRef: "WPS-9", ndtExtent: "RT 100%", needsConfirming: true }] });
    });

    it("refuses a type change on a joint that has weld records, naming the joint; nothing is written", async () => {
      const { t, jobId } = await fresh();
      await load(eng, t, xlsx([["X-1", "Attachment", "Lug"], ["X-2", "Attachment", "Cleat"]]));
      const x1 = await owner.plannedJoint.findFirstOrThrow({ where: { equipmentId: t.equipmentId, jointNo: "X-1" } });
      await owner.weldJoint.create({ data: { jobId, jointNo: "X-1", jointType: "ATTACHMENT", loggedBy: eng.userId, plannedJointId: x1.id } });
      const bytes = xlsx([["X-1", "Nozzle", "Lug"], ["X-2", "Nozzle", "Cleat"], ["X-3"]]);
      const r = await dryRunWeldMap(eng, t, bytes);
      expect(r.canApply).toBe(false);
      expect(r.rows.find((x) => x.jointNo === "X-1")).toMatchObject({ action: "REFUSED" });
      expect(r.rows.find((x) => x.jointNo === "X-2")).toMatchObject({ action: "UPDATE" });
      let err: unknown;
      try {
        await applyWeldMap(eng, t, bytes, { expected: { fileSha256: r.fileSha256, planFingerprint: r.planFingerprint }, fileName: "x" });
      } catch (e) {
        err = e;
      }
      expect(isAppError(err) && err.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(isAppError(err) && err.detail).toMatchObject({ joint: "X-1" });
      expect(await owner.plannedJoint.count({ where: { equipmentId: t.equipmentId, jointType: "ATTACHMENT" } })).toBe(2);
      expect(await nos(t.equipmentId)).toEqual(["X-1", "X-2"]);
    });

    it("a joint number can repeat on another line of the same job", async () => {
      const { t, jobId } = await fresh();
      const second = await owner.equipment.create({ data: { jobId, name: "Second line" } });
      await load(eng, t, xlsx([["LS-1"]]));
      await load(eng, { jobId, equipmentId: second.id }, xlsx([["LS-1"]]));
      expect(await owner.plannedJoint.count({ where: { jobId, jointNo: "LS-1" } })).toBe(2);
    });
  });

  describe("add from tags", () => {
    it("N1-N3 becomes NS- and NF- pairs, unconfirmed, once; adding again adds nothing", async () => {
      const { t } = await fresh();
      const r = await addJointsFromTags(eng, { ...t, text: "N1-N3", mode: "NOZZLES", withFlanges: true });
      expect(r.added).toEqual(["NS-N1", "NF-N1", "NS-N2", "NF-N2", "NS-N3", "NF-N3"]);
      const rows = await owner.plannedJoint.findMany({ where: { equipmentId: t.equipmentId } });
      expect(rows.every((j) => j.jointType === "NOZZLE" && !j.confirmed && j.source === "IMPORTED")).toBe(true);
      expect(await audits("weldMap.addFromTags", t.equipmentId)).toBe(1);
      const again = await addJointsFromTags(eng, { ...t, text: "N1-N4", mode: "NOZZLES", withFlanges: true });
      expect(again.added).toEqual(["NS-N4", "NF-N4"]);
      expect(again.alreadyThere).toHaveLength(6);
      const none = await addJointsFromTags(eng, { ...t, text: "N1-N4", mode: "NOZZLES", withFlanges: true });
      expect(none.added).toEqual([]);
      expect(await audits("weldMap.addFromTags", t.equipmentId)).toBe(2);
      expect(await owner.plannedJoint.count({ where: { equipmentId: t.equipmentId } })).toBe(8);
    });

    it("joint numbers are kept as typed, with a type and a Joins text from the prefix, after the existing joints", async () => {
      const { t } = await fresh();
      await load(eng, t, xlsx([["LS-1"]]));
      await addJointsFromTags(head, { ...t, text: "SK-1, GW-1…GW-3", mode: "JOINTS", withFlanges: false });
      expect(await nos(t.equipmentId)).toEqual(["LS-1", "SK-1", "GW-1", "GW-2", "GW-3"]);
      const gw = await owner.plannedJoint.findFirstOrThrow({ where: { equipmentId: t.equipmentId, jointNo: "GW-2" } });
      expect([gw.jointType, gw.joins]).toEqual(["ATTACHMENT", "Gusset"]);
    });
  });

  describe("confirm", () => {
    it("confirms every unconfirmed joint of the line, or just the named ones, and not another line's", async () => {
      const { t, jobId } = await fresh();
      const second = await owner.equipment.create({ data: { jobId, name: "Second line" } });
      const t2 = { jobId, equipmentId: second.id };
      await addJointsFromTags(eng, { ...t, text: "N1-N3", mode: "NOZZLES", withFlanges: false });
      await addJointsFromTags(eng, { ...t2, text: "N1", mode: "NOZZLES", withFlanges: false });
      const mine = await owner.plannedJoint.findMany({ where: { equipmentId: t.equipmentId }, orderBy: { id: "asc" } });
      const theirs = await owner.plannedJoint.findFirstOrThrow({ where: { equipmentId: second.id } });
      expect(await code(confirmWeldMap(qc, { ...t, jointIds: [theirs.id] }))).toBe(ERROR_CODES.NOT_FOUND);
      expect((await confirmWeldMap(qc, { ...t, jointIds: [mine[0].id] })).confirmed).toEqual(["NS-N1"]);
      expect((await confirmWeldMap(qc, t)).confirmed).toEqual(["NS-N2", "NS-N3"]);
      expect((await confirmWeldMap(qc, t)).confirmed).toEqual([]);
      expect((await owner.plannedJoint.findFirstOrThrow({ where: { equipmentId: second.id } })).confirmed).toBe(false);
      expect(await audits("weldMap.confirm", t.equipmentId)).toBe(2);
    });
  });

  describe("register", () => {
    it("lists joints with their use, flags a joint type the line's steps need and the map lacks", async () => {
      const j = await o.job({ units: 1 });
      const asm = await owner.assemblyTemplate.create({ data: { tenantId: o.tenantId, familyId: o.family.id, name: o.uniq("A") } });
      const av = await owner.assemblyTemplateVersion.create({ data: { templateId: asm.id, version: 1, status: "PUBLISHED", publishedAt: new Date() } });
      await owner.assemblyTemplateStep.create({
        data: { versionId: av.id, seq: 1, groupCode: "A", groupName: "A", srNo: "1", activity: "Weld nozzle", kind: "WORK", defaultDepartmentId: o.fab.id, scope: "PER_JOINT", jointType: "NOZZLE" },
      });
      await owner.equipment.update({ where: { id: j.equipment.id }, data: { assemblyTemplateVersionId: av.id } });
      const t = { jobId: j.job.id, equipmentId: j.equipment.id };
      await addJointsFromTags(eng, { ...t, text: "LS-1", mode: "JOINTS", withFlanges: false });

      let v = await loadWeldMap(sup, j.job.id);
      expect(v.canEdit).toBe(false);
      expect(v.canConfirm).toBe(false);
      expect(v.lines[0].notices).toEqual(["No nozzle joints on the weld map: nozzle weld steps will not be created."]);
      expect(v.lines[0].joints).toMatchObject([{ jointNo: "LS-1", confirmed: false, steps: 0, welds: 0 }]);

      await addJointsFromTags(eng, { ...t, text: "N1", mode: "NOZZLES", withFlanges: false });
      v = await loadWeldMap(eng, j.job.id);
      expect(v.canEdit).toBe(true);
      expect(v.canConfirm).toBe(true);
      expect(v.lines[0].notices).toEqual([]);
    });
  });
});
