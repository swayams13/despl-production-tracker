"use client";

import { useState } from "react";
import { StatusChip } from "@/components/industrial/status-chip";
import { StageSpine } from "@/components/industrial/stage-spine";
import { StageSheet } from "@/components/industrial/stage-sheet";
import { STAGE_STATUS, type StageDisplayStatus } from "@/components/industrial/stage-status";
import { DEMO_SPINE, DEMO_WAYPOINTS } from "@/components/industrial/_demo";

/**
 * /kit — Session-1 review surface for the industrial component set (the new
 * analogue of the old /component-gallery). Every value here is illustrative;
 * real data lands as later sessions wire the pages.
 */
const ALL_STATUSES = Object.keys(STAGE_STATUS) as StageDisplayStatus[];

export default function KitPage() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [picked, setPicked] = useState<(typeof DEMO_SPINE)[number] | null>(null);

  return (
    <>
      <div className="page-h">
        <h1>Component kit</h1>
        <span className="sub">Session 1 · StatusChip · StageSpine · StageSheet — illustrative data</span>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Status chips</h3>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: 16 }}>
          {ALL_STATUSES.map((s) => (
            <StatusChip key={s} status={s} />
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Stage spine — full (click a segment)</h3>
          <span className="sub" style={{ marginLeft: "auto" }}>
            Stage 9 shows the C26 dual signal: hold fill + overdue pip
          </span>
        </div>
        <div style={{ padding: 16 }}>
          <StageSpine
            segments={DEMO_SPINE}
            waypoints={DEMO_WAYPOINTS}
            onSegmentClick={(seg) => {
              setPicked(seg);
              setSheetOpen(true);
            }}
          />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Stage spine — mini</h3>
        </div>
        <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <span className="mono" style={{ fontSize: 12 }}>
            DESPL-320
          </span>
          <StageSpine variant="mini" segments={DEMO_SPINE} />
        </div>
      </div>

      <div className="card">
        <div className="hd">
          <h3>Stage sheet</h3>
        </div>
        <div style={{ padding: 16 }}>
          <button className="btn btn-accent" onClick={() => { setPicked(DEMO_SPINE[8]); setSheetOpen(true); }}>
            Open stage sheet (Stage 9)
          </button>
        </div>
      </div>

      <StageSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={picked ? `Stage ${picked.stageNo} · ${picked.stageName}` : "Stage"}
        status={picked?.status ?? "idle"}
        positionSegments={DEMO_SPINE}
        meta={[
          { label: "Job · Unit", value: "DESPL-320 · 320SR03" },
          { label: "Owner", value: "Quality Control / QA" },
          { label: "Target / actual", value: "12 Aug / — (in progress)" },
          { label: "Std vs elapsed", value: "3d / 4d" },
        ]}
        body={
          <>
            <div className="sh-sec">Why on hold</div>
            <div style={{ fontSize: 12 }}>ITP-320-05 (H) — awaiting TPI attendance.</div>
            <div className="sh-sec">Why overdue</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              Overdue 4d · reason required (not yet filed).
            </div>
          </>
        }
        footer={
          <>
            <button className="btn">File reason…</button>
            <button className="btn btn-accent">Submit for QC</button>
          </>
        }
      />
    </>
  );
}
