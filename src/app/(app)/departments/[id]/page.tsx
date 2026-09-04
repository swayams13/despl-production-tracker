import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadDepartmentDetail } from "@/lib/services/departments.read";
import { classifyDeptCode } from "@/lib/services/command-center.read";
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

  // Final review fix (Phase 3, Finding 1 — reachability gap): PH/ADMIN/
  // MANAGEMENT never land on /my-day (the only other inbound link to
  // /command/[dept]), but they do reach this page. Link out only for office
  // departments — a floor department's /command/[floor-code] redirects to
  // /workspace, so the link would be a dead control there (CLAUDE.md hard
  // ban). classifyDeptCode() reads Department.isOfficeDept, kept server-side
  // (imported here, not in the client component) so its DB-backed module
  // never ships to the client bundle.
  const commandCenterCode = classifyDeptCode(dept) === "office" ? dept.code.toLowerCase() : null;

  return <DepartmentDetailClient dept={dept} commandCenterCode={commandCenterCode} />;
}
