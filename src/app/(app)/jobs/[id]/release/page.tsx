import { redirectToLogin } from "@/lib/auth/login-redirect";
import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadBomReleaseView } from "@/lib/services/bom-release.read";
import { previewBomRelease, type BomReleasePreview } from "@/lib/services/bom-release.service";
import { isAppError, messageFor } from "@/lib/shared/errors";
import { ReleaseClient } from "./_client";

/**
 * Lean Core J5b (frames 14A-14B): Engineering releases a line's BOM. Line and revision come from the
 * URL, so the screen survives a refresh and the back button. The preview is the release itself run
 * inside a rolled-back transaction, so what it shows is what Release would make.
 */
export default async function BomReleasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ line?: string; rev?: string }> }) {
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");
  const jobId = Number((await params).id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();
  const view = await loadBomReleaseView(actor, jobId).catch(() => null);
  if (!view) notFound();

  const sp = await searchParams;
  const line = view.lines.find((l) => l.id === Number(sp.line)) ?? view.lines[0] ?? null;
  const revisions = line?.revisions ?? [];
  const revision =
    revisions.find((r) => r.id === Number(sp.rev)) ??
    [...revisions].reverse().find((r) => r.materializedAt == null) ??
    revisions[revisions.length - 1] ??
    null;

  let preview: BomReleasePreview | null = null;
  let previewError: string | null = null;
  if (view.canRelease && line && revision && !line.legacy) {
    try {
      preview = await previewBomRelease(actor, { equipmentId: line.id, bomRevisionId: revision.id });
    } catch (e) {
      previewError = isAppError(e) ? messageFor(e.code, e.detail) : "The preview could not be built. Try again, and tell an administrator if it keeps failing.";
    }
  }
  return <ReleaseClient view={view} lineId={line?.id ?? null} revisionId={revision?.id ?? null} preview={preview} previewError={previewError} />;
}
