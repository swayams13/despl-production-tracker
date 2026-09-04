import type { NotificationRow } from "@/lib/services/notifications.read";

/** S14 — pulled out of app-shell.tsx's bell dropdown so /alerts (the real
 * page) can render the exact same rows/links without duplicating the logic. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days <= 0) return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Where a notification's payload sends you when clicked. */
export function notificationHref(n: NotificationRow): string | null {
  const p = n.payload as { jobId?: number; unitId?: number; stageNo?: number; date?: string } | null;
  if (n.type === "DIGEST_PUBLISHED") return p?.date ? `/reports?date=${p.date}` : "/reports";
  if (n.type === "CLIENT_UPDATE_PUBLISHED" || n.type === "CLIENT_UPDATE_REJECTED") {
    return p?.jobId != null ? `/jobs/${p.jobId}?tab=client` : null;
  }
  if (p?.jobId != null) {
    return p.unitId != null && p.stageNo != null
      ? `/jobs/${p.jobId}?openUnit=${p.unitId}&openStage=${p.stageNo}`
      : `/jobs/${p.jobId}`;
  }
  return null;
}
