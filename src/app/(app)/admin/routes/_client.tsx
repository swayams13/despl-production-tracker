"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "@/components/industrial/theme-root";
import { StatusChip } from "@/components/industrial/status-chip";
import {
  createOrReviseRouteTemplateAction,
  setOperationRefFamilySeqAction,
} from "@/app/actions/route-template";
import type { RouteTemplateAdmin, RouteTemplateAdminRow } from "@/lib/services/job-intake.read";

type Family = { id: number; name: string };
type OperationOption = { id: number; code: string; name: string; defaultDepartmentId: number | null };
type Department = { id: number; name: string };

const SHARED_WARNING =
  "This route is used by every family with no more specific route. Changing it affects all of them.";

/** What opens the author/revise dialog: a truly new route (componentType
 * editable, family picked from scratch), or a revision of an existing one
 * (componentType + family fixed, steps prefilled from its latest version). */
type RouteDialogRequest = {
  componentTypeId: number | null;
  familyId: number | null;
  fixed: boolean;
  existingRoute: RouteTemplateAdminRow | null;
};

let stepKeySeq = 0;
function nextStepKey(): string {
  stepKeySeq += 1;
  return `s${stepKeySeq}`;
}

type StepDraft = {
  key: string;
  seq: number;
  optional: boolean;
  printed: string;
  operationMode: "existing" | "new";
  operationId: number | null;
  newCode: string;
  newName: string;
  newDepartmentId: number | null;
};

function blankStep(seq: number): StepDraft {
  return {
    key: nextStepKey(),
    seq,
    optional: false,
    printed: "",
    operationMode: "existing",
    operationId: null,
    newCode: "",
    newName: "",
    newDepartmentId: null,
  };
}

