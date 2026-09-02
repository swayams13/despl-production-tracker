import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * The action boundary (S3).
 *
 * `toActionError` is the funnel every one of the 20 Server Action modules
 * routes its failures through — i.e. every mutation in the product. Two
 * properties are asserted here:
 *
 *  1. It emits ONE structured, request-id-correlated line per refusal and per
 *     unexpected error. Before S3 it logged nothing at all, so an incident gave
 *     the operator raw Railway stdout with no trace of the primary write path.
 *  2. It maps Prisma's P2002 (unique violation) to a domain error code. Every
 *     duplicate guard in this codebase is check-then-insert against a real
 *     unique index, so each has a losing-race path that previously surfaced as
 *     an unexplained 500.
 *
 * The metas below are not invented — each was captured from a REAL duplicate
 * insert against despl_test (clone a seeded row, let the real unique index
 * reject it). That run is also what killed the original field-keyed design:
 * on an RLS-protected table Postgres withholds the constraint detail from the
 * non-owner `despl_web` role, so Job/User/Client/Welder all arrive as
 * `target: null` while non-RLS tables report snake_case columns. Hence the
 * table is keyed on `modelName` alone, and both shapes are asserted here.
 */

const headersMock = vi.fn();
const readSessionMock = vi.fn();

vi.mock("next/headers", () => ({ headers: () => headersMock() }));
vi.mock("@/lib/auth/session", () => ({ readSession: () => readSessionMock() }));

// Imported after the mocks are registered.
const { toActionError } = await import("./_action");

function p2002(modelName: string, target: string[] | null) {
  const e = new Error(
    target ? `Unique constraint failed on the fields: (\`${target.join(",")}\`)` : "Unique constraint failed on the (not available)",
  ) as Error & {
    code: string;
    meta: Record<string, unknown>;
  };
  e.name = "PrismaClientKnownRequestError";
  e.code = "P2002";
  e.meta = { modelName, target };
  return e;
}

