"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "@/components/industrial/theme-root";
import {
  createJobAction,
  scheduleNewJobAction,
  createClientAction,
  loadTemplateProcessesAction,
  type CreateJobActionResult,
  type ScheduleVerdict,
} from "@/app/actions/job-intake";
import { specFieldsFor } from "@/lib/shared/specs";
import type { IntakeOptions, IntakeFamily } from "@/lib/services/job-intake.read";
import type { CreateJobInput } from "@/lib/shared/schemas";

// ── Shared little formatters ───────────────────────────────────────────────
function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

const PRIORITY_LABEL: Record<string, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

type TemplateProcessRow = {
  code: string;
  seq: number;
  name: string;
  departmentName: string;
  optional: boolean;
  provisional: boolean;
  durationMaxDays: number | null;
};

interface EquipBlockState {
  key: string;
  equipmentTypeId: number | null;
  name: string;
  blockNo: string;
  remarks: string;
  serialPrefix: string;
  serialStart: string;
  serialPad: string;
  serialCount: string;
  serials: string[];
}

interface WizardState {
  step: number;
  maxStep: number;
  // step 1
  clientId: number | null;
  jobNumber: string;
  clientOrderNo: string;
  poRef: string;
  projectName: string;
  orderDate: string;
  committedDeliveryDate: string;
  targetDispatchDate: string;
  priority: Priority;
  calendarId: number | null;
  // step 2
  familyId: number | null;
  versionId: number | null;
  excludedProcessCodes: string[];
  qcpTemplateSourceId: number | null;
  // step 3
  equipments: EquipBlockState[];
  // step 4
  designCode: string;
  specs: Record<string, string>;
  copyBomFromEquipmentId: number | null;
  // step 5
  remarks: string;
}

function newBlockKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function emptyBlock(): EquipBlockState {
  return {
    key: newBlockKey(),
    equipmentTypeId: null,
    name: "",
    blockNo: "",
    remarks: "",
    serialPrefix: "",
    serialStart: "1",
    serialPad: "2",
    serialCount: "1",
    serials: [""],
  };
}

function defaultState(options: IntakeOptions): WizardState {
  const defaultCalendar = options.calendars.find((c) => c.isDefault);
  return {
    step: 1,
    maxStep: 1,
    clientId: null,
    jobNumber: "",
    clientOrderNo: "",
    poRef: "",
    projectName: "",
    orderDate: "",
    committedDeliveryDate: "",
    targetDispatchDate: "",
    priority: "NORMAL",
    calendarId: defaultCalendar?.id ?? null,
    familyId: null,
    versionId: null,
    excludedProcessCodes: [],
    qcpTemplateSourceId: null,
    equipments: [emptyBlock()],
    designCode: "",
    specs: {},
    copyBomFromEquipmentId: null,
    remarks: "",
  };
}

function generateSerials(prefix: string, start: string, pad: string, count: string): string[] {
  const s = Number.parseInt(start, 10) || 1;
  const p = Math.max(0, Number.parseInt(pad, 10) || 0);
  const n = Math.max(0, Number.parseInt(count, 10) || 0);
  return Array.from({ length: n }, (_, i) => `${prefix}${String(s + i).padStart(p, "0")}`);
}

// ── URL state — lives in the query string, never localStorage.
//
// This MUST go through next/navigation's router, not a raw
// history.replaceState: a Server Action call (loadTemplateProcessesAction,
// createClientAction, ...) makes Next.js resync its client router cache
// against the URL it last navigated to. If that URL was set by
// history.replaceState instead of the router, Next doesn't know about it —
// the next Server Action's implicit refresh then silently reverts the
// address bar (and the wizard state read back out of it) to the last URL
// the router DID see, quietly discarding whatever the user did since.
// Verified live: selecting a QCP template, then changing the route version
// (which calls loadTemplateProcessesAction) made the QCP selection vanish.
// router.replace keeps the router's own bookkeeping current, so it doesn't
// have anything stale to "helpfully" restore.
function readStateFromUrl(params: URLSearchParams, options: IntakeOptions): WizardState {
  const raw = params.get("s");
  const base = defaultState(options);
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw);
    return { ...base, ...parsed };
  } catch {
    return base;
  }
}

