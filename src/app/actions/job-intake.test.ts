import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ERROR_CODES, ERROR_MESSAGES } from "@/lib/shared/errors";

/**
 * New-job delivery date (21 Oct 2026). A job with no committed delivery date
 * cannot be scheduled, which silently left it with no ProcessPlans. The wizard
 * action refuses it; a schedule refusal says what is missing; and the date can
 * be repaired on an existing job while the CPM replan UI stays frozen (the
 * save is allowed, the scheduler only runs for a job that has no schedule yet).
 */
const h = vi.hoisted(() => ({
  features: { cpmReplanUi: false, multiFamilyIntake: true },
  hasSchedule: false,
}));

vi.mock("@/lib/shared/flags", () => ({ FEATURES: h.features }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/session", () => ({ readSession: async () => null }));
vi.mock("@/lib/authz", () => ({
  requireActor: vi.fn(async () => ({ userId: 1, tenantId: 1, clientId: null, roles: ["PRODUCTION_HEAD"] })),
}));
vi.mock("@/lib/db", () => ({ withTenant: vi.fn() }));
vi.mock("@/lib/services/job-intake.service", () => ({
  createJob: vi.fn(async () => ({ jobId: 1 })),
  updateJobDates: vi.fn(async (_a: unknown, i: { committedDeliveryDate: Date | null }) => ({
    committedDeliveryDate: i.committedDeliveryDate,
  })),
}));
vi.mock("@/lib/services/job-intake.read", () => ({}));
vi.mock("@/lib/services/admin.service", () => ({}));
vi.mock("@/lib/services/schedule.service", () => ({
  generateSchedule: vi.fn(async () => ({ feasibility: "FEASIBLE", shortfallDays: null, processPlans: [1, 2] })),
  getSchedule: vi.fn(async () => (h.hasSchedule ? { id: 1 } : null)),
}));

const intake = await import("./job-intake");
const intakeSvc = await import("@/lib/services/job-intake.service");
const scheduleSvc = await import("@/lib/services/schedule.service");

const createInput = (committedDeliveryDate: Date | null) =>
  ({ familyId: 7, committedDeliveryDate }) as unknown as Parameters<typeof intake.createJobAction>[0];
const datesInput = (committedDeliveryDate: Date | null) => ({
  jobId: 1,
  orderDate: null,
  committedDeliveryDate,
  targetDispatchDate: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.features.cpmReplanUi = false;
  h.hasSchedule = false;
});

describe("createJobAction needs a committed delivery date", () => {
  it.each([{ name: "null", value: null }, { name: "undefined", value: undefined as unknown as null }])(
    "$name is refused with DELIVERY_DATE_REQUIRED and createJob is never reached",
    async ({ value }) => {
      const r = await intake.createJobAction(createInput(value));
      expect(r).toMatchObject({ ok: false, code: ERROR_CODES.DELIVERY_DATE_REQUIRED });
      expect(ERROR_MESSAGES.DELIVERY_DATE_REQUIRED).toMatch(/delivery date/i);
      expect(intakeSvc.createJob).not.toHaveBeenCalled();
    },
  );

  it("a date reaches createJob", async () => {
    expect(await intake.createJobAction(createInput(new Date("2026-12-31")))).toMatchObject({ ok: true });
    expect(intakeSvc.createJob).toHaveBeenCalledOnce();
  });
});

describe("scheduleNewJobAction says what is missing", () => {
  it("a missing delivery date is named, not blamed on durations", async () => {
    vi.mocked(scheduleSvc.generateSchedule).mockRejectedValueOnce(
      new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, { jobId: 1, missing: "committedDeliveryDate" }),
    );
    const v = await intake.scheduleNewJobAction(1);
    expect(v).toMatchObject({ kind: "DATA_MISSING" });
    expect((v as { message: string }).message).toMatch(/delivery date/i);
    expect((v as { message: string }).message).not.toMatch(/duration/i);
  });

  it("a duration gap keeps the duration message", async () => {
    vi.mocked(scheduleSvc.generateSchedule).mockRejectedValueOnce(
      new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, { processId: 3, code: "X" }),
    );
    const v = await intake.scheduleNewJobAction(1);
    expect((v as { message: string }).message).toMatch(/duration/i);
  });
});

describe("updateJobDatesAction while CPM replan is frozen", () => {
  it("saves the date and builds the first schedule for a job that has none", async () => {
    const r = await intake.updateJobDatesAction(datesInput(new Date("2026-12-31")));
    expect(r).toMatchObject({ ok: true, schedule: { kind: "FEASIBLE" } });
    expect(intakeSvc.updateJobDates).toHaveBeenCalledOnce();
    expect(scheduleSvc.generateSchedule).toHaveBeenCalledOnce();
  });

  it("saves the date but never re-runs the scheduler over an existing schedule", async () => {
    h.hasSchedule = true;
    const r = await intake.updateJobDatesAction(datesInput(new Date("2026-12-31")));
    expect(r).toMatchObject({ ok: true, schedule: { kind: "UNCHANGED" } });
    expect(intakeSvc.updateJobDates).toHaveBeenCalledOnce();
    expect(scheduleSvc.generateSchedule).not.toHaveBeenCalled();
  });

  it("replan switched on: re-runs the scheduler even over an existing schedule", async () => {
    h.features.cpmReplanUi = true;
    h.hasSchedule = true;
    await intake.updateJobDatesAction(datesInput(new Date("2026-12-31")));
    expect(scheduleSvc.generateSchedule).toHaveBeenCalledOnce();
  });

  it("clearing the date is refused", async () => {
    const r = await intake.updateJobDatesAction(datesInput(null));
    expect(r).toMatchObject({ ok: false, code: ERROR_CODES.DELIVERY_DATE_REQUIRED });
    expect(intakeSvc.updateJobDates).not.toHaveBeenCalled();
  });
});
