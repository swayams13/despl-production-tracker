// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { StageDetail } from "@/lib/services/stage-detail.read";

const { push, info } = vi.hoisted(() => ({ push: vi.fn(), info: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info } }));
vi.mock("@/app/actions/process", () => ({ startAction: vi.fn(), submitAction: vi.fn(), verifyAction: vi.fn(), rejectAction: vi.fn() }));
vi.mock("@/app/actions/delay", () => ({ fileDelayBulkAction: vi.fn() }));
vi.mock("@/app/actions/notifications", () => ({ nudgeQcAction: vi.fn() }));

import { StageSheetLauncher, useStageSheetLauncher } from "./stage-sheet-launcher";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("openStage: a job-level step has no unit, so the click goes to the job instead of doing nothing", () => {
  it("no unit: says so, opens the job page, loads no stage", async () => {
    const { result } = renderHook(() => useStageSheetLauncher());
    await act(async () => result.current.openStage(7, undefined, 3));
    expect(info).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/jobs/7");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.sheet.open).toBe(false);
  });

  it("with a unit: loads the stage as before", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: "x" } }) });
    const { result } = renderHook(() => useStageSheetLauncher());
    await act(async () => result.current.openStage(7, 11, 3));
    expect(fetchMock).toHaveBeenCalledWith("/api/jobs/7/stage?unit=11&stage=3");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("StageSheetLauncher: Verify and Reject on a submitted stage follow the viewer's role", () => {
  const detail = (canVerify: boolean): StageDetail => ({
    canVerify, jobId: 1, jobNumber: "J-1", stageNo: 3, stageName: "Cutting", unitId: 1, serialNo: "SR01", deptName: "Fab", deptId: 1,
    status: "submitted", overduePip: false, rejectedMarker: false, plannedStart: null, plannedFinish: null, actualStart: null, actualFinish: null,
    varianceDays: null, standardDays: null, elapsedDays: null, governingPlanId: 5,
    backingPlans: [{ planId: 5, processName: "Cutting", status: "SUBMITTED", plannedStart: null, plannedFinish: null, actualStart: null, actualFinish: null, standardDays: null, submittedBy: 2, submittedByName: "A", isGoverning: true, contributingOps: [] }],
    holdPoints: [], delayReasons: [], rejections: [], delayCategories: [],
  }) as unknown as StageDetail;
  const open = (canVerify: boolean) =>
    render(<StageSheetLauncher sheet={{ open: true, loading: false, jobId: 1, detail: detail(canVerify) }} onOpenChange={() => {}} onChanged={() => {}} />);

  it.each([[true, 1], [false, 0]])("canVerify %s: %i Verify button(s) and as many Reject…", (canVerify, n) => {
    open(canVerify);
    expect(screen.queryAllByRole("button", { name: "Verify" })).toHaveLength(n);
    expect(screen.queryAllByRole("button", { name: "Reject…" })).toHaveLength(n);
  });
});
