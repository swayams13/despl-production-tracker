// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DryRunReport } from "@/lib/services/master-import.service";

const { toast, preview, apply } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  preview: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/app/actions/master-import", () => ({
  previewMasterImportAction: (...a: unknown[]) => preview(...a),
  applyMasterImportAction: (...a: unknown[]) => apply(...a),
}));

import { MasterImport } from "./_import";

// jsdom 26 (the newest that loads on the pinned Node 20) has no Blob.arrayBuffer or Blob.text; browsers do.
const readBlob = (b: Blob, how: "readAsArrayBuffer" | "readAsText") =>
  new Promise<never>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as never);
    r.onerror = () => rej(r.error);
    r[how](b);
  });
if (!Blob.prototype.arrayBuffer) Blob.prototype.arrayBuffer = function (this: Blob) { return readBlob(this, "readAsArrayBuffer"); };
if (!Blob.prototype.text) Blob.prototype.text = function (this: Blob) { return readBlob(this, "readAsText"); };

const tally = (create = 0, update = 0, unchanged = 0, skipped = 0) => ({ create, update, unchanged, skipped });
const issue = (code: string, severity: string, row = 5, message = `${code} at ${row}`) =>
  ({ code, severity, sheet: "Part Routes", row, partCode: "SHL-01", message }) as DryRunReport["issues"][number];

function report(over: Partial<DryRunReport> = {}): DryRunReport {
  return {
    fileSha256: "a".repeat(64), planFingerprint: "b".repeat(64), allowDraft: true, sheets: [],
    counts: { parts: 2, routeSteps: 4, materialGrades: 1, heStages: 0, assemblyRows: 0, newOperations: 0, reviewActions: 0, exampleRowsSkipped: 0 },
    plan: {
      partFamilies: tally(2), routes: tally(2), stageMappingRows: 4, materialGrades: tally(1),
      heStages: { loadable: false, stages: 0, existingTemplates: 0, outcome: "skipped" },
    },
    parts: [
      { code: "SHL-01", status: "DRAFT", outcome: "create", routes: [{ variant: "A", steps: 2, outcome: "create" }] },
      { code: "HED-01", status: "DRAFT", outcome: "create", routes: [{ variant: "A", steps: 2, outcome: "create" }] },
    ],
    issues: [issue("PROPOSED_STD_TIME", "WARNING", 5), issue("MISSING_DEPARTMENT", "ERROR", 7)],
    issueSummary: [], ...over,
  };
}

