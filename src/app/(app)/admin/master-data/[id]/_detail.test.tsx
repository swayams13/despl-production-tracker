// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PartFamilyDetail } from "@/lib/services/master-data.read";

const { refresh, toast, approve, revise, edit, review } = vi.hoisted(() => ({
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  approve: vi.fn(),
  revise: vi.fn(),
  edit: vi.fn(),
  review: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/actions/master-data", () => ({
  approvePartFamilyAction: (...a: unknown[]) => approve(...a),
  revisePartFamilyAction: (...a: unknown[]) => revise(...a),
  editPartFamilyAction: (...a: unknown[]) => edit(...a),
  reviewPartFamiliesAction: (...a: unknown[]) => review(...a),
  saveRouteDraftAction: vi.fn(),
}));

import { PartFamilyDetailView } from "./_detail";

const step = (seq: number, over: Record<string, unknown> = {}) => ({
  seq, operationCode: "RECEIPT", whatIsDone: "", department: "Stores", pvStage: 10, heStage: null, stdTime: 0.5,
  stdTimeUnit: "HOURS", stdTimeBasis: "PER_PIECE", conditional: false, conditionText: "", acceptanceStandard: "",
  recordDocument: "", requiresQc: true, ...over,
});

function detail(over: Partial<PartFamilyDetail> = {}): PartFamilyDetail {
  return {
    id: 7, code: "SHL-01", name: "Shell Course", scope: "PV", status: "DRAFT", assemblyGroup: "Shell",
    makeBuy: "MADE_IN_HOUSE", rawForm: "Plate", typicalMoc: "SA516", weightBasis: "Rolled shell", dimensionKeys: ["ID", "thickness"],
    isSpare: false, routeSource: "Current shop practice", remarks: null, approvedAt: null, approvedBy: null,
    preparedBy: "Engineering", reviewedBy: null, reviewedAt: null, selfApproved: false, willSelfApprove: false,
    variants: [
      {
        variant: "A", routeId: 1, versionId: 11, version: 1, status: "DRAFT", signature: "[]", liveVersion: null,
        history: [{ id: 11, version: 1, status: "DRAFT", components: 0 }], changes: null,
        steps: [step(10), step(20, { operationCode: "MTC_VERIFICATION", department: "Quality Control / QA", pvStage: 11 })],
      },
    ],
    readiness: { blockers: [], warnings: [] },
    can: { edit: true, review: true, approve: true, revise: false, approveRole: true },
    approveRefusal: null,
    reference: {
      operations: [
        { code: "RECEIPT", name: "Receipt", active: true, defaultDepartment: "Stores", defaultPvStage: 10 },
        { code: "MTC_VERIFICATION", name: "MTC verification", active: true, defaultDepartment: "Quality Control / QA", defaultPvStage: 11 },
      ],
      departments: ["Stores", "Quality Control / QA"],
      pvStages: [{ no: 10, name: "Receipt", department: "Stores" }, { no: 11, name: "Identification", department: "Quality Control / QA" }],
      heStages: [],
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

const has = (name: RegExp | string) => screen.queryByRole("button", { name });

describe("PartFamilyDetailView — what each role sees (refusals first)", () => {
  it("a planner sees no controls and is told who approves", () => {
    render(<PartFamilyDetailView variant={null} detail={detail({ can: { edit: false, review: false, approve: false, revise: false, approveRole: false }, approveRefusal: "Only the Production Head approves master data." })} />);
    for (const name of [/Edit part/, /Mark reviewed/, /Approve part/, /Revise/, /Edit steps/]) expect(has(name)).toBeNull();
    expect(screen.getAllByText(/Only the Production Head approves master data/).length).toBeGreaterThan(0);
  });

  it("engineering can edit and review but has no Approve control", () => {
    render(<PartFamilyDetailView variant={null} detail={detail({ can: { edit: true, review: true, approve: false, revise: false, approveRole: false } })} />);
    expect(has(/Edit part/)).not.toBeNull();
    expect(has(/Mark reviewed/)).not.toBeNull();
    expect(has(/Approve part/)).toBeNull();
  });

  it("the Production Head sees Approve disabled, with the reason, while something blocks it", () => {
    render(
      <PartFamilyDetailView
        variant={null}
        detail={detail({
          can: { edit: true, review: true, approve: false, revise: false, approveRole: true },
          approveRefusal: "1 thing to fix first.",
          readiness: { blockers: [{ variant: "A", seq: 20, code: "MISSING_DEPARTMENT", message: "Step 20 of SHL-01 has no department.", fields: ["department"] }], warnings: [] },
        })}
      />,
    );
    expect((has(/Approve part/) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("1 thing to fix first.")).toBeTruthy();
    expect(screen.getByText(/Step 20 of SHL-01 has no department/)).toBeTruthy();
  });

  it("an approved part offers Revise, not Edit steps, and shows the self-approved chip", () => {
    render(
      <PartFamilyDetailView
        variant={null}
        detail={detail({
          status: "APPROVED", selfApproved: true, approvedBy: "SJ", approvedAt: "2026-10-13T08:00:00Z",
          can: { edit: false, review: false, approve: false, revise: true, approveRole: true },
          variants: [{ ...detail().variants[0], status: "PUBLISHED", liveVersion: 1 }],
        })}
      />,
    );
    expect(has(/Revise part/)).not.toBeNull();
    expect(has(/Edit steps/)).toBeNull();
    expect(has(/Approve part/)).toBeNull();
    expect(screen.getByText("Self-approved")).toBeTruthy();
  });
});

describe("approve flow", () => {
  it("warns before the click when the approver made the last change, and sends the id on confirm", async () => {
    approve.mockResolvedValue({ ok: true, selfApproved: true, published: [{ variant: "A", version: 1 }] });
    render(<PartFamilyDetailView variant={null} detail={detail({ willSelfApprove: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve part/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Approving it yourself is allowed and is recorded as self-approved/)).toBeTruthy();
    expect(within(dialog).getByText(/No one else has reviewed it/)).toBeTruthy();
    expect(within(dialog).getByText(/variant A v1/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Approve part" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith({ partFamilyId: 7 }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Approved. Recorded as self-approved."));
    expect(refresh).toHaveBeenCalled();
  });

  it("a refusal with blockers closes the dialog, says how many, and refreshes the readiness panel", async () => {
    approve.mockResolvedValue({ ok: false, code: "APPROVAL_BLOCKED", message: "x", detail: { blockers: [{}, {}] } });
    render(<PartFamilyDetailView variant={null} detail={detail()} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve part/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve part" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Fix 2 things first."));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("revise needs a reason before it can be confirmed", async () => {
    revise.mockResolvedValue({ ok: true });
    render(
      <PartFamilyDetailView
        variant={null}
        detail={detail({ status: "APPROVED", can: { edit: false, review: false, approve: false, revise: true, approveRole: true } })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Revise part/ }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Revise part" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "New acceptance standard" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(revise).toHaveBeenCalledWith({ partFamilyId: 7, reason: "New acceptance standard" }));
  });
});

describe("the steps table", () => {
  it("marks the cell a blocker is about, and shows what a revision changes against the live version", () => {
    render(
      <PartFamilyDetailView
        variant={null}
        detail={detail({
          readiness: { blockers: [{ variant: "A", seq: 20, code: "MISSING_DEPARTMENT", message: "Step 20 has no department.", fields: ["department"] }], warnings: [] },
          variants: [
            {
              ...detail().variants[0], version: 2, liveVersion: 1,
              history: [{ id: 12, version: 2, status: "DRAFT", components: 0 }, { id: 11, version: 1, status: "PUBLISHED", components: 27 }],
              changes: [{ seq: 10, kind: "changed", fields: ["time"] }, { seq: 20, kind: "added" }, { seq: 30, kind: "removed" }],
            },
          ],
        })}
      />,
    );
    expect(screen.getByLabelText("Step 20 has no department.")).toBeTruthy();
    expect(screen.getByText(/Changed: time/)).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.getByText(/Removed since v1/)).toBeTruthy();
    expect(screen.getByText(/New jobs keep using v1 until this is approved/)).toBeTruthy();
    expect(screen.getByText(/v1 Superseded, 27 components|v1 Published, used for new jobs, 27 components/)).toBeTruthy();
  });

  it("says why a non-first variant is not used by new jobs yet", () => {
    const a = detail().variants[0];
    render(
      <PartFamilyDetailView
        variant="B"
        detail={detail({ variants: [a, { ...a, variant: "B", routeId: 2, versionId: 21 }] })}
      />,
    );
    expect(screen.getByText(/New jobs use variant A\. This variant is used once BOM release can choose/)).toBeTruthy();
  });

  it("a part with no route offers to add one, only to those who may edit", () => {
    const { rerender } = render(<PartFamilyDetailView variant={null} detail={detail({ variants: [] })} />);
    expect(screen.getByText("This part has no route yet.")).toBeTruthy();
    expect(has(/Add route \(variant A\)/)).not.toBeNull();
    rerender(
      <PartFamilyDetailView
        variant={null}
        detail={detail({ variants: [], can: { edit: false, review: false, approve: false, revise: false, approveRole: false } })}
      />,
    );
    expect(has(/Add route/)).toBeNull();
  });
});
