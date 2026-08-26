import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { NDT_REPAIR_RATE_ALERT_PCT } from "@/lib/shared/constants";

/**
 * `/welding` (§4.7). Cross-job like `/qc` and `/departments` (§9.7) — a
 * welder's productivity and repair rate are measured across every project
 * they're assigned to (FR-W4: "total work done across the projects assigned
 * to them"), not one job at a time.
 */

export interface WelderCard {
  welderId: number;
  name: string;
  roleLabel: string;
  jointsCount: number;
  vsTeamAvgPct: number | null;
  repairRatePct: number | null;
  flagged: boolean;
  sparkline14d: number[];
}

export interface OpenJointsRow {
  welderId: number;
  welderName: string;
  openCount: number;
}

export interface NdtRow {
  ndtResultId: number;
  jointNo: string;
  jobNumber: string;
  unitLabel: string;
  welderNames: string;
  testTypeCode: string;
  result: string;
  recordedAt: string | null;
}

export interface WeldingView {
  teamAvgJoints: number;
  teamRepairRatePct: number | null;
  welders: WelderCard[];
  openJointsByWelder: OpenJointsRow[];
  recentNdt: NdtRow[];
  testTypes: { id: number; code: string; name: string }[];
}

/** Pure — unit-tested directly (repair rate + the config threshold flag). */
export function repairRatePct(accept: number, reject: number): number | null {
  const total = accept + reject;
  return total > 0 ? Math.round((reject / total) * 100 * 10) / 10 : null;
}

/** Pure — "above 6% (config, not hardcoded)" per DESIGN_SPEC §4.7. */
export function isRepairRateFlagged(pct: number | null, thresholdPct = NDT_REPAIR_RATE_ALERT_PCT): boolean {
  return pct != null && pct > thresholdPct;
}

/** Pure — a welder's joint count vs the team average, as a signed percentage. */
export function deltaVsTeamAvgPct(count: number, teamAvg: number): number | null {
  return teamAvg > 0 ? Math.round(((count - teamAvg) / teamAvg) * 100) : null;
}

