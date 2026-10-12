// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { toast, save } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() }, save: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/actions/master-data", () => ({ saveRouteDraftAction: (...a: unknown[]) => save(...a) }));

import { StepEditor } from "./_step-editor";
import type { SourceStep } from "./_step-model";

const reference = {
  operations: [
    { code: "RECEIPT", name: "Receipt", active: true, defaultDepartment: "Stores", defaultPvStage: 10 },
    { code: "FIT_UP", name: "Fit-up", active: true, defaultDepartment: "Fabrication / Welding", defaultPvStage: 15 },
    { code: "GRINDING", name: "Grinding", active: false, defaultDepartment: null, defaultPvStage: null },
  ],
  departments: ["Stores", "Fabrication / Welding", "Quality Control / QA"],
  pvStages: [{ no: 10, name: "Receipt", department: "Stores" }, { no: 15, name: "Shell fit-up", department: "Fabrication / Welding" }],
  heStages: [],
};
const step = (seq: number, over: Partial<SourceStep> = {}): SourceStep => ({
  seq, operationCode: "RECEIPT", department: "Stores", pvStage: 10, heStage: null, stdTime: 0.5, stdTimeUnit: "HOURS",
  stdTimeBasis: "PER_PIECE", conditional: false, conditionText: "", acceptanceStandard: "", recordDocument: "", whatIsDone: "", ...over,
});

const props = (over: Partial<Parameters<typeof StepEditor>[0]> = {}) => ({
  partFamilyId: 7, variant: "A", scope: "PV" as const, steps: [step(10)], signature: "SIG-1", blockers: [], warnings: [], reference,
  canRevise: false, onRevise: vi.fn(), onClose: vi.fn(), onSaved: vi.fn(), ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("StepEditor", () => {
  it("does not call the server for what is certain to be refused, and says how many things are wrong", async () => {
    render(<StepEditor {...props({ steps: [] })} />); // one blank row: no operation
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("1 thing to fix before this can be saved."));
    expect(save).not.toHaveBeenCalled();
  });

  it("picking an operation pre-fills its department and stage, but only into empty cells", () => {
    render(<StepEditor {...props({ steps: [] })} />);
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "FIT_UP" } });
    expect((screen.getByLabelText("Department") as HTMLSelectElement).value).toBe("Fabrication / Welding");
    expect((screen.getByLabelText("PV stage") as HTMLSelectElement).value).toBe("15");

    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "Quality Control / QA" } });
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "RECEIPT" } });
    expect((screen.getByLabelText("Department") as HTMLSelectElement).value).toBe("Quality Control / QA");
  });

  it("an inactive operation a step still uses stays selectable, marked inactive", () => {
    render(<StepEditor {...props({ steps: [step(10, { operationCode: "GRINDING" })] })} />);
    const select = screen.getByLabelText("Operation") as HTMLSelectElement;
    expect(select.value).toBe("GRINDING");
    expect(Array.from(select.options).map((o) => o.text)).toContain("Grinding (inactive)");
    // …but is not offered on a second row.
    fireEvent.click(screen.getByRole("button", { name: "+ Add step" }));
    const second = screen.getAllByLabelText("Operation")[1] as HTMLSelectElement;
    expect(Array.from(second.options).map((o) => o.text)).not.toContain("Grinding (inactive)");
  });

  it("saves the whole variant with the signature it loaded, and tells the screen it is done", async () => {
    save.mockResolvedValue({ ok: true, version: 3, readiness: { blockers: [], warnings: [] } });
    const p = props();
    render(<StepEditor {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({
      partFamilyId: 7,
      variant: "A",
      baseSignature: "SIG-1",
      steps: [{ seq: 10, operationCode: "RECEIPT", department: "Stores", pvStage: 10, stdTime: 0.5, requiresQc: true }],
    });
    await waitFor(() => expect(p.onSaved).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Draft v3 saved.");
  });

  it("says how many approval blockers remain after a save", async () => {
    save.mockResolvedValue({ ok: true, version: 1, readiness: { blockers: [{}, {}], warnings: [] } });
    render(<StepEditor {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Draft v1 saved. 2 things still to fix before approval."));
  });

  it("a stale save keeps the edits, explains, and offers a reload", async () => {
    save.mockResolvedValue({ ok: false, code: "STALE_WRITE", message: "Someone else changed this." });
    const p = props();
    render(<StepEditor {...p} />);
    fireEvent.change(screen.getByLabelText("Standard time"), { target: { value: "0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/Someone else changed this variant while you were editing/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect((screen.getByLabelText("Standard time") as HTMLInputElement).value).toBe("0.9");
    expect(p.onSaved).not.toHaveBeenCalled();
  });

  it("an approved part says so, and offers Revise only to someone who may", async () => {
    save.mockResolvedValue({ ok: false, code: "REVISE_REQUIRED", message: "This is approved. Revise it first." });
    const first = render(<StepEditor {...props({ canRevise: false })} />);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("This is approved. Revise it first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revise part" })).toBeNull();
    first.unmount();

    const p = props({ canRevise: true });
    render(<StepEditor {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revise part" }));
    expect(p.onRevise).toHaveBeenCalled();
  });

  it("puts a server finding on the cell it is about, and marks it invalid", async () => {
    save.mockResolvedValue({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Some of the values submitted are not valid.",
      detail: { reason: "some steps are not valid", findings: [{ variant: "A", seq: 10, code: "UNKNOWN_DEPARTMENT", message: "Department \"Mars\" is not a tracker department.", fields: ["department"] }] },
    });
    render(<StepEditor {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByLabelText("Department").getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByLabelText("Department").getAttribute("title")).toMatch(/not a tracker department/);
    expect(screen.getByText("some steps are not valid")).toBeTruthy();
  });

  it("discarding unsaved edits asks first; with no edits it closes straight away", () => {
    const p = props();
    render(<StepEditor {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(p.onClose).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Standard time"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Discard your changes to variant A\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it("shows only the stage columns the part's equipment needs", () => {
    const pv = render(<StepEditor {...props({ scope: "PV" })} />);
    expect(screen.queryByLabelText("PV stage")).not.toBeNull();
    expect(screen.queryByLabelText("HE stage")).toBeNull();
    pv.unmount();

    render(<StepEditor {...props({ scope: "HE" })} />);
    expect(screen.queryByLabelText("PV stage")).toBeNull();
    expect(screen.queryByLabelText("HE stage")).not.toBeNull();
  });
});

describe("StepEditor — what the grid marks", () => {
  it("an approval blocker is outlined on its cell; a warning is only a tooltip", () => {
    render(
      <StepEditor
        {...props({
          blockers: [{ variant: "A", seq: 10, code: "MISSING_DEPARTMENT", message: "Step 10 has no department.", fields: ["department"] }],
          warnings: [{ variant: "A", seq: 10, code: "MISSING_STD_TIME", message: "Step 10 has no standard time.", fields: ["stdTime"] }],
          steps: [step(10, { department: "", stdTime: null, stdTimeUnit: null, stdTimeBasis: null })],
        })}
      />,
    );
    const dept = screen.getByLabelText("Department") as HTMLSelectElement;
    expect(dept.getAttribute("title")).toBe("Step 10 has no department.");
    expect(dept.style.outline).toContain("var(--s-hold)");
    const time = screen.getByLabelText("Standard time") as HTMLInputElement;
    expect(time.getAttribute("title")).toBe("Step 10 has no standard time.");
    expect(time.style.outline).toBe("");
  });
});
