import { describe, expect, it, afterAll, beforeAll } from "vitest";
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

  // Arbitrary shared lock key for DESPL-320's ProgressSnapshot rows,
  // coordinated with client-snapshot.service.test.ts — the only two files
  // that touch this job's same-day rows. Must match that file's LOCK_KEY exactly.
  const LOCK_KEY = 987654321;

  // Serialize this whole file's DB-backed tests against
  // client-snapshot.service.test.ts, which races on the same DESPL-320
  // same-day ProgressSnapshot rows when vitest runs both files in parallel
  // workers (see task-10 race-fix report). Held for the entire describe
  // block, not per-test: the "returns the verified batch" test below depends
  // on state left behind by the PRECEDING test in this same file, so a
  // per-test lock still lets client-snapshot.service.test.ts's own
  // cleanup()/deleteMany calls interleave BETWEEN those two tests in the
  // other worker and wipe the row out from under it.
  // 60s, not the 10s vitest default: under full-suite pool contention (8
  // workers sharing .env.test's connection_limit=10, plus the known
  // unrelated contention in files like portfolio.read.test.ts), the other
  // file's 13 sequential DB-gated tests can legitimately take longer than
  // 10s to finish and release this lock — that's real queueing, not a
  // deadlock. Applied to afterAll too for symmetry, though unlock+disconnect
  // shouldn't need it in practice.
  beforeAll(async () => {
    await owner.$executeRaw`SELECT pg_advisory_lock(${LOCK_KEY})`;
  }, 60000);
  afterAll(async () => {
    await owner.$executeRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    await owner.$disconnect();
  }, 60000);

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

  it("never exposes a Job column outside ClientJobView's documented key set", async () => {
    // The portal's protection is the RETURN TYPE, not the query:
    // client-snapshot.read.ts:103 calls tx.job.findMany with no `select`, so it
    // loads every column of Job — including targetDispatchDate, which is
    // DESPL's internal buffer and must never reach a client. Nothing asserted
    // that until now. A key-set comparison (not a spot check) means any future
    // column accidentally spread into the view fails here instead of shipping.
    const allowed = new Set([
      "jobId",
      "jobNumber",
      "equipmentName",
      "hasUpdate",
      "asOf",
      "overallPct",
      "forecastDispatch",
      "units",
      "unitsUnderInspection",
    ]);

    const { job, clientUser } = await fixture();
    const asClient: Actor = { ...actorBase(job.tenantId), userId: clientUser.id, clientId: clientUser.clientId, roles: [ROLES.CLIENT_VIEWER] };
    const views = await loadClientPortalView(asClient);
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      const unexpected = Object.keys(v).filter((k) => !allowed.has(k));
      expect(unexpected, `unexpected keys on ClientJobView for job ${v.jobNumber}`).toEqual([]);
    }
  });

  it("sources forecastDispatch from the committed date, never the internal target", async () => {
    const { job, clientUser } = await fixture();

    // A throwaway job, not a mutation of DESPL-320: workspace.read.test.ts
    // (:106) hard-asserts DESPL-320's own committedDeliveryDate is null as a
    // seed invariant, and this file's LOCK_KEY only coordinates against
    // client-snapshot.service.test.ts — workspace.read.test.ts isn't blocked
    // by it, and vitest runs files across parallel workers here. Mutating
    // DESPL-320's dates in place (even with a revert) left a real, if
    // narrow, race window against that assertion. A fresh job nothing else
    // references can't collide with anything, so create-then-delete
    // replaces mutate-then-revert.
    const throwaway = await owner.job.create({
      data: {
        tenantId: job.tenantId,
        publicId: crypto.randomUUID(),
        clientId: job.clientId,
        familyId: job.familyId,
        templateVersionId: job.templateVersionId,
        jobNumber: `TEST-PORTAL-DATES-${Date.now()}`,
        committedDeliveryDate: new Date("2030-06-15T00:00:00.000Z"),
        targetDispatchDate: new Date("2001-01-01T00:00:00.000Z"),
      },
    });

    try {
      // loadClientPortalView only puts forecastDispatch on a job once it has
      // a VERIFIED snapshot — insert one directly rather than routing
      // through publishSnapshot/verifySnapshot, which need real unit spines
      // this throwaway job has no reason to have.
      await owner.progressSnapshot.create({
        data: { tenantId: job.tenantId, jobId: throwaway.id, asOf: new Date(), overallPct: 0, status: "VERIFIED" },
      });

      const asClient: Actor = { ...actorBase(job.tenantId), userId: clientUser.id, clientId: clientUser.clientId, roles: [ROLES.CLIENT_VIEWER] };
      const views = await loadClientPortalView(asClient);
      const view = views.find((v) => v.jobNumber === throwaway.jobNumber);
      expect(view).toBeDefined();
      if (view && "forecastDispatch" in view) {
        expect(view.forecastDispatch).not.toContain("2001-01-01");
        expect(view.forecastDispatch).toBe("2030-06-15T00:00:00.000Z");
      }
    } finally {
      // ProgressSnapshot.job is onDelete: Cascade — deleting the job takes
      // its snapshot row with it. Zero residue either way.
      await owner.job.delete({ where: { id: throwaway.id } });
    }
  });
});

// ── Task 8: batched snapshot lookup preserves per-job attribution ───────
describe.skipIf(!RUN_DB)("loadClientPortalView — batched snapshot lookup (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("each job's hasUpdate/asOf reflect that job's own latest VERIFIED snapshot", async () => {
    try {
      const client = await owner.client.findFirst({ where: { jobs: { some: {} } } });
      if (!client) throw new Error("seed missing a client with jobs — run pnpm db:seed");
      const jobs = await owner.job.findMany({ where: { clientId: client.id } });
      if (jobs.length === 0) throw new Error("client has no jobs");

      const { loadClientPortalView } = await import("./client-snapshot.read");
      const views = await loadClientPortalView({
        userId: 1, tenantId: client.tenantId, clientId: client.id, name: "T", email: "t@despl.local",
        roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false,
      });

      for (const job of jobs) {
        const latest = await owner.progressSnapshot.findFirst({ where: { jobId: job.id, status: "VERIFIED" }, orderBy: { asOf: "desc" } });
        const view = views.find((v) => v.jobId === job.id)!;
        expect(view.hasUpdate).toBe(latest != null);
        if (latest && view.hasUpdate) expect(view.asOf === null || new Date(view.asOf).getTime() === latest.asOf.getTime()).toBe(true);
      }
    } finally {
      await owner.$disconnect();
    }
  });
});
