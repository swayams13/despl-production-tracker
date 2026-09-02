// Phase 5, D4: authors a new PRESSURE_VESSEL ProcessTemplateVersion that
// tags the Packing and Dispatch lead-time processes with `evidenceKind` so
// `verifyProcess` can gate on real proof (Task 5's Package/DispatchBatch),
// instead of an in-place edit of the currently-published version.
//
// Invariant #9 (templates are versioned; running units keep their pinned
// version): DESPL-320 is pinned to v1 today and this script does NOT
// re-point it — editing v1's TemplateProcess rows in place, or re-pinning
// the job to the new version, would change gating behaviour underneath a
// job already in flight. This script only creates v2 and publishes it; a
// human decides separately, later, whether/when to re-pin DESPL-320.
//
// Uses the real template.service.ts functions (cloneVersion, publishVersion)
// as an ADMIN actor — same "construct an Actor and call the real service"
// precedent as scripts/bootstrap-schedule.ts — rather than hand-rolling the
// draft/publish state transition. The one step with no service support is
// setting `evidenceKind` on the two rows (saveDraftVersion's schema doesn't
// carry that column yet), so that part writes directly via Prisma between
// clone and publish.
//
// MDR_COMPILED is deliberately NOT tagged on any row this phase — no task
// adds a "compile MDR" action, so tagging seq 33 would make that stage
// permanently unverifiable. Wiring the enum value/gate logic without tagging
// real data is exactly what the controller ruling asked for.
//
// Idempotent: no-ops if a version already exists with Packing/Dispatch
// already tagged.
//
// Run with: pnpm tsx scripts/add-packing-dispatch-evidence-v2.ts
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { ROLES, type Actor } from "../src/lib/authz";
import { cloneVersion, publishVersion } from "../src/lib/services/template.service";
import { isAppError, ERROR_CODES } from "../src/lib/shared/errors";

const owner = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

// TemplateProcess.seq is the 36-process lead-time-table grain, NOT the
// 25-stage work-order-report grain — verified by querying the seeded data,
// not assumed. Matched by name, not a literal seq number, so this reads
// correctly even if a future edit renumbers the table.
const PACKING_NAME = "Packing & Preservation";
const DISPATCH_NAME = "Dispatch";

async function main() {
  const org = await owner.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
  const family = await owner.productFamily.findFirstOrThrow({
    where: { tenantId: org.id, code: "PRESSURE_VESSEL" },
  });
  const template = await owner.processTemplate.findFirstOrThrow({
    where: { tenantId: org.id, familyId: family.id },
  });

  const versions = await owner.processTemplateVersion.findMany({
    where: { templateId: template.id },
    orderBy: { version: "desc" },
  });
  const published = versions.find((v) => v.status === "PUBLISHED");
  if (!published) throw new Error("PRESSURE_VESSEL template has no PUBLISHED version to base v2 on");

  // Idempotency: the current latest PUBLISHED version already carrying both
  // tags means this script already ran — nothing to do.
  const [packingTagged, dispatchTagged] = await Promise.all([
    owner.templateProcess.findFirst({
      where: { versionId: published.id, name: PACKING_NAME, evidenceKind: "PACKING_DONE" },
    }),
    owner.templateProcess.findFirst({
      where: { versionId: published.id, name: DISPATCH_NAME, evidenceKind: "DISPATCH_RECORDED" },
    }),
  ]);
  if (packingTagged && dispatchTagged) {
    console.log(`v${published.version} already tags Packing/Dispatch — nothing to do.`);
    return;
  }

  const admin = await owner.user.findFirstOrThrow({
    where: { tenantId: org.id, active: true, roles: { some: { role: { code: "ADMIN" } } } },
    select: { id: true, email: true, name: true },
  });
  const actor: Actor = {
    userId: admin.id,
    tenantId: org.id,
    clientId: null,
    name: admin.name,
    email: admin.email,
    roles: [ROLES.ADMIN],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
  };

  const draft = await cloneVersion(actor, {
    sourceVersionId: published.id,
    notes:
      "Phase 5 D4: clone of v" +
      published.version +
      " tagging Packing (evidenceKind PACKING_DONE) and Dispatch (evidenceKind DISPATCH_RECORDED) " +
      "so verifyProcess can gate on Package/DispatchBatch evidence. MDR_COMPILED intentionally left " +
      "untagged — no compile-MDR action exists yet.",
  });

  const packing = await owner.templateProcess.findFirstOrThrow({
    where: { versionId: draft.id, name: PACKING_NAME },
  });
  const dispatch = await owner.templateProcess.findFirstOrThrow({
    where: { versionId: draft.id, name: DISPATCH_NAME },
  });

  await owner.templateProcess.update({
    where: { id: packing.id },
    data: { evidenceKind: "PACKING_DONE" },
  });
  await owner.templateProcess.update({
    where: { id: dispatch.id },
    data: { evidenceKind: "DISPATCH_RECORDED" },
  });

  console.log(
    `Draft v${draft.version} (id ${draft.id}): tagged seq ${packing.seq} "${packing.name}" PACKING_DONE, ` +
      `seq ${dispatch.seq} "${dispatch.name}" DISPATCH_RECORDED.`,
  );

  // Publish through the real service — retry once with whatever warnings it
  // reports acknowledged, rather than hand-picking codes ahead of time.
  const publishNotes =
    "Phase 5 D4: Packing/Dispatch now gate verifyProcess on real evidence (Package.assign / recordDispatch). " +
    "Same route as v" + published.version + " otherwise.";
  let acknowledgedWarnings: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await publishVersion(actor, {
        versionId: draft.id,
        notes: publishNotes,
        acknowledgedWarnings: acknowledgedWarnings as never,
        expectedEnvelopeDays: null,
      });
      console.log(`Published v${result.version.version} (id ${result.version.id}).`);
      return;
    } catch (err) {
      if (attempt === 0 && isAppError(err) && err.code === ERROR_CODES.TEMPLATE_INCOMPLETE) {
        const warnings = err.detail?.unacknowledgedWarnings as string[] | undefined;
        if (warnings && warnings.length > 0) {
          console.log(`Acknowledging warnings and retrying publish: ${warnings.join(", ")}`);
          acknowledgedWarnings = warnings;
          continue;
        }
      }
      throw err;
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await owner.$disconnect();
  });
