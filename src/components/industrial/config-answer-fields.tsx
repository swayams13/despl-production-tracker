"use client";

import type { ConfigQuestionDef } from "@/lib/shared/config-questions";

/** One input per config question (J2). Answers are strings here; the server coerces them by question type. */
export function ConfigAnswerFields({
  questions,
  values,
  onChange,
  emptyText,
}: {
  questions: ConfigQuestionDef[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  emptyText: string;
}) {
  if (questions.length === 0) {
    return <p className="note" style={{ margin: 0, textAlign: "left" }}>{emptyText}</p>;
  }
  return (
    <div className="emp-grid">
      {questions.map((q) => {
        const hint = q.default != null ? `Default: ${String(q.default)}` : undefined;
        return (
          <div key={q.key}>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }} title={q.help ?? undefined}>
              {q.label}{q.unit ? ` (${q.unit})` : ""}
            </label>
            {q.type === "SELECT" || q.type === "BOOLEAN" ? (
              <select className="ws-detail" value={values[q.key] ?? ""} onChange={(e) => onChange(q.key, e.target.value)}>
                <option value="">{hint ? `— (${hint})` : "—"}</option>
                {q.type === "BOOLEAN" ? (
                  <>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </>
                ) : (
                  (q.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)
                )}
              </select>
            ) : (
              <input
                className="ws-detail"
                type={q.type === "NUMBER" ? "number" : "text"}
                value={values[q.key] ?? ""}
                placeholder={hint}
                onChange={(e) => onChange(q.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
