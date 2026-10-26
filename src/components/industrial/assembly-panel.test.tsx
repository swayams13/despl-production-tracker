// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AssemblyGrid, AssemblyStepRow } from "@/lib/services/assembly.read";
import { ROLES, type Actor, type RoleCode } from "@/lib/authz";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/assembly", () => ({
  startAssemblyStepAction: vi.fn(),
  submitAssemblyStepAction: vi.fn(),
  verifyAssemblyStepAction: vi.fn(),
  rejectAssemblyStepAction: vi.fn(),
}));
// resolveQcAccess is pure; its module also imports the database, which these tests never touch.
vi.mock("@/lib/db", () => ({ prisma: {}, withTenant: vi.fn() }));

import { AssemblyPanel } from "./assembly-panel";
import { resolveQcAccess } from "@/lib/services/qc-queue.read";

const step = (id: number, status: AssemblyStepRow["status"]): AssemblyStepRow => ({
  id, seq: id, srNo: `1.${id}`, activity: `Step ${id}`, kind: "WORK", status,
  startedAt: null, finishedAt: null, submittedBy: null, performedByWelderName: null, performedByUserName: null,
  remarks: null, jointRef: null, weldJoint: null, qcpItem: null, rejection: null,
});
const data: AssemblyGrid = {
  units: [{ id: 1, serialNo: "320SR01" }], unitId: 1, hasTemplate: true,
  groups: [{ groupCode: "A", groupName: "Fit-up", steps: [step(1, "NOT_STARTED"), step(2, "IN_PROGRESS"), step(3, "SUBMITTED")] }],
  welders: [], delayCategories: [], testTypes: [],
};
const actor = (role: RoleCode, clientId: number | null = null): Actor =>
  ({ userId: 1, tenantId: 1, clientId, name: "T", email: "t@x", roles: [role], departmentIds: [], mustChangePassword: false }) as unknown as Actor;

afterEach(cleanup);

describe("AssemblyPanel: Verify and Reject are shown only to the role the server lets verify", () => {
  // The job page feeds the panel `resolveQcAccess(actor).inspect`; run every role through it.
  it.each(Object.values(ROLES).map((r) => [r, r === ROLES.QC] as const))("%s sees Verify and Reject: %s", (role, shown) => {
    render(<AssemblyPanel jobId={1} data={data} canVerify={resolveQcAccess(actor(role)).inspect} />);
    expect(screen.getByText(/Fit-up/)).toBeTruthy(); // the first group is open by default
    expect(screen.queryAllByRole("button", { name: "Verify" }).length).toBe(shown ? 1 : 0);
    expect(screen.queryAllByRole("button", { name: "Reject" }).length).toBe(shown ? 1 : 0);
    // Everyone still gets Start on a not-started step and Submit on one in progress.
    expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Submit" })).toHaveLength(1);
  });

  it("a client user holding the QC role is not shown them either", () => {
    expect(resolveQcAccess(actor(ROLES.QC, 9)).inspect).toBe(false);
  });
});

