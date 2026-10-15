import { route, intParam } from "../../../../_lib";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { loadBoardCell } from "@/lib/services/board.cell.read";

// GET /api/jobs/:id/board/cell?unit=&stage= — the Job board's Stage Sheet content (L2.4).
export const GET = route(async (actor, req, params) => {
  const jobId = intParam(params.id);
  const url = new URL(req.url);
  const cell = await loadBoardCell(actor, jobId, intParam(url.searchParams.get("unit")), intParam(url.searchParams.get("stage")));
  if (!cell) throw new AppError(ERROR_CODES.NOT_FOUND);
  return cell;
});
