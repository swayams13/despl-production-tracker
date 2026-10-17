import { describe, expect, it } from "vitest";
import { item, iso, sheet } from "./job-import.fixtures";
import {
  buildImportPlan,
  capIssues,
  parseTrackerGrid,
  readDate,
  type BlockTarget,
  type Cell,
  type ExistingBom,
  type Issue,
} from "./job-import";

describe("L2.10 tracker parse", () => {
  it("finds the header by name and reads the title block", () => {
    const p = parseTrackerGrid(sheet([item(1, "SHELL")]));
    expect(p.header).toMatchObject({ workOrderNo: "DE0455-01", projectName: 'PRESSURE PIPE 8"', qtyText: "QTY-05 NOS." });
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0].items[0]).toMatchObject({ itemNo: 1, partName: "SHELL", qty: "1", unit: "NOS" });
  });

  it("a numbering restart starts a new block; an unlabelled block is flagged", () => {
    const p = parseTrackerGrid(sheet([item(1, "A"), item(2, "B"), [], item(1, "C"), item(2, "D"), item(3, "E")]));
    expect(p.blocks.map((b) => b.items.length)).toEqual([2, 3]);
    expect(p.issues.filter((i) => i.code === "UNLABELLED_BLOCK")).toHaveLength(2);
  });

  it("keeps a block label the sheet did have", () => {
    const p = parseTrackerGrid(sheet([["VESSEL V-101"], item(1, "A"), [], ["NOZZLES"], item(1, "B")]));
    expect(p.blocks.map((b) => b.label)).toEqual(["VESSEL V-101", "NOZZLES"]);
    expect(p.issues.some((i) => i.code === "UNLABELLED_BLOCK")).toBe(false);
  });

  it("reads procurement dates from real date cells and day-first text", () => {
    const p = parseTrackerGrid(
      sheet([item(1, "A", { "Indent No.": "I1", "Indent Generate Date": iso("2026-07-13"), "PO No.": "P1", "PO Date": "24.07.2026", "Material Received Date": "13/7/2026" })]),
    );
    expect(p.blocks[0].items[0].procurement).toMatchObject({
      indentNo: "I1", indentGenerateDate: "2026-07-13", poNo: "P1", poDate: "2026-07-24", receivedDate: "2026-07-13",
    });
  });

  it("reads manufacturing and test columns as steps, only when they carry a value", () => {
    const p = parseTrackerGrid(
      sheet([item(1, "A", { "Cutting Type": "In-house", "Cutting Start": iso("2026-07-17"), "Set-up Type": "N/A", "RT Result": "Accepted" }), item(2, "B")]),
    );
    const [a, b] = p.blocks[0].items;
    expect(a.steps.map((s) => s.name)).toEqual(["Cutting", "Set-up", "RT"]);
    expect(a.steps[0]).toMatchObject({ type: "In-house", start: "2026-07-17", end: null });
    expect(a.steps[2].result).toBe("Accepted");
    expect(b.steps).toEqual([]);
  });

  it("no header row is a hard error", () => {
    const p = parseTrackerGrid([["hello"], ["world"]]);
    expect(p.issues[0]).toMatchObject({ severity: "ERROR", code: "HEADER_NOT_FOUND" });
    expect(p.blocks).toEqual([]);
  });

  it("reads the drawings and assembly processes sections below the items", () => {
    const p = parseTrackerGrid(
      sheet([item(1, "A")], [
        [],
        ["ASSEMBLY DRAWINGS (Applied to Final Assembly)"],
        ["Drawing Name", "Drawing No.", "Approval Date", "Released Date", "Revised Date", "Rev No."],
        ["Assembly Drawing"],
        ["General Arrangement (GA) Drawing", "DE0463-001", "28.07.2026", "28.07.2026", null, 2],
        ["Weld Map / WPS Drawing"],
        [],
        ["ASSEMBLY PROCESSES (Applied to Final Assembly)"],
        ["Process Name", "Type", "Start Date", "End Date"],
        ["Radiographic Testing (RT)", "Outsource", "01.08.2026", null],
        ["Vacuum Test"],
      ]),
    );
    expect(p.drawings).toEqual([{ row: 11, name: "General Arrangement (GA) Drawing", ref: "DE0463-001", dates: ["2026-07-28", "2026-07-28"] }]);
    expect(p.assemblyProcesses.map((x) => [x.name, x.ref, x.dates])).toEqual([["Radiographic Testing (RT)", "Outsource", ["2026-08-01"]]]);
    // the drawing's "Rev No." is a number, not a date, and raised no warning
    expect(p.issues.some((i) => i.code === "DATE_UNREADABLE")).toBe(false);
  });
});

describe("L2.10 dates", () => {
  const dates = (c: Cell) => {
    const issues: Issue[] = [];
    return { value: readDate(c, 7, "Date", issues), issues };
  };
  it("a real date is exact", () => expect(dates(iso("2026-02-28")).value).toBe("2026-02-28"));
  it("day.month.year and day-first with a slash", () => {
    expect(dates("24.06.2026").value).toBe("2026-06-24");
    expect(dates("13/07/2026").value).toBe("2026-07-13");
  });
  it("month/day when only that reading is possible", () => expect(dates("7/13/26").value).toBe("2026-07-13"));
  it("an ambiguous slash date is read day first and flagged", () => {
    const r = dates("7/8/2026");
    expect(r.value).toBe("2026-08-07");
    expect(r.issues[0]).toMatchObject({ severity: "WARNING", code: "AMBIGUOUS_DATE", row: 7 });
  });
  it("not a real date, a number and free text are left out with a warning", () => {
    for (const c of ["31.02.2026", 46216, "next week"] as Cell[]) {
      const r = dates(c);
      expect(r.value).toBeNull();
      expect(r.issues[0].code).toBe("DATE_UNREADABLE");
    }
  });
  it("empty is just empty", () => {
    expect(dates(null)).toEqual({ value: null, issues: [] });
    expect(dates("")).toEqual({ value: null, issues: [] });
  });
});

