import { describe, expect, test } from "vitest";
import { jobSwitchHref, jobTabUrl, parseMaterialsView, resolveJobTab } from "./job-tabs";

describe("resolveJobTab", () => {
  const lean = { lean: true, clientPortal: false };
  const legacy = { lean: false, clientPortal: false };
  test.each([
    // lean: own names stay, hidden assembly stays, old names redirect, junk -> overview
    ["overview", lean, { tab: "overview", redirect: false }],
    ["schedule", lean, { tab: "schedule", redirect: false }],
    ["materials", lean, { tab: "materials", redirect: false }],
    ["qc", lean, { tab: "qc", redirect: false }],
    ["dispatch", lean, { tab: "dispatch", redirect: false }],
    ["history", lean, { tab: "history", redirect: false }],
    ["assembly", lean, { tab: "assembly", redirect: false }],
    ["gantt", lean, { tab: "schedule", redirect: true, extra: undefined }],
    ["bom", lean, { tab: "materials", redirect: true, extra: { view: "parts" } }],
    ["qcp", lean, { tab: "qc", redirect: true, extra: undefined }],
    ["packing", lean, { tab: "dispatch", redirect: true, extra: undefined }],
    ["activity", lean, { tab: "history", redirect: true, extra: undefined }],
    ["client", lean, { tab: "overview", redirect: false }], // frozen: client portal off
    ["nonsense", lean, { tab: "overview", redirect: false }],
    [undefined, lean, { tab: "overview", redirect: false }],
    // flag off: today's names, lean names mapped back
    ["gantt", legacy, { tab: "gantt", redirect: false }],
    ["bom", legacy, { tab: "bom", redirect: false }],
    ["schedule", legacy, { tab: "gantt", redirect: true }],
    ["materials", legacy, { tab: "bom", redirect: true }],
    ["qc", legacy, { tab: "qcp", redirect: true }],
    ["history", legacy, { tab: "activity", redirect: true }],
    ["dispatch", legacy, { tab: "dispatch", redirect: false }],
    ["client", legacy, { tab: "overview", redirect: false }],
  ] as const)("%s (lean=%j)", (param, opts, want) => {
    expect(resolveJobTab(param, opts)).toMatchObject(want);
  });

  test("client tab only while the portal is unfrozen", () => {
    expect(resolveJobTab("client", { lean: true, clientPortal: true }).tab).toBe("client");
    expect(resolveJobTab("client", { lean: false, clientPortal: true }).tab).toBe("client");
  });
});

test("parseMaterialsView", () => {
  expect(parseMaterialsView("parts")).toBe("parts");
  expect(parseMaterialsView("pipeline")).toBe("pipeline");
  expect(parseMaterialsView(undefined)).toBe("pipeline");
});

describe("jobSwitchHref keeps the tab", () => {
  test.each([
    ["/jobs/12", "?tab=qc", 34, "/jobs/34?tab=qc"],
    ["/jobs/12", "?tab=materials&view=parts&unit=5", 34, "/jobs/34?tab=materials"],
    ["/jobs/12", "", 34, "/jobs/34"],
    ["/jobs/12", "?tab=../x", 34, "/jobs/34"],
    ["/jobs/12/board", "?dept=3", 34, "/jobs/34/board"],
    ["/jobs/12/activity/7/3", "", 34, "/jobs/34"],
  ])("%s%s -> job %i", (path, search, id, want) => {
    expect(jobSwitchHref(path, search, id)).toBe(want);
  });
});

test("jobTabUrl swaps the tab, keeps the other params, adds extras", () => {
  expect(jobTabUrl(5, "materials", { tab: "bom", equipment: "3", unit: ["7", "8"] }, { view: "parts" })).toBe("/jobs/5?tab=materials&equipment=3&unit=7&view=parts");
  expect(jobTabUrl(5, "schedule", { tab: "gantt" })).toBe("/jobs/5?tab=schedule");
});
