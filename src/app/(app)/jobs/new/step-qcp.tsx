"use client";

import { plural } from "@/lib/shared/plural";
import type { IntakeOptions } from "@/lib/services/job-intake.read";
import type { WizardState } from "./wizard-state";

/** Frame 13E, first cut: pick the QC plan the job starts from. Editing the plan per client is not built. */
export function StepQcp({ state, patch, options }: { state: WizardState; patch: (p: Partial<WizardState>) => void; options: IntakeOptions }) {
  const gaps = (id: number) => (state.familyId != null ? options.qcpTemplates.find((q) => q.id === id)?.assemblyGaps[state.familyId]?.length ?? 0 : 0);
  const chosen = options.qcpTemplates.find((q) => q.id === state.qcpTemplateSourceId) ?? null;
  return (
    <div className="card">
      <div className="hd"><h3>QC plan (optional)</h3></div>
      <div style={{ padding: 16 }}>
        {options.qcpTemplates.length === 0 ? (
          <p className="note" style={{ textAlign: "left", margin: 0 }}>
            No QC plan exists to start from. You can create the job without one and attach a plan later from the job page.
          </p>
        ) : (
          <>
            <select
              className="ws-detail"
              aria-label="QC plan"
              value={state.qcpTemplateSourceId ?? ""}
              onChange={(e) => patch({ qcpTemplateSourceId: e.target.value ? Number(e.target.value) : null })}
              style={{ maxWidth: 460 }}
            >
              <option value="">No QC plan: attach later</option>
              {options.qcpTemplates.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.vessel} rev {q.revision}: {plural(q.itemCount, "item")} ({q.label}){gaps(q.id) > 0 ? " (may not cover the assembly checklist)" : ""}
                </option>
              ))}
            </select>
            {chosen && gaps(chosen.id) > 0 && (
              <div className="chip c-hold" style={{ marginTop: 10 }}>
                <i />This plan may not number every step of the assembly checklist, so creating the job may be refused. If it is, pick another plan.
              </div>
            )}
            {chosen ? (
              <p className="emp-hint">{plural(chosen.itemCount, "QC point")} will be copied into the job. Points that match no process on this route are skipped and listed once the job exists.</p>
            ) : (
              <p className="emp-hint">With no plan attached, no hold points block completion until one is added.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