describe("L2.10 plan", () => {
  const sample = () =>
    parseTrackerGrid(
      sheet([
        item(1, "DN-24 PIPE", {
          "Indent No.": "I1", "Indent Generate Date": iso("2026-07-13"), "Indent Approved Date": iso("2026-07-14"), "PO No.": "P1", "PO Date": iso("2026-07-15"),
          "Material Received Status": "Received", "Material Received Date": iso("2026-07-20"), "Procurement Status": "PO Placed", Qty: "2",
          "Cutting Start": iso("2026-07-17"), "Material Identification": "In-house",
        }),
        item(2, "DISH END", { "Material Received Status": "Partially Received", "Material Received Date": iso("2026-07-21") }),
        item(3, "NAME PLATE", { Qty: null }),
        item(4, "BRACKET", { "Material Received Status": "Received", "Indent No.": "I9", "PO No.": "P9" }),
        [],
        item(1, "TEE"),
      ]),
    );
  const targets = (m: Array<[number, BlockTarget]>) => new Map(m);

  it("plans events from procurement dates; a full receipt carries the quantity", () => {
    const { plan } = buildImportPlan(sample(), targets([[1, { newName: "V-101" }], [2, { newName: "TEES" }]]), new Map());
    const first = plan.items[0];
    expect(first.action).toBe("CREATE");
    expect(first.events.map((e) => [e.type, e.on, e.refNo, e.qty])).toEqual([
      ["INDENT_RAISED", "2026-07-13", "I1", null],
      ["INDENT_APPROVED", "2026-07-14", null, null],
      ["PO_PLACED", "2026-07-15", "P1", null],
      ["RECEIPT", "2026-07-20", null, 2],
    ]);
    expect(first.data).toMatchObject({ sourceQty: "2", qtyPer: 2, remarks: "Tracker status: PO Placed" });
    expect(plan.items[1].events[0]).toMatchObject({ type: "RECEIPT", qty: null }); // partial: no quantity guessed
  });

  it("never makes up a date: received / indent / PO without a date record nothing and warn", () => {
    const { plan, issues } = buildImportPlan(sample(), targets([[1, { newName: "V-101" }], [2, { newName: "TEES" }]]), new Map());
    expect(plan.items[3].events).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["RECEIVED_WITHOUT_DATE", "INDENT_WITHOUT_DATE", "PO_WITHOUT_DATE"]));
  });

  it("an item with no quantity is skipped, the rest still load", () => {
    const { plan } = buildImportPlan(sample(), targets([[1, { newName: "V-101" }], [2, { newName: "TEES" }]]), new Map());
    expect(plan.items.map((i) => i.action)).toEqual(["CREATE", "CREATE", "SKIP_ERROR", "CREATE", "CREATE"]);
    expect(plan.counts).toMatchObject({ blocks: 2, items: 5, create: 4, errors: 1, exists: 0, conflict: 0, events: 5 });
  });

  it("names the new equipment once per block", () => {
    const { plan } = buildImportPlan(sample(), targets([[1, { newName: "V-101" }], [2, { newName: "TEES" }]]), new Map());
    expect(plan.newEquipment).toEqual([{ blockNo: 1, name: "V-101" }, { blockNo: 2, name: "TEES" }]);
  });

  it("is safe to run twice: an item already there is left alone, a different part under the same number is a conflict", () => {
    const existing: ExistingBom = new Map([[10, new Map([[1, { partName: "dn-24  pipe" }], [2, { partName: "SOMETHING ELSE" }]])]]);
    const { plan, issues } = buildImportPlan(sample(), targets([[1, { equipmentId: 10 }], [2, { newName: "TEES" }]]), existing);
    expect(plan.items.slice(0, 2).map((i) => i.action)).toEqual(["SKIP_EXISTS", "SKIP_CONFLICT"]);
    expect(plan.items[0].events).toEqual([]);
    expect(plan.newEquipment).toEqual([{ blockNo: 2, name: "TEES" }]);
    expect(issues.find((i) => i.code === "ITEM_CONFLICT")?.message).toContain("SOMETHING ELSE");
    expect(issues.some((i) => i.code === "ITEM_EXISTS")).toBe(true);
  });

  it("says what was read but not loaded", () => {
    const { plan, issues } = buildImportPlan(sample(), targets([[1, { newName: "V-101" }], [2, { newName: "TEES" }]]), new Map());
    expect(plan.carried).toMatchObject({ itemsWithSteps: 1, stepEntries: 1, materialIdentifications: 1 });
    expect(issues.find((i) => i.code === "NOT_IMPORTED")?.message).toMatch(/upload this file again/);
  });
});

describe("L2.10 issue cap", () => {
  it("keeps the first 25 of a code and counts the rest", () => {
    const many: Issue[] = Array.from({ length: 31 }, (_, i) => ({ severity: "WARNING", code: "AMBIGUOUS_DATE", row: i + 1, message: `m${i}` }));
    const out = capIssues(many);
    expect(out).toHaveLength(26);
    expect(out[25].message).toMatch(/and 6 more/);
  });
});
