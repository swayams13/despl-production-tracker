import { expect, test } from "vitest";
import { projectComponentRoute, groupProjectedRoute } from "./bom-route";
import type { RouteStepDef, ActualOp } from "./bom-route";

function step(seq: number, operationId: number, operationName: string, leadTimeProcessSeq: number | null = null): RouteStepDef {
  return { seq, operationId, operationName, leadTimeProcessSeq };
}

function op(operationId: number, operationName: string, status: string, leadTimeProcessSeq: number | null = null): ActualOp {
  return { id: operationId, operationId, operationName, status, startedAt: null, finishedAt: null, leadTimeProcessSeq };
}

test("no route, no actual ops -> empty", () => {
  expect(projectComponentRoute([], [])).toEqual([]);
});

test("no route configured -> falls back to actual ops as-is, in order", () => {
  const actual = [op(1, "Cutting", "COMPLETE"), op(2, "Forming", "IN_PROGRESS")];
  const result = projectComponentRoute([], actual);
  expect(result.map((r) => r.operationName)).toEqual(["Cutting", "Forming"]);
  expect(result.map((r) => r.status)).toEqual(["COMPLETE", "IN_PROGRESS"]);
});

test("full route, no actual ops yet -> every step NOT_STARTED, in seq order", () => {
  const route = [step(1, 1, "Cutting"), step(2, 2, "Forming"), step(3, 3, "Welding")];
  const result = projectComponentRoute(route, []);
  expect(result.map((r) => r.operationName)).toEqual(["Cutting", "Forming", "Welding"]);
  expect(result.every((r) => r.status === "NOT_STARTED")).toBe(true);
});

test("route steps matched to actual ops by operationId, not by seq", () => {
  // Actual ComponentOperation seq numbering can diverge from the canonical
  // route's seq (live CSV only recorded a subset) — match must be on operationId.
  const route = [step(1, 1, "Cutting"), step(2, 2, "Forming"), step(3, 3, "Welding")];
  const actual = [op(1, "Cutting", "COMPLETE"), op(2, "Forming", "IN_PROGRESS")];
  const result = projectComponentRoute(route, actual);
  expect(result.map((r) => r.status)).toEqual(["COMPLETE", "IN_PROGRESS", "NOT_STARTED"]);
});

test("actual op with no matching route step (e.g. synthesized MTC verification) is appended, not dropped", () => {
  const route = [step(1, 1, "Cutting")];
  const actual = [op(1, "Cutting", "COMPLETE"), op(99, "MTC Verification", "NOT_STARTED")];
  const result = projectComponentRoute(route, actual);
  expect(result.map((r) => r.operationName)).toEqual(["Cutting", "MTC Verification"]);
});

test("id is null for a route step with no matching ComponentOperation row, and carries the real id when matched", () => {
  const route = [step(1, 1, "Cutting"), step(2, 2, "Forming")];
  const actual = [op(1, "Cutting", "COMPLETE")];
  const result = projectComponentRoute(route, actual);
  expect(result.map((r) => r.id)).toEqual([1, null]);
});

test("carries leadTimeProcessSeq through for checkpoint lookup", () => {
  const route = [step(1, 1, "Cutting", 12)];
  const result = projectComponentRoute(route, []);
  expect(result[0].leadTimeProcessSeq).toBe(12);
});

test("groupProjectedRoute: no steps complete -> nothing collapsed", () => {
  const steps = projectComponentRoute([step(1, 1, "Cutting"), step(2, 2, "Forming")], []);
  const { collapsedDoneCount, visible } = groupProjectedRoute(steps);
  expect(collapsedDoneCount).toBe(0);
  expect(visible).toHaveLength(2);
});

test("groupProjectedRoute: leading complete run collapses, current + upcoming stay visible", () => {
  const route = [step(1, 1, "Cutting"), step(2, 2, "Edge prep"), step(3, 3, "Forming"), step(4, 4, "Fit-up")];
  const actual = [op(1, "Cutting", "COMPLETE"), op(2, "Edge prep", "COMPLETE"), op(3, "Forming", "IN_PROGRESS")];
  const steps = projectComponentRoute(route, actual);
  const { collapsedDoneCount, visible } = groupProjectedRoute(steps);
  expect(collapsedDoneCount).toBe(2);
  expect(visible.map((s) => s.operationName)).toEqual(["Forming", "Fit-up"]);
});

test("groupProjectedRoute: all steps complete -> fully collapsed, nothing left visible", () => {
  const route = [step(1, 1, "Cutting"), step(2, 2, "Forming")];
  const actual = [op(1, "Cutting", "COMPLETE"), op(2, "Forming", "COMPLETE")];
  const steps = projectComponentRoute(route, actual);
  const { collapsedDoneCount, visible } = groupProjectedRoute(steps);
  expect(collapsedDoneCount).toBe(2);
  expect(visible).toEqual([]);
});

test("groupProjectedRoute: a complete step after a gap does not collapse (only a LEADING run counts)", () => {
  const route = [step(1, 1, "Cutting"), step(2, 2, "Forming"), step(3, 3, "Fit-up")];
  const actual = [op(1, "Cutting", "COMPLETE"), op(3, "Fit-up", "COMPLETE")];
  const steps = projectComponentRoute(route, actual);
  const { collapsedDoneCount, visible } = groupProjectedRoute(steps);
  expect(collapsedDoneCount).toBe(1);
  expect(visible.map((s) => s.operationName)).toEqual(["Forming", "Fit-up"]);
});
