import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES } from "@/lib/authz";
import { NAV_ITEMS, activeItem, landingFor, navFor, sidebarJobs } from "./nav";

const hrefs = (items: { href: string }[]) => items.map((i) => i.href);

describe("navFor: primary items per role (build prompt §8.2 item 21, interim routes)", () => {
  const table: [string, string[]][] = [
    ["OPERATOR", ["/my-day", "/alerts"]],
    ["SUPERVISOR", ["/my-day", "/workspace", "/jobs"]],
    ["QC", ["/qc", "/jobs"]],
    ["PLANNER", ["/jobs"]],
    ["PRODUCTION_HEAD", ["/workspace", "/dashboard", "/jobs", "/jobs/new", "/admin/templates"]],
    ["MANAGEMENT", ["/dashboard", "/jobs", "/admin"]],
    ["ADMIN", ["/dashboard", "/jobs", "/jobs/new", "/admin", "/admin/templates"]],
    ["ENGINEERING", ["/jobs"]],
    ["STORES", ["/materials", "/jobs"]],
  ];
  it.each(table)("%s", (role, expected) => {
    expect(hrefs(navFor([role]).primary)).toEqual(expected);
  });

  it("Scan appears only while leanFloor is on, in the spec's position", () => {
    for (const role of ["OPERATOR", "SUPERVISOR", "QC"]) {
      expect(hrefs(navFor([role]).primary), role).not.toContain("/scan");
    }
    expect(hrefs(navFor(["OPERATOR"], { leanFloor: true }).primary)).toEqual(["/today", "/scan", "/alerts"]);
    expect(hrefs(navFor(["SUPERVISOR"], { leanFloor: true }).primary)).toEqual(["/today", "/team", "/scan", "/jobs"]);
    expect(hrefs(navFor(["QC"], { leanFloor: true }).primary)).toEqual(["/qc", "/scan", "/jobs"]);
    expect(hrefs(navFor(["PLANNER"], { leanFloor: true }).primary)).not.toContain("/scan");
  });

  it("Today is /my-day until leanFloor is on, then /today (one entry, same position)", () => {
    for (const role of ["OPERATOR", "SUPERVISOR"]) {
      expect(hrefs(navFor([role]).primary)[0]).toBe("/my-day");
      expect(hrefs(navFor([role], { leanFloor: true }).primary)[0]).toBe("/today");
    }
    expect(navFor(["SUPERVISOR"], { leanFloor: true }).primary.find((i) => i.href === "/today")?.badge).toBe("overdue");
    // a role without Today is untouched by the switch
    expect(hrefs(navFor(["QC"], { leanFloor: true }).primary)).not.toContain("/today");
  });

  it("New job is only for the roles that can create one (job-intake: ADMIN, PRODUCTION_HEAD); never a planner", () => {
    for (const on of [{}, { leanFloor: true }]) {
      expect(hrefs(navFor(["PLANNER"], on).primary)).not.toContain("/jobs/new");
      for (const r of ["ADMIN", "PRODUCTION_HEAD"]) expect(hrefs(navFor([r], on).primary), r).toContain("/jobs/new");
    }
  });

  it("Today reaches a planner only with leanFloor on (it is where processes 1-11 are recorded)", () => {
    expect(hrefs(navFor(["PLANNER"]).primary)).toEqual(["/jobs"]);
    expect(hrefs(navFor(["PLANNER"], { leanFloor: true }).primary)).toEqual(["/today", "/jobs"]);
    // no duplicate when a user also holds a floor role
    expect(hrefs(navFor(["PLANNER", "SUPERVISOR"], { leanFloor: true }).primary).filter((h) => h === "/today")).toHaveLength(1);
  });

  it("Team is /workspace until leanFloor is on, then /team, with the department overdue badge", () => {
    for (const role of ["SUPERVISOR", "PRODUCTION_HEAD"]) {
      expect(hrefs(navFor([role]).primary)).toContain("/workspace");
      const lean = navFor([role], { leanFloor: true }).primary;
      expect(hrefs(lean)).toContain("/team");
      expect(hrefs(lean)).not.toContain("/workspace");
      expect(lean.find((i) => i.href === "/team")?.badge).toBe("team");
    }
  });

  it("QC's Queue carries the waiting-for-QC badge", () => {
    expect(navFor(["QC"], { leanFloor: true }).primary.find((i) => i.href === "/qc")?.badge).toBe("qc");
  });

  it("is the union across roles with one entry per href", () => {
    const { primary, more } = navFor(["SUPERVISOR", "QC"]);
    expect(hrefs(primary)).toEqual(["/my-day", "/workspace", "/qc", "/jobs"]);
    const all = [...hrefs(primary), ...hrefs(more)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("a role's primary label wins over the more-group label for the same href", () => {
    const qc = navFor(["QC"]);
    expect(qc.primary.find((i) => i.href === "/qc")?.label).toBe("Queue");
    expect(hrefs(qc.more)).not.toContain("/qc");
    expect(navFor(["MANAGEMENT"]).more.find((i) => i.href === "/qc")?.label).toBe("QC & hold points");
  });

  it("keeps every pre-L2.1 page reachable for the roles that could see it", () => {
    for (const role of ["SUPERVISOR", "QC", "PRODUCTION_HEAD", "MANAGEMENT", "ADMIN"]) {
      const all = hrefs([...navFor([role]).primary, ...navFor([role]).more]);
      for (const h of ["/departments", "/welding", "/reports", "/qc"]) expect(all, `${role} ${h}`).toContain(h);
    }
  });

  it("every role gets a non-empty nav; unknown shape gets none", () => {
    for (const role of Object.values(ROLES)) {
      if (role === "CLIENT_VIEWER") continue; // portal user, never in the shell
      expect(navFor([role]).primary.length, role).toBeGreaterThan(0);
    }
    expect(navFor([]).primary).toEqual([]);
  });
});

describe("landingFor", () => {
  const table: [string[], string][] = [
    [["OPERATOR"], "/my-day"],
    [["SUPERVISOR"], "/my-day"],
    [["QC"], "/qc"],
    [["PLANNER"], "/jobs"],
    [["PRODUCTION_HEAD"], "/dashboard"],
    [["MANAGEMENT"], "/dashboard"],
    [["ADMIN"], "/dashboard"],
    [["ENGINEERING"], "/jobs"],
    [["STORES"], "/materials"],
    // precedence as before L2.1: management tier, then supervisor over QC
    [["SUPERVISOR", "QC"], "/my-day"],
    [["QC", "PRODUCTION_HEAD"], "/dashboard"],
    [["CLIENT_VIEWER"], "/workspace"],
    [[], "/workspace"],
  ];
  it.each(table)("%j -> %s", (roles, href) => {
    expect(landingFor(roles)).toBe(href);
  });

  it.each<[string[], string]>([
    [["OPERATOR"], "/today"],
    [["SUPERVISOR"], "/today"],
    [["SUPERVISOR", "QC"], "/today"],
    [["QC"], "/qc"],
    [["PLANNER"], "/jobs"],
    [["PRODUCTION_HEAD"], "/team"],
    [["MANAGEMENT"], "/dashboard"],
    [[], "/workspace"],
  ])("with leanFloor on: %j -> %s", (roles, href) => {
    expect(landingFor(roles, { leanFloor: true })).toBe(href);
  });
});

describe("no dead controls: every registry href is a real page", () => {
  it.each(NAV_ITEMS.flatMap((i) => [[i.id, i.href] as const, ...(i.hrefWhen ? [[`${i.id} (leanFloor)`, i.hrefWhen.leanFloor] as const] : [])]))(
    "%s -> %s",
    (_id, href) => {
      expect(existsSync(join(process.cwd(), "src/app/(app)", href, "page.tsx"))).toBe(true);
    },
  );
  it("landing targets are real pages", () => {
    for (const roles of [["OPERATOR"], ["QC"], ["PLANNER"], ["MANAGEMENT"], ["STORES"], []]) {
      expect(existsSync(join(process.cwd(), "src/app/(app)", landingFor(roles), "page.tsx"))).toBe(true);
    }
  });
});

describe("activeItem: longest segment-boundary prefix", () => {
  const { primary } = navFor(["PLANNER"]);
  it("distinguishes /jobs from /jobs/new", () => {
    expect(activeItem(primary, "/jobs")?.id).toBe("jobs");
    expect(activeItem(navFor(["ADMIN"]).primary, "/jobs/new")?.id).toBe("new-job");
    expect(activeItem(primary, "/jobs/12/activity")?.id).toBe("jobs");
  });
  it("does not match a shared string prefix", () => {
    expect(activeItem(primary, "/jobsearch")).toBeUndefined();
    expect(activeItem(primary, "/elsewhere")).toBeUndefined();
  });
});

describe("sidebarJobs", () => {
  const j = (id: number, status: string, v: number | null, o = 0) => ({
    id, jobNumber: `J${id}`, status, forecastVarianceDays: v, overduePlans: o,
  });
  it("active only, worst first, nulls last, ties by overdue, capped", () => {
    const out = sidebarJobs(
      [j(1, "ACTIVE", 2), j(2, "COMPLETE", 40), j(3, "ACTIVE", null), j(4, "ACTIVE", 9), j(5, "ACTIVE", 2, 3), j(6, "ON_HOLD", 5)],
      4,
    );
    expect(out.map((x) => x.id)).toEqual([4, 5, 1, 3]);
  });
});

describe("L2.14 Materials queue entry", () => {
  it("Stores has it as a primary item; Planning, the Production Head and Admin as a more item; nobody else", () => {
    expect(navFor(["STORES"]).primary.map((i) => i.href)).toContain("/materials");
    for (const r of ["PLANNER", "PRODUCTION_HEAD", "ADMIN"]) {
      expect(navFor([r]).more.map((i) => i.href), r).toContain("/materials");
      expect(navFor([r]).primary.map((i) => i.href), r).not.toContain("/materials");
    }
    for (const r of ["OPERATOR", "SUPERVISOR", "QC", "MANAGEMENT", "ENGINEERING"]) {
      const all = navFor([r]);
      expect([...all.primary, ...all.more].map((i) => i.href), r).not.toContain("/materials");
    }
  });
});
