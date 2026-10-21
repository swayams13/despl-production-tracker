import type { JobMilestones } from "@/lib/shared/milestones";

/**
 * Lean Core J8: the job's milestones as a short table (name, percent bar, planned
 * finish). Server-renderable. A family with no milestone map says so in one line.
 */
const fmt = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "not scheduled";

export function MilestoneStrip({ milestones }: { milestones: JobMilestones }) {
  if (milestones.milestones.length === 0) {
    return <p className="note" style={{ margin: 0 }}>No milestone list for this type of equipment yet.</p>;
  }
  return (
    <table className="matrix">
      <thead>
        <tr>
          <th>Milestone</th>
          <th style={{ minWidth: 140 }}>Complete</th>
          <th>Planned finish</th>
        </tr>
      </thead>
      <tbody>
        {milestones.milestones.map((m) => (
          <tr key={m.id}>
            <td>
              {m.name}
              {milestones.current?.id === m.id && <span className="sub" style={{ color: "var(--muted)", marginLeft: 6 }}>current</span>}
            </td>
            <td>
              <div className="otbar">
                <div className="bar"><i style={{ width: `${m.percent}%`, background: "var(--s-complete)" }} /></div>
                <span className="mono" style={{ fontSize: "var(--fs-xs, 11px)" }}>{m.percent}%</span>
              </div>
            </td>
            <td className="mono" style={{ color: m.late ? "var(--s-overdue)" : undefined }}>
              {fmt(m.plannedFinish)}
              {m.late ? " · late" : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
