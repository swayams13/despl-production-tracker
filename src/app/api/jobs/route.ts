import { route } from "../_lib";
import { loadJobs } from "@/lib/services/jobs.read";

export const GET = route(async (actor) => ({ jobs: await loadJobs(actor) }));
