import { route } from "../_lib";
import { loadEvents } from "@/lib/services/events.read";

// GET /api/events?job=&limit= — activity feed from the domain-event stream.
export const GET = route(async (actor, req) => {
  const url = new URL(req.url);
  const jobParam = url.searchParams.get("job");
  const limitParam = url.searchParams.get("limit");
  const jobId = jobParam != null && /^\d+$/.test(jobParam) ? Number(jobParam) : undefined;
  const limit = limitParam != null && /^\d+$/.test(limitParam) ? Number(limitParam) : undefined;
  return { events: await loadEvents(actor, { jobId, limit }) };
});
