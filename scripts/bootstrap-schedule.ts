// Post-seed bootstrap — generates the DESPL-320 pilot schedule as an ADMIN
// actor, so ProcessPlan rows exist for the workspace UI to drive.
//
// Resolving tenant/admin/job happens through a short-lived OWNER client
// (DIRECT_URL, bypasses RLS) — mirrors prisma/seed.ts. generateSchedule
// itself runs through the normal app client under withTenant/RLS.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { generateSchedule } from "../src/lib/services/schedule.service";
import { ROLES, type Actor } from "../src/lib/authz";

async function resolveTargets() {
  const owner = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  });
  try {
    const org = await owner.organization.findFirst({ select: { id: true } });
    if (!org) throw new Error("bootstrap: no organization found — run pnpm db:seed first");

    const admin = await owner.user.findFirst({
      where: { tenantId: org.id, active: true, roles: { some: { role: { code: "ADMIN" } } } },
      select: { id: true },
    });
    if (!admin) throw new Error("bootstrap: no ADMIN user found — run pnpm db:seed first");

    const jobNumber = process.argv[2] ?? "DESPL-320";
    const job = await owner.job.findFirst({
      where: { tenantId: org.id, jobNumber },
      select: { id: true, orderDate: true },
    });
    if (!job) throw new Error(`bootstrap: job ${jobNumber} not found — run pnpm db:seed first`);

    return {
      tenantId: org.id,
      adminUserId: admin.id,
      jobId: job.id,
      jobNumber,
      orderDate: job.orderDate,
    };
  } finally {
    await owner.$disconnect();
  }
}

async function main() {
  const { tenantId, adminUserId, jobId, jobNumber, orderDate } = await resolveTargets();
  const admin: Actor = {
    userId: adminUserId,
    tenantId,
    clientId: null,
    name: "bootstrap",
    email: "bootstrap@local",
    roles: [ROLES.ADMIN],
    departmentIds: [],
    mustChangePassword: false,
  };
  // A job with a real order date anchors on it: that is the actual planning
  // input, not an invention. DESPL-320's order date is genuinely unknown (seed
  // leaves it null rather than fabricating one), so it keeps the synthetic
  // anchor below — ~10 weeks back, putting the pilot mid-flight so the demo has
  // a realistic spread of overdue/current/future plans for the overdue ->
  // REASON_REQUIRED delay flow (invariant #7), instead of an all-future
  // schedule where nothing is ever overdue.
  const projectStartDate = orderDate ?? new Date(Date.now() - 70 * 24 * 60 * 60 * 1000);
  const run = await generateSchedule(admin, { jobId, mode: "FORWARD", projectStartDate });
  console.log(
    `[${jobNumber}] generated schedule run ${run.id} v${run.version} with ${run.processPlans.length} plans ` +
      `(anchor ${projectStartDate.toISOString().slice(0, 10)}${orderDate ? ", real order date" : ", synthetic"}).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
