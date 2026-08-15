import { route, intParam } from "../../../_lib";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { loadStageDetail } from "@/lib/services/stage-detail.read";

// GET /api/jobs/:id/stage?unit=&stage= — full StageSheet detail for one (unit, stage) (§4.5).
export const GET = route(async (actor, req, params) => {
  const jobId = intParam(params.id);
  const url = new URL(req.url);
  const unitId = intParam(url.searchParams.get("unit"));
  const stageNo = intParam(url.searchParams.get("stage"));
  const detail = await loadStageDetail(actor, jobId, unitId, stageNo);
  if (!detail) throw new AppError(ERROR_CODES.NOT_FOUND);
  return detail;
});
