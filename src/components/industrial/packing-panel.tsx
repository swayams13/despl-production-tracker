"use client";

import { useState, useTransition, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createPackageAction, assignUnitToPackageAction } from "@/app/actions/packing";
import type { ActionResult } from "@/app/actions/_action";
import type { PackingPanel as PackingPanelData, PackageRow } from "@/lib/services/packing.read";

type Refusal = { code: string; message: string };

function stop(e: MouseEvent) {
  e.stopPropagation();
}

/** Inline refusal display — SPEC §7.2's stronger pattern (my-day's
 * RefusalNote), not the toast-only convention most other panels use. */
function RefusalNote({ refusal }: { refusal: Refusal | null }) {
  if (!refusal) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6, fontSize: 11 }} onClick={stop}>
      <span className="chip c-overdue"><i />{refusal.code}</span>
      <span style={{ color: "var(--muted)", flex: "1 1 160px" }}>{refusal.message}</span>
    </div>
  );
}

function dims(pkg: PackageRow): string | null {
  if (pkg.lengthMm == null && pkg.widthMm == null && pkg.heightMm == null) return null;
  return `${pkg.lengthMm ?? "—"} × ${pkg.widthMm ?? "—"} × ${pkg.heightMm ?? "—"} mm`;
}

export function PackingPanel({
  jobId,
  data,
  canManagePacking,
}: {
  jobId: number;
  data: PackingPanelData;
  canManagePacking: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const onResult = (r: ActionResult, ok?: string) => {
    if (!r.ok) {
      setRefusal({ code: r.code, message: r.message });
      toast.error(r.message);
    } else {
      setRefusal(null);
      if (ok) toast.success(ok);
      router.refresh();
    }
  };

  const hasPackages = data.packages.length > 0;

  return (
    <div className="card">
      <div className="hd">
        <h3>Packing</h3>
        {canManagePacking && !creating && (
          <button className="btn btn-accent" style={{ marginLeft: "auto" }} onClick={() => setCreating(true)}>
            + New package
          </button>
        )}
      </div>

      {!hasPackages && !creating ? (
        <div style={{ padding: 16 }}>
          <p className="note" style={{ margin: "0 0 10px" }}>
            No units have been packed for this job yet.
          </p>
          {canManagePacking && (
            <button className="btn btn-accent" onClick={() => setCreating(true)}>
              + New package
            </button>
          )}
          <RefusalNote refusal={refusal} />
        </div>
      ) : (
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
          {creating && (
            <CreatePackageForm
              jobId={jobId}
              existingPackageNos={data.packages.map((p) => p.packageNo)}
              onDone={(r) => {
                setCreating(false);
                if (r) onResult(r, "Package created.");
              }}
              onCancel={() => setCreating(false)}
            />
          )}
          {data.packages.map((pkg) => (
            <PackageCard
              key={pkg.id}
              jobId={jobId}
              pkg={pkg}
              unpackedUnits={data.unpackedUnits}
              canManagePacking={canManagePacking}
              onResult={onResult}
            />
          ))}
          <RefusalNote refusal={refusal} />
        </div>
      )}
    </div>
  );
}

function CreatePackageForm({
  jobId,
  existingPackageNos,
  onDone,
  onCancel,
}: {
  jobId: number;
  existingPackageNos: string[];
  onDone: (r: ActionResult | null) => void;
  onCancel: () => void;
}) {
  const [pending, start] = useTransition();
  const [packageNo, setPackageNo] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [lengthMm, setLengthMm] = useState("");
  const [widthMm, setWidthMm] = useState("");
  const [heightMm, setHeightMm] = useState("");
  const [preservationNotes, setPreservationNotes] = useState("");

  const save = () => {
    const no = packageNo.trim();
    if (!no) return toast.error("Package number is required.");
    if (existingPackageNos.includes(no)) return toast.error("A package with this number already exists.");

    start(async () => {
      const r = await createPackageAction(jobId, no, {
        weightKg: weightKg.trim() ? Number(weightKg) : undefined,
        lengthMm: lengthMm.trim() ? Number(lengthMm) : undefined,
        widthMm: widthMm.trim() ? Number(widthMm) : undefined,
        heightMm: heightMm.trim() ? Number(heightMm) : undefined,
        preservationNotes: preservationNotes.trim() || undefined,
      });
      onDone(r);
    });
  };

  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <div style={{ padding: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input
          className="ws-detail"
          placeholder="Package no."
          value={packageNo}
          onChange={(e) => setPackageNo(e.target.value)}
          style={{ width: 130 }}
          autoFocus
        />
        <input
          className="ws-detail"
          type="number"
          min={0}
          placeholder="Weight (kg)"
          value={weightKg}
          onChange={(e) => setWeightKg(e.target.value)}
          style={{ width: 110 }}
        />
        <input
          className="ws-detail"
          type="number"
          min={1}
          placeholder="L (mm)"
          value={lengthMm}
          onChange={(e) => setLengthMm(e.target.value)}
          style={{ width: 90 }}
        />
        <input
          className="ws-detail"
          type="number"
          min={1}
          placeholder="W (mm)"
          value={widthMm}
          onChange={(e) => setWidthMm(e.target.value)}
          style={{ width: 90 }}
        />
        <input
          className="ws-detail"
          type="number"
          min={1}
          placeholder="H (mm)"
          value={heightMm}
          onChange={(e) => setHeightMm(e.target.value)}
          style={{ width: 90 }}
        />
        <input
          className="ws-detail"
          placeholder="Preservation notes (optional)"
          value={preservationNotes}
          onChange={(e) => setPreservationNotes(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <button className="btn btn-accent" disabled={pending} onClick={save}>
          Save
        </button>
        <button className="btn" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function PackageCard({
  jobId,
  pkg,
  unpackedUnits,
  canManagePacking,
  onResult,
}: {
  jobId: number;
  pkg: PackageRow;
  unpackedUnits: PackingPanelData["unpackedUnits"];
  canManagePacking: boolean;
  onResult: (r: ActionResult, ok?: string) => void;
}) {
  const [pending, start] = useTransition();
  const [assignUnitId, setAssignUnitId] = useState("");
  const d = dims(pkg);

  const assign = () => {
    if (!assignUnitId) return;
    start(async () => {
      const r = await assignUnitToPackageAction(jobId, pkg.id, Number(assignUnitId));
      if (r.ok) setAssignUnitId("");
      onResult(r, "Unit assigned.");
    });
  };

  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <div className="hd">
        <b className="mono">{pkg.packageNo}</b>
        {pkg.weightKg != null && <span className="sub">{pkg.weightKg} kg</span>}
        {d && <span className="sub">{d}</span>}
      </div>
      <div style={{ padding: 12, display: "grid", gap: 8 }}>
        {pkg.preservationNotes && (
          <p className="note" style={{ margin: 0 }}>
            {pkg.preservationNotes}
          </p>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {pkg.units.length === 0 ? (
            <span className="note">No units assigned yet.</span>
          ) : (
            pkg.units.map((u) => (
              <span key={u.id} className="chip">
                Unit {u.serialNo}
              </span>
            ))
          )}
        </div>
        {canManagePacking && unpackedUnits.length > 0 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select
              className="btn"
              value={assignUnitId}
              onChange={(e) => setAssignUnitId(e.target.value)}
              aria-label={`Assign a unit into ${pkg.packageNo}`}
            >
              <option value="">Assign unit…</option>
              {unpackedUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  Unit {u.serialNo}
                </option>
              ))}
            </select>
            <button className="btn btn-accent" disabled={pending || !assignUnitId} onClick={assign}>
              Assign
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
