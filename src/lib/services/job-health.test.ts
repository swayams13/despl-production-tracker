import { describe, expect, test } from "vitest";
import { classifyJobHealth, HEALTH_LABEL, HEALTH_ORDER, type HealthInput } from "./job-health";

const TODAY = new Date("2026-08-16T09:00:00Z");

/** A healthy ACTIVE job: scheduled, nothing overdue, forecast inside the promise. */
const base: HealthInput = {
  status: "ACTIVE",
  committedDeliveryDate: "2026-12-01T00:00:00.000Z",
  forecastDispatch: "2026-11-01T00:00:00.000Z",
  totalPlans: 36,
  overduePlans: 0,
};

const cases: [name: string, input: Partial<HealthInput>, expected: string][] = [
  ["cancelled wins over everything", { status: "CANCELLED", overduePlans: 99 }, "CANCELLED"],
  ["complete wins over overdue", { status: "COMPLETE", overduePlans: 99 }, "COMPLETED"],
  ["on hold wins over overdue", { status: "ON_HOLD", overduePlans: 99 }, "ON_HOLD"],
  ["no plans at all", { totalPlans: 0 }, "NOT_PLANNED"],
  ["no plans outranks a blown promise", { totalPlans: 0, committedDeliveryDate: "2026-01-01T00:00:00.000Z" }, "NOT_PLANNED"],
  ["promised date already passed", { committedDeliveryDate: "2026-08-15T00:00:00.000Z" }, "DELAYED"],
  ["promised today is NOT yet late", { committedDeliveryDate: "2026-08-16T00:00:00.000Z", forecastDispatch: "2026-08-16T00:00:00.000Z" }, "ON_TRACK"],
  ["forecast breaches the promise", { forecastDispatch: "2026-12-02T00:00:00.000Z" }, "DELAYED"],
  ["forecast exactly equals the promise", { forecastDispatch: "2026-12-01T00:00:00.000Z" }, "ON_TRACK"],
  ["delayed outranks at-risk", { forecastDispatch: "2026-12-02T00:00:00.000Z", overduePlans: 5 }, "DELAYED"],
  ["overdue plans with a safe forecast", { overduePlans: 1 }, "AT_RISK"],
  ["no promised date, overdue plans", { committedDeliveryDate: null, overduePlans: 1 }, "AT_RISK"],
  ["no promised date, nothing overdue", { committedDeliveryDate: null }, "ON_TRACK"],
  ["no forecast yet, nothing overdue", { forecastDispatch: null }, "ON_TRACK"],
  ["healthy baseline", {}, "ON_TRACK"],
];

describe("classifyJobHealth", () => {
  for (const [name, patch, expected] of cases) {
    test(name, () => {
      expect(classifyJobHealth({ ...base, ...patch }, TODAY)).toBe(expected);
    });
  }

  test("late-and-unclosed: promise passed, all plans complete, still ACTIVE", () => {
    const job: HealthInput = {
      status: "ACTIVE",
      committedDeliveryDate: "2026-07-28T00:00:00.000Z",
      forecastDispatch: "2026-07-20T00:00:00.000Z",
      totalPlans: 36,
      overduePlans: 0,
    };
    expect(classifyJobHealth(job, TODAY)).toBe("DELAYED");
  });

  test("is pure — the same input classifies identically twice", () => {
    expect(classifyJobHealth(base, TODAY)).toBe(classifyJobHealth(base, TODAY));
  });
});

// `HEALTH_ORDER` is a plain array, so — unlike HEALTH_LABEL/HEALTH_CLASS/SLUG,
// which are `Record<JobHealth, _>` and fail to compile when a value is missing —
// nothing stops a new health state from being added to the union and forgotten
// here, silently dropping its tile and its sort rank. HEALTH_LABEL's keys are the
// compiler-enforced complete list, so comparing against them is the cheap check.
test("HEALTH_ORDER lists every JobHealth exactly once", () => {
  expect([...HEALTH_ORDER].sort()).toEqual(Object.keys(HEALTH_LABEL).sort());
  expect(new Set(HEALTH_ORDER).size).toBe(HEALTH_ORDER.length);
});
