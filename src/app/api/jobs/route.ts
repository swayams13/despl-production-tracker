import { route } from "../_lib";
import { loadJobs } from "@/lib/services/jobs.read";

const MAX_PAGE_SIZE = 200;

/** Clamp to [1, MAX_PAGE_SIZE] — an uncapped pageSize would let a caller force
 * loadJobs's batched-extras pipeline over the whole tenant in one request,
 * defeating the point of paginating it. */
export function resolvePageSize(pageSizeParam: string | null): number {
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSizeParam) || 50));
}

export const GET = route(async (actor, req) => {
  const url = new URL(req.url);
  const pageParam = url.searchParams.get("page");
  const pageSizeParam = url.searchParams.get("pageSize");
  // Old bare-array shape preserved when neither param is present, in case an
  // undiscovered external consumer expects today's response.
  if (pageParam === null && pageSizeParam === null) {
    return { jobs: await loadJobs(actor) };
  }
  const page = Math.max(1, Number(pageParam) || 1);
  const pageSize = resolvePageSize(pageSizeParam);
  return await loadJobs(actor, { page, pageSize });
});
