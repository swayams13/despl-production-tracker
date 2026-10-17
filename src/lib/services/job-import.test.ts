import { afterAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { HEADERS, GROUP_ROW, item, sheet } from "@/lib/shared/job-import.fixtures";
import type { Cell } from "@/lib/shared/job-import";

/**
 * Lean Core L2.10 part A, DB-gated: check then load a tracker sheet into a job.
 * Real .xlsx bytes go through the real reader. Disposable orgs per test group.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

/** A grid to .xlsx bytes. A `{iso}` cell becomes a real Excel date. */
function xlsxOf(grid: Cell[][]): Buffer {
  const ws: XLSX.WorkSheet = {};
  grid.forEach((r, ri) =>
    r.forEach((c, ci) => {
      if (c == null) return;
      const ref = XLSX.utils.encode_cell({ r: ri, c: ci });
      if (typeof c === "object") {
        const [y, m, d] = c.iso.split("-").map(Number);
        ws[ref] = { t: "n", v: Math.round(Date.UTC(y, m - 1, d) / 86_400_000) + 25569, z: "m/d/yy" };
      } else if (typeof c === "number") ws[ref] = { t: "n", v: c };
      else ws[ref] = { t: "s", v: String(c) };
    }),
  );
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: grid.length - 1, c: HEADERS.length - 1 } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "in");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const iso = (d: string): Cell => ({ iso: d });

const GOOD = () =>
  xlsxOf(
    sheet([
      item(1, "DN-24 PIPE", { "Indent No.": "I1", "Indent Generate Date": iso("2026-07-13"), "PO No.": "P1", "PO Date": "15.07.2026", "Material Received Status": "Received", "Material Received Date": iso("2026-07-20"), Qty: "2" }),
      item(2, "DISH END"),
      item(3, "NAME PLATE", { Qty: null }),
      [],
      item(1, "TEE"),
    ]),
  );

describe("L2.10 job import is for planning and engineering roles", () => {
  it("grid sanity", () => expect(GROUP_ROW.length).toBe(HEADERS.length));
});

