import { describe, expect, it } from "vitest";
import { ISSUE_CODES } from "@/lib/services/master-import.rules";
import type { DryRunReport } from "@/lib/services/master-import.service";
import {
  confirmBlockedReason, groupIssues, ISSUE_TITLES, issuesToCsv, nothingToWrite, noPartLoads, severityCounts, whatWillLoad,
} from "./_import-model";

const tally = (create = 0, update = 0, unchanged = 0, skipped = 0) => ({ create, update, unchanged, skipped });
function report(over: Partial<DryRunReport> = {}): DryRunReport {
  return {
    fileSha256: "a".repeat(64), planFingerprint: "b".repeat(64), allowDraft: true, sheets: [],
    counts: { parts: 2, routeSteps: 4, materialGrades: 1, heStages: 0, assemblyRows: 0, newOperations: 0, reviewActions: 0, exampleRowsSkipped: 0 },
    plan: {
      partFamilies: tally(2), routes: tally(2), stageMappingRows: 4, materialGrades: tally(1),
      heStages: { loadable: false, stages: 0, existingTemplates: 0, outcome: "skipped" },
    },
    parts: [
      { code: "A-01", status: "DRAFT", outcome: "create", routes: [{ variant: "A", steps: 2, outcome: "create" }] },
      { code: "B-01", status: "DRAFT", outcome: "create", routes: [{ variant: "A", steps: 2, outcome: "create" }] },
    ],
    issues: [], issueSummary: [], ...over,
  };
}
const issue = (code: string, severity: string, over: Record<string, unknown> = {}) =>
  ({ code, severity, sheet: "Part Routes", row: 5, message: `${code} message`, ...over }) as DryRunReport["issues"][number];

describe("issue titles", () => {
  it("cover every code the importer can raise, so no screen shows a raw code", () => {
    for (const code of ISSUE_CODES) expect(ISSUE_TITLES[code], code).toBeTruthy();
  });
});

describe("confirmBlockedReason — refusals first", () => {
  it("a workbook missing a sheet cannot be loaded", () => {
    const r = report({ issues: [issue("SHEET_MISSING", "ERROR", { message: 'Sheet "Part Routes" is missing.' })] });
    expect(confirmBlockedReason({ report: r, canApply: true, isHead: true })).toMatch(/Part Routes/);
  });
  it("Engineering can check but not load", () => {
    expect(confirmBlockedReason({ report: report(), canApply: false, isHead: false })).toMatch(/Only the Production Head and Admins/);
  });
  it("an Admin is told who must load approved parts, including approved parts that would be unchanged", () => {
    const r = report({ parts: [{ code: "A-01", status: "APPROVED", outcome: "unchanged", routes: [] }] });
    expect(confirmBlockedReason({ report: r, canApply: true, isHead: false })).toMatch(/Only the Production Head can load them/);
  });
  it("an approved part that is skipped does not block an Admin", () => {
    const r = report({ parts: [{ code: "A-01", status: "APPROVED", outcome: "skipped", routes: [] }] });
    expect(confirmBlockedReason({ report: r, canApply: true, isHead: false })).toBeNull();
  });
  it("a file that would change nothing cannot be loaded", () => {
    const r = report({
      plan: { ...report().plan, partFamilies: tally(0, 0, 2), routes: tally(0, 0, 2), materialGrades: tally(0, 0, 1) },
    });
    expect(confirmBlockedReason({ report: r, canApply: true, isHead: true })).toMatch(/already matches/);
  });
  it("is available to the Production Head with something to write", () => {
    expect(confirmBlockedReason({ report: report(), canApply: true, isHead: true })).toBeNull();
  });
});

describe("plan helpers", () => {
  it("nothingToWrite sees an HE template that would be created", () => {
    const p = { ...report().plan, partFamilies: tally(0, 0, 2), routes: tally(), materialGrades: tally() };
    expect(nothingToWrite({ ...p, heStages: { loadable: true, stages: 3, existingTemplates: 0, outcome: "create" } })).toBe(false);
    expect(nothingToWrite({ ...p, heStages: { loadable: true, stages: 3, existingTemplates: 1, outcome: "unchanged" } })).toBe(true);
  });
  it("whatWillLoad says exactly what is written, singular and plural", () => {
    expect(whatWillLoad(report().plan)).toBe("2 part families, 2 routes, 1 material grade");
    const p = { ...report().plan, partFamilies: tally(), routes: tally(), materialGrades: tally(40), heStages: { loadable: true, stages: 42, existingTemplates: 0, outcome: "create" as const } };
    expect(whatWillLoad(p)).toBe("40 material grades, the heat-exchanger stage list");
    expect(whatWillLoad({ ...p, materialGrades: tally(), heStages: { ...p.heStages, outcome: "unchanged" } })).toBe("nothing");
  });
  it("noPartLoads is true when production mode skipped every part", () => {
    const skipped = report({ plan: { ...report().plan, partFamilies: tally(0, 0, 0, 60), routes: tally(0, 0, 0, 42) }, counts: { ...report().counts, parts: 60 } });
    expect(noPartLoads(skipped)).toBe(true);
    expect(noPartLoads(report())).toBe(false);
  });
});

describe("groupIssues", () => {
  const issues = [
    issue("PROPOSED_STD_TIME", "WARNING"), issue("PROPOSED_STD_TIME", "WARNING"), issue("PROPOSED_STD_TIME", "WARNING"),
    issue("MISSING_DEPARTMENT", "ERROR"), issue("REVIEW_ACTION_OPEN", "INFO"), issue("MISSING_STAGE", "ERROR"), issue("MISSING_STAGE", "ERROR"),
  ];
  it("puts errors first, then by size, with plain titles", () => {
    expect(groupIssues(issues).map((g) => [g.code, g.count])).toEqual([
      ["MISSING_STAGE", 2], ["MISSING_DEPARTMENT", 1], ["PROPOSED_STD_TIME", 3], ["REVIEW_ACTION_OPEN", 1],
    ]);
    expect(groupIssues(issues)[0].title).toBe("Step has no stage number");
  });
  it("filters by severity, and an empty filter means all", () => {
    expect(groupIssues(issues, new Set(["WARNING"])).map((g) => g.code)).toEqual(["PROPOSED_STD_TIME"]);
    expect(groupIssues(issues, new Set()).length).toBe(4);
    expect(severityCounts(issues)).toEqual({ ERROR: 3, WARNING: 3, INFO: 1 });
  });
});

describe("issuesToCsv", () => {
  it("escapes commas, quotes and line breaks, and names the sheet and row", () => {
    const csv = issuesToCsv([
      issue("MISSING_DEPARTMENT", "ERROR", { partCode: "TSH-02", row: 78, message: 'Step 10, "fit-up"\nhas no department.' }),
      issue("REVIEW_ACTION_OPEN", "INFO", { row: null, sheet: "Review Actions", message: "Q-01" }),
    ]);
    const lines = csv.split("\r\n"); // rows end CRLF; a line break inside a quoted cell stays a bare LF
    expect(lines[0]).toBe("Severity,What,Code,Sheet,Row,Part,Detail");
    expect(lines[1]).toBe('ERROR,Step has no department,MISSING_DEPARTMENT,Part Routes,78,TSH-02,"Step 10, ""fit-up""\nhas no department."');
    expect(lines[2]).toBe("INFO,An open review question from the workbook,REVIEW_ACTION_OPEN,Review Actions,,,Q-01");
    expect(lines[3]).toBe("");
  });
});
