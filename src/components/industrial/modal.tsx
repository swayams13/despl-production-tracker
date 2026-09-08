"use client";

import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "./theme-root";

/**
 * Canonical Modal (DESIGN_SYSTEM.md §2: centered, header + body + right-
 * aligned action row). Extracted from the `.admin-dialog`/`.admin-dialog-ov`
 * pattern already built and pixel-reviewed five times over (admin/routes,
 * admin/templates, admin/families, admin/qcp-templates,
 * admin/equipment-types _client.tsx) — same classes, same `.sh-hd`/`.sh-body`/
 * `.sh-ft` slots StageSheet's Drawer already uses, just centered instead of a
 * right-side sheet. Needed for Phase 4's new confirmation-dialog pattern
 * (Reassign, Reject-with-reason — UX_FINAL_REVIEW.md §16) so those don't
 * invent a sixth ad-hoc dialog.
 *
 * Escape-to-cancel and focus trap/return come from Radix Dialog for free
 * (ACCESSIBILITY_AUDIT.md's keyboard-navigation requirement).
 */
export function Modal({
  open,
  onOpenChange,
  title,
  wide,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** 760px instead of the 560px default, for forms with more fields. */
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const themeClass = useThemeClass();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog${wide ? " wide" : ""}`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">
                ✕
              </button>
            </Dialog.Close>
            <Dialog.Title asChild>
              <h2>{title}</h2>
            </Dialog.Title>
          </div>
          <div className="sh-body">{children}</div>
          {footer && <div className="sh-ft">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Confirm/Cancel footer row (DESIGN_SYSTEM.md §2: "Cancel = secondary,
 * Confirm = primary or status-critical fill for destructive"). Use for any
 * Modal whose body is just a consequence statement, not a form — Reject,
 * Put-on-hold-style confirmations.
 */
export function ModalConfirmFooter({
  onCancel,
  onConfirm,
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  destructive,
  disabled,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  cancelLabel?: string;
  confirmLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <>
      <button type="button" className="btn" onClick={onCancel}>
        {cancelLabel}
      </button>
      <button
        type="button"
        className={destructive ? "btn btn-destructive" : "btn btn-accent"}
        onClick={onConfirm}
        disabled={disabled}
      >
        {confirmLabel}
      </button>
    </>
  );
}
