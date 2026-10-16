import { Tabs } from "@/components/industrial/tabs";

/**
 * Lean Core L2.8: Overview · Board · Schedule · Materials · QC · Dispatch ·
 * History. Board is its own route; Assembly is not on the strip (Board
 * reaches it) and keeps Board lit. Client View exists only while the portal
 * is unfrozen.
 */
export function JobTabStrip({ jobId, tab, showClient }: { jobId: number; tab: string; showClient: boolean }) {
  const t = (key: string, label: string) => ({ key, label, href: `/jobs/${jobId}?tab=${key}`, active: tab === key });
  return (
    <Tabs
      items={[
        t("overview", "Overview"),
        { key: "board", label: "Board", href: `/jobs/${jobId}/board`, active: tab === "assembly" },
        t("schedule", "Schedule"),
        t("materials", "Materials"),
        t("qc", "QC"),
        t("dispatch", "Dispatch"),
        t("history", "History"),
        ...(showClient ? [t("client", "Client View")] : []),
      ]}
    />
  );
}
