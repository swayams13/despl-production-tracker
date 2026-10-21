import { beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "@/lib/shared/errors";

/**
 * Lean Core §4 freeze (session L0.4). A frozen feature keeps its code but:
 * its routes call notFound(), its Server Actions refuse with FEATURE_FROZEN
 * before touching a service, and createJob refuses any family other than
 * PRESSURE_VESSEL server-side (hiding it in the wizard is not enough).
 *
 * `FEATURES` is swapped for a mutable copy so the last block can prove that
 * flipping a flag back on restores the original path. The real module's
 * defaults are asserted separately via importActual.
 */
const h = vi.hoisted(() => ({
  features: { clientPortal: false, multiFamilyIntake: false, cpmReplanUi: false, analytics: false, agents: false },
  familyCode: null as string | null,
}));

vi.mock("@/lib/shared/flags", () => ({ FEATURES: h.features }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/session", () => ({ readSession: async () => null }));
vi.mock("@/lib/authz", () => ({
  requireActor: vi.fn(async () => ({ userId: 1, tenantId: 1, clientId: null, roles: ["ADMIN"] })),
  getActor: vi.fn(async () => null),
}));
vi.mock("@/lib/db", () => ({
  withTenant: vi.fn(async (_tenantId: number, fn: (tx: unknown) => unknown) =>
    fn({ productFamily: { findFirst: async () => (h.familyCode ? { code: h.familyCode } : null) } }),
  ),
}));
vi.mock("@/lib/services/client-snapshot.service", () => ({
  publishSnapshot: vi.fn(),
  verifySnapshot: vi.fn(),
  rejectSnapshot: vi.fn(),
}));
vi.mock("@/lib/services/client-snapshot.read", () => ({ loadClientPortalView: vi.fn() }));
vi.mock("@/lib/services/job-intake.service", () => ({
  createJob: vi.fn(async () => ({ id: 1 })),
  updateJobDates: vi.fn(async () => ({ committedDeliveryDate: null })),
}));
vi.mock("@/lib/services/job-intake.read", () => ({}));
vi.mock("@/lib/services/admin.service", () => ({}));
vi.mock("@/lib/services/schedule.service", () => ({ generateSchedule: vi.fn(async () => ({ feasibility: "FEASIBLE", shortfallDays: null, processPlans: [] })), getSchedule: vi.fn(async () => null) }));
vi.mock("@/app/actions/auth", () => ({ logout: vi.fn() }));

const { notFound } = await import("next/navigation");
const { getActor } = await import("@/lib/authz");
const snapshotSvc = await import("@/lib/services/client-snapshot.service");
const intakeSvc = await import("@/lib/services/job-intake.service");
const snapshot = await import("./actions/client-snapshot");
const intake = await import("./actions/job-intake");
const { default: PortalPage } = await import("./portal/page");

const createInput = (familyId = 7) => ({ familyId, committedDeliveryDate: new Date("2026-12-31") }) as unknown as Parameters<typeof intake.createJobAction>[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  Object.assign(h.features, { clientPortal: false, multiFamilyIntake: false, cpmReplanUi: false, analytics: false, agents: false });
  h.familyCode = null;
});

describe("FEATURES defaults (build prompt §4)", () => {
  it("ships the five frozen switches off, plus leanFloor (L1.2e), off unless LEAN_FLOOR=on", async () => {
    const { FEATURES } = await vi.importActual<typeof import("@/lib/shared/flags")>("@/lib/shared/flags");
    const was = process.env.LEAN_FLOOR;
    try {
      delete process.env.LEAN_FLOOR;
      expect(FEATURES).toEqual({
        clientPortal: false,
        multiFamilyIntake: false,
        cpmReplanUi: false,
        analytics: false,
        agents: false,
        leanFloor: false,
      });
      for (const [value, expected] of [["on", true], ["1", false], ["off", false]] as const) {
        process.env.LEAN_FLOOR = value;
        expect(FEATURES.leanFloor, value).toBe(expected);
      }
    } finally {
      if (was === undefined) delete process.env.LEAN_FLOOR;
      else process.env.LEAN_FLOOR = was;
    }
  });
});

describe("frozen Server Actions refuse with FEATURE_FROZEN and never reach the service", () => {
  const cases: Array<{ name: string; familyCode?: string; call: () => Promise<{ ok: boolean }>; service: () => unknown }> = [
    { name: "publishSnapshotAction", call: () => snapshot.publishSnapshotAction(1), service: () => snapshotSvc.publishSnapshot },
    { name: "verifySnapshotAction", call: () => snapshot.verifySnapshotAction(1), service: () => snapshotSvc.verifySnapshot },
    { name: "rejectSnapshotAction", call: () => snapshot.rejectSnapshotAction(1, "wrong"), service: () => snapshotSvc.rejectSnapshot },
    { name: "createJobAction, HEAT_EXCHANGER", familyCode: "HEAT_EXCHANGER", call: () => intake.createJobAction(createInput()), service: () => intakeSvc.createJob },
    { name: "createJobAction, PIPE_SPOOL", familyCode: "PIPE_SPOOL", call: () => intake.createJobAction(createInput()), service: () => intakeSvc.createJob },
    { name: "createJobAction, PIPING_SYSTEM", familyCode: "PIPING_SYSTEM", call: () => intake.createJobAction(createInput()), service: () => intakeSvc.createJob },
  ];

  it.each(cases)("$name", async ({ familyCode, call, service }) => {
    h.familyCode = familyCode ?? null;
    const result = await call();
    expect(result).toMatchObject({ ok: false, code: ERROR_CODES.FEATURE_FROZEN });
    expect(service()).not.toHaveBeenCalled();
  });
});

describe("frozen routes call notFound()", () => {
  it("/portal 404s before reading the session", async () => {
    await expect(PortalPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
    expect(getActor).not.toHaveBeenCalled();
  });
});

describe("paths the freeze must not break", () => {
  it.each([
    { name: "PRESSURE_VESSEL family", familyCode: "PRESSURE_VESSEL" },
    { name: "unknown family falls through to createJob's own refusal", familyCode: null },
  ])("createJobAction: $name reaches createJob", async ({ familyCode }) => {
    h.familyCode = familyCode;
    const result = await intake.createJobAction(createInput());
    expect(result).toMatchObject({ ok: true });
    expect(intakeSvc.createJob).toHaveBeenCalledOnce();
  });
});

describe("flipping a flag on restores the original path", () => {
  it("clientPortal: publishSnapshotAction reaches the service", async () => {
    h.features.clientPortal = true;
    expect(await snapshot.publishSnapshotAction(1)).toEqual({ ok: true });
    expect(snapshotSvc.publishSnapshot).toHaveBeenCalledOnce();
  });

  it("clientPortal: /portal reads the session instead of 404ing", async () => {
    h.features.clientPortal = true;
    await expect(PortalPage()).rejects.toThrow("NEXT_REDIRECT"); // getActor() → null → /login
    expect(notFound).not.toHaveBeenCalled();
    expect(getActor).toHaveBeenCalledOnce();
  });

  it("multiFamilyIntake: a HEAT_EXCHANGER job reaches createJob", async () => {
    h.features.multiFamilyIntake = true;
    h.familyCode = "HEAT_EXCHANGER";
    expect(await intake.createJobAction(createInput())).toMatchObject({ ok: true });
    expect(intakeSvc.createJob).toHaveBeenCalledOnce();
  });
});
