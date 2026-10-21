// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { QcpGrid as QcpGridData } from "@/lib/services/qcp-grid.read";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/qcp", () => ({ recordQcpAction: vi.fn(), approveQcpWaiverAction: vi.fn() }));

import { QcpGrid } from "./qcp-grid";

const row = (qcpItemId: number, status: string, pendingWaiver = false) => ({
  qcpItemId, srNo: `${qcpItemId}`, activity: `Check ${qcpItemId}`, classCode: "H", acceptanceCriteria: null,
  qcCode: "H", tpiCode: null, status, ageDays: 0, pendingWaiver,
});
const data: QcpGridData = {
  unitId: 1, serialNo: "320SR01", units: [{ id: 1, serialNo: "320SR01" }],
  sections: [{ section: "A", title: "Fit-up", rows: [row(1, "Pending"), row(2, "Cleared"), row(3, "Pending waiver", true)] }],
};

afterEach(cleanup);

describe("QcpGrid: Record… only for roles the server lets record a result", () => {
  it("canRecord false (e.g. MD, CEO): no Record… button, results still shown, waiver approval unaffected", () => {
    render(<QcpGrid jobId={1} data={data} canApproveWaiver canRecord={false} />);
    expect(screen.queryByText("Record…")).toBeNull();
    expect(screen.getByText("Check 1")).toBeTruthy();
    expect(screen.getByText("Cleared")).toBeTruthy();
    expect(screen.getByText("Approve waiver")).toBeTruthy();
  });

  it("canRecord true (QC): Record… on each open row, none on a cleared or waiver-pending one", () => {
    render(<QcpGrid jobId={1} data={data} canApproveWaiver={false} canRecord />);
    expect(screen.getAllByText("Record…")).toHaveLength(1);
  });
});
