import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { FEATURES } from "@/lib/shared/flags";
import { applyBoardFilter, parseBoardFilter } from "@/lib/shared/board";
import { loadJobBoard } from "@/lib/services/board.read";
import { BoardClient } from "./_client";

/**
 * Lean Core L2.4: the Job board. Read-only anywhere; its Start / Mark done and
 * QC Accept / Reject are recordWork's and inspect's, which exist only while
 * `leanFloor` is on, so the sheet shows those actions only then. Filters live
 * in the URL (shareable, back-button safe) and are applied here.
 */
export default async function JobBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const jobId = Number((await params).id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();

  const view = await loadJobBoard(actor, jobId);
  if (!view) notFound();

  const filter = parseBoardFilter(await searchParams);
  const { stageNos, unitIds } = applyBoardFilter(
    {
      stages: view.stages.map((s) => ({ stageNo: s.stageNo, departmentId: s.departmentId })),
      units: view.units.map((u) => ({ unitId: u.unitId, cells: u.cells })),
    },
    filter,
  );

  return <BoardClient jobId={jobId} view={view} filter={filter} stageNos={stageNos} unitIds={unitIds} leanFloor={FEATURES.leanFloor} />;
}