export function RouteTemplateAdminClient({ admin }: { admin: RouteTemplateAdmin }) {
  const [routeDialog, setRouteDialog] = useState<RouteDialogRequest | null>(null);
  const [mappingRow, setMappingRow] = useState<RouteTemplateAdmin["operationFamilySeqs"][number] | null>(null);

  return (
    <>
      <div className="page-h">
        <h1>Component routes</h1>
        <span className="sub">Per-component operation routes — shared, or overridden per product family</span>
        <button
          className="btn btn-accent"
          style={{ marginLeft: "auto" }}
          disabled={admin.componentTypes.length === 0}
          onClick={() => setRouteDialog({ componentTypeId: admin.componentTypes[0]?.componentTypeId ?? null, familyId: null, fixed: false, existingRoute: null })}
        >
          + New route
        </button>
      </div>

      {admin.componentTypes.length === 0 ? (
        <div className="card">
          <p className="note" style={{ padding: 16 }}>No component types yet. Add one before authoring a route.</p>
        </div>
      ) : (
        admin.componentTypes.map((ct) => (
          <div className="card" key={ct.componentTypeId} style={{ marginBottom: 14 }}>
            <div className="hd">
              <h3>{ct.componentTypeName}</h3>
              <span className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>{ct.componentTypeCode}</span>
            </div>

            <div style={{ padding: "0 16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
              <RouteGroup
                title="Shared (every family)"
                route={ct.shared}
                onAuthor={() =>
                  setRouteDialog({ componentTypeId: ct.componentTypeId, familyId: null, fixed: false, existingRoute: null })
                }
                onRevise={() =>
                  setRouteDialog({ componentTypeId: ct.componentTypeId, familyId: null, fixed: true, existingRoute: ct.shared })
                }
                addLabel="Add shared route"
              />

              {ct.families.map((f) => (
                <RouteGroup
                  key={f.familyId}
                  title={f.familyName}
                  route={f.route}
                  onAuthor={() =>
                    setRouteDialog({ componentTypeId: ct.componentTypeId, familyId: f.familyId, fixed: true, existingRoute: null })
                  }
                  onRevise={() =>
                    setRouteDialog({ componentTypeId: ct.componentTypeId, familyId: f.familyId, fixed: true, existingRoute: f.route })
                  }
                  addLabel={`Add ${f.familyName} route`}
                />
              ))}

              <div>
                <button
                  className="btn"
                  onClick={() =>
                    setRouteDialog({ componentTypeId: ct.componentTypeId, familyId: null, fixed: false, existingRoute: null })
                  }
                >
                  Add family-specific route
                </button>
              </div>
            </div>
          </div>
        ))
      )}

      <div className="card">
        <div className="hd"><h3>Operation lead-time mapping</h3></div>
        {admin.operationFamilySeqs.length === 0 ? (
          <p className="note" style={{ padding: 16 }}>No operations are used by a route yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Family mappings</th>
                <th className="num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {admin.operationFamilySeqs.map((o) => (
                <tr className="row" key={o.operationRefId}>
                  <td><span className="mono">{o.operationCode}</span> — {o.operationName}</td>
                  <td style={{ color: "var(--muted)", fontSize: 12 }}>
                    {o.mappings.length === 0
                      ? "Not set for any family"
                      : o.mappings.map((m) => `${m.familyName}: seq ${m.leadTimeProcessSeq}`).join(", ")}
                  </td>
                  <td className="num">
                    <button className="btn" onClick={() => setMappingRow(o)}>Set mapping</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {routeDialog && (
        <RouteDialog
          request={routeDialog}
          componentTypes={admin.componentTypes}
          families={admin.families}
          operations={admin.operations}
          departments={admin.departments}
          onClose={() => setRouteDialog(null)}
        />
      )}

      {mappingRow && (
        <MappingDialog
          operation={mappingRow}
          families={admin.families}
          onClose={() => setMappingRow(null)}
        />
      )}
    </>
  );
}

function RouteGroup({
  title,
  route,
  onAuthor,
  onRevise,
  addLabel,
}: {
  title: string;
  route: RouteTemplateAdminRow | null;
  onAuthor: () => void;
  onRevise: () => void;
  addLabel: string;
}) {
  const latest = route?.versions[0] ?? null;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</span>
        {latest && (
          <>
            <StatusChip status="complete" label={`v${latest.version}`} />
            <span style={{ color: "var(--muted)", fontSize: 11 }}>{latest.stepCount} steps</span>
            {latest.jobCount > 0 && (
              <span className="mono" style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>
                {latest.jobCount} component{latest.jobCount === 1 ? "" : "s"} pinned
              </span>
            )}
          </>
        )}
        <button className="btn" style={{ marginLeft: "auto" }} onClick={route ? onRevise : onAuthor}>
          {route ? "Revise" : addLabel}
        </button>
      </div>
      {latest && latest.steps.length > 0 && (
        <table>
          <thead>
            <tr>
              <th style={{ width: 48 }}>Seq</th>
              <th>Operation</th>
              <th style={{ width: 90 }}>Optional</th>
              <th>Printed</th>
            </tr>
          </thead>
          <tbody>
            {latest.steps.map((s) => (
              <tr className="row" key={s.seq}>
                <td className="mono">{s.seq}</td>
                <td><span className="mono">{s.operationCode}</span> — {s.operationName}</td>
                <td>{s.optional ? "Yes" : "No"}</td>
                <td style={{ color: "var(--muted)" }}>{s.printed ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RouteDialog({
  request,
  componentTypes,
  families,
  operations,
  departments,
  onClose,
}: {
  request: RouteDialogRequest;
  componentTypes: RouteTemplateAdmin["componentTypes"];
  families: Family[];
  operations: OperationOption[];
  departments: Department[];
  onClose: () => void;
}) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [componentTypeId, setComponentTypeId] = useState<number | null>(request.componentTypeId);
  const [familyId, setFamilyId] = useState<number | null>(request.familyId);
  const latestExisting = request.existingRoute?.versions[0] ?? null;
  const [name, setName] = useState(request.existingRoute?.name ?? "");
  const [printedRoute, setPrintedRoute] = useState(latestExisting?.printedRoute ?? "");
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    latestExisting && latestExisting.steps.length > 0
      ? latestExisting.steps.map((s) => ({
          key: nextStepKey(),
          seq: s.seq,
          optional: s.optional,
          printed: s.printed ?? "",
          operationMode: "existing" as const,
          operationId: operations.find((o) => o.code === s.operationCode)?.id ?? null,
          newCode: "",
          newName: "",
          newDepartmentId: null,
        }))
      : [blankStep(10)],
  );

  const isRevision = request.fixed && !!request.existingRoute;
  const isSharedSelected = familyId == null;

  const updateStep = (key: string, patch: Partial<StepDraft>) =>
    setSteps((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeStep = (key: string) => setSteps((rows) => rows.filter((r) => r.key !== key));
  const addStep = () =>
    setSteps((rows) => [...rows, blankStep((Math.max(0, ...rows.map((r) => r.seq)) || 0) + 10)]);

  const submit = () => {
    if (!componentTypeId) return toast.error("Pick a component type.");
    if (!name.trim()) return toast.error("A name is required.");
    if (steps.length === 0) return toast.error("A route needs at least one step.");
    const seqSeen = new Set<number>();
    for (const s of steps) {
      if (!Number.isInteger(s.seq) || s.seq <= 0) return toast.error("Every step needs a positive sequence number.");
      if (seqSeen.has(s.seq)) return toast.error(`Sequence ${s.seq} is used more than once.`);
      seqSeen.add(s.seq);
      if (s.operationMode === "existing" && !s.operationId) return toast.error("Pick an operation for every step.");
      if (s.operationMode === "new" && (!s.newCode.trim() || !s.newName.trim())) {
        return toast.error("A new operation needs a code and a name.");
      }
    }

    startTransition(async () => {
      const r = await createOrReviseRouteTemplateAction({
        componentTypeId,
        familyId,
        name: name.trim(),
        printedRoute: printedRoute.trim() || undefined,
        steps: steps
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map((s) => ({
            seq: s.seq,
            optional: s.optional,
            printed: s.printed.trim() || undefined,
            ...(s.operationMode === "existing"
              ? { operationId: s.operationId! }
              : {
                  newOperation: {
                    code: s.newCode.trim(),
                    name: s.newName.trim(),
                    defaultDepartmentId: s.newDepartmentId ?? undefined,
                  },
                }),
          })),
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(isRevision ? "Route revised." : "Route created.");
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined} style={{ width: 640 }}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">✕</button>
            </Dialog.Close>
            <Dialog.Title asChild>
              <h2>{isRevision ? `Revise ${request.existingRoute!.name}` : "New route"}</h2>
            </Dialog.Title>
          </div>
          <div className="sh-body">
            <div className="emp-grid">
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Component type *</label>
                <select
                  className="ws-detail"
                  value={componentTypeId ?? ""}
                  disabled={request.fixed}
                  onChange={(e) => setComponentTypeId(e.target.value ? Number(e.target.value) : null)}
                >
                  {componentTypes.map((ct) => (
                    <option key={ct.componentTypeId} value={ct.componentTypeId}>{ct.componentTypeName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Product family *</label>
                <select
                  className="ws-detail"
                  value={familyId ?? ""}
                  disabled={request.fixed}
                  onChange={(e) => setFamilyId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Shared (every family)</option>
                  {families.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
              <input className="ws-detail" placeholder="Route name *" value={name} onChange={(e) => setName(e.target.value)} />
              <input
                className="ws-detail"
                placeholder="Printed route (optional)"
                value={printedRoute}
                onChange={(e) => setPrintedRoute(e.target.value)}
              />
            </div>

            {isSharedSelected && (
              <p className="note" style={{ textAlign: "left", color: "var(--s-hold)" }}>{SHARED_WARNING}</p>
            )}

            <div className="sh-sec">Steps</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {steps.map((s) => (
                <StepRow
                  key={s.key}
                  step={s}
                  operations={operations}
                  departments={departments}
                  onChange={(patch) => updateStep(s.key, patch)}
                  onRemove={steps.length > 1 ? () => removeStep(s.key) : undefined}
                />
              ))}
            </div>
            <button className="btn" style={{ marginTop: 8 }} onClick={addStep}>+ Add step</button>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>
              {isRevision ? "Publish revision" : "Create route"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StepRow({
  step,
  operations,
  departments,
  onChange,
  onRemove,
}: {
  step: StepDraft;
  operations: OperationOption[];
  departments: Department[];
  onChange: (patch: Partial<StepDraft>) => void;
  onRemove?: () => void;
}) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="ws-detail mono"
          type="number"
          style={{ width: 64 }}
          value={step.seq}
          onChange={(e) => onChange({ seq: Number(e.target.value) })}
        />
        <select
          className="ws-detail"
          style={{ flex: "1 1 200px" }}
          value={step.operationMode === "existing" ? (step.operationId ?? "") : "__new__"}
          onChange={(e) =>
            e.target.value === "__new__"
              ? onChange({ operationMode: "new", operationId: null })
              : onChange({ operationMode: "existing", operationId: Number(e.target.value) })
          }
        >
          <option value="" disabled>Pick an operation…</option>
          {operations.map((o) => (
            <option key={o.id} value={o.id}>{o.code} — {o.name}</option>
          ))}
          <option value="__new__">+ New operation…</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <input type="checkbox" checked={step.optional} onChange={(e) => onChange({ optional: e.target.checked })} />
          Optional
        </label>
        {onRemove && (
          <button className="btn" onClick={onRemove}>Remove</button>
        )}
      </div>
      {step.operationMode === "new" && (
        <div className="emp-grid" style={{ marginTop: 8 }}>
          <input
            className="ws-detail mono"
            placeholder="Code *"
            value={step.newCode}
            onChange={(e) => onChange({ newCode: e.target.value })}
          />
          <input
            className="ws-detail"
            placeholder="Name *"
            value={step.newName}
            onChange={(e) => onChange({ newName: e.target.value })}
          />
          <select
            className="ws-detail"
            value={step.newDepartmentId ?? ""}
            onChange={(e) => onChange({ newDepartmentId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Default department (optional)</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      )}
      <input
        className="ws-detail"
        style={{ marginTop: 8 }}
        placeholder="Printed step text (optional)"
        value={step.printed}
        onChange={(e) => onChange({ printed: e.target.value })}
      />
    </div>
  );
}

function MappingDialog({
  operation,
  families,
  onClose,
}: {
  operation: RouteTemplateAdmin["operationFamilySeqs"][number];
  families: Family[];
  onClose: () => void;
}) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [familyId, setFamilyId] = useState<number | null>(families[0]?.id ?? null);
  const [seq, setSeq] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const submit = () => {
    setError(null);
    if (!familyId) return toast.error("Pick a product family.");
    const n = Number(seq);
    if (!Number.isInteger(n) || n <= 0) return toast.error("Enter a positive sequence number.");
    startTransition(async () => {
      const r = await setOperationRefFamilySeqAction({ operationRefId: operation.operationRefId, familyId, leadTimeProcessSeq: n });
      if (!r.ok) {
        setError({ code: r.code, message: r.message });
        return;
      }
      toast.success("Mapping saved.");
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined} style={{ width: 420 }}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">✕</button>
            </Dialog.Close>
            <Dialog.Title asChild><h2>{operation.operationCode} — lead-time mapping</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <div>
              <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Product family *</label>
              <select className="ws-detail" value={familyId ?? ""} onChange={(e) => setFamilyId(Number(e.target.value))}>
                {families.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
            <div style={{ marginTop: 12 }}>
              <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Lead-time process sequence *</label>
              <input
                className="ws-detail mono"
                type="number"
                value={seq}
                onChange={(e) => setSeq(e.target.value)}
                placeholder="e.g. 12"
              />
            </div>
            {error && (
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 10, fontSize: 11 }}>
                <span className="chip c-overdue"><i />{error.code}</span>
                <span style={{ color: "var(--muted)", flex: "1 1 160px" }}>{error.message}</span>
              </div>
            )}
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>Save mapping</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
