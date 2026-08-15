import { route, intParam } from "../../../_lib";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { loadJobSpines } from "@/lib/services/spine.read";

// GET /api/jobs/:id/spine — per-unit stage rows + governing_plan_id (DESIGN_SPEC §11.5).
export const GET = route(async (actor, _req, params) => {
  const jobId = intParam(params.id);
  const units = await loadJobSpines(actor, jobId);
  if (units === null) throw new AppError(ERROR_CODES.NOT_FOUND);
  return { jobId, units };
});