export async function loadWeldingView(actor: Actor): Promise<WeldingView> {
  return withTenant(actor.tenantId, async (tx) => {
    const welders = await tx.welder.findMany({
      where: { active: true },
      include: { department: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    const welderIds = welders.map((w) => w.id);

    const joints = welderIds.length
      ? await tx.weldJointWelder.findMany({
          where: { welderId: { in: welderIds } },
          select: { welderId: true, weldJoint: { select: { id: true, createdAt: true } } },
        })
      : [];

    const ndtRows = welderIds.length
      ? await tx.ndtResult.findMany({
          where: { weldJoint: { welders: { some: { welderId: { in: welderIds } } } } },
          select: { result: true, weldJoint: { select: { welders: { select: { welderId: true } } } } },
        })
      : [];

    // ── per-welder aggregates ────────────────────────────────────────────
    const jointCountByWelder = new Map<number, number>();
    const jointDatesByWelder = new Map<number, Date[]>();
    for (const j of joints) {
      jointCountByWelder.set(j.welderId, (jointCountByWelder.get(j.welderId) ?? 0) + 1);
      const arr = jointDatesByWelder.get(j.welderId) ?? [];
      arr.push(j.weldJoint.createdAt);
      jointDatesByWelder.set(j.welderId, arr);
    }

    const acceptByWelder = new Map<number, number>();
    const rejectByWelder = new Map<number, number>();
    for (const n of ndtRows) {
      for (const w of n.weldJoint.welders) {
        if (n.result === "ACCEPT") acceptByWelder.set(w.welderId, (acceptByWelder.get(w.welderId) ?? 0) + 1);
        if (n.result === "REJECT") rejectByWelder.set(w.welderId, (rejectByWelder.get(w.welderId) ?? 0) + 1);
      }
    }

    const totalJoints = [...jointCountByWelder.values()].reduce((a, b) => a + b, 0);
    const teamAvgJoints = welders.length > 0 ? Math.round((totalJoints / welders.length) * 10) / 10 : 0;
    const teamAccept = [...acceptByWelder.values()].reduce((a, b) => a + b, 0);
    const teamReject = [...rejectByWelder.values()].reduce((a, b) => a + b, 0);
    const teamRepairRatePct = repairRatePct(teamAccept, teamReject);

    const now = new Date();
    const dayKey = (d: Date) => Math.floor(d.getTime() / 864e5);
    const todayKey = dayKey(now);

    const welderCards: WelderCard[] = welders.map((w) => {
      const jointsCount = jointCountByWelder.get(w.id) ?? 0;
      const accept = acceptByWelder.get(w.id) ?? 0;
      const reject = rejectByWelder.get(w.id) ?? 0;
      const pct = repairRatePct(accept, reject);
      const dates = jointDatesByWelder.get(w.id) ?? [];
      const sparkline14d = Array.from({ length: 14 }, (_, i) => {
        const key = todayKey - (13 - i);
        return dates.filter((d) => dayKey(d) === key).length;
      });
      return {
        welderId: w.id,
        name: w.name,
        roleLabel: w.department?.name ?? "—",
        jointsCount,
        vsTeamAvgPct: deltaVsTeamAvgPct(jointsCount, teamAvgJoints),
        repairRatePct: pct,
        flagged: isRepairRateFlagged(pct),
        sparkline14d,
      };
    });

    // ── open joints per welder (no NDT yet, or latest result still PENDING) ─
    const jointIds = joints.map((j) => j.weldJoint.id);
    const latestResultByJoint = new Map<number, string>();
    if (jointIds.length) {
      const allNdt = await tx.ndtResult.findMany({
        where: { weldJointId: { in: [...new Set(jointIds)] } },
        orderBy: { id: "desc" },
        select: { weldJointId: true, result: true },
      });
      for (const n of allNdt) {
        if (!latestResultByJoint.has(n.weldJointId)) latestResultByJoint.set(n.weldJointId, n.result);
      }
    }
    const openCountByWelder = new Map<number, number>();
    for (const j of joints) {
      const latest = latestResultByJoint.get(j.weldJoint.id);
      if (latest == null || latest === "PENDING") {
        openCountByWelder.set(j.welderId, (openCountByWelder.get(j.welderId) ?? 0) + 1);
      }
    }
    const openJointsByWelder: OpenJointsRow[] = welders
      .map((w) => ({ welderId: w.id, welderName: w.name, openCount: openCountByWelder.get(w.id) ?? 0 }))
      .filter((r) => r.openCount > 0)
      .sort((a, b) => b.openCount - a.openCount);

    // ── recent NDT results, most recent first ───────────────────────────
    const recent = await tx.ndtResult.findMany({
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      take: 12,
      include: {
        testType: { select: { code: true } },
        weldJoint: {
          select: {
            jointNo: true,
            job: { select: { jobNumber: true } },
            unit: { select: { serialNo: true } },
            welders: { select: { welder: { select: { name: true } } } },
          },
        },
      },
    });
    const recentNdt: NdtRow[] = recent.map((n) => ({
      ndtResultId: n.id,
      jointNo: n.weldJoint.jointNo,
      jobNumber: n.weldJoint.job.jobNumber,
      unitLabel: n.weldJoint.unit ? `Unit ${n.weldJoint.unit.serialNo}` : "—",
      welderNames: n.weldJoint.welders.map((w) => w.welder.name).join(", "),
      testTypeCode: n.testType.code,
      result: n.result,
      recordedAt: n.recordedAt ? n.recordedAt.toISOString() : null,
    }));

    const testTypes = await tx.testTypeRef.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });

    return {
      teamAvgJoints,
      teamRepairRatePct,
      welders: welderCards,
      openJointsByWelder,
      recentNdt,
      testTypes,
    };
  });
}

export interface WeldJointOption {
  weldJointId: number;
  jointNo: string;
  jobNumber: string;
  unitLabel: string;
}

/** Feeds the "record result" picker — joints logged for a job (any unit). */
export async function loadWeldJointOptions(actor: Actor, jobId: number): Promise<WeldJointOption[]> {
  return withTenant(actor.tenantId, async (tx) => {
    // `weld_joints` carries no tenant_id (audit H4): a bare `jobId` filter let
    // any authenticated user enumerate every weld joint, WPS ref and unit
    // serial in the DB by guessing/incrementing job ids. Anchor through `job`,
    // which IS tenant-scoped.
    const joints = await tx.weldJoint.findMany({
      where: { jobId, job: { tenantId: actor.tenantId } },
      orderBy: { createdAt: "desc" },
      include: { job: { select: { jobNumber: true } }, unit: { select: { serialNo: true } } },
    });
    return joints.map((j) => ({
      weldJointId: j.id,
      jointNo: j.jointNo,
      jobNumber: j.job.jobNumber,
      unitLabel: j.unit ? `Unit ${j.unit.serialNo}` : "—",
    }));
  });
}
