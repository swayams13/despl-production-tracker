import { describe, expect, it } from "vitest";
import { digestPreheader, digestSubject, renderDigest, type DigestPayload } from "./digest-email";

const base = (over: Partial<DigestPayload> = {}): DigestPayload => ({
  date: "2027-02-11",
  workDay: "2027-02-10",
  asOf: "2027-02-11T03:00:00Z",
  jobsAtRisk: [
    { jobNumber: "DESPL-327", health: "DELAYED", forecast: "2027-03-30", committed: "2027-03-18", slipDays: 12, percentComplete: 41, topBlocker: "Hydro test waiting on PWHT", milestone: { label: "Pressure test 20%", plannedFinish: "2027-03-12", late: true } },
    { jobNumber: "DESPL-320", health: "AT_RISK", forecast: null, committed: "2027-04-02", slipDays: null, percentComplete: 63, topBlocker: null, milestone: null },
  ],
  overdueTotal: 5,
  overdueByDept: [{ dept: "Fabrication", overdue: 3, topReason: "Material delay", topReasonCount: 2 }, { dept: "QC", overdue: 2, topReason: null, topReasonCount: 0 }],
  overrides: [{ jobNumber: "DESPL-320", serialNo: "320SR05", title: "Nozzle N2 fit-up", by: "R. Patel", at: "2027-02-10T09:40:00Z", category: "Crew or machine free", note: null }],
  overridesTotal: 1,
  unreviewedEarlyStarts: [],
  sameDay: { overall: { same: 63, total: 78, rate: 81 }, byDept: [{ dept: "QC", same: 4, total: 9, rate: 44 }, { dept: "Fabrication", same: 59, total: 69, rate: 86 }] },
  appUrl: "https://tracker.despl.in",
  ...over,
});

describe("L2.11 digest email render", () => {
  it("builds the frame's subject and preheader", () => {
    expect(digestSubject(base())).toBe("DESPL daily — 2 jobs need attention · same-day updates 81%");
    expect(digestPreheader(base())).toBe("DESPL-327 +12 d and DESPL-320 · 5 steps overdue · 1 out-of-sequence start");
  });

  it("handles singular, none-at-risk and no-updates wording", () => {
    expect(digestSubject(base({ jobsAtRisk: base().jobsAtRisk.slice(0, 1) }))).toContain("1 job needs attention");
    const quiet = base({ jobsAtRisk: [], overdueTotal: 0, overdueByDept: [], overrides: [], overridesTotal: 0, sameDay: { overall: { same: 0, total: 0, rate: null }, byDept: [] } });
    expect(digestSubject(quiet)).toBe("DESPL daily — all jobs on track · same-day updates n/a");
    const r = renderDigest(quiet);
    for (const s of ["No job is at risk this morning.", "Nothing is overdue in any department.", "No stage was started out of sequence yesterday.", "No updates were recorded yesterday."]) {
      expect(r.html).toContain(s);
      expect(r.text).toContain(s);
    }
  });

  it("lists every section, in the order given, with the dashboard link", () => {
    const { html, text } = renderDigest(base());
    expect(html.indexOf("DESPL-327")).toBeLessThan(html.indexOf("DESPL-320"));
    const rates = html.slice(html.indexOf("Same-day updates by department"));
    expect(rates.indexOf("QC")).toBeLessThan(rates.indexOf("Fabrication"));
    expect(html).toContain("Top reason: Material delay · 2");
    expect(html).toContain("No reason filed yet");
    expect(html).toContain("63 of 78");
    expect(html).toContain('href="https://tracker.despl.in/dashboard"');
    expect(text).toContain("Open dashboard: https://tracker.despl.in/dashboard");
  });

  it("J8: one milestone line per at-risk job that has a milestone map, none for a job without", () => {
    const { html, text } = renderDigest(base());
    expect(text).toContain("  Milestone: Pressure test 20%, planned finish 12 Mar (late)");
    expect(html).toContain("Milestone: Pressure test 20%, planned finish 12 Mar (late)");
    expect(text.match(/Milestone:/g)).toHaveLength(1);
  });

  it("leaves the button out without an app URL", () => {
    const r = renderDigest(base({ appUrl: null }));
    expect(r.html).not.toContain("Open dashboard");
    expect(r.text).not.toContain("Open dashboard");
  });

  it("escapes anything a user typed", () => {
    const r = renderDigest(base({ overrides: [{ ...base().overrides[0], by: `<script>alert(1)</script>`, note: `"x" & <b>` }] }));
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain("&quot;x&quot; &amp; &lt;b&gt;");
  });

  it("never claims an override was acknowledged (only the Production Head may)", () => {
    expect(renderDigest(base()).html.toLowerCase()).not.toContain("acknowledged");
  });

  it("adds one line per job for early starts waiting more than 2 working days, and nothing when none wait", () => {
    const quiet = renderDigest(base());
    expect(quiet.html).not.toContain("waiting for review");
    expect(quiet.text).not.toContain("WAITING FOR REVIEW");
    expect(digestPreheader(base())).not.toContain("not reviewed");

    const d = base({
      unreviewedEarlyStarts: [
        { jobNumber: "DESPL-320", count: 3, oldestAt: "2027-02-08T09:40:00Z" },
        { jobNumber: "DESPL-327", count: 1, oldestAt: "2027-02-09T04:00:00Z" },
      ],
    });
    const r = renderDigest(d);
    expect(r.html).toContain("Early starts waiting for review");
    expect(r.html).toContain("DESPL-320: 3 early starts not yet acknowledged by the Production Head, the oldest from 8 Feb");
    expect(r.html).toContain("DESPL-327: 1 early start not yet acknowledged");
    expect(r.text).toContain("EARLY STARTS WAITING FOR REVIEW\nDESPL-320: 3 early starts");
    expect(r.text.match(/not yet acknowledged/g)).toHaveLength(2);
    expect(digestPreheader(d)).toBe("DESPL-327 +12 d and DESPL-320 · 5 steps overdue · 1 out-of-sequence start · 4 early starts not reviewed");
  });

  it("names the weekday when the covered day is not yesterday (a Monday reports Saturday)", () => {
    const mon = renderDigest(base({ date: "2027-02-15", workDay: "2027-02-13" }));
    expect(mon.html).toContain("Out of sequence on Sat, 13 Feb");
    expect(mon.text).toContain("OUT OF SEQUENCE ON SAT, 13 FEB");
    expect(mon.html).toContain("the updates on Sat, 13 Feb were recorded the same day");
    expect(renderDigest(base()).html).toContain("Out of sequence yesterday");
  });

  it("says how many overrides were left off the list", () => {
    const r = renderDigest(base({ overridesTotal: 14 }));
    expect(r.html).toContain("and 13 more");
    expect(r.text).toContain("and 13 more");
  });

  it("states the IST send-time figures", () => {
    expect(renderDigest(base()).html).toContain("Figures are from 08:30 IST");
  });
});
