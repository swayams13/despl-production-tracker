import type { DiffClass, DiffEntity, ReleaseDiff } from "@/lib/services/bom-release-diff";

/**
 * J5c: what a re-release (or "Check for changes") would do to the floor rows, before anyone applies it:
 * counts per kind and class, then the first rows with their before and after.
 */

const CLASS_CHIP: Record<DiffClass, { cls: string; label: string }> = {
  add: { cls: "c-complete", label: "Added" },
  update: { cls: "c-progress", label: "Updated" },
  retire: { cls: "c-idle", label: "Retired" },
  review: { cls: "c-hold", label: "Needs review" },
};
const ENTITY_LABEL: Record<DiffEntity, string> = { component: "Parts", operation: "Operations", step: "Assembly steps" };
const FIELD_LABEL: Record<string, string> = { partFamily: "part family", routeVariant: "route variant", partName: "name", quantity: "quantity", joint: "joint", operations: "operations", requiresQc: "QC needed", qcpItem: "QC point", pressurePart: "pressure part", role: "role", operation: "operation", line: "BOM line", step: "step", part: "part" };
const show = (v: unknown) => (v == null ? "none" : String(v));

export function DiffPanel({ diff }: { diff: ReleaseDiff }) {
  const total = diff.rows.length;
  return (
    <div className="card" aria-label="Changes">
      <div className="hd">
        <h3>Changes to the floor rows</h3>
        <span className="note" style={{ margin: "0 0 0 auto" }}>{total === 0 ? "None" : `Showing ${total} (the audit log keeps every row)`}</span>
      </div>
      <div style={{ padding: "0 16px 12px", display: "grid", gap: 10 }}>
        <table>
          <thead><tr><th /><th className="num">Added</th><th className="num">Updated</th><th className="num">Retired</th><th className="num">Needs review</th></tr></thead>
          <tbody>
            {(Object.keys(ENTITY_LABEL) as DiffEntity[]).map((e) => (
              <tr className="row" key={e}>
                <td>{ENTITY_LABEL[e]}</td>
                {(["add", "update", "retire", "review"] as const).map((c) => (
                  <td className="num mono" key={c}>{diff.counts[e][c]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note" style={{ textAlign: "left", margin: 0 }}>
          Rows that have not started are updated or retired. Started rows are never changed: they stay on the floor with a flag until Engineering or the Production Head keeps, replaces or cancels them.
        </p>
      </div>
      {total > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Unit</th><th>Row</th><th>Change</th><th>Detail</th></tr></thead>
            <tbody>
              {diff.rows.map((r, i) => (
                <tr className="row" key={`${r.entity}:${r.id ?? "new"}:${i}`}>
                  <td className="mono">{r.unit ?? "All"}</td>
                  <td>{r.label}</td>
                  <td><span className={`chip ${CLASS_CHIP[r.class].cls}`}><i />{CLASS_CHIP[r.class].label}</span></td>
                  <td>{r.fields.length > 0 ? r.fields.map((f) => `${FIELD_LABEL[f.field] ?? f.field}: ${show(f.from)} → ${show(f.to)}`).join("; ") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
