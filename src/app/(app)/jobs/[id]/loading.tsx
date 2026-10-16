// Route-level Suspense fallback while the server component awaits its
// Promise.all of tab data. Mirrors the final header + tabs + card layout
// (L2.8: the tab labels follow `leanFloor`, like the strip), rather than a full-page spinner — DESIGN_SPEC's loading-state rule.
// Applies to every tab, not just packing — this page had no loading.tsx at all before.
import { FEATURES } from "@/lib/shared/flags";

const LEAN_LABELS = ["Overview", "Board", "Schedule", "Materials", "QC", "Dispatch", "History"];
const LEGACY_LABELS = ["Overview", "Timeline", "BOM & Components", "Assembly", "QCP", "Packing", "Dispatch", "Activity"];

export default function JobDetailLoading() {
  return (
    <>
      <div className="page-h">
        <span className="skel" style={{ width: 140, height: 20 }} />
        <span className="skel" style={{ width: 220, height: 12, marginLeft: 10 }} />
      </div>
      <div className="tabs">
        {(FEATURES.leanFloor ? LEAN_LABELS : LEGACY_LABELS).map((label) => (
          <span key={label} className="tab" style={{ opacity: 0.5 }}>
            {label}
          </span>
        ))}
      </div>
      <div className="card">
        <div className="hd">
          <span className="skel" style={{ width: 160, height: 12 }} />
        </div>
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className="skel" style={{ width: "100%", height: 32 }} />
          ))}
        </div>
      </div>
    </>
  );
}
