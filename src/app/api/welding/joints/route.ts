import { route, intParam } from "../../_lib";
import { loadWeldJointOptions } from "@/lib/services/welding.read";

/** Feeds the "Record NDT result" dialog's joint picker for a chosen job. */
export const GET = route(async (actor, req) => {
  const jobId = intParam(new URL(req.url).searchParams.get("job"));
  return { joints: await loadWeldJointOptions(actor, jobId) };
});
