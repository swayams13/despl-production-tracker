import { route, intParam } from "../../../_lib";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { loadJobSpines, rollupJobSpine } from "@/lib/services/spine.read";

// GET /api/jobs/:id/rollup — the job-level mini spine for the app shell's topbar (AUD-020). One
// job's `v_unit_stage_status` rows collapsed across units, instead of the shell loading it for every job.
export const GET = route(async (actor, _req, params) => {
  const jobId = intParam(params.id);
  const units = await loadJobSpines(actor, jobId);
  if (units === null) throw new AppError(ERROR_CODES.NOT_FOUND);
  return { jobId, rollup: rollupJobSpine(units) };
});
