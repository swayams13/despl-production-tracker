import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";

/**
 * Activity feed — backs `GET /api/events?job=`. Reads the append-only
 * `domain_events` stream (the intended activity/agent source), resolving each
 * event's process/unit context and actor. Tenant RLS scopes the stream; the
 * optional job filter joins through the plan → job_process → job chain.
 *
 * ponytail: dept filter (§5 `&dept=`) is deferred — no consumer needs it until
 * the department activity panel (§9.7). Add a `department_id` predicate on the
 * job_process join when that page lands.
 */
export interface ActivityEvent {
  id: string;
  type: string;
  label: string;
  at: string;
  actorName: string | null;
  processName: string | null;
  serialNo: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  ProcessStarted: "started",
  ProcessSubmitted: "submitted for QC",
  ProcessVerified: "verified",
  ProcessHeld: "put on hold",
  ProcessResumed: "resumed",
  ProcessRejected: "rejected",
};

interface Row {
  id: bigint;
  type: string;
  at: Date;
  actor_name: string | null;
  process_name: string | null;
  serial_no: string | null;
  category_name: string | null;
}

export async function loadEvents(
  actor: Actor,
  opts: { jobId?: number; limit?: number } = {},
): Promise<ActivityEvent[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return withTenant(actor.tenantId, async (tx) => {
    if (opts.jobId != null) {
      const job = await tx.job.findUnique({ where: { id: opts.jobId }, select: { clientId: true } });
      if (!job) return [];
      assertClientScope(actor, job.clientId);
    }

    // aggregate_id holds the ProcessPlan (or, for DelayReasonFiled, the
    // DelayReason) id as text; cast to join each event type's own context.
    // Two branches, not one join, because the two aggregate types reach
    // process/unit context through different foreign keys (pp.id directly vs
    // dr.process_plan_id).
    const rows = await tx.$queryRaw<Row[]>`
      SELECT de.id, de.type, de.at,
             usr.name    AS actor_name,
             jp.name     AS process_name,
             u.serial_no AS serial_no,
             NULL::text  AS category_name
      FROM domain_events de
      LEFT JOIN process_plans pp ON pp.id::text = de.aggregate_id
      LEFT JOIN job_processes jp ON jp.id = pp.job_process_id
      LEFT JOIN units u          ON u.id = pp.unit_id
      LEFT JOIN users usr        ON usr.id = de.actor_id
      WHERE de.aggregate_type = 'ProcessPlan'
        AND (${opts.jobId ?? null}::int IS NULL OR jp.job_id = ${opts.jobId ?? null}::int)

      UNION ALL

      SELECT de.id, de.type, de.at,
             usr.name    AS actor_name,
             jp.name     AS process_name,
             u.serial_no AS serial_no,
             dc.name     AS category_name
      FROM domain_events de
      JOIN delay_reasons dr           ON dr.id::text = de.aggregate_id
      LEFT JOIN delay_category_refs dc ON dc.id = dr.category_id
      LEFT JOIN process_plans pp      ON pp.id = dr.process_plan_id
      LEFT JOIN job_processes jp      ON jp.id = pp.job_process_id
      LEFT JOIN units u               ON u.id = pp.unit_id
      LEFT JOIN users usr             ON usr.id = de.actor_id
      WHERE de.aggregate_type = 'DelayReason'
        AND (${opts.jobId ?? null}::int IS NULL OR jp.job_id = ${opts.jobId ?? null}::int)

      ORDER BY at DESC, id DESC
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      id: r.id.toString(),
      type: r.type,
      label:
        r.type === "DelayReasonFiled"
          ? `filed a delay reason${r.category_name ? ` — ${r.category_name}` : ""}`
          : (TYPE_LABELS[r.type] ?? r.type),
      at: r.at.toISOString(),
      actorName: r.actor_name,
      processName: r.process_name,
      serialNo: r.serial_no,
    }));
  });
}
