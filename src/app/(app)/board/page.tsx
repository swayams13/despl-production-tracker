import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";

export default async function Board() {
  const actor = await getActor();
  if (!actor) redirect("/login");

  return (
    <div className="page-h">
      <h1>Board</h1>
      <span className="sub">Process state board (Ready, In progress, With QC, Hold, Done) coming in R2.</span>
    </div>
  );
}
