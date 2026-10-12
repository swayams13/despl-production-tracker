// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MaterialGradeRow } from "@/lib/services/master-data.read";

const { toast, save, setStatus, bulk, refresh, replace } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  save: vi.fn(),
  setStatus: vi.fn(),
  bulk: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace, push: vi.fn() }) }));
vi.mock("@/app/actions/master-data", () => ({
  saveMaterialGradeAction: (...a: unknown[]) => save(...a),
  setMaterialStatusAction: (...a: unknown[]) => setStatus(...a),
  setMaterialStatusBulkAction: (...a: unknown[]) => bulk(...a),
}));

import { MaterialsView, validateDraft } from "./_materials";

const row = (id: number, over: Partial<MaterialGradeRow> = {}): MaterialGradeRow => ({
  id, spec: `SA ${id}`, grade: "Gr.70", productForm: "Plate", densityGcc: 7.85, remarks: null, status: "DRAFT", ...over,
});
const totals = { all: 3, draft: 2, reviewed: 1, approved: 0, noDensity: 1 };
const editor = { edit: true, approve: false, revise: false };
const head = { edit: true, approve: true, revise: true };
const none = { edit: false, approve: false, revise: false };

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const btn = (name: RegExp | string) => screen.queryByRole("button", { name });

describe("MaterialsView — what each role sees (refusals first)", () => {
  it("a planner sees the grades and no controls", () => {
    render(<MaterialsView rows={[row(1)]} totals={totals} filters={{}} can={none} />);
    expect(screen.getByText("SA 1")).toBeTruthy();
    for (const name of ["Add grade", "Edit", "Mark reviewed", "Approve", "Revise"]) expect(btn(name)).toBeNull();
    expect(screen.queryByLabelText("Select SA 1 Gr.70")).toBeNull();
  });

  it("engineering can edit and review but not approve or revise", () => {
    render(<MaterialsView rows={[row(1), row(2, { status: "REVIEWED" })]} totals={totals} filters={{}} can={editor} />);
    expect(btn("Add grade")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Edit" }).length).toBe(2);
    expect(btn("Approve")).toBeNull();
    expect(btn("Revise")).toBeNull();
  });

  it("an approved grade has no Edit, only Revise for those who may", () => {
    const { unmount } = render(<MaterialsView rows={[row(1, { status: "APPROVED" })]} totals={totals} filters={{}} can={head} />);
    expect(btn("Edit")).toBeNull();
    expect(btn("Revise")).not.toBeNull();
    unmount();
    render(<MaterialsView rows={[row(1, { status: "APPROVED" })]} totals={totals} filters={{}} can={editor} />);
    expect(btn("Edit")).toBeNull();
    expect(btn("Revise")).toBeNull();
  });

  it("a grade with no density cannot be approved, and says so instead of showing a dead button", () => {
    render(<MaterialsView rows={[row(1, { densityGcc: null })]} totals={totals} filters={{}} can={head} />);
    expect(btn("Approve")).toBeNull();
    expect(screen.getByText("Needs a density to approve")).toBeTruthy();
  });
});

describe("validateDraft", () => {
  const ok = { spec: "SA 516", grade: "Gr.70", productForm: "Plate", density: "7.85", remarks: "" };
  it("accepts a complete grade and one with no density yet", () => {
    expect(validateDraft(ok)).toBeNull();
    expect(validateDraft({ ...ok, density: "" })).toBeNull();
  });
  const refused: Array<[string, Partial<typeof ok>, string]> = [
    ["no specification", { spec: " " }, "spec"],
    ["no form", { productForm: "" }, "productForm"],
    ["a zero density", { density: "0" }, "density"],
    ["a negative density", { density: "-1" }, "density"],
    ["a density past the column", { density: "1000" }, "density"],
    ["a non-number density", { density: "heavy" }, "density"],
  ];
  it.each(refused)("refuses %s", (_n, over, field) => {
    expect(validateDraft({ ...ok, ...over })?.field).toBe(field);
  });
});

describe("editing", () => {
  it("adds a grade inline, validating before the round trip and saving on Enter", async () => {
    save.mockResolvedValue({ ok: true, id: 9 });
    render(<MaterialsView rows={[row(1)]} totals={totals} filters={{}} can={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Add grade" }));

    const spec = screen.getByLabelText("Specification");
    fireEvent.keyDown(spec, { key: "Enter" });
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/A specification is required/)).toBeTruthy();

    fireEvent.change(spec, { target: { value: "SA 240" } });
    fireEvent.change(screen.getByLabelText("Form"), { target: { value: "Plate" } });
    fireEvent.change(screen.getByLabelText("Density (g/cm³)"), { target: { value: "7.9" } });
    fireEvent.keyDown(spec, { key: "Enter" });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({ spec: "SA 240", grade: "", productForm: "Plate", densityGcc: 7.9, remarks: null });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("warns that saving a reviewed grade returns it to draft, and hints at kg/m³", () => {
    render(<MaterialsView rows={[row(1, { status: "REVIEWED" })]} totals={totals} filters={{}} can={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText(/Saving returns this grade to draft/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Density (g/cm³)"), { target: { value: "7850" } });
    expect(screen.getByText(/Looks like kg\/m³/)).toBeTruthy();
  });

  it("Esc cancels the edit without saving", () => {
    render(<MaterialsView rows={[row(1)]} totals={totals} filters={{}} can={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(screen.getByLabelText("Specification"), { key: "Escape" });
    expect(screen.queryByLabelText("Specification")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("shows a server refusal's reason (a duplicate grade)", async () => {
    save.mockResolvedValue({ ok: false, code: "VALIDATION_FAILED", message: "x", detail: { reason: "this specification, grade and form already exists" } });
    render(<MaterialsView rows={[row(1)]} totals={totals} filters={{}} can={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(screen.getByLabelText("Specification"), { key: "Enter" });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("this specification, grade and form already exists"));
  });
});

describe("review, approve, revise", () => {
  it("marks one reviewed and approves one", async () => {
    setStatus.mockResolvedValue({ ok: true });
    render(<MaterialsView rows={[row(1), row(2, { status: "REVIEWED" })]} totals={totals} filters={{}} can={head} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith({ materialGradeId: 1, to: "REVIEWED" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[1]);
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith({ materialGradeId: 2, to: "APPROVED" }));
  });

  it("revise needs a reason of at least five characters", async () => {
    setStatus.mockResolvedValue({ ok: true });
    render(<MaterialsView rows={[row(1, { status: "APPROVED" })]} totals={totals} filters={{}} can={head} />);
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Revise grade" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "New MTC" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith({ materialGradeId: 1, to: "DRAFT", reason: "New MTC" }));
  });

  it("bulk review reports what it skipped; Approve is offered only to the Production Head", async () => {
    bulk.mockResolvedValue({ ok: true, reviewed: [1], refused: [{ id: 2, code: "VALIDATION_FAILED", message: "A grade that is APPROVED cannot move to REVIEWED." }] });
    const { unmount } = render(<MaterialsView rows={[row(1), row(2)]} totals={totals} filters={{}} can={editor} />);
    fireEvent.click(screen.getByLabelText("Select SA 1 Gr.70"));
    fireEvent.click(screen.getByLabelText("Select SA 2 Gr.70"));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    // The bulk bar sits above the table, so its button comes first (rows have their own).
    fireEvent.click(screen.getAllByRole("button", { name: "Mark reviewed" })[0]);
    await waitFor(() => expect(bulk).toHaveBeenCalledWith([1, 2], "REVIEWED"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("1 marked reviewed, 1 skipped."));
    expect(toast.error).toHaveBeenCalledWith("A grade that is APPROVED cannot move to REVIEWED.");
    unmount();

    render(<MaterialsView rows={[row(1), row(2)]} totals={totals} filters={{}} can={head} />);
    fireEvent.click(screen.getByLabelText("Select SA 1 Gr.70"));
    expect(screen.getAllByRole("button", { name: "Approve" }).length).toBeGreaterThan(0);
  });
});

describe("filters", () => {
  it("the strip filters through the URL and keeps the search", () => {
    render(<MaterialsView rows={[row(1)]} totals={totals} filters={{ q: "516" }} can={none} />);
    fireEvent.click(screen.getByRole("button", { name: /No density/ }));
    expect(replace).toHaveBeenCalledWith("/admin/master-data/materials?q=516&nodensity=1", { scroll: false });
  });

  it("explains an empty result, and an empty catalogue, differently", () => {
    const a = render(<MaterialsView rows={[]} totals={totals} filters={{ status: "APPROVED" }} can={editor} />);
    expect(screen.getByText("No grades match these filters.")).toBeTruthy();
    a.unmount();
    render(<MaterialsView rows={[]} totals={{ all: 0, draft: 0, reviewed: 0, approved: 0, noDensity: 0 }} filters={{}} can={editor} />);
    expect(screen.getByText(/No material grades yet/)).toBeTruthy();
  });
});
