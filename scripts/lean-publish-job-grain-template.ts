// Lean Core L1.3 (Q5): publish a new PRESSURE_VESSEL process template version whose office processes
// (D5: codes 1-11 and 33) carry grain = JOB, so jobs created from it get ONE plan per job for them.
//
//   pnpm exec tsx scripts/lean-publish-job-grain-template.ts                       # dry run (default): writes nothing
//   pnpm exec tsx scripts/lean-publish-job-grain-template.ts --apply               # clone, set grain, publish
//   ... --actor-user <id>   the user recorded in the audit log (default: first active ADMIN of tenant DESPL)
//
// Invariant 9: the published version is never edited. The script clones it (template.service cloneVersion),
// changes `grain` on the DRAFT clone only, and publishes it (publishVersion). Running jobs keep their pin.
// Why Prisma for the grain and not saveDraftVersion: saveDraftVersion is a full replace, and a one-column
// change does not need one. cloneVersion carries every column (J4c fixed template-copy.ts, which used to drop
// evidenceKind and includeWhen; template-copy.test.ts proves it), and the script still refuses to publish if
// the clone differs from the source in anything but grain.
// Idempotent: nothing to do once the newest PUBLISHED version already has JOB on all of those codes.
// Run with the owner URL (DIRECT_URL), like the other backfills; rehearse on a restored dump first.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { JOB_GRAIN_PROCESS_CODES } from "../src/lib/shared/job-grain";

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const actorArg = argv[argv.indexOf("--actor-user") + 1];
  const actorUserId = argv.includes("--actor-user") && actorArg ? Number(actorArg) : null;
  if (argv.includes("--actor-user") && !Number.isInteger(actorUserId)) throw new Error("--actor-user needs a user id");
  if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
  if (!process.env.DATABASE_URL) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(process.env.DATABASE_URL);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})`);

  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
    const family = await prisma.productFamily.findFirstOrThrow({ where: { tenantId: org.id, code: "PRESSURE_VESSEL" } });
    const template = await prisma.processTemplate.findFirstOrThrow({ where: { tenantId: org.id, familyId: family.id } });
    const source = await prisma.processTemplateVersion.findFirst({
      where: { templateId: template.id, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
    if (!source) throw new Error("PRESSURE_VESSEL template has no PUBLISHED version to base the new one on");

    const rows = await prisma.templateProcess.findMany({ where: { versionId: source.id }, orderBy: { seq: "asc" } });
    const wanted = new Set<string>(JOB_GRAIN_PROCESS_CODES);
    const present = rows.filter((r) => wanted.has(r.code));
    const missing = [...wanted].filter((c) => !present.some((r) => r.code === c));
    const toChange = present.filter((r) => r.grain !== "JOB");
    console.log(
      `source: v${source.version} (id ${source.id}), ${rows.length} processes; D5 codes present ${present.length}/${wanted.size}` +
        (missing.length ? ` (missing: ${missing.join(", ")})` : "") +
        `; to switch UNIT -> JOB: ${toChange.map((r) => r.code).join(", ") || "none"}`,
    );
    if (toChange.length === 0) {
      console.log("Nothing to do: the newest published version already has JOB grain on every D5 code.");
      return;
    }
    if (!apply) {
      console.log(`\nDRY RUN: would clone v${source.version} to v${source.version + 1} (DRAFT), set grain JOB on ${toChange.length} process(es), publish. Pass --apply to write.`);
      return;
    }

    const user = actorUserId
      ? await prisma.user.findFirstOrThrow({ where: { id: actorUserId, tenantId: org.id, active: true }, include: { roles: { include: { role: true } } } })
      : await prisma.user.findFirstOrThrow({
          where: { tenantId: org.id, active: true, roles: { some: { role: { code: "ADMIN" } } } },
          orderBy: { id: "asc" },
          include: { roles: { include: { role: true } } },
        });
    const actor = {
      userId: user.id, tenantId: org.id, clientId: null, name: user.name, email: user.email,
      roles: user.roles.map((r) => r.role.code), departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false,
    } as never;
    console.log(`actor: user ${user.id} (${user.email})`);

    // Dynamic import: the services read DATABASE_URL when first loaded, so it must be set to the owner URL first.
    const { cloneVersion, publishVersion } = await import("../src/lib/services/template.service");
    const { isAppError, ERROR_CODES } = await import("../src/lib/shared/errors");

    const draft = await cloneVersion(actor, {
      sourceVersionId: source.id,
      notes: `L1.3: clone of v${source.version} with grain JOB on office processes ${[...wanted].join(", ")} (one plan per job).`,
    });
    await prisma.templateProcess.updateMany({ where: { versionId: draft.id, code: { in: [...wanted] } }, data: { grain: "JOB" } });
    // Faithful clone check: every column except grain (on the D5 codes) must match the source.
    const finalRows = await prisma.templateProcess.findMany({ where: { versionId: draft.id } });
    const strip = (r: Record<string, unknown>) => {
      const { id: _id, versionId: _v, ...rest } = r;
      return rest;
    };
    for (const r of rows) {
      const c = finalRows.find((x) => x.code === r.code)!;
      const expected = { ...strip(r), ...(wanted.has(r.code) ? { grain: "JOB" } : {}) };
      if (JSON.stringify(strip(c)) !== JSON.stringify(expected)) {
        throw new Error(`clone of process ${r.code} differs from the source beyond grain; draft ${draft.id} left unpublished`);
      }
    }
    console.log(`Draft v${draft.version} (id ${draft.id}): grain JOB on ${toChange.map((r) => r.code).join(", ")}.`);

    let acknowledgedWarnings: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await publishVersion(actor, {
          versionId: draft.id,
          notes: `L1.3: office processes ${[...wanted].join(", ")} are JOB grain. Same route as v${source.version} otherwise.`,
          acknowledgedWarnings: acknowledgedWarnings as never,
          expectedEnvelopeDays: null,
        });
        console.log(`Published v${result.version.version} (id ${result.version.id}). Running jobs keep their pinned version.`);
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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
