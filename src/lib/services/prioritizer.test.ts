import { expect, test } from "vitest";
import { prioritize, type PrioritizeInput } from "./prioritizer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plan = (o: Partial<any>) => ({
  id: o.id, jobProcessId: o.jobProcessId, unitId: 1, ownerDepartmentId: o.dept ?? 10,
  status: o.status ?? "NOT_STARTED", plannedStart: null,
  plannedFinish: o.plannedFinish ?? null, scheduleRunId: 1,
  baselineStart: null, baselineFinish: null, actualStart: null, actualFinish: null,
  submittedBy: null, verifiedBy: null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

test("critical-path READY outranks a nearer-due non-critical READY", () => {
  const input: PrioritizeInput = {
    today: new Date("2026-08-14"),
    plans: [
      plan({ id: 1, jobProcessId: 1, plannedFinish: new Date("2026-09-01") }), // critical
      plan({ id: 2, jobProcessId: 2, plannedFinish: new Date("2026-08-20") }), // nearer due, not critical
    ],
    edges: [],
    floatByProcessId: new Map([[1, { totalFloat: 0, isCritical: true }], [2, { totalFloat: 5, isCritical: false }]]),
    processNameById: new Map([[1, "Shell rolling"], [2, "Painting"]]),
  };
  const ranked = prioritize(input).get(10)!;
  expect(ranked[0].plan.id).toBe(1);
  expect(ranked[0].criticalPath).toBe(true);
});

test("blocked plan names its incomplete predecessor", () => {
  const input: PrioritizeInput = {
    today: new Date("2026-08-14"),
    plans: [
      plan({ id: 1, jobProcessId: 1, status: "IN_PROGRESS" }),
      plan({ id: 2, jobProcessId: 2, status: "NOT_STARTED" }),
    ],
    edges: [{ processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 }],
    floatByProcessId: new Map([[1, { totalFloat: 0, isCritical: true }], [2, { totalFloat: 0, isCritical: true }]]),
    processNameById: new Map([[1, "Shell rolling"], [2, "Long-seam weld"]]),
  };
  const ranked = prioritize(input).get(10)!;
  const blocked = ranked.find((r) => r.plan.id === 2)!;
  expect(blocked.state).toBe("BLOCKED");
  expect(blocked.reasonText).toContain("Shell rolling");
});
