import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/authz";

// AUD-037: /qc shows every NCR in the tenant, each naming who caused it.
const { getActor, loadQcCockpit, loadQcQueue } = vi.hoisted(() => ({
  getActor: vi.fn(),
  loadQcCockpit: vi.fn(async () => ({})),
  loadQcQueue: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/auth/login-redirect", () => ({ redirectToLogin: () => Promise.reject(new Error("REDIRECT /login")) }));
vi.mock("@/lib/authz", async (orig) => ({ ...(await orig<typeof import("@/lib/authz")>()), getActor }));
vi.mock("@/lib/services/qc-cockpit.read", () => ({ loadQcCockpit }));
vi.mock("@/lib/services/qc-queue.read", async (orig) => ({ ...(await orig<typeof import("@/lib/services/qc-queue.read")>()), loadQcQueue }));
vi.mock("./_client", () => ({ QcCockpitClient: () => null }));
vi.mock("./_queue", () => ({ QcQueueClient: () => null }));

import QcCockpit from "./page";

const actor = (roles: string[], clientId: number | null = null) =>
  ({ userId: 7, tenantId: 1, clientId, name: "T", email: "t@x", roles, departmentIds: [], mustChangePassword: false }) as unknown as Actor;
const open = () => QcCockpit({ searchParams: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LEAN_FLOOR;
});

describe.each(["off", "on"])("/qc with the lean floor %s", (lean) => {
  beforeEach(() => {
    if (lean === "on") process.env.LEAN_FLOOR = "on";
  });

  it.each([["SUPERVISOR"], ["OPERATOR"], ["PLANNER"], ["STORES"], ["ENGINEERING"]])("sends a %s away without loading a single NCR", async (role) => {
    getActor.mockResolvedValue(actor([role]));
    await expect(open()).rejects.toThrow(/^REDIRECT \/(my-day|today|jobs|materials|workspace)/);
    expect(loadQcCockpit).not.toHaveBeenCalled();
    expect(loadQcQueue).not.toHaveBeenCalled();
  });

  it("sends a signed-out caller to /login", async () => {
    getActor.mockResolvedValue(null);
    await expect(open()).rejects.toThrow("REDIRECT /login");
  });

  it.each([["QC"], ["PRODUCTION_HEAD"], ["MANAGEMENT"], ["ADMIN"]])("lets a %s in", async (role) => {
    getActor.mockResolvedValue(actor([role]));
    await open();
    expect(lean === "on" ? loadQcQueue : loadQcCockpit).toHaveBeenCalledTimes(1);
  });
});
