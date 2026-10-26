// Rename a client (placeholder names from the live-jobs import show on the dashboard, jobs list,
// new-job screen and the printed traveller). One row, one audit_log row, same transaction.
//
//   npx tsx scripts/rename-client.ts --match "Unknown client" --name "Hindustan Zinc"          # dry run (default)
//   npx tsx scripts/rename-client.ts --client-id 7 --name "Hindustan Zinc" --actor-user 1 --apply
//
//   --client-id <id>   exact client (must belong to the tenant), or
//   --match "<text>"   case-insensitive substring of the current name; lists candidates, refuses unless exactly one
//   --name "<new>"     required; trimmed; refused if empty or another client in the tenant already has it
//   --actor-user <id>  optional; recorded as audit actor (must be a user of the tenant); null = script
//   --tenant <code>    default DESPL
// Production: phone hotspot, owner role (DIRECT_URL); see docs/pilot-review/PRODUCTION-BACKFILL-COMMANDS.md.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";

export class RenameClientError extends Error {
  constructor(
    public code: "NAME_EMPTY" | "NAME_TOO_LONG" | "NO_SELECTOR" | "NOT_FOUND" | "AMBIGUOUS" | "NAME_TAKEN" | "ACTOR_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export type RenameClientResult = {
  mode: "DRY_RUN" | "APPLIED" | "UNCHANGED";
  clientId: number;
  before: string;
  after: string;
  jobs: number;
  auditRows: number;
};

export async function renameClient(
  prisma: PrismaClient,
  opts: { tenantId: number; clientId?: number; match?: string; name: string; actorUserId?: number | null; apply?: boolean },
): Promise<RenameClientResult> {
  const name = opts.name.trim();
  if (!name) throw new RenameClientError("NAME_EMPTY", "--name must not be empty");
  if (name.length > 200) throw new RenameClientError("NAME_TOO_LONG", "--name is longer than 200 characters");

  const candidates = await prisma.client.findMany({
    where: {
      tenantId: opts.tenantId,
      ...(opts.clientId !== undefined ? { id: opts.clientId } : opts.match ? { name: { contains: opts.match, mode: "insensitive" } } : { id: -1 }),
    },
    select: { id: true, name: true, _count: { select: { jobs: true } } },
    orderBy: { id: "asc" },
  });
  if (opts.clientId === undefined && !opts.match?.trim()) throw new RenameClientError("NO_SELECTOR", "give --client-id or --match");
  if (candidates.length === 0) throw new RenameClientError("NOT_FOUND", "no client in this tenant matches");
  if (candidates.length > 1) {
    const list = candidates.map((c) => `  #${c.id}  ${c.name}  (${c._count.jobs} jobs)`).join("\n");
    throw new RenameClientError("AMBIGUOUS", `${candidates.length} clients match; rerun with --client-id:\n${list}`);
  }
  const target = candidates[0];

  if (opts.actorUserId != null) {
    const actor = await prisma.user.findFirst({ where: { id: opts.actorUserId, tenantId: opts.tenantId }, select: { id: true } });
    if (!actor) throw new RenameClientError("ACTOR_NOT_FOUND", `--actor-user ${opts.actorUserId} is not a user of this tenant`);
  }
  const base = { clientId: target.id, before: target.name, after: name, jobs: target._count.jobs };
  if (target.name === name) return { ...base, mode: "UNCHANGED", auditRows: 0 };

  const taken = await prisma.client.findFirst({
    where: { tenantId: opts.tenantId, id: { not: target.id }, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (taken) throw new RenameClientError("NAME_TAKEN", `client #${taken.id} already has the name "${name}"`);
  if (!opts.apply) return { ...base, mode: "DRY_RUN", auditRows: 0 };

  await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction: refuse if the name moved since the dry look.
    const now = await tx.client.findFirstOrThrow({ where: { id: target.id, tenantId: opts.tenantId }, select: { name: true } });
    if (now.name !== target.name) throw new RenameClientError("NOT_FOUND", `client #${target.id} changed during the run; rerun`);
    await tx.client.update({ where: { id: target.id }, data: { name } });
    await tx.auditLog.create({
      data: {
        tenantId: opts.tenantId,
        actorId: opts.actorUserId ?? null,
        action: "client.rename",
        entityType: "Client",
        entityId: String(target.id),
        before: { name: target.name },
        after: { name, source: "scripts/rename-client.ts" },
      },
    });
  });
  return { ...base, mode: "APPLIED", auditRows: 1 };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(url);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})`);
  const num = (n: string) => {
    const v = arg(n);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) throw new Error(`${n} must be a whole number`);
    return Number(v);
  };

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: arg("--tenant") ?? "DESPL" } });
    const r = await renameClient(prisma, {
      tenantId: org.id,
      clientId: num("--client-id"),
      match: arg("--match"),
      name: arg("--name") ?? "",
      actorUserId: num("--actor-user"),
      apply,
    });
    console.log(`client #${r.clientId} (${r.jobs} jobs)\n  before: ${r.before}\n  after:  ${r.after}`);
    console.log(
      r.mode === "APPLIED" ? `APPLIED: ${r.auditRows} audit row written.` : r.mode === "UNCHANGED" ? "Already named that; nothing to do." : "\nDry run: nothing written. Re-run with --apply.",
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("rename-client.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
