import { describe, expect, it } from "vitest";
import { istCalendarDayMarker, isOverdue, isOnTime } from "./business-day";

describe("istCalendarDayMarker", () => {
  it("05:29 UTC (10:59 IST) is still the previous IST calendar day's marker", () => {
    // 05:29 UTC on Aug 26 = 10:59 IST on Aug 26 — same IST day as 05:30 UTC.
    // Use a moment that actually straddles the IST midnight boundary instead:
    // 18:29 UTC Aug 25 = 23:59 IST Aug 25 (still the 25th in IST).
    const justBeforeIstMidnight = new Date("2026-08-25T18:29:00Z");
    expect(istCalendarDayMarker(justBeforeIstMidnight).toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("18:30 UTC Aug 25 (00:00 IST Aug 26) is already the next IST calendar day", () => {
    const atIstMidnight = new Date("2026-08-25T18:30:00Z");
    expect(istCalendarDayMarker(atIstMidnight).toISOString()).toBe("2026-08-26T00:00:00.000Z");
  });

  it("00:00-05:29 UTC is still the SAME IST calendar day as the UTC date itself", () => {
    // The exact regime the bug lived in: UTC midnight (00:00 UTC = 05:30 IST)
    // is well inside the IST day that started 5.5h earlier at 18:30 UTC the
    // previous day — so a raw `< now()` at UTC midnight was 5.5h premature.
    const utcMidnight = new Date("2026-08-26T00:00:00Z");
    expect(istCalendarDayMarker(utcMidnight).toISOString()).toBe("2026-08-26T00:00:00.000Z");
  });
});

describe("isOverdue", () => {
  const dueAug25 = new Date("2026-08-25T00:00:00Z"); // calendar marker, per toDateOnly's convention

  it("is NOT overdue at UTC midnight on the due date itself (the audit H1 bug)", () => {
    // 00:00 UTC Aug 25 = 05:30 IST Aug 25 — still Aug 25 in IST, the due day itself.
    expect(isOverdue(dueAug25, new Date("2026-08-25T00:00:00Z"))).toBe(false);
  });

  it("is still NOT overdue at 18:00 IST on the due date (23:59 IST)", () => {
    expect(isOverdue(dueAug25, new Date("2026-08-25T18:29:00Z"))).toBe(false);
  });

  it("IS overdue once IST midnight rolls into the next calendar day", () => {
    expect(isOverdue(dueAug25, new Date("2026-08-25T18:30:00Z"))).toBe(true);
  });

  it("null due date is never overdue", () => {
    expect(isOverdue(null)).toBe(false);
  });
});

describe("isOnTime", () => {
  const dueAug25 = new Date("2026-08-25T00:00:00Z");

  it("verifying at 16:00 IST on the due date counts as on time (Phase 0 acceptance criterion)", () => {
    // 16:00 IST Aug 25 = 10:30 UTC Aug 25.
    expect(isOnTime(new Date("2026-08-25T10:30:00Z"), dueAug25)).toBe(true);
  });

  it("verifying just after IST midnight the next day counts as late", () => {
    expect(isOnTime(new Date("2026-08-25T18:31:00Z"), dueAug25)).toBe(false);
  });

  it("null actualFinish or dueDate is never on-time", () => {
    expect(isOnTime(null, dueAug25)).toBe(false);
    expect(isOnTime(new Date(), null)).toBe(false);
  });
});