const workbook = (name = "Standard_Parts_Master.xlsx", bytes = [0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) =>
  new File([new Uint8Array(bytes)], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

async function choose(file: File) {
  fireEvent.change(screen.getByLabelText("Standard Parts Master workbook"), { target: { files: [file] } });
}
const checkBtn = () => screen.getByRole("button", { name: /Check file|Checking/ }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("MasterImport — refusals first", () => {
  it("refuses a file that is not an .xlsx before sending anything", async () => {
    render(<MasterImport canApply isHead />);
    await choose(workbook("parts.csv"));
    expect(await screen.findByText("Choose an Excel workbook (.xlsx).")).toBeTruthy();
    expect(checkBtn().disabled).toBe(true);
    expect(preview).not.toHaveBeenCalled();
  });

  it("refuses a renamed non-workbook by its first bytes", async () => {
    render(<MasterImport canApply isHead />);
    await choose(workbook("parts.xlsx", [0x68, 0x65, 0x6c, 0x6c, 0x6f]));
    expect(await screen.findByText(/does not look like an Excel workbook/)).toBeTruthy();
    expect(checkBtn().disabled).toBe(true);
  });

  it("Engineering can check the file but cannot load it, and is told why", async () => {
    preview.mockResolvedValue({ ok: true, report: report() });
    render(<MasterImport canApply={false} isHead={false} />);
    await choose(workbook());
    await waitFor(() => expect(checkBtn().disabled).toBe(false));
    fireEvent.click(checkBtn());
    expect(await screen.findByText(/Only the Production Head and Admins can load a workbook/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Load into tracker" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an Admin cannot load a file with approved parts, and is told to ask SJ", async () => {
    preview.mockResolvedValue({
      ok: true,
      report: report({ parts: [{ code: "SHL-01", status: "APPROVED", outcome: "create", routes: [] }] }),
    });
    render(<MasterImport canApply isHead={false} />);
    await choose(workbook());
    await waitFor(() => expect(checkBtn().disabled).toBe(false));
    fireEvent.click(checkBtn());
    expect(await screen.findByText(/Only the Production Head can load them; ask SJ/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Load into tracker" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a workbook missing a sheet cannot be loaded", async () => {
    preview.mockResolvedValue({
      ok: true,
      report: report({ issues: [{ code: "SHEET_MISSING", severity: "ERROR", sheet: "Part Routes", row: null, message: 'Sheet "Part Routes" is missing.' } as never] }),
    });
    render(<MasterImport canApply isHead />);
    await choose(workbook());
    await waitFor(() => expect(checkBtn().disabled).toBe(false));
    fireEvent.click(checkBtn());
    expect(await screen.findByText(/missing something the importer needs/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Load into tracker" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a file that already matches the tracker cannot be loaded again", async () => {
    preview.mockResolvedValue({
      ok: true,
      report: report({ plan: { ...report().plan, partFamilies: tally(0, 0, 2), routes: tally(0, 0, 2), materialGrades: tally(0, 0, 1) } }),
    });
    render(<MasterImport canApply isHead />);
    await choose(workbook());
    await waitFor(() => expect(checkBtn().disabled).toBe(false));
    fireEvent.click(checkBtn());
    expect(await screen.findByText(/already matches the tracker/)).toBeTruthy();
  });
});

describe("MasterImport — check, confirm, load", () => {
  async function checked(r: DryRunReport, props = { canApply: true, isHead: true }) {
    preview.mockResolvedValue({ ok: true, report: r });
    render(<MasterImport {...props} />);
    await choose(workbook());
    await waitFor(() => expect(checkBtn().disabled).toBe(false));
    fireEvent.click(checkBtn());
    await screen.findByText("What this file would do");
  }

  it("sends the file and the drafts choice to the check", async () => {
    await checked(report());
    const fd = preview.mock.calls[0][0] as FormData;
    expect((fd.get("file") as File).name).toBe("Standard_Parts_Master.xlsx");
    expect(fd.get("allowDraft")).toBe("1");
  });

  it("shows the plan in plain words and the issues grouped, errors first", async () => {
    await checked(report());
    expect(screen.getByText(/Read 2 parts · 4 route steps · 1 materials/)).toBeTruthy();
    const items = screen.getAllByRole("button", { expanded: false }).map((b) => b.textContent ?? "");
    const stepNoDept = items.findIndex((t) => t.includes("Step has no department"));
    const proposed = items.findIndex((t) => t.includes("Standard time is only proposed"));
    expect(stepNoDept).toBeGreaterThanOrEqual(0);
    expect(stepNoDept).toBeLessThan(proposed);
  });

  it("an issue group expands to sheet, row, part and message; severity buttons filter", async () => {
    await checked(report());
    fireEvent.click(screen.getByRole("button", { name: /Step has no department/ }));
    expect(screen.getByText(/Part Routes row 7 · SHL-01/)).toBeTruthy();
    expect(screen.getByText("MISSING_DEPARTMENT at 7")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /To check/ }));
    expect(screen.queryByRole("button", { name: /Step has no department/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Standard time is only proposed/ })).toBeTruthy();
  });

  it("shows the first 50 of a long group and the rest on request", async () => {
    const many = Array.from({ length: 120 }, (_, i) => issue("PROPOSED_STD_TIME", "WARNING", i + 5, `time ${i + 5}`));
    await checked(report({ issues: many }));
    fireEvent.click(screen.getByRole("button", { name: /Standard time is only proposed/ }));
    expect(screen.queryByText("time 60")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 120" }));
    expect(screen.getByText("time 124")).toBeTruthy();
  });

  it("downloads the issues as CSV", async () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await checked(report());
    fireEvent.click(screen.getByRole("button", { name: "Download issues (CSV)" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalled();
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(await blob.text()).toContain("Severity,What,Code,Sheet,Row,Part,Detail");
    click.mockRestore();
  });

  it("production mode with nothing approved says no part will load, and what still does", async () => {
    await checked(
      report({
        allowDraft: false,
        plan: {
          partFamilies: tally(0, 0, 0, 2), routes: tally(0, 0, 0, 2), stageMappingRows: 0, materialGrades: tally(40),
          heStages: { loadable: true, stages: 42, existingTemplates: 0, outcome: "create" },
        },
        parts: [{ code: "SHL-01", status: "DRAFT", outcome: "skipped", routes: [] }, { code: "HED-01", status: "DRAFT", outcome: "skipped", routes: [] }],
      }),
    );
    expect(screen.getByText(/No part will load: none is marked/)).toBeTruthy();
    expect(screen.getByText(/Still loads: 40 material grades, the heat-exchanger stage list, as drafts/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load 40 material grades, the heat-exchanger stage list" })).toBeTruthy();
  });

  it("changing the drafts choice discards the old check, because the plan depends on it", async () => {
    await checked(report());
    fireEvent.click(screen.getByLabelText(/Load parts that are not approved yet as drafts/));
    expect(screen.queryByText("What this file would do")).toBeNull();
  });

  it("confirm states what loads, then sends the file with the hash and fingerprint it was shown", async () => {
    apply.mockResolvedValue({
      ok: true,
      plan: report().plan,
      written: { partFamilies: tally(2), routes: tally(2), stageMappingRows: 4, materialGrades: tally(1), heTemplate: "skipped" },
    });
    await checked(report());
    fireEvent.click(screen.getByRole("button", { name: "Load into tracker" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/This loads 2 part families, 2 routes, 1 material grade/)).toBeTruthy();
    expect(within(dialog).getByText(/load as drafts and are not used by any job/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Load" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const fd = apply.mock.calls[0][0] as FormData;
    expect(fd.get("fileSha256")).toBe("a".repeat(64));
    expect(fd.get("planFingerprint")).toBe("b".repeat(64));
    expect((fd.get("file") as File).name).toBe("Standard_Parts_Master.xlsx");

    expect(await screen.findByText("Loaded")).toBeTruthy();
    expect(screen.getByText(/Part families: planned 2, written 2/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review the draft parts" }).getAttribute("href")).toBe("/admin/master-data?status=DRAFT");
    expect(screen.getByRole("link", { name: "Parts with problems" }).getAttribute("href")).toBe("/admin/master-data?issues=1");
  });

  it("a plan that changed since the check says nothing was saved and offers Check again", async () => {
    apply.mockResolvedValue({ ok: false, code: "STALE_WRITE", message: "x", detail: { kind: "PLAN_CHANGED" } });
    await checked(report());
    fireEvent.click(screen.getByRole("button", { name: "Load into tracker" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Load" }));
    expect(await screen.findByText("Master data changed since your check. Nothing was saved.")).toBeTruthy();
    expect(screen.queryByText("Loaded")).toBeNull();
    preview.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
  });

  it("a file that changed after the check is refused with its own message", async () => {
    apply.mockResolvedValue({ ok: false, code: "VALIDATION_FAILED", message: "x", detail: { kind: "FILE_CHANGED" } });
    await checked(report());
    fireEvent.click(screen.getByRole("button", { name: "Load into tracker" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Load" }));
    expect(await screen.findByText("This file changed after you checked it. Check it again.")).toBeTruthy();
  });

  it("shows the reason a load was refused for role, not just 'forbidden'", async () => {
    apply.mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "You do not have permission.", detail: { reason: "only the Production Head approves master data" } });
    await checked(report());
    fireEvent.click(screen.getByRole("button", { name: "Load into tracker" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Load" }));
    expect(await screen.findByText("only the Production Head approves master data")).toBeTruthy();
  });
});
