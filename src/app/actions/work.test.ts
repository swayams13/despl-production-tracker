import { beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "@/lib/shared/errors";

/**
 * Lean Core L1.2e: the floor Server Actions are thin. Switch off (the default):
 * FEATURE_FROZEN, and no service is reached. Switch on: they call the service
 * as the session's actor and hand back its result; a service refusal comes back
 * as its own explainable code, and malformed input (a client-sent time) is a
 * validation refusal, not a 500.
 */
const h = vi.hoisted(() => ({ features: { leanFloor: false } }));

vi.mock("@/lib/shared/flags", () => ({ FEATURES: h.features }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/session", () => ({ readSession: async () => null }));
vi.mock("@/lib/authz", () => ({ requireActor: vi.fn(async () => ({ userId: 9, tenantId: 1, clientId: null, roles: ["QC"] })) }));
vi.mock("@/lib/services/work.service", () => ({ recordWork: vi.fn(), inspect: vi.fn() }));
vi.mock("@/lib/services/ncr.service", () => ({ raiseRuleNcr: vi.fn() }));

const svc = await import("@/lib/services/work.service");
const ncrSvc = await import("@/lib/services/ncr.service");
const { recordWorkAction, inspectAction, raiseRuleNcrAction } = await import("./work");
const { AppError } = await import("@/lib/shared/errors");
const { ZodError } = await import("zod");

const rw = { jobId: 1, action: "START" as const, items: [{ kind: "ASSEMBLY_STEP" as const, id: 1 }] };
const ins = { kind: "ASSEMBLY_STEP" as const, targetId: 1, result: "ACCEPT" as const };
const raise = { kind: "ASSEMBLY_STEP" as const, targetId: 1, rule: "H5" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  h.features.leanFloor = false;
});

describe("switch off: FEATURE_FROZEN before any service", () => {
  it.each([
    ["recordWorkAction", () => recordWorkAction(rw)],
    ["inspectAction", () => inspectAction(ins)],
    ["raiseRuleNcrAction", () => raiseRuleNcrAction(raise)],
  ])("%s", async (_n, call) => {
    expect(await call()).toMatchObject({ ok: false, code: ERROR_CODES.FEATURE_FROZEN });
    expect(svc.recordWork).not.toHaveBeenCalled();
    expect(svc.inspect).not.toHaveBeenCalled();
    expect(ncrSvc.raiseRuleNcr).not.toHaveBeenCalled();
  });
});

describe("switch on", () => {
  beforeEach(() => {
    h.features.leanFloor = true;
  });

  it("recordWorkAction calls the service as the session actor and returns its result", async () => {
    const out = { applied: [], refused: [], rolledUp: [] };
    vi.mocked(svc.recordWork).mockResolvedValue(out);
    expect(await recordWorkAction(rw)).toEqual({ ok: true, result: out });
    expect(svc.recordWork).toHaveBeenCalledWith(expect.objectContaining({ userId: 9 }), rw);
  });

  it("inspectAction calls the service as the session actor and returns its result", async () => {
    const out = { kind: "ASSEMBLY_STEP" as const, targetId: 1, result: "ACCEPT" as const, from: "SUBMITTED", to: "COMPLETE", rolledUp: [] };
    vi.mocked(svc.inspect).mockResolvedValue(out);
    expect(await inspectAction(ins)).toEqual({ ok: true, result: out });
    expect(svc.inspect).toHaveBeenCalledWith(expect.objectContaining({ userId: 9 }), ins);
  });

  it("raiseRuleNcrAction calls the service as the session actor and returns the NCR id", async () => {
    vi.mocked(ncrSvc.raiseRuleNcr).mockResolvedValue({ id: 42 } as never);
    expect(await raiseRuleNcrAction(raise)).toEqual({ ok: true, result: { ncrId: 42 } });
    expect(ncrSvc.raiseRuleNcr).toHaveBeenCalledWith(expect.objectContaining({ userId: 9 }), raise);
  });

  it("a service refusal comes back as its stable code", async () => {
    vi.mocked(svc.inspect).mockRejectedValue(new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION));
    expect(await inspectAction(ins)).toMatchObject({ ok: false, code: ERROR_CODES.MAKER_CHECKER_VIOLATION });
  });

  it("malformed input is a validation refusal, not a thrown error", async () => {
    vi.mocked(svc.recordWork).mockRejectedValue(new ZodError([]));
    expect(await recordWorkAction({ ...rw, actualStart: "2026-10-14T00:00:00Z" } as never)).toMatchObject({
      ok: false,
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  });
});
