import { describe, expect, it, afterAll } from "vitest";
import { toClientStatus, sanitizeDetail } from "./client-snapshot.read";
// Type-only import: erased at compile time, so it doesn't force-load
// @/lib/authz for the pure (non-DB) test tier — only the dynamic `await
// import` below does that, and only inside the DB-gated describe block.
import type { Actor } from "@/lib/authz";

// ── Pure sanitization (always-on tier) ──────────────────────────────────
describe("toClientStatus", () => {
  it.each([
    ["complete", "complete"],
    ["progress", "progress"],
    ["submitted", "hold"], // collapsed — same icon+label as hold, see spec §7/§8
    ["hold", "hold"],
    ["overdue", "overdue"],
    ["idle", "idle"],
  ] as const)("%s → %s", (internal, expected) => {
    expect(toClientStatus(internal)).toBe(expected);
  });
});

describe("sanitizeDetail", () => {
  it("never contains an actor name, department name, or internal enum value in its rendered form", () => {
    const raw = { stageNo: 6, stageName: "Incoming Material Inspection", status: "submitted" as const, serialNo: "320SR01" };
    const clean = sanitizeDetail(raw);
    expect(clean.stageName).toBe("Incoming Material Inspection");
    expect(clean.serialNo).toBe("320SR01");
    expect(clean.status).toBe("hold"); // not "submitted" — the raw internal value never survives
    expect(JSON.stringify(clean)).not.toMatch(/submitted|Administrator|Supervisor|MATERIAL_DELAY/i);
  });
});

// ── Scoping (DB-gated) ───────────────────────────────────────────────────
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("client-snapshot.read (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { publishSnapshot, verifySnapshot } = await import("./client-snapshot.service");
  const { loadClientPortalView, loadClientPreview } = await import("./client-snapshot.read");
  const { ROLES } = await import("@/lib/authz");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function actorBase(tenantId: number) {
    return { userId: 1, tenantId, clientId: null as number | null, name: "Test", email: "t@x", roles: [] as (typeof ROLES)[keyof typeof ROLES][], departmentIds: [] as number[], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  async function fixture() {
    const job = await owner.job.findFirstOrThrow({ where: { jobNumber: "DESPL-320" } });
    const client = await owner.client.findFirstOrThrow({ where: { id: job.clientId } });
    const clientUser = await owner.user.findFirstOrThrow({ where: { clientId: client.id } });
    return { job, client, clientUser };
  }

  it("loadClientPortalView never returns a PUBLISHED-but-unverified batch", async () => {
    const { job, clientUser } = await fixture();
    await owner.progressSnapshot.deleteMany({ where: { jobId: job.id } });
    const ph: Actor = { ...actorBase(job.tenantId), userId: 4, roles: [ROLES.PRODUCTION_HEAD] };
    await publishSnapshot(ph, { jobId: job.id });

    const asClient: Actor = { ...actorBase(job.tenantId), userId: clientUser.id, clientId: clientUser.clientId, roles: [ROLES.CLIENT_VIEWER] };
    const view = await loadClientPortalView(asClient);
    const despl320 = view.find((v) => v.jobId === job.id);
    expect(despl320?.hasUpdate).toBe(false); // nothing verified yet — must not leak the draft
  });

  it("loadClientPortalView returns the verified batch once Management verifies it", async () => {
    const { job, clientUser } = await fixture();
    const md: Actor = { ...actorBase(job.tenantId), userId: 2, roles: [ROLES.MANAGEMENT] };
    await verifySnapshot(md, { jobId: job.id });

    const asClient: Actor = { ...actorBase(job.tenantId), userId: clientUser.id, clientId: clientUser.clientId, roles: [ROLES.CLIENT_VIEWER] };
    const view = await loadClientPortalView(asClient);
    const despl320 = view.find((v) => v.jobId === job.id);
    expect(despl320?.hasUpdate).toBe(true);
    if (despl320?.hasUpdate) {
      expect(despl320.units.length).toBeGreaterThan(0);
      expect(JSON.stringify(despl320)).not.toMatch(/Administrator|Supervisor|MATERIAL_DELAY/i);
    }
  });

  it("loadClientPreview shows a Supervisor nothing (wrong role)", async () => {
    const { job } = await fixture();
    const sup: Actor = { ...actorBase(job.tenantId), userId: 14, roles: [ROLES.SUPERVISOR] };
    await expect(loadClientPreview(sup, job.id)).rejects.toThrow();
  });
});
