import { route } from "../../_lib";
import { loadJobPercents, loadShellJobs } from "@/lib/services/jobs.read";

// GET /api/jobs/percent — % complete of the jobs the app shell lists, fetched when the job switcher is
// opened instead of on every page (AUD-020). Same figure as the job list's `percentComplete`.
export const GET = route(async (actor) => {
  const jobs = await loadShellJobs(actor);
  return { percents: await loadJobPercents(actor, jobs.map((j) => j.id)) };
});
