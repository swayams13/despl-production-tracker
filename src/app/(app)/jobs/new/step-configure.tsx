"use client";

import { ConfigAnswerFields } from "@/components/industrial/config-answer-fields";
import type { IntakeOptions, IntakeFamily } from "@/lib/services/job-intake.read";
import type { WizardState } from "./wizard-state";
import { PreviewPanel, type PreviewState } from "./preview-panel";

export type TemplateProcessRow = {
  code: string;
  seq: number;
  name: string;
  departmentName: string;
  optional: boolean;
  provisional: boolean;
  durationMaxDays: number | null;
};

export type ProcessesState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; rows: TemplateProcessRow[] };

/** Frame 13C: the questions on the left, what they decide on the right. */
export function StepConfigure({
  state,
  patch,
  options,
  family,
  processes,
  onReloadProcesses,
  preview,
  onRetryPreview,
}: {
  state: WizardState;
  patch: (p: Partial<WizardState>) => void;
  options: IntakeOptions;
  family: IntakeFamily | null;
  processes: ProcessesState;
  onReloadProcesses: () => void;
  preview: PreviewState;
  onRetryPreview: () => void;
}) {
  // Family-level questions plus those of every equipment type chosen on step 2.
  const familyQuestions = options.questions.filter((q) => q.familyId === family?.id);
  const chosenTypes = new Set(state.equipments.map((b) => b.equipmentTypeId));
  const questions = familyQuestions.filter((q) => q.equipmentTypeId == null || chosenTypes.has(q.equipmentTypeId));
  const setAnswer = (key: string, value: string) => patch({ answers: { ...state.answers, [key]: value } });

  const toggleExcluded = (code: string) => {
    const set = new Set(state.excludedProcessCodes);
    if (set.has(code)) set.delete(code); else set.add(code);
    patch({ excludedProcessCodes: [...set] });
  };
  const optional = processes.status === "ok" ? processes.rows.filter((p) => p.optional) : [];

  return (
    <div className="cfg-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 14, alignItems: "start" }}>
      <div>
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="hd"><h3>Design configuration</h3></div>
          <div style={{ padding: 16 }}>
            <div style={{ marginBottom: 14 }}>
              <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Design code</label>
              <input className="ws-detail" style={{ maxWidth: 320 }} value={state.designCode} onChange={(e) => patch({ designCode: e.target.value })} />
            </div>
            <ConfigAnswerFields
              questions={questions}
              values={state.answers}
              onChange={setAnswer}
              emptyText="No design questions are defined for this equipment type yet."
            />
          </div>
        </div>

        <div className="card">
          <div className="hd"><h3>Processes you can leave out</h3></div>
          <div style={{ padding: 16 }}>
            {processes.status === "loading" && (
              <div style={{ display: "grid", gap: 8 }}>
                {Array.from({ length: 3 }).map((_, i) => <span key={i} className="skel" style={{ height: 22, width: "100%" }} />)}
              </div>
            )}
            {processes.status === "error" && (
              <div>
                <div className="chip c-overdue" role="alert"><i />{processes.message}</div>
                <div style={{ marginTop: 8 }}><button className="btn" onClick={onReloadProcesses}>Try again</button></div>
              </div>
            )}
            {processes.status === "ok" && optional.length === 0 && (
              <p className="note" style={{ textAlign: "left", margin: 0 }}>Every process on this route is mandatory.</p>
            )}
            {optional.map((p) => {
              const excluded = state.excludedProcessCodes.includes(p.code);
              return (
                <label key={p.code} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
                  <input type="checkbox" checked={!excluded} onChange={() => toggleExcluded(p.code)} />
                  <span style={excluded ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>
                    {p.name} <span className="emp-hint">{p.departmentName}</span>
                  </span>
                </label>
              );
            })}
            {state.excludedProcessCodes.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }} htmlFor="exclusion-reason">
                  Reason for leaving out {state.excludedProcessCodes.length} process{state.excludedProcessCodes.length === 1 ? "" : "es"} *
                </label>
                <textarea
                  id="exclusion-reason"
                  className="ws-detail"
                  style={{ width: "100%", minHeight: 60 }}
                  value={state.exclusionReason}
                  onChange={(e) => patch({ exclusionReason: e.target.value })}
                  placeholder="Required: recorded on the job's audit trail"
                />
              </div>
            )}
          </div>
        </div>
      </div>
      <PreviewPanel preview={preview} onRetry={onRetryPreview} />
    </div>
  );
}
