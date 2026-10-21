"use client";

import { useState } from "react";
import type { BomReleasePreview } from "@/lib/services/bom-release.service";

/**
 * J5b: the right-hand panel of the BOM release screen: what a release would make, the warnings with
 * their single acknowledgement, and the Release button (rendered only for roles that can release,
 * so there is no dead control). Pure props in, one callback out: the page owns the write.
 */

const SCOPE_LABEL: Record<string, string> = { PER_UNIT: "per unit", PER_JOINT: "per joint", PER_COMPONENT: "per component" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why the Release button is off, or null when it can be pressed. Exported for the tests. */
export function releaseBlocker(p: { state: BomReleasePreview["state"]; dirty: boolean; warnings: number; acknowledged: boolean }): string | null {
  if (p.state !== "READY") return "This revision cannot be released as it is.";
  if (p.dirty) return "Save the mapping first. The release uses the saved mapping.";
  if (p.warnings > 0 && !p.acknowledged) return "Tick the box to confirm you have checked the warnings.";
  return null;
}

export function ReleasePanel({
  preview,
  canRelease,
  dirty,
  busy,
  onRelease,
}: {
  preview: BomReleasePreview;
  canRelease: boolean;
  dirty: boolean;
  busy: boolean;
  onRelease: (acknowledged: boolean) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { counts, warnings, state, revision } = preview;
  const blocker = releaseBlocker({ state, dirty, warnings: warnings.length, acknowledged });
  return (
    <div className="card" aria-label="Release">
      <div className="hd">
        <h3>{state === "ALREADY_RELEASED" ? `Revision ${revision.revisionNo} is released` : `Release revision ${revision.revisionNo} will make`}</h3>
      </div>
      <div style={{ padding: "0 16px 16px", display: "grid", gap: 12, fontSize: "var(--fs-md, 13px)" }}>
        {counts ? (
          <table>
            <tbody>
              <tr className="row"><td>Components</td><td className="num mono">{counts.components}</td></tr>
              <tr className="row"><td>Component operations</td><td className="num mono">{counts.operations}</td></tr>
              <tr className="row"><td>Assembly steps</td><td className="num mono">{counts.steps}</td></tr>
              {Object.entries(counts.stepsByScope).map(([scope, n]) => (
                <tr className="row" key={scope}><td style={{ paddingLeft: 24, color: "var(--muted)" }}>{SCOPE_LABEL[scope] ?? scope}</td><td className="num mono">{n}</td></tr>
              ))}
              <tr className="row"><td>Linked to QC plan points</td><td className="num mono">{counts.boundToQcp}</td></tr>
              {counts.unmappedLines > 0 && <tr className="row"><td>BOM lines without a part family</td><td className="num mono">{counts.unmappedLines}</td></tr>}
            </tbody>
          </table>
        ) : (
          <p className="note" style={{ textAlign: "left", margin: 0 }}>Nothing to show until the revision can be released.</p>
        )}

        {state === "READY" && warnings.length > 0 && (
          <div role="group" aria-label="Warnings" style={{ display: "grid", gap: 8 }}>
            {warnings.map((w) => (
              <div key={w.code} role="status">
                <span className="chip c-hold"><i />Check</span> {w.message}
                {w.items.length > 0 && <span className="mono" style={{ color: "var(--muted)" }}> {w.items.slice(0, 12).join(", ")}{w.items.length > 12 ? " …" : ""}</span>}
              </div>
            ))}
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              I have checked these
            </label>
          </div>
        )}

        {canRelease && state === "READY" && (
          <div style={{ display: "grid", gap: 6 }}>
            <div>
              <button type="button" className="btn btn-accent" disabled={blocker !== null || busy} onClick={() => onRelease(acknowledged)}>
                {busy ? "Releasing…" : `Release revision ${revision.revisionNo}`}
              </button>
            </div>
            {blocker && <span className="note" style={{ textAlign: "left", margin: 0 }}>{blocker}</span>}
            {!blocker && (
              <span className="note" style={{ textAlign: "left", margin: 0 }}>
                Makes {plural(counts?.components ?? 0, "component")} and {plural(counts?.steps ?? 0, "step")} for {plural(preview.equipment.units, "unit")}. It cannot be undone here.
              </span>
            )}
          </div>
        )}
        {!canRelease && <p className="note" style={{ textAlign: "left", margin: 0 }}>Engineering, the Production Head and Admins release the BOM.</p>}
      </div>
    </div>
  );
}
