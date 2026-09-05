// One-off backfill (Phase 4, B5): synthesizes `ProcurementEvent` rows out of
// every pre-existing `procurements` row, ahead of migration
// 20260827120001_procurement_event_drop_procurements dropping that table for
// good. Read via `$queryRaw` rather than `prisma.procurement` — the model was
// removed from schema.prisma in this same dispatch (migration
// 20260827120000_procurement_event left the physical table alone
// deliberately, see that migration's header), so the generated client has no
// typed accessor for it any more.
//
// DEAD/REDUNDANT for a fresh `prisma migrate deploy` as of the Phase-4 fix
// wave (Critical #2): migration 20260827120001 now folds this exact logic
// into itself as a plain SQL INSERT ... SELECT that runs before its own
// guard, so an unattended deploy no longer depends on this script running in
// between. Kept as a diagnostic/dry-run tool only — e.g. to preview what the
// migration's SQL would insert against a given database before applying it.
//
// One event per non-null date field on the old row:
//   indent_date    -> INDENT_RAISED  (refNo = indent_no)
//   approved_date  -> INDENT_APPROVED
//   po_date        -> PO_PLACED      (refNo = po_no)
//   received_date  -> RECEIPT, qty = the BomItem's qtyPer, but ONLY when
//                      received_status = 'RECEIVED'. When received_status =
//                      'PARTIALLY_RECEIVED', still emit the RECEIPT event at
//                      that date but leave qty null — the old data genuinely
//                      never recorded a partial-receipt number, and inventing
//                      one would be exactly the kind of guess this codebase
//                      forbids (CLAUDE.md: flag, don't fabricate).
//
// `by` (actor) has no source in the old data either (Procurement was never
// written by anything but the seed importer — no UI writer exists). Attributed
// to each row's own tenant's "admin@despl.local" account, which is the same
// account the importer itself runs as in prisma/seed.ts/scripts/seed-despl320-
// and-de0467.ts after this dispatch's changes there.
//
// Dry-run by default — prints exactly what it would insert and exits without
// writing. Pass --apply to actually insert. Idempotent guard: skips any
// bom_item_id that already has at least one ProcurementEvent row, so a
// re-run after a partial/aborted --apply is safe.
//
// Run via `npx tsx scripts/backfill-procurement-events.ts [--apply]`.
import "dotenv/config";
import { PrismaClient, ProcurementEventType } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

interface OldProcurementRow {
  id: number;
  bom_item_id: number;
  indent_no: string | null;
  indent_date: Date | null;
  approved_date: Date | null;
  po_no: string | null;
  po_date: Date | null;
  received_status: "NOT_RECEIVED" | "PARTIALLY_RECEIVED" | "RECEIVED" | null;
  received_date: Date | null;
  qty_per: string | null; // numeric comes back as string from $queryRaw
  tenant_id: number;
}

interface PlannedEvent {
  bomItemId: number;
  type: ProcurementEventType;
  qty: string | null;
  refNo: string | null;
  at: Date;
}

