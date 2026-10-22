"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import { PageHeader } from "@/components/industrial/page-header";
import { mapBomLinesAction, releaseBomRevisionAction, startBomRevisionAction } from "@/app/actions/bom-release";
import type { BomReleaseView, ReleaseLine } from "@/lib/services/bom-release.read";
import type { BomReleaseLine, BomReleasePreview, BomReleaseResult } from "@/lib/services/bom-release.service";
import { ReleasePanel } from "./release-panel";

/**
 * Lean Core J5b (frames 14A-14B). Pick a line and a BOM revision, map each BOM line to a part family
 * and route variant, read the warnings, release. Nothing here makes floor rows except Release; the
 * write rules (roles, refusals, idempotency) are the service's. Frame sample data is placeholder.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const reasonOf = (r: { message: string; detail?: Record<string, unknown> }) => (typeof r.detail?.reason === "string" ? r.detail.reason : r.message);
const NOT_REVISION_STATE: Partial<Record<BomReleasePreview["state"], string>> = {
  ALREADY_RELEASED: "This revision is released. Its parts and steps are on the floor; releasing again changes nothing.",
  LEGACY_MATERIALIZED: "This line already has parts or steps from before the BOM release existed, so its BOM cannot be released. Existing jobs are never changed by a release.",
  SUPERSEDED: "A later revision of this line is already released. This one is kept as history.",
};

type Edit = { componentTypeId: number | null; routeVariant: string | null };

export function ReleaseClient({
  view,
  lineId,
  revisionId,
  preview,
  previewError,
}: {
  view: BomReleaseView;
  lineId: number | null;
  revisionId: number | null;
  preview: BomReleasePreview | null;
  previewError: string | null;
}) {
  const router = useRouter();
  const line = view.lines.find((l) => l.id === lineId) ?? null;
  const go = (l: number, r?: number) => router.push(`/jobs/${view.job.id}/release?line=${l}${r ? `&rev=${r}` : ""}`);

  return (
    <>
      <PageHeader title="BOM release" subtitle={`${view.job.jobNumber}${view.job.projectName ? ` · ${view.job.projectName}` : ""}`} />
      <p className="note" style={{ textAlign: "left", margin: "0 0 12px" }}>
        Releasing a BOM makes the line&apos;s parts, their operations and the assembly steps on the floor. <Link href={`/jobs/${view.job.id}?tab=materials&view=parts`}>Back to Materials</Link>
      </p>
      {view.lines.length === 0 || !line ? (
        <p className="note" style={{ textAlign: "left" }}>This job has no equipment lines, so there is no BOM to release.</p>
      ) : (
        <>
          {view.lines.length > 1 && (
            <div className="jt-sub" role="group" aria-label="Line" style={{ marginBottom: 12 }}>
              {view.lines.map((l) => (
                <button key={l.id} type="button" className={`btn${l.id === line.id ? " jt-on" : ""}`} aria-pressed={l.id === line.id} onClick={() => go(l.id)}>
                  {l.name}
                </button>
              ))}
            </div>
          )}
          <LineSection key={`${line.id}:${revisionId ?? 0}`} view={view} line={line} revisionId={revisionId} preview={preview} previewError={previewError} go={go} />
        </>
      )}
    </>
  );
}

function LineSection({
  view,
  line,
  revisionId,
  preview,
  previewError,
  go,
}: {
  view: BomReleaseView;
  line: ReleaseLine;
  revisionId: number | null;
  preview: BomReleasePreview | null;
  previewError: string | null;
  go: (line: number, rev?: number) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const draft = [...line.revisions].reverse().find((r) => r.materializedAt == null && r.status === "DRAFT") ?? null;
  const nextNo = (line.revisions[line.revisions.length - 1]?.revisionNo ?? 0) + 1;
  const [result, setResult] = useState<BomReleaseResult | null>(null);

  const startRevision = () =>
    start(async () => {
      const r = await startBomRevisionAction(view.job.id, line.id);
      if (!r.ok) return void toast.error(reasonOf(r));
      toast.success(r.created ? `Started revision ${r.revisionNo}${r.moved ? `, ${plural(r.moved, "BOM line")} moved into it` : ""}.` : `${plural(r.moved ?? 0, "BOM line")} moved into revision ${r.revisionNo}.`);
      if (r.bomRevisionId) go(line.id, r.bomRevisionId);
      else router.refresh();
    });

  if (line.legacy) {
    return (
      <p role="status" className="note" style={{ textAlign: "left" }}>
        <span className="chip c-idle"><i />Already on the floor</span> {line.name} already has parts or steps from before the BOM release existed. Its BOM cannot be released; existing jobs are never changed by a release.
      </p>
    );
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>{line.name}</h3>
          <span className="note" style={{ margin: "0 0 0 auto" }}>{plural(line.units, "unit")} · {plural(line.revisions.length, "BOM revision")}</span>
        </div>
        <div style={{ padding: "0 16px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {line.revisions.length > 0 && (
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              BOM revision
              <select className="ws-detail" value={revisionId ?? ""} onChange={(e) => go(line.id, Number(e.target.value))} aria-label="BOM revision">
                {line.revisions.map((r) => (
                  <option key={r.id} value={r.id}>
                    Revision {r.revisionNo} · {r.materializedAt ? "released" : "draft"} · {plural(r.items, "line")}
                  </option>
                ))}
              </select>
            </label>
          )}
          {view.canRelease && !draft && line.revisions.every((r) => r.materializedAt == null) && (
            <button type="button" className="btn btn-accent" disabled={pending} onClick={startRevision}>
              {pending ? "Starting…" : `Start revision ${nextNo}`}
            </button>
          )}
          {view.canRelease && draft && line.looseItems > 0 && (
            <button type="button" className="btn" disabled={pending} onClick={startRevision}>
              {pending ? "Moving…" : `Add ${plural(line.looseItems, "loose BOM line")} to revision ${draft.revisionNo}`}
            </button>
          )}
        </div>
        {line.revisions.length === 0 && (
          <p className="note" style={{ textAlign: "left", padding: "0 16px 14px", margin: 0 }}>
            No BOM revision on this line yet.{view.canRelease ? ` Start revision ${nextNo} to gather the line's BOM lines, map them and release.` : ""}
            {view.lines.length > 1 && " When a job is created only its first line gets a copied BOM; load the others under Parts and stock, or release them empty to get their assembly steps only."}
          </p>
        )}
      </div>

      {!view.canRelease ? (
        <p role="status" className="note" style={{ textAlign: "left" }}>
          <span className="chip c-idle"><i />View only</span> Engineering, the Production Head and Admins map and release the BOM. You can see which revisions exist above.
        </p>
      ) : previewError ? (
        <div role="alert" className="card" style={{ padding: 16, borderColor: "var(--s-overdue)" }}>
          <div className="chip c-overdue"><i />{previewError}</div>
          <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={() => router.refresh()}>Try again</button></div>
        </div>
      ) : preview ? (
        <Body view={view} line={line} preview={preview} result={result} onReleased={setResult} />
      ) : line.revisions.length > 0 ? (
        <p className="note" style={{ textAlign: "left" }}>Choose a BOM revision above.</p>
      ) : null}
    </>
  );
}

function Body({
  view,
  line,
  preview,
  result,
  onReleased,
}: {
  view: BomReleaseView;
  line: ReleaseLine;
  preview: BomReleasePreview;
  result: BomReleaseResult | null;
  onReleased: (r: BomReleaseResult) => void;
}) {
  const router = useRouter();
  const [edits, setEdits] = useState<Map<number, Edit>>(new Map());
  const [saving, startSaving] = useTransition();
  const [releasing, startReleasing] = useTransition();
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const editable = preview.state !== "ALREADY_RELEASED" && preview.state !== "LEGACY_MATERIALIZED" && preview.state !== "SUPERSEDED" && preview.revision.materializedAt == null;
  const families = view.families;

  const current = (l: BomReleaseLine): Edit => edits.get(l.bomItemId) ?? { componentTypeId: l.componentTypeId, routeVariant: l.routeVariant };
  const set = (l: BomReleaseLine, e: Edit) =>
    setEdits((m) => {
      const n = new Map(m);
      if (e.componentTypeId === l.componentTypeId && e.routeVariant === l.routeVariant) n.delete(l.bomItemId);
      else n.set(l.bomItemId, e);
      return n;
    });

  const save = () =>
    startSaving(async () => {
      setBanner(null);
      const r = await mapBomLinesAction(view.job.id, preview.revision.id, [...edits].map(([bomItemId, e]) => ({ bomItemId, ...e })));
      if (!r.ok) return void setBanner(reasonOf(r));
      toast.success(`Mapping saved for ${plural(r.updated ?? 0, "BOM line")}.`);
      setEdits(new Map());
      router.refresh();
    });

  const release = (acknowledged: boolean) =>
    startReleasing(async () => {
      setBanner(null);
      const r = await releaseBomRevisionAction(view.job.id, line.id, preview.revision.id, acknowledged);
      setConfirm(null);
      if (!r.ok) return void setBanner(reasonOf(r));
      toast.success(r.release?.noop ? "Already released." : "BOM released. The floor steps are made.");
      if (r.release) onReleased(r.release);
      router.refresh();
    });

  const refusals = preview.lines.filter((l) => l.issue);
  const stateNote = NOT_REVISION_STATE[preview.state];

  return (
    <div className="grid-2">
      <div className="card">
        <div className="hd">
          <h3>Revision {preview.revision.revisionNo} · BOM lines</h3>
          <span className="note" style={{ margin: "0 0 0 auto" }}>{plural(preview.lines.length, "line")}</span>
        </div>
        {stateNote && (
          <p role="status" className="note" style={{ textAlign: "left", padding: "0 16px 8px", margin: 0 }}>
            <span className="chip c-idle"><i />{preview.state === "ALREADY_RELEASED" ? "Released" : "Not releasable"}</span> {stateNote}
          </p>
        )}
        {preview.state === "REFUSED" && (
          <div role="alert" style={{ padding: "0 16px 8px", display: "grid", gap: 4 }}>
            {refusals.map((l) => (
              <div key={l.bomItemId}><span className="chip c-overdue"><i />Cannot release</span> {l.issue!.message}</div>
            ))}
            <span className="note" style={{ textAlign: "left", margin: 0 }}>Ask the Production Head to approve it in master data, or map the line to another part family.</span>
          </div>
        )}
        {banner && <div role="alert" style={{ padding: "0 16px 8px" }}><span className="chip c-overdue"><i />{banner}</span></div>}
        {preview.lines.length === 0 ? (
          <p className="note" style={{ textAlign: "left", padding: "0 16px 14px", margin: 0 }}>
            This revision has no BOM lines. It can still be released: only the steps that do not need a part are made.
            {view.lines.length > 1 && " (A copied BOM reaches the first line only. Load this line's BOM under Parts and stock if it has one.)"}
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th className="num">Item</th><th>Part</th><th className="num">Qty</th><th>Part family</th><th>Route variant</th><th>Approved</th><th className="num">Operations</th></tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => {
                  const cur = current(l);
                  const dirtyRow = edits.has(l.bomItemId);
                  const picked = families.find((f) => f.id === cur.componentTypeId);
                  return (
                    <tr className="row" key={l.bomItemId}>
                      <td className="num mono">{l.itemNo}</td>
                      <td>
                        {l.partName}
                        {l.issue && <div style={{ color: "var(--s-overdue)", fontSize: "var(--fs-sm, 12px)" }}>{l.issue.message}</div>}
                      </td>
                      <td className="num mono">{l.qtyPer ?? "—"}</td>
                      <td>
                        {editable ? (
                          <>
                            <select
                              className="ws-detail"
                              aria-label={`Part family for item ${l.itemNo}`}
                              value={cur.componentTypeId ?? ""}
                              onChange={(e) => set(l, { componentTypeId: e.target.value ? Number(e.target.value) : null, routeVariant: null })}
                            >
                              <option value="">No part family</option>
                              {families.map((f) => (
                                <option key={f.id} value={f.id}>{f.code} · {f.name}{f.approved ? "" : " (not approved)"}</option>
                              ))}
                            </select>
                            {l.suggestion && cur.componentTypeId == null && (
                              <div style={{ fontSize: "var(--fs-sm, 12px)", marginTop: 4 }}>
                                Suggested: <b>{l.suggestion.code}</b> <span style={{ color: "var(--muted)" }}>({l.suggestion.reason})</span>{" "}
                                <button type="button" className="btn" onClick={() => set(l, { componentTypeId: l.suggestion!.componentTypeId, routeVariant: null })}>Use {l.suggestion.code}</button>
                              </div>
                            )}
                          </>
                        ) : (
                          l.partFamilyCode ? <span><span className="mono">{l.partFamilyCode}</span> · {l.partFamilyName}</span> : <span style={{ color: "var(--muted)" }}>None</span>
                        )}
                      </td>
                      <td>
                        {editable && cur.componentTypeId != null ? (
                          dirtyRow && cur.componentTypeId !== l.componentTypeId ? (
                            <span className="note" style={{ margin: 0 }}>Save to choose</span>
                          ) : (
                            <select
                              className="ws-detail"
                              aria-label={`Route variant for item ${l.itemNo}`}
                              value={cur.routeVariant ?? ""}
                              onChange={(e) => set(l, { componentTypeId: cur.componentTypeId, routeVariant: e.target.value || null })}
                            >
                              <option value="">Lowest available{l.variantsAvailable[0] ? ` (${l.variantsAvailable[0]})` : ""}</option>
                              {l.variantsAvailable.map((v) => <option key={v} value={v}>Variant {v}</option>)}
                              {cur.routeVariant && !l.variantsAvailable.includes(cur.routeVariant) && <option value={cur.routeVariant}>Variant {cur.routeVariant} (no published route)</option>}
                            </select>
                          )
                        ) : (
                          <span className="mono">{l.effectiveVariant ?? "—"}</span>
                        )}
                      </td>
                      <td>
                        {cur.componentTypeId == null ? <span style={{ color: "var(--muted)" }}>—</span> : (picked?.approved ?? l.approved) ? <span className="chip c-complete"><i />Approved</span> : <span className="chip c-hold"><i />Not approved</span>}
                      </td>
                      <td className="num mono">{dirtyRow ? "—" : l.operations}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {editable && edits.size > 0 && (
          <div style={{ padding: "10px 16px 14px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-accent" disabled={saving} onClick={save}>{saving ? "Saving…" : `Save mapping (${edits.size})`}</button>
            <button type="button" className="btn" disabled={saving} onClick={() => setEdits(new Map())}>Discard changes</button>
            <span className="note" style={{ margin: 0 }}>Operations are counted after you save.</span>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
        <ReleasePanel
          key={`${preview.revision.id}:${preview.warnings.map((w) => w.code).join(",")}`}
          preview={preview}
          canRelease={view.canRelease}
          dirty={edits.size > 0}
          busy={releasing}
          onRelease={(ack) => setConfirm(ack)}
        />
        {result && (
          <div className="card" role="status">
            <div className="hd"><h3>{result.noop ? "Already released" : "Released"}</h3></div>
            <div style={{ padding: "0 16px 16px", display: "grid", gap: 8 }}>
              <p style={{ margin: 0 }}>
                {plural(result.counts.components, "component")}, {plural(result.counts.operations, "operation")}, {plural(result.counts.steps, "assembly step")}
                {result.counts.boundToQcp > 0 ? `, ${result.counts.boundToQcp} linked to the QC plan` : ""}.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Link className="btn btn-accent" href={`/jobs/${view.job.id}/board`}>Open the board</Link>
                <Link className="btn" href={`/jobs/${view.job.id}?tab=materials&view=parts`}>Back to Materials</Link>
              </div>
            </div>
          </div>
        )}
      </div>

      {confirm !== null && (
        <Modal
          open
          onOpenChange={(o) => !o && !releasing && setConfirm(null)}
          title={`Release revision ${preview.revision.revisionNo}?`}
          footer={<ModalConfirmFooter onCancel={() => setConfirm(null)} onConfirm={() => release(confirm)} confirmLabel={releasing ? "Releasing…" : "Release"} disabled={releasing} />}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <p style={{ margin: 0 }}>
              This makes {plural(preview.counts?.components ?? 0, "component")}, {plural(preview.counts?.operations ?? 0, "operation")} and {plural(preview.counts?.steps ?? 0, "assembly step")} on {line.name}, and sets the revision to released.
            </p>
            <p style={{ margin: 0, color: "var(--muted)" }}>It is written as you, in one step, and recorded in the audit log.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
