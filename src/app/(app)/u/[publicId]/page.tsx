import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { FEATURES } from "@/lib/shared/flags";
import { loadFloorUnit } from "@/lib/services/floor.read";
import { FloorClient } from "./_client";

/**
 * Lean Core L2.2: the Floor screen, the target of the traveller QR
 * (/u/<Unit.publicId>, an opaque id, never the serial). Behind `leanFloor`:
 * the writes it makes are recordWork's, which refuse FEATURE_FROZEN while the
 * switch is off, so the route is a plain 404 until then.
 */
export default async function FloorPage({ params }: { params: Promise<{ publicId: string }> }) {
  if (!FEATURES.leanFloor) notFound();
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const { publicId } = await params;
  const view = await loadFloorUnit(actor, publicId);
  if (!view) notFound();
  return <FloorClient view={view} />;
}
