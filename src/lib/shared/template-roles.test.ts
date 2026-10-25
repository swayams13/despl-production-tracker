import { describe, expect, it } from "vitest";
import { planTemplateRoles } from "./template-roles";

/**
 * L1.2h: fill a template version's step roles from the reviewed mapping, never overwriting.
 * Violation and misalignment cases first.
 */
const t = (seq: number, role: string | null = null, jointRef: string | null = null, pressurePart = false) => ({ seq, role, jointRef, pressurePart });
const m = (seq: number, role: string | null, jointRef: string | null = null, pressurePart = false) => ({ seq, role, jointRef, pressurePart });

describe("planTemplateRoles", () => {
  it.each([
    ["a template step the mapping does not cover", [t(1), t(2)], [m(1, "WELD")], { unmapped: [2], unknown: [] }],
    ["a mapping row the template does not have", [t(1)], [m(1, "WELD"), m(9, "NDT")], { unmapped: [], unknown: [9] }],
    ["both at once", [t(1), t(3)], [m(1, null), m(2, null)], { unmapped: [3], unknown: [2] }],
  ])("%s is reported, so the caller can refuse", (_l, template, mapping, expected) => {
    const plan = planTemplateRoles(template, mapping);
    expect({ unmapped: plan.unmapped, unknown: plan.unknown }).toEqual(expected);
  });

  it("never overwrites a role, joint or pressure flag that is already set", () => {
    const plan = planTemplateRoles([t(1, "FIT_UP", "LS-1", true)], [m(1, "WELD", "CS-1", true)]);
    expect(plan.fills).toEqual([]);
    expect(plan.already).toBe(1);
  });

  it.each([
    ["role only", t(1), m(1, "FIT_UP"), { role: "FIT_UP" }],
    ["role and joint", t(1), m(1, "WELD", "LS-1"), { role: "WELD", jointRef: "LS-1" }],
    ["pressure flag false to true", t(1), m(1, null, null, true), { pressurePart: true }],
    ["a set role is kept, an empty joint is filled", t(1, "WELD"), m(1, "NDT", "CS-2"), { jointRef: "CS-2" }],
    ["a mapped null role stays null", t(1), m(1, null, "LS-1"), { jointRef: "LS-1" }],
  ])("fills only the empty facts: %s", (_l, template, mapping, set) => {
    expect(planTemplateRoles([template], [mapping]).fills).toEqual([{ seq: 1, set }]);
  });

  it("a step the mapping leaves bare (no role, no joint, not pressure) needs nothing", () => {
    const plan = planTemplateRoles([t(1)], [m(1, null)]);
    expect(plan).toMatchObject({ fills: [], already: 1, unmapped: [], unknown: [] });
  });

  it("is idempotent: applying the fills and planning again plans nothing", () => {
    const template = [t(1), t(2, "WELD", null, false), t(3)];
    const mapping = [m(1, "FIT_UP", "LS-1", true), m(2, "WELD", "LS-1", true), m(3, "HYDRO")];
    const first = planTemplateRoles(template, mapping);
    const applied = template.map((s) => ({ ...s, ...(first.fills.find((f) => f.seq === s.seq)?.set ?? {}) }));
    const second = planTemplateRoles(applied, mapping);
    expect(second.fills).toEqual([]);
    expect(second.already).toBe(3);
  });

  it("does not mutate its inputs", () => {
    const template = [t(1)];
    const mapping = [m(1, "WELD", "LS-1", true)];
    const before = JSON.stringify([template, mapping]);
    planTemplateRoles(template, mapping);
    expect(JSON.stringify([template, mapping])).toBe(before);
  });
});
