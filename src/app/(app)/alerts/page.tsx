import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";

export default async function Alerts() {
  const actor = await getActor();
  if (!actor) redirect("/login");

  return (
    <div className="page-h">
      <h1>Alerts</h1>
      <span className="sub">Delay and hold notifications coming in R2.</span>
    </div>
  );
}
