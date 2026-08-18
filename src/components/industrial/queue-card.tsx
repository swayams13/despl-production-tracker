import type { ReactNode } from "react";

/**
 * QueueCard (R2 Task 1, SPEC-supervisor-ui-v3.md §3 + P3-03/P3-04): one
 * action per card, always the bottom-most element so a thumb lands on it
 * without hunting. Rank 1 gets the accent frame + "DO THIS FIRST" ribbon;
 * every other card (rank 2+, or pool) drops both — purely a visual cue for
 * where to look first, not a size tier (SPEC §5 gives every QueueCard
 * action the same 56px floor regardless).
 */
export function QueueCard({
  top,
  metaLine,
  due,
  overdue,
  title,
  tags,
  action,
  onClick,
}: {
  top?: boolean;
  metaLine: ReactNode;
  due?: ReactNode;
  overdue?: boolean;
  title: ReactNode;
  tags?: ReactNode;
  action: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div className={`queue-card${top ? " top" : ""}`} onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      {top && (
        <div className="queue-ribbon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 3v18" />
            <path d="M5 4h11l-2.5 4L16 12H5" />
          </svg>
          DO THIS FIRST
        </div>
      )}
      <div className="queue-card-body">
        <div className="queue-card-meta">
          <span>{metaLine}</span>
          {due != null && <span className={`queue-card-due${overdue ? " overdue" : ""}`}>{due}</span>}
        </div>
        <div className="queue-card-title">{title}</div>
        {tags && <div className="queue-card-tags">{tags}</div>}
        <div className="queue-card-action">{action}</div>
      </div>
    </div>
  );
}