async function planEvents(): Promise<{ events: PlannedEvent[]; rowCount: number; skipped: number }> {
  const rows = await prisma.$queryRaw<OldProcurementRow[]>`
    SELECT p.id, p.bom_item_id, p.indent_no, p.indent_date, p.approved_date,
           p.po_no, p.po_date, p.received_status, p.received_date,
           bi.qty_per::text AS qty_per,
           e.job_id_tenant AS tenant_id
    FROM procurements p
    JOIN bom_items bi ON bi.id = p.bom_item_id
    JOIN LATERAL (
      SELECT j.tenant_id AS job_id_tenant
      FROM equipments eq JOIN jobs j ON j.id = eq.job_id
      WHERE eq.id = bi.equipment_id
    ) e ON true
  `;

  const alreadyBackfilled = new Set(
    (await prisma.procurementEvent.findMany({ select: { bomItemId: true } })).map((r) => r.bomItemId),
  );

  const events: PlannedEvent[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (alreadyBackfilled.has(row.bom_item_id)) {
      skipped++;
      continue;
    }
    if (row.indent_date) {
      events.push({ bomItemId: row.bom_item_id, type: "INDENT_RAISED", qty: null, refNo: row.indent_no, at: row.indent_date });
    }
    if (row.approved_date) {
      events.push({ bomItemId: row.bom_item_id, type: "INDENT_APPROVED", qty: null, refNo: null, at: row.approved_date });
    }
    if (row.po_date) {
      events.push({ bomItemId: row.bom_item_id, type: "PO_PLACED", qty: null, refNo: row.po_no, at: row.po_date });
    }
    if (row.received_date) {
      const qty = row.received_status === "RECEIVED" ? row.qty_per : null;
      events.push({ bomItemId: row.bom_item_id, type: "RECEIPT", qty, refNo: null, at: row.received_date });
    }
  }
  return { events, rowCount: rows.length, skipped };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { events, rowCount, skipped } = await planEvents();

  console.log(`${rowCount} procurements row(s) found; ${skipped} bom_item_id already backfilled (skipped).`);
  console.log(`${apply ? "Inserting" : "[DRY RUN] Would insert"} ${events.length} ProcurementEvent row(s):`);
  for (const e of events) {
    console.log(`  bomItemId=${e.bomItemId}  ${e.type.padEnd(16)} at=${e.at.toISOString()}  qty=${e.qty ?? "null"}  refNo=${e.refNo ?? "null"}`);
  }

  if (!apply) {
    console.log("\nDry run only — nothing written. Re-run with --apply to insert.");
    return;
  }
  if (events.length === 0) {
    console.log("\nNothing to insert.");
    return;
  }

  // Resolve every actor BEFORE any write (task review C2): a run that fails
  // partway through used to leave whichever bomItem it stopped on with only
  // SOME of its events written, and the idempotency guard above then treats
  // that bomItem as "already backfilled" forever — silently losing the rest.
  // Failing here, before touching the DB, is what actually makes "no partial
  // writes intended" true.
  const admins = await prisma.user.findMany({
    where: { email: "admin@despl.local" },
    select: { id: true, tenantId: true },
  });
  const adminIdByTenant = new Map(admins.map((a) => [a.tenantId, a.id]));

  const bomItems = await prisma.bomItem.findMany({
    where: { id: { in: [...new Set(events.map((e) => e.bomItemId))] } },
    select: { id: true, jobId: true, equipment: { select: { job: { select: { tenantId: true } } } } },
  });
  const tenantByBomItem = new Map(bomItems.map((b) => [b.id, b.equipment.job.tenantId]));
  const jobIdByBomItem = new Map(bomItems.map((b) => [b.id, b.jobId]));

  const eventsByBomItem = new Map<number, PlannedEvent[]>();
  for (const e of events) {
    const list = eventsByBomItem.get(e.bomItemId) ?? [];
    list.push(e);
    eventsByBomItem.set(e.bomItemId, list);
  }

  const byForBomItem = new Map<number, number>();
  for (const bomItemId of eventsByBomItem.keys()) {
    const tenantId = tenantByBomItem.get(bomItemId);
    const by = tenantId != null ? adminIdByTenant.get(tenantId) : undefined;
    if (by == null) throw new Error(`No admin@despl.local user found for tenant of bomItemId=${bomItemId} — aborting before any writes.`);
    byForBomItem.set(bomItemId, by);
  }

  // One `$transaction` per bomItem (task review C2): its handful of events
  // (indent/approval/PO/receipt, at most 4) commit together or not at all —
  // a dropped connection mid-run (documented as observed, over this same DB
  // proxy, in scripts/seed-despl320-and-de0467.ts's header) leaves the
  // NEXT bomItem's events unwritten, not a partially-written one the resume
  // guard would then skip forever.
  let inserted = 0;
  for (const [bomItemId, bomItemEvents] of eventsByBomItem) {
    const by = byForBomItem.get(bomItemId)!;
    const jobId = jobIdByBomItem.get(bomItemId)!;
    await prisma.$transaction(
      bomItemEvents.map((e) =>
        prisma.procurementEvent.create({ data: { jobId, bomItemId: e.bomItemId, type: e.type, qty: e.qty, refNo: e.refNo, at: e.at, by } }),
      ),
    );
    inserted += bomItemEvents.length;
  }
  console.log(`\nInserted ${inserted} ProcurementEvent row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
