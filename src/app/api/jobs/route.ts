import { route } from "../_lib";
import { loadJobs } from "@/lib/services/jobs.read";

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
  const pageSize = Math.max(1, Number(pageSizeParam) || 50);
  return await loadJobs(actor, { page, pageSize });
});
