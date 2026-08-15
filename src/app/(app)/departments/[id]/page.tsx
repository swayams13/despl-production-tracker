import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadDepartmentDetail } from "@/lib/services/departments.read";
import { DepartmentDetailClient } from "./_client";

export default async function DepartmentDetail({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const { id } = await params;
  const deptId = Number(id);
  if (!Number.isInteger(deptId) || deptId <= 0) notFound();

  const dept = await loadDepartmentDetail(actor, deptId);
  if (!dept) notFound();

  return <DepartmentDetailClient dept={dept} />;
}