/** The log is emitted from a floating promise; let the microtask queue drain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  headersMock.mockResolvedValue(
    new Headers({ "x-request-id": "req-123", "next-action": "act-abc", referer: "http://h/workspace?dept=2" }),
  );
  readSessionMock.mockResolvedValue({ userId: 7, tenantId: 1, clientId: null, sessionVersion: 1 });
});

afterEach(() => vi.restoreAllMocks());

describe("toActionError — P2002 mapping", () => {
  const cases: Array<{ name: string; model: string; target: string[] | null; expected: string }> = [
    // ── RLS-protected tables: target withheld by Postgres. Captured verbatim. ──
    { name: "duplicate job number", model: "Job", target: null, expected: ERROR_CODES.DUPLICATE_JOB_NUMBER },
    { name: "duplicate user identifier", model: "User", target: null, expected: ERROR_CODES.VALIDATION_FAILED },
    { name: "duplicate welder employee code", model: "Welder", target: null, expected: ERROR_CODES.VALIDATION_FAILED },
    { name: "duplicate client code", model: "Client", target: null, expected: ERROR_CODES.VALIDATION_FAILED },
    // ── No RLS: Postgres discloses snake_case columns. Captured verbatim. ──
    { name: "drawing revision race", model: "DrawingRevision", target: ["assembly_drawing_id", "revision_no"], expected: ERROR_CODES.DRAWING_REVISION_NOT_INCREASING },
    { name: "template process code", model: "TemplateProcess", target: ["version_id", "code"], expected: ERROR_CODES.TEMPLATE_INCOMPLETE },
    // No seeded BomRevision row existed to provoke this one; shape mirrors
    // DrawingRevision, which shares its migration and RLS status.
    { name: "bom revision race", model: "BomRevision", target: ["equipment_id", "revision_no"], expected: ERROR_CODES.BOM_REVISION_NOT_INCREASING },
    // A disclosed target must not change the answer — the table ignores it.
    { name: "job number with target disclosed", model: "Job", target: ["tenant_id", "job_number"], expected: ERROR_CODES.DUPLICATE_JOB_NUMBER },
    // Unmapped constraints are races on check-then-insert paths with no
    // specific domain code (qcp attemptNo, snapshot upsert, schedule run
    // version). "Someone else changed this — reload" is the honest message.
    { name: "qcp attempt race falls back", model: "QcpExecution", target: ["qcp_item_id", "unit_id", "attempt_no"], expected: ERROR_CODES.STALE_WRITE },
    { name: "unknown model falls back", model: "SomethingNew", target: ["a", "b"], expected: ERROR_CODES.STALE_WRITE },
    { name: "unknown model with no target falls back", model: "SomethingNew", target: null, expected: ERROR_CODES.STALE_WRITE },
  ];

  for (const c of cases) {
    it(`maps ${c.name}`, () => {
      const result = toActionError(p2002(c.model, c.target));
      expect(result).toEqual({ ok: false, code: c.expected, message: expect.any(String) });
    });
  }

  it("does not swallow other Prisma errors", () => {
    const e = Object.assign(new Error("connection lost"), { code: "P1001" });
    expect(() => toActionError(e)).toThrow("connection lost");
  });

  it("still rethrows plain unexpected errors", () => {
    expect(() => toActionError(new Error("boom"))).toThrow("boom");
  });

  it("still maps AppError unchanged", () => {
    const result = toActionError(new AppError(ERROR_CODES.GATING_BLOCKED, { processPlanId: 1 }));
    expect(result).toEqual({ ok: false, code: ERROR_CODES.GATING_BLOCKED, message: expect.any(String) });
  });
});

describe("toActionError — structured logging", () => {
  it("logs a refusal with the correlation key and actor", async () => {
    toActionError(new AppError(ERROR_CODES.HOLD_POINT_OPEN, { processPlanId: 4 }));
    await flush();

    expect(info).toHaveBeenCalledTimes(1);
    const [tag, payload] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(tag).toBe("[action] refused");
    expect(payload).toMatchObject({
      requestId: "req-123",
      actionId: "act-abc",
      path: "/workspace",
      userId: 7,
      tenantId: 1,
      code: ERROR_CODES.HOLD_POINT_OPEN,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("logs a mapped P2002 as an error, not a refusal — the guard lost a race", async () => {
    toActionError(p2002("Job", null));
    await flush();

    expect(error).toHaveBeenCalledTimes(1);
    const [tag, payload] = error.mock.calls[0] as [string, Record<string, unknown>];
    expect(tag).toBe("[action] unique-violation");
    // `target: null` is the normal case on an RLS table, not a defect — the
    // operator still gets the model and the mapped code.
    expect(payload).toMatchObject({
      requestId: "req-123",
      code: ERROR_CODES.DUPLICATE_JOB_NUMBER,
      model: "Job",
      target: null,
    });
  });

  it("logs an unexpected error before rethrowing", async () => {
    expect(() => toActionError(new Error("boom"))).toThrow("boom");
    await flush();

    expect(error).toHaveBeenCalledTimes(1);
    const [tag, payload] = error.mock.calls[0] as [string, Record<string, unknown>];
    expect(tag).toBe("[action] unhandled");
    expect(payload).toMatchObject({ requestId: "req-123", userId: 7, tenantId: 1 });
  });

  it("logs an unauthenticated refusal rather than throwing when there is no session", async () => {
    readSessionMock.mockResolvedValue(null);
    toActionError(new AppError(ERROR_CODES.UNAUTHENTICATED));
    await flush();

    expect(info).toHaveBeenCalledTimes(1);
    const [, payload] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ userId: null, tenantId: null, code: ERROR_CODES.UNAUTHENTICATED });
  });

  it("never lets a logging failure change the caller's result", async () => {
    headersMock.mockRejectedValue(new Error("outside request scope"));
    const result = toActionError(new AppError(ERROR_CODES.FORBIDDEN));
    expect(result).toEqual({ ok: false, code: ERROR_CODES.FORBIDDEN, message: expect.any(String) });
    await flush();
  });
});