describe.skipIf(!RUN_DB)("L2.10 tracker import (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { dryRunTrackerImport, applyTrackerImport } = await import("./job-import.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  afterAll(() => owner.$disconnect());

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  async function fixture(label: string) {
    const org = await owner.organization.create({ data: { code: `L210-${label}-${stamp}`, name: `l210 ${label}` } });
    const user = await owner.user.create({ data: { tenantId: org.id, email: `u-${label}-${stamp}@despl.test`, username: `u-${label}-${stamp}`, name: "Planner", passwordHash: "x" } });
    const client = await owner.client.create({ data: { tenantId: org.id, name: "ACME", code: `ACME-${label}-${stamp}` } });
    const family = await owner.productFamily.create({ data: { tenantId: org.id, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId: org.id, familyId: family.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: { tenantId: org.id, publicId: `pub-l210-${label}-${stamp}`, clientId: client.id, familyId: family.id, templateVersionId: tv.id, jobNumber: `DE0467-${label}-${stamp}` },
    });
    const actor = (roles: Array<"ADMIN" | "PLANNER" | "PRODUCTION_HEAD" | "OPERATOR">, clientId: number | null = null) => ({
      userId: user.id, tenantId: org.id, clientId, name: "Planner", email: user.email, roles, departmentIds: [],
      mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false,
    });
    return { orgId: org.id, jobId: job.id, jobNumber: job.jobNumber, userId: user.id, clientId: client.id, actor };
  }

  it("check reads the sheet, plans one new equipment per block and writes nothing", async () => {
    const f = await fixture("check");
    const r = await dryRunTrackerImport(f.actor(["PLANNER"]), f.jobId, GOOD(), null);
    expect(r.canApply).toBe(true);
    expect(r.blocks.map((b) => b.target)).toEqual([{ newName: `${f.jobNumber}-B1` }, { newName: `${f.jobNumber}-B2` }]);
    expect(r.counts).toMatchObject({ blocks: 2, items: 4, create: 3, errors: 1, events: 3 });
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["QTY_MISSING", "UNLABELLED_BLOCK", "JOB_NUMBER_MISMATCH"]));
    expect(await owner.equipment.count({ where: { jobId: f.jobId } })).toBe(0);
    expect(await owner.bomItem.count({ where: { jobId: f.jobId } })).toBe(0);
  });

  it("load writes equipment, items and events with the sheet's dates, audited once", async () => {
    const f = await fixture("load");
    const bytes = GOOD();
    const choices = [{ blockNo: 1, newName: "VESSEL V-101" }];
    const checked = await dryRunTrackerImport(f.actor(["PLANNER"]), f.jobId, bytes, choices);
    const r = await applyTrackerImport(f.actor(["PLANNER"]), f.jobId, bytes, choices, {
      expected: { fileSha256: checked.fileSha256, planFingerprint: checked.planFingerprint },
      fileName: "DESPL(DE0467).xlsx",
    });
    expect(r.written).toEqual({ equipment: 2, items: 3, events: 3 });
    const eq = await owner.equipment.findMany({ where: { jobId: f.jobId }, orderBy: { blockNo: "asc" } });
    expect(eq.map((e) => [e.name, e.blockNo])).toEqual([["VESSEL V-101", 1], [`${f.jobNumber}-B2`, 2]]);
    const items = await owner.bomItem.findMany({ where: { jobId: f.jobId }, orderBy: { id: "asc" } });
    expect(items.map((i) => [i.itemNo, i.partName, i.sourceQty, i.blockNo])).toEqual([[1, "DN-24 PIPE", "2", 1], [2, "DISH END", "1", 1], [1, "TEE", "1", 2]]);
    const ev = await owner.procurementEvent.findMany({ where: { jobId: f.jobId }, orderBy: { id: "asc" } });
    const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    expect(ev.map((e) => [e.type, day(e.at), e.refNo, e.by])).toEqual([
      ["INDENT_RAISED", "2026-07-13", "I1", f.userId],
      ["PO_PLACED", "2026-07-15", "P1", f.userId],
      ["RECEIPT", "2026-07-20", null, f.userId],
    ]);
    expect(await owner.auditLog.count({ where: { tenantId: f.orgId, action: "jobImport.apply", entityId: String(f.jobId) } })).toBe(1);
  });

  it("is safe to load twice: the second check shows everything as already there and a second load refuses", async () => {
    const f = await fixture("twice");
    const bytes = GOOD();
    const a = f.actor(["ADMIN"]);
    const c1 = await dryRunTrackerImport(a, f.jobId, bytes, null);
    await applyTrackerImport(a, f.jobId, bytes, null, { expected: { fileSha256: c1.fileSha256, planFingerprint: c1.planFingerprint }, fileName: "x.xlsx" });
    // the same default names now collide with the equipment just created: pick them from the list
    const eq = await owner.equipment.findMany({ where: { jobId: f.jobId }, orderBy: { blockNo: "asc" } });
    const choices = eq.map((e) => ({ blockNo: e.blockNo!, equipmentId: e.id }));
    const c2 = await dryRunTrackerImport(a, f.jobId, bytes, choices);
    expect(c2.counts).toMatchObject({ create: 0, exists: 3, errors: 1 });
    expect(c2.canApply).toBe(false);
    await expect(
      applyTrackerImport(a, f.jobId, bytes, choices, { expected: { fileSha256: c2.fileSha256, planFingerprint: c2.planFingerprint }, fileName: "x.xlsx" }),
    ).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/nothing to load/i) } });
    expect(await owner.bomItem.count({ where: { jobId: f.jobId } })).toBe(3);
  });

  it("refuses a different file, and a plan that changed since the check", async () => {
    const f = await fixture("stale");
    const a = f.actor(["PRODUCTION_HEAD"]);
    const bytes = GOOD();
    const c = await dryRunTrackerImport(a, f.jobId, bytes, null);
    await expect(
      applyTrackerImport(a, f.jobId, xlsxOf(sheet([item(1, "OTHER")])), null, { expected: { fileSha256: c.fileSha256, planFingerprint: c.planFingerprint }, fileName: "x.xlsx" }),
    ).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/not the file that was checked/i) } });

    // someone adds an equipment called like the default name between the check and the load
    await owner.equipment.create({ data: { jobId: f.jobId, name: `${f.jobNumber}-B1`, blockNo: 1 } });
    await expect(
      applyTrackerImport(a, f.jobId, bytes, null, { expected: { fileSha256: c.fileSha256, planFingerprint: c.planFingerprint }, fileName: "x.xlsx" }),
    ).rejects.toBeTruthy();
    expect(await owner.bomItem.count({ where: { jobId: f.jobId } })).toBe(0);
  });

  it("maps a block to an existing equipment and flags a part that disagrees", async () => {
    const f = await fixture("map");
    const eq = await owner.equipment.create({ data: { jobId: f.jobId, name: "V-1", blockNo: 1 } });
    await owner.bomItem.create({ data: { jobId: f.jobId, equipmentId: eq.id, itemNo: 1, partName: "A DIFFERENT PART", sourceQty: "1" } });
    const r = await dryRunTrackerImport(f.actor(["PLANNER"]), f.jobId, GOOD(), [{ blockNo: 1, equipmentId: eq.id }, { blockNo: 2, newName: "TEES" }]);
    expect(r.items.map((i) => i.action)).toEqual(["SKIP_CONFLICT", "CREATE", "SKIP_ERROR", "CREATE"]);
    expect(r.issues.find((i) => i.code === "ITEM_CONFLICT")?.message).toContain("A DIFFERENT PART");
    await expect(dryRunTrackerImport(f.actor(["PLANNER"]), f.jobId, GOOD(), [{ blockNo: 2, newName: "v-1" }])).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/already has equipment called/i) } });
    await expect(dryRunTrackerImport(f.actor(["PLANNER"]), f.jobId, GOOD(), [{ blockNo: 1, equipmentId: 999999999 }])).rejects.toMatchObject({ detail: { reason: expect.stringMatching(/not in this job/i) } });
  });

  it("a file that is not a tracker is reported, not loaded", async () => {
    const f = await fixture("junk");
    const r = await dryRunTrackerImport(f.actor(["PLANNER"]), f.jobId, xlsxOf([["hello", "world"]]), null);
    expect(r.canApply).toBe(false);
    expect(r.issues[0]).toMatchObject({ severity: "ERROR", code: "HEADER_NOT_FOUND" });
  });

  it("only planning, engineering-side roles; never a client user; never another tenant's job", async () => {
    const f = await fixture("authz");
    const other = await fixture("authz-other");
    await expect(dryRunTrackerImport(f.actor(["OPERATOR"]), f.jobId, GOOD(), null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(dryRunTrackerImport(f.actor(["PLANNER"], f.clientId), f.jobId, GOOD(), null)).rejects.toBeTruthy();
    await expect(dryRunTrackerImport(f.actor(["PLANNER"]), other.jobId, GOOD(), null)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
