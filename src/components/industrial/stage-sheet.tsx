"use client";

import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { StatusChip } from "./status-chip";
import { StageSpine } from "./stage-spine";
import { type StageDisplayStatus, type StageSegment } from "./stage-status";
import { useThemeClass } from "./theme-root";

/**
 * StageSheet — 460px right sheet, opens from any stage reference (spine
 * segment, matrix cell, gantt row, worklist row). DESIGN_SPEC §4.5.
 *
 * Session-1 shell: structure + open/close + a11y + the token-carrying wrapper.
 * Real per-process data, both-reasons panel and role-correct actions land in
 * later sessions; `body`/`footer` are slots so those can fill in.
 *
 * NOTE: radix portals Content to <body>, OUTSIDE the (app) `.theme-industrial`
 * wrapper — so Content re-declares the class, or the tokens wouldn't resolve.
 * It reads the live class (which palette is active) from ThemeRoot's context
 * rather than a hardcoded string, or the sheet would stay dark in light mode.
 */
export function StageSheet({
  open,
  onOpenChange,
  title,
  status,
  meta,
  positionSegments,
  body,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "Stage 9 · Material inspection" */
  title: string;
  status: StageDisplayStatus;
  /** key/value rows (job, unit, owner, target vs actual, variance …) */
  meta?: { label: string; value: ReactNode }[];
  /** spine position strip showing where this stage sits */
  positionSegments?: StageSegment[];
  body?: ReactNode;
  footer?: ReactNode;
}) {
  const themeClass = useThemeClass();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="stage-sheet-ov" />
        <Dialog.Content className={`${themeClass} stage-sheet`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">
                <span className="sh-x-close">✕</span>
                <svg className="sh-x-back" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5" />
                  <path d="M12 19l-7-7 7-7" />
                </svg>
              </button>
            </Dialog.Close>
            <StatusChip status={status} />
            <Dialog.Title asChild>
              <h2>{title}</h2>
            </Dialog.Title>
            {positionSegments && positionSegments.length > 0 && (
              <StageSpine variant="mini" segments={positionSegments} />
            )}
          </div>

          <div className="sh-body">
            {meta && meta.length > 0 && (
              <dl className="sh-kv">
                {meta.map((m) => (
                  <div key={m.label} style={{ display: "contents" }}>
                    <dt>{m.label}</dt>
                    <dd>{m.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {body}
          </div>

          {footer && <div className="sh-ft">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