// ── Step validation ─────────────────────────────────────────────────────
function step1Valid(s: WizardState): boolean {
  if (!s.clientId || !s.jobNumber.trim()) return false;
  if (s.targetDispatchDate && s.committedDeliveryDate && s.targetDispatchDate > s.committedDeliveryDate) return false;
  return true;
}
function step2Valid(s: WizardState, families: IntakeFamily[]): boolean {
  const fam = families.find((f) => f.id === s.familyId);
  return !!fam && fam.schedulable && s.versionId != null;
}
function step3Valid(s: WizardState): boolean {
  if (s.equipments.length === 0) return false;
  return s.equipments.every((e) => {
    const serials = e.serials.map((x) => x.trim()).filter(Boolean);
    return e.name.trim().length > 0 && serials.length > 0 && new Set(serials).size === serials.length;
  });
}
function step5Valid(s: WizardState, families: IntakeFamily[]): boolean {
  return step1Valid(s) && step2Valid(s, families) && step3Valid(s);
}

const STEP_LABELS = ["Order", "Type & route", "Equipment", "Configuration", "Review"];

export function NewJobWizard({ options }: { options: IntakeOptions }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [extraClients, setExtraClients] = useState<Array<{ id: number; name: string; code: string | null }>>([]);
  const [state, setState] = useState<WizardState>(() => readStateFromUrl(searchParams, options));
  const [addClientOpen, setAddClientOpen] = useState(false);

  // router.replace, not a raw history write — see readStateFromUrl's comment
  // above: a debounced/raw write leaves a window where a Server Action's
  // implicit router refresh can resync the address bar to a URL the router
  // still thinks is current, silently discarding whatever changed since. A
  // synchronous replace on every state change closes that window. The page
  // component never reads searchParams, so this shallow-replace never
  // re-runs loadIntakeOptions.
  useEffect(() => {
    const qs = new URLSearchParams();
    qs.set("s", JSON.stringify(state));
    router.replace(`${pathname}?${qs.toString()}`, { scroll: false });
  }, [pathname, state, router]);

  const clients = useMemo(() => [...options.clients, ...extraClients], [options.clients, extraClients]);
  const family = options.families.find((f) => f.id === state.familyId) ?? null;
  const version = family?.versions.find((v) => v.id === state.versionId) ?? null;

  const patch = (p: Partial<WizardState>) => setState((s) => ({ ...s, ...p }));

  const goToStep = (n: number) => {
    if (n > state.maxStep) return;
    patch({ step: n });
  };

  const next = () => {
    const n = Math.min(5, state.step + 1);
    patch({ step: n, maxStep: Math.max(state.maxStep, n) });
  };
  const back = () => patch({ step: Math.max(1, state.step - 1) });

  const canAdvance =
    state.step === 1 ? step1Valid(state) :
    state.step === 2 ? step2Valid(state, options.families) :
    state.step === 3 ? step3Valid(state) :
    true;

  // ── Job creation result panel (step 5) ──────────────────────────────
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{ message: string; detail?: Record<string, unknown> } | null>(null);
  const [createdJob, setCreatedJob] = useState<NonNullable<CreateJobActionResult["job"]>>();
  const [verdict, setVerdict] = useState<ScheduleVerdict | null>(null);

  const handleCreate = async () => {
    if (!step5Valid(state, options.families)) {
      toast.error("Some required fields are missing. Go back and complete every step first.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    const input: CreateJobInput = {
      clientId: state.clientId!,
      familyId: state.familyId!,
      templateVersionId: state.versionId!,
      calendarId: state.calendarId,
      jobNumber: state.jobNumber.trim(),
      clientOrderNo: state.clientOrderNo.trim() || null,
      projectName: state.projectName.trim() || null,
      poRef: state.poRef.trim() || null,
      designCode: state.designCode.trim() || null,
      orderDate: state.orderDate ? new Date(state.orderDate) : null,
      committedDeliveryDate: state.committedDeliveryDate ? new Date(state.committedDeliveryDate) : null,
      targetDispatchDate: state.targetDispatchDate ? new Date(state.targetDispatchDate) : null,
      priority: state.priority,
      remarks: state.remarks.trim() || null,
      specs: Object.keys(state.specs).length ? state.specs : null,
      excludedProcessCodes: state.excludedProcessCodes,
      equipments: state.equipments.map((e) => ({
        equipmentTypeId: e.equipmentTypeId,
        name: e.name.trim(),
        blockNo: e.blockNo.trim() ? Number(e.blockNo) : null,
        remarks: e.remarks.trim() || null,
        serials: e.serials.map((x) => x.trim()).filter(Boolean),
      })),
      qcpTemplateSourceId: state.qcpTemplateSourceId,
      copyBomFromEquipmentId: state.copyBomFromEquipmentId,
    };

    const res = await createJobAction(input);
    if (!res.ok) {
      setCreateError({ message: res.message, detail: res.detail });
      setCreating(false);
      return;
    }
    const job = res.job!;
    setCreatedJob(job);
    const v = await scheduleNewJobAction(
      job.jobId,
      state.committedDeliveryDate ? new Date(state.committedDeliveryDate) : undefined,
    );
    setVerdict(v);
    setCreating(false);
  };

  return (
    <>
      <div className="page-h">
        <h1>New job</h1>
        <span className="sub">Client order → work order in five steps</span>
      </div>

      <div className="wiz-steps">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const cls = n === state.step ? "on" : n < state.step ? "done" : "";
          const unlocked = n <= state.maxStep;
          return (
            <div key={label} className={`wiz-step ${cls}`}>
              <button
                type="button"
                className="wiz-step-btn"
                disabled={!unlocked}
                onClick={() => goToStep(n)}
                aria-current={n === state.step ? "step" : undefined}
              >
                <span className="wiz-step-n">{n < state.step ? "✓" : n}</span>
                {label}
              </button>
            </div>
          );
        })}
      </div>

      {state.step === 1 && (
        <StepOrder
          state={state}
          patch={patch}
          options={options}
          clients={clients}
          onAddClient={() => setAddClientOpen(true)}
        />
      )}
      {state.step === 2 && (
        <StepRoute state={state} patch={patch} options={options} family={family} />
      )}
      {state.step === 3 && (
        <StepEquipment state={state} patch={patch} options={options} family={family} />
      )}
      {state.step === 4 && (
        <StepConfig state={state} patch={patch} options={options} family={family} />
      )}
      {state.step === 5 && (
        <StepReview
          state={state}
          options={options}
          clients={clients}
          family={family}
          version={version}
          creating={creating}
          createError={createError}
          createdJob={createdJob}
          verdict={verdict}
          onCreate={handleCreate}
          onOpenJob={() => createdJob && router.push(`/jobs/${createdJob.jobId}`)}
        />
      )}

      {state.step < 5 && (
        <div className="sh-ft" style={{ border: "none", padding: "16px 0 0", justifyContent: "space-between" }}>
          <button className="btn" onClick={back} disabled={state.step === 1}>← Back</button>
          <button className="btn btn-accent" onClick={next} disabled={!canAdvance}>Next →</button>
        </div>
      )}
      {state.step === 5 && !createdJob && (
        <div className="sh-ft" style={{ border: "none", padding: "16px 0 0", justifyContent: "space-between" }}>
          <button className="btn" onClick={back} disabled={creating}>← Back</button>
        </div>
      )}

      {addClientOpen && (
        <AddClientDialog
          onClose={() => setAddClientOpen(false)}
          onCreated={(c) => {
            setExtraClients((prev) => [...prev, c]);
            patch({ clientId: c.id });
            setAddClientOpen(false);
          }}
        />
      )}
    </>
  );
}

