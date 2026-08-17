import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";

export default async function Profile() {
  const actor = await getActor();
  if (!actor) redirect("/login");

  return (
    <div className="page-h">
      <h1>Profile</h1>
      <span className="sub">Account information and settings coming in R2.</span>
    </div>
  );
}
