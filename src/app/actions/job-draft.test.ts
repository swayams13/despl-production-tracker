import { describe, expect, it, vi } from "vitest";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * J7a: the draft actions are thin callers of toActionError. A FORBIDDEN refusal names the required
 * and held roles in its detail; _action.ts strips that, and these actions must not put it back.
 */
const forbidden = () => {
  throw new AppError(ERROR_CODES.FORBIDDEN, { required: ["ADMIN", "PRODUCTION_HEAD"], held: ["SUPERVISOR"], reason: "Only the Production Head turns a draft into a job." });
};
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/session", () => ({ readSession: async () => null }));
vi.mock("@/lib/authz", () => ({ requireActor: vi.fn(async () => ({ userId: 1, tenantId: 1, clientId: null, roles: ["SUPERVISOR"] })) }));
vi.mock("@/lib/services/job-draft.service", () => ({
  saveDraft: vi.fn(async () => forbidden()),
  copyJobToDraft: vi.fn(async () => forbidden()),
  releaseDraft: vi.fn(async () => forbidden()),
  discardDraft: vi.fn(async () => forbidden()),
}));
vi.mock("@/lib/services/job-preview.service", () => ({ previewJob: vi.fn(async () => forbidden()) }));
vi.mock("@/lib/services/job-intake.service", () => ({}));
vi.mock("@/lib/services/bom-upload.service", () => ({ previewBomUpload: vi.fn(async () => forbidden()) }));

const actions = await import("./job-draft");

describe("job-draft actions never leak role names in a FORBIDDEN refusal", () => {
  it.each([
    ["previewJobAction", () => actions.previewJobAction({} as never)],
    ["saveDraftAction", () => actions.saveDraftAction(undefined, {})],
    ["copyJobToDraftAction", () => actions.copyJobToDraftAction(1)],
    ["releaseDraftAction", () => actions.releaseDraftAction(1)],
    ["discardDraftAction", () => actions.discardDraftAction(1)],
    ["previewBomUploadAction", () => actions.previewBomUploadAction(Object.assign(new FormData(), { get: () => new File(["x"], "bom.xlsx") }))],
  ])("%s", async (_name, call) => {
    const r = await call();
    expect(r).toMatchObject({ ok: false, code: ERROR_CODES.FORBIDDEN });
    const detail = (r as { detail?: Record<string, unknown> }).detail;
    expect(detail).toEqual({ reason: "Only the Production Head turns a draft into a job." });
    expect(JSON.stringify(r)).not.toMatch(/SUPERVISOR|PRODUCTION_HEAD|ADMIN|required|held/);
  });
});

describe("previewBomUploadAction", () => {
  it("asks for a file when none came with the form, without calling the service", async () => {
    expect(await actions.previewBomUploadAction(new FormData())).toMatchObject({ ok: false, code: ERROR_CODES.VALIDATION_FAILED, detail: { reason: "Choose a file first." } });
  });
});