// ── Step 1: Order ──────────────────────────────────────────────────────
function StepOrder({
  state,
  patch,
  options,
  clients,
  onAddClient,
}: {
  state: WizardState;
  patch: (p: Partial<WizardState>) => void;
  options: IntakeOptions;
  clients: Array<{ id: number; name: string; code: string | null }>;
  onAddClient: () => void;
}) {
  const dateOrderError =
    state.targetDispatchDate && state.committedDeliveryDate && state.targetDispatchDate > state.committedDeliveryDate;

  return (
    <div className="card">
      <div className="hd"><h3>Order details</h3></div>
      <div style={{ padding: 16 }}>
        <div className="emp-grid">
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Client *</label>
            <ClientPicker clients={clients} value={state.clientId} onChange={(id) => patch({ clientId: id })} onAddNew={onAddClient} />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Job number *</label>
            <input className="ws-detail" value={state.jobNumber} onChange={(e) => patch({ jobNumber: e.target.value })} placeholder="e.g. DESPL-321" />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Client order no.</label>
            <input className="ws-detail" value={state.clientOrderNo} onChange={(e) => patch({ clientOrderNo: e.target.value })} />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>PO reference</label>
            <input className="ws-detail" value={state.poRef} onChange={(e) => patch({ poRef: e.target.value })} />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Project name</label>
            <input className="ws-detail" value={state.projectName} onChange={(e) => patch({ projectName: e.target.value })} />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Order date</label>
            <input className="ws-detail" type="date" value={state.orderDate} onChange={(e) => patch({ orderDate: e.target.value })} />
          </div>
        </div>

        <div className="emp-grid" style={{ marginTop: 4 }}>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Committed delivery date</label>
            <input className="ws-detail" type="date" value={state.committedDeliveryDate} onChange={(e) => patch({ committedDeliveryDate: e.target.value })} />
            <div className="emp-hint">The date promised to the client. Lateness is measured against this.</div>
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Target dispatch date</label>
            <input className="ws-detail" type="date" value={state.targetDispatchDate} onChange={(e) => patch({ targetDispatchDate: e.target.value })} />
            <div className="emp-hint">DESPL&apos;s internal aim, usually earlier.</div>
            {dateOrderError && (
              <div className="ws-err">Target dispatch cannot be later than the committed delivery date.</div>
            )}
          </div>
        </div>

        <div className="emp-grid" style={{ marginTop: 4 }}>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Priority</label>
            <select className="ws-detail" value={state.priority} onChange={(e) => patch({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Work calendar</label>
            <select
              className="ws-detail"
              value={state.calendarId ?? ""}
              onChange={(e) => patch({ calendarId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">No calendar selected</option>
              {options.calendars.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.isDefault ? " (default)" : ""}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Client searchable picker — reuses the topbar job switcher's .drop/.d-row
// idiom instead of pulling in a combobox dependency. ────────────────────
function ClientPicker({
  clients,
  value,
  onChange,
  onAddNew,
}: {
  clients: Array<{ id: number; name: string; code: string | null }>;
  value: number | null;
  onChange: (id: number) => void;
  onAddNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const selected = clients.find((c) => c.id === value) ?? null;

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = clients.filter(
    (c) => c.name.toLowerCase().includes(q.toLowerCase()) || (c.code ?? "").toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <input
        className="ws-detail"
        placeholder="Search client…"
        value={open ? q : (selected?.name ?? "")}
        onFocus={() => { setOpen(true); setQ(""); }}
        onChange={(e) => setQ(e.target.value)}
      />
      {open && (
        <div className="drop" style={{ left: 0, right: "auto", top: "calc(100% + 4px)", minWidth: "100%" }}>
          {filtered.length === 0 ? (
            <div className="d-row" style={{ color: "var(--muted)" }}>No matches</div>
          ) : (
            filtered.map((c) => (
              <div key={c.id} className="d-row" onClick={() => { onChange(c.id); setOpen(false); }}>
                {c.name}{c.code ? <small> {c.code}</small> : null}
              </div>
            ))
          )}
          <div className="d-row" style={{ color: "var(--accent)", fontWeight: 600 }} onClick={() => { setOpen(false); onAddNew(); }}>
            + Add client…
          </div>
        </div>
      )}
    </div>
  );
}

function AddClientDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: { id: number; name: string; code: string | null }) => void;
}) {
  const themeClass = useThemeClass();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const submit = () => {
    if (!name.trim()) return toast.error("A client name is required.");
    startTransition(async () => {
      const r = await createClientAction({ name: name.trim(), code: code.trim() || null });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("Client added.");
      onCreated({ id: r.clientId!, name: r.name!, code: code.trim() || null });
    });
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild><button className="sh-x" aria-label="Close">✕</button></Dialog.Close>
            <Dialog.Title asChild><h2>Add client</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <div className="emp-grid">
              <input className="ws-detail" placeholder="Client name *" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="ws-detail" placeholder="Code (optional)" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>Add client</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Step 2: Type and route ───────────────────────────────────────────────
function StepRoute({
  state,
  patch,
  options,
  family,
}: {
  state: WizardState;
  patch: (p: Partial<WizardState>) => void;
  options: IntakeOptions;
  family: IntakeFamily | null;
}) {
  const [processes, setProcesses] = useState<TemplateProcessRow[]>([]);
  const [loadingProcesses, setLoadingProcesses] = useState(false);
  const defaultsAppliedFor = useRef<number | null>(state.versionId);

  useEffect(() => {
    if (!state.versionId) { setProcesses([]); return; }
    let cancelled = false;
    setLoadingProcesses(true);
    loadTemplateProcessesAction(state.versionId).then((r) => {
      if (cancelled) return;
      setLoadingProcesses(false);
      if (!r.ok) { toast.error(r.message); return; }
      setProcesses(r.processes ?? []);
      if (defaultsAppliedFor.current !== state.versionId) {
        defaultsAppliedFor.current = state.versionId;
        patch({ excludedProcessCodes: (r.processes ?? []).filter((p) => p.optional).map((p) => p.code) });
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.versionId]);

  const selectFamily = (f: IntakeFamily) => {
    if (!f.schedulable) return;
    const version = f.versions[0] ?? null;
    defaultsAppliedFor.current = null;
    patch({ familyId: f.id, versionId: version?.id ?? null, excludedProcessCodes: [], qcpTemplateSourceId: null });
  };

  const toggleExcluded = (code: string) => {
    const set = new Set(state.excludedProcessCodes);
    if (set.has(code)) set.delete(code); else set.add(code);
    patch({ excludedProcessCodes: [...set] });
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Product family</h3></div>
        <div style={{ padding: 16 }}>
          <div className="dept-grid">
            {options.families.map((f) => {
              const selected = state.familyId === f.id;
              return (
                <div
                  key={f.id}
                  className={`fam-card ${f.schedulable ? "pickable" : "disabled"} ${selected ? "sel" : ""}`}
                  role={f.schedulable ? "button" : undefined}
                  tabIndex={f.schedulable ? 0 : undefined}
                  onClick={() => selectFamily(f)}
                  onKeyDown={(e) => { if (f.schedulable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectFamily(f); } }}
                >
                  <h4>{f.name}</h4>
                  {f.schedulable ? (
                    <div className="rep">{f.versions.length} route version{f.versions.length === 1 ? "" : "s"} available</div>
                  ) : (
                    <div className="rep" style={{ color: "var(--s-hold)" }}>
                      No process route defined yet — <Link href="/admin/templates">set one up →</Link>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {family && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="hd"><h3>Process route version</h3></div>
          <div style={{ padding: 16 }}>
            <select
              className="ws-detail"
              value={state.versionId ?? ""}
              onChange={(e) => {
                defaultsAppliedFor.current = null;
                patch({ versionId: Number(e.target.value), excludedProcessCodes: [] });
              }}
              style={{ maxWidth: 460 }}
            >
              {family.versions.map((v) => (
                <option key={v.id} value={v.id}>{v.templateName} v{v.version} — {v.processCount} processes</option>
              ))}
            </select>
            {(() => {
              const v = family.versions.find((x) => x.id === state.versionId);
              return v && v.provisionalCount > 0 ? (
                <div className="chip c-hold" style={{ marginTop: 10 }}>
                  <i />{v.provisionalCount} process{v.provisionalCount === 1 ? "" : "es"} have no confirmed duration — this job will not produce dates yet.
                </div>
              ) : null;
            })()}
          </div>
          {loadingProcesses ? (
            <div style={{ padding: 16, display: "grid", gap: 8 }}>
              {Array.from({ length: 4 }).map((_, i) => <span key={i} className="skel" style={{ height: 24, width: "100%" }} />)}
            </div>
          ) : processes.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 50 }}>Seq</th>
                  <th>Process</th>
                  <th>Department</th>
                  <th className="num">Duration</th>
                  <th className="num" style={{ width: 90 }}>Include</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((p) => {
                  const excluded = state.excludedProcessCodes.includes(p.code);
                  return (
                    <tr className="row" key={p.code} style={excluded ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>
                      <td className="mono">{p.seq}</td>
                      <td>{p.name}{p.provisional && <span className="chip c-hold" style={{ marginLeft: 6 }}><i />Placeholder</span>}</td>
                      <td style={{ color: "var(--muted)" }}>{p.departmentName}</td>
                      <td className="num mono">{p.durationMaxDays ?? "—"}</td>
                      <td className="num">
                        <input type="checkbox" checked={!excluded} onChange={() => toggleExcluded(p.code)} aria-label={`Include ${p.name}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>
      )}

      <div className="card">
        <div className="hd"><h3>QCP template (optional)</h3></div>
        <div style={{ padding: 16 }}>
          <select
            className="ws-detail"
            value={state.qcpTemplateSourceId ?? ""}
            onChange={(e) => patch({ qcpTemplateSourceId: e.target.value ? Number(e.target.value) : null })}
            style={{ maxWidth: 460 }}
          >
            <option value="">No QCP — attach later</option>
            {options.qcpTemplates.map((q) => (
              <option key={q.id} value={q.id}>{q.vessel} rev {q.revision} — {q.itemCount} items ({q.label})</option>
            ))}
          </select>
        </div>
      </div>
    </>
  );
}

// ── Step 3: Equipment and serials ────────────────────────────────────────
function StepEquipment({
  state,
  patch,
  options,
  family,
}: {
  state: WizardState;
  patch: (p: Partial<WizardState>) => void;
  options: IntakeOptions;
  family: IntakeFamily | null;
}) {
  const typesForFamily = options.equipmentTypes.filter((t) => t.familyId === state.familyId);

  const updateBlock = (key: string, fn: (b: EquipBlockState) => EquipBlockState) => {
    patch({ equipments: state.equipments.map((b) => (b.key === key ? fn(b) : b)) });
  };

  const addBlock = () => patch({ equipments: [...state.equipments, emptyBlock()] });
  const removeBlock = (key: string) => patch({ equipments: state.equipments.filter((b) => b.key !== key) });

  const selectEquipmentType = (key: string, typeId: number | null) => {
    const type = options.equipmentTypes.find((t) => t.id === typeId) ?? null;
    updateBlock(key, (b) => ({ ...b, equipmentTypeId: typeId, name: type ? type.name : b.name }));
    if (type) {
      patch({
        designCode: type.defaultDesignCode ?? state.designCode,
        specs: type.defaultSpecs
          ? Object.fromEntries(Object.entries(type.defaultSpecs).map(([k, v]) => [k, String(v)]))
          : state.specs,
      });
    }
  };

  return (
    <div>
      {state.equipments.map((b, idx) => (
        <div className="card" style={{ marginBottom: 14 }} key={b.key}>
          <div className="hd">
            <h3>Equipment block {idx + 1}</h3>
            {state.equipments.length > 1 && (
              <button className="btn" style={{ marginLeft: "auto" }} onClick={() => removeBlock(b.key)}>Remove</button>
            )}
          </div>
          <div style={{ padding: 16 }}>
            <div className="emp-grid">
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Equipment type</label>
                <select
                  className="ws-detail"
                  value={b.equipmentTypeId ?? ""}
                  onChange={(e) => selectEquipmentType(b.key, e.target.value ? Number(e.target.value) : null)}
                  disabled={!family}
                >
                  <option value="">{family ? "Select equipment type…" : "Choose a family first"}</option>
                  {typesForFamily.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Block name *</label>
                <input className="ws-detail" value={b.name} onChange={(e) => updateBlock(b.key, (x) => ({ ...x, name: e.target.value }))} />
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Block number</label>
                <input className="ws-detail" type="number" min={1} value={b.blockNo} onChange={(e) => updateBlock(b.key, (x) => ({ ...x, blockNo: e.target.value }))} />
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Remarks</label>
                <input className="ws-detail" value={b.remarks} onChange={(e) => updateBlock(b.key, (x) => ({ ...x, remarks: e.target.value }))} />
              </div>
            </div>

            <div className="sh-sec">Serial scheme</div>
            <div className="emp-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Prefix</label>
                <input
                  className="ws-detail"
                  value={b.serialPrefix}
                  placeholder="e.g. 320SR"
                  onChange={(e) => updateBlock(b.key, (x) => ({ ...x, serialPrefix: e.target.value, serials: generateSerials(e.target.value, x.serialStart, x.serialPad, x.serialCount) }))}
                />
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Start</label>
                <input
                  className="ws-detail"
                  type="number"
                  min={0}
                  value={b.serialStart}
                  onChange={(e) => updateBlock(b.key, (x) => ({ ...x, serialStart: e.target.value, serials: generateSerials(x.serialPrefix, e.target.value, x.serialPad, x.serialCount) }))}
                />
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Pad width</label>
                <input
                  className="ws-detail"
                  type="number"
                  min={0}
                  max={6}
                  value={b.serialPad}
                  onChange={(e) => updateBlock(b.key, (x) => ({ ...x, serialPad: e.target.value, serials: generateSerials(x.serialPrefix, x.serialStart, e.target.value, x.serialCount) }))}
                />
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Quantity</label>
                <input
                  className="ws-detail"
                  type="number"
                  min={1}
                  value={b.serialCount}
                  onChange={(e) => updateBlock(b.key, (x) => ({ ...x, serialCount: e.target.value, serials: generateSerials(x.serialPrefix, x.serialStart, x.serialPad, e.target.value) }))}
                />
              </div>
            </div>

            <div className="emp-hint" style={{ marginTop: 10 }}>
              {b.serials.length} serial{b.serials.length === 1 ? "" : "s"} — each editable below
            </div>
            <div className="serial-row">
              {b.serials.map((serial, i) => (
                <input
                  key={i}
                  className="ws-detail mono"
                  value={serial}
                  onChange={(e) => updateBlock(b.key, (x) => {
                    const serials = [...x.serials];
                    serials[i] = e.target.value;
                    return { ...x, serials };
                  })}
                />
              ))}
            </div>
            {new Set(b.serials.map((s) => s.trim())).size !== b.serials.map((s) => s.trim()).filter(Boolean).length && (
              <div className="ws-err">Serial numbers must be unique within this block.</div>
            )}
          </div>
        </div>
      ))}
      <button className="btn" onClick={addBlock}>+ Add another equipment block</button>
    </div>
  );
}

// ── Step 4: Material and configuration ───────────────────────────────────
function StepConfig({
  state,
  patch,
  options,
  family,
}: {
  state: WizardState;
  patch: (p: Partial<WizardState>) => void;
  options: IntakeOptions;
  family: IntakeFamily | null;
}) {
  const fields = family ? specFieldsFor(family.code) : [];
  const setSpec = (key: string, value: string) => patch({ specs: { ...state.specs, [key]: value } });

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Design configuration</h3></div>
        <div style={{ padding: 16 }}>
          <div style={{ marginBottom: 14 }}>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Design code</label>
            <input className="ws-detail" style={{ maxWidth: 320 }} value={state.designCode} onChange={(e) => patch({ designCode: e.target.value })} />
          </div>

          {fields.length === 0 ? (
            <p className="note" style={{ margin: 0, textAlign: "left" }}>No design fields are defined for this equipment type yet.</p>
          ) : (
            <div className="emp-grid">
              {fields.map((f) => (
                <div key={f.key}>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>
                    {f.label}{f.unit ? ` (${f.unit})` : ""}
                  </label>
                  {f.type === "select" ? (
                    <select className="ws-detail" value={state.specs[f.key] ?? ""} onChange={(e) => setSpec(f.key, e.target.value)}>
                      <option value="">—</option>
                      {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      className="ws-detail"
                      type={f.type === "number" ? "number" : "text"}
                      value={state.specs[f.key] ?? ""}
                      onChange={(e) => setSpec(f.key, e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="hd"><h3>Copy BOM (optional)</h3></div>
        <div style={{ padding: 16 }}>
          <select
            className="ws-detail"
            style={{ maxWidth: 460 }}
            value={state.copyBomFromEquipmentId ?? ""}
            onChange={(e) => patch({ copyBomFromEquipmentId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Don&apos;t copy a BOM</option>
            {options.bomSources.map((s) => (
              <option key={s.equipmentId} value={s.equipmentId}>{s.label} — {s.itemCount} items</option>
            ))}
          </select>
          <div className="emp-hint">Copies BOM lines onto the first equipment block above.</div>
        </div>
      </div>
    </>
  );
}

// ── Step 5: Review and create ────────────────────────────────────────────
function StepReview({
  state,
  options,
  clients,
  family,
  version,
  creating,
  createError,
  createdJob,
  verdict,
  onCreate,
  onOpenJob,
}: {
  state: WizardState;
  options: IntakeOptions;
  clients: Array<{ id: number; name: string; code: string | null }>;
  family: IntakeFamily | null;
  version: IntakeFamily["versions"][number] | null;
  creating: boolean;
  createError: { message: string; detail?: Record<string, unknown> } | null;
  createdJob: NonNullable<CreateJobActionResult["job"]> | undefined;
  verdict: ScheduleVerdict | null;
  onCreate: () => void;
  onOpenJob: () => void;
}) {
  const client = clients.find((c) => c.id === state.clientId);
  const qcp = options.qcpTemplates.find((q) => q.id === state.qcpTemplateSourceId);
  const calendar = options.calendars.find((c) => c.id === state.calendarId);
  const excludedCount = state.excludedProcessCodes.length;

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Order</h3></div>
        <div style={{ padding: 16 }}>
          <dl className="sh-kv">
            <div style={{ display: "contents" }}><dt>Client</dt><dd>{client?.name ?? "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Job number</dt><dd className="mono">{state.jobNumber || "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Client order no.</dt><dd>{state.clientOrderNo || "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>PO reference</dt><dd>{state.poRef || "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Project name</dt><dd>{state.projectName || "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Order date</dt><dd>{state.orderDate ? fmtDate(state.orderDate) : "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Committed delivery</dt><dd>{state.committedDeliveryDate ? fmtDate(state.committedDeliveryDate) : "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Target dispatch</dt><dd>{state.targetDispatchDate ? fmtDate(state.targetDispatchDate) : "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Priority</dt><dd>{PRIORITY_LABEL[state.priority]}</dd></div>
            <div style={{ display: "contents" }}><dt>Work calendar</dt><dd>{calendar?.name ?? "—"}</dd></div>
          </dl>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Type and route</h3></div>
        <div style={{ padding: 16 }}>
          <dl className="sh-kv">
            <div style={{ display: "contents" }}><dt>Family</dt><dd>{family?.name ?? "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Route version</dt><dd>{version ? `${version.templateName} v${version.version}` : "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Processes</dt><dd>{excludedCount > 0 ? `${excludedCount} excluded` : "All included"}</dd></div>
          </dl>
          {version && version.provisionalCount > 0 && (
            <div className="chip c-hold" style={{ marginTop: 4 }}>
              <i />{version.provisionalCount} process{version.provisionalCount === 1 ? "" : "es"} are provisional — dates cannot be computed for this job yet.
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            {qcp ? (
              <span className="chip c-submitted"><i />{qcp.vessel} rev {qcp.revision} — {qcp.itemCount} QCP items will be cloned</span>
            ) : (
              <p className="note" style={{ margin: 0, textAlign: "left" }}>No QCP attached — no hold points will block completion until one is added.</p>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Equipment and serials</h3></div>
        <table>
          <thead><tr><th>Block</th><th className="num">Serials</th><th>Serial numbers</th></tr></thead>
          <tbody>
            {state.equipments.map((b) => (
              <tr className="row" key={b.key}>
                <td>{b.name || "—"}</td>
                <td className="num mono">{b.serials.filter((s) => s.trim()).length}</td>
                <td className="mono" style={{ color: "var(--muted)" }}>{b.serials.filter((s) => s.trim()).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Configuration</h3></div>
        <div style={{ padding: 16 }}>
          <dl className="sh-kv">
            <div style={{ display: "contents" }}><dt>Design code</dt><dd>{state.designCode || "—"}</dd></div>
          </dl>
          {Object.keys(state.specs).length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {Object.entries(state.specs).filter(([, v]) => v).map(([k, v]) => <span className="tag" key={k}>{k}: {v}</span>)}
            </div>
          )}
        </div>
      </div>

      {createError && (
        <div className="card" style={{ marginBottom: 14, borderColor: "var(--s-overdue)" }}>
          <div style={{ padding: 16 }}>
            <div className="chip c-overdue"><i />{createError.message}</div>
            {createError.detail && typeof createError.detail.existingJobId === "number" ? (
              <div style={{ marginTop: 8 }}>
                <Link href={`/jobs/${createError.detail.existingJobId}`} className="btn">View existing job →</Link>
              </div>
            ) : createError.detail ? (
              <div className="emp-hint" style={{ marginTop: 8 }}>
                {Object.entries(createError.detail).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {createdJob && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="hd"><h3>Job created</h3></div>
          <div style={{ padding: 16 }}>
            <p style={{ margin: "0 0 10px" }}>
              <b>{createdJob.publicId}</b> — {createdJob.unitCount} unit{createdJob.unitCount === 1 ? "" : "s"}, {createdJob.processCount} processes, {createdJob.qcpItemCount} QCP items, {createdJob.bomItemCount} BOM lines.
            </p>
            {createdJob.unmatchedQcpProcessCodes.length > 0 && (
              <p className="note" style={{ textAlign: "left", margin: "0 0 10px" }}>
                {createdJob.unmatchedQcpProcessCodes.length} QCP item{createdJob.unmatchedQcpProcessCodes.length === 1 ? "" : "s"} skipped — no matching process on this route ({createdJob.unmatchedQcpProcessCodes.join(", ")}).
              </p>
            )}
            {verdict ? <VerdictPanel verdict={verdict} /> : <div className="chip c-idle"><i />Computing schedule…</div>}
            <button className="btn btn-accent" style={{ marginTop: 14 }} onClick={onOpenJob} disabled={!verdict}>
              Open job →
            </button>
          </div>
        </div>
      )}

      {!createdJob && (
        <button className="btn btn-accent" disabled={creating} onClick={onCreate}>
          {creating ? "Creating…" : "Create job"}
        </button>
      )}
    </>
  );
}

// Split out of StepReview's JSX: TS's control-flow narrowing on a
// multi-value discriminant ("FEASIBLE" | "INFEASIBLE" sharing one union
// member) doesn't survive a chain of ternaries, but does survive an if/else
// in its own function body.
function VerdictPanel({ verdict }: { verdict: ScheduleVerdict }) {
  switch (verdict.kind) {
    case "FEASIBLE":
      return <div className="chip c-complete"><i />Schedule feasible — {verdict.planCount} process plans generated</div>;
    case "INFEASIBLE":
      return (
        <>
          <div className="chip c-overdue"><i />Infeasible by {verdict.shortfallDays ?? "?"} day{verdict.shortfallDays === 1 ? "" : "s"}</div>
          <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>The schedule was still saved, so the gap is visible on the job page.</p>
        </>
      );
    case "DATA_MISSING":
      return (
        <>
          <div className="chip c-hold"><i />No schedule yet</div>
          <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>{verdict.message}</p>
        </>
      );
    case "FAILED":
      return (
        <>
          <div className="chip c-overdue"><i />Scheduling failed</div>
          <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>{verdict.message}</p>
        </>
      );
  }
}
