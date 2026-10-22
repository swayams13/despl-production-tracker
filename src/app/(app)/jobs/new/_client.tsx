"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { loadTemplateProcessesAction, scheduleNewJobAction, type ScheduleVerdict } from "@/app/actions/job-intake";
import { previewJobAction, releaseDraftAction, saveDraftAction } from "@/app/actions/job-draft";
import type { IntakeOptions, IntakeFamily } from "@/lib/services/job-intake.read";
import type { CreateJobResult } from "@/lib/services/job-intake.service";
import {
  LAST_STEP,
  STEP_LABELS,
  allValid,
  defaultState,
  fromPayload,
  payloadToInput,
  resumeStep,
  stepBlockReason,
  toPayload,
  type WizardState,
} from "./wizard-state";
import { StepOrder, AddClientDialog } from "./step-order";
import { StepLines } from "./step-lines";
import { StepConfigure, type ProcessesState } from "./step-configure";
import { StepQcp } from "./step-qcp";
import { StepRelease } from "./step-release";
import type { PreviewState } from "./preview-panel";

// Kept here so the existing step-1 tests and any importer keep working.
export { step1Valid, step1BlockReason } from "./wizard-state";

type SaveState = { status: "idle" | "saving" | "saved" | "error"; at?: Date; message?: string };

const SAVE_DELAY_MS = 800;
const PREVIEW_DELAY_MS = 700;

function clock(d: Date): string {
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" });
}

/**
 * The new-job wizard (J7b). State lives in this component; the URL carries at most `?draft=<id>`.
 * Every change is autosaved to a `job_drafts` row (`saveDraftAction`), the Configure and Schedule
 * steps preview from `previewJobAction` (the real createJob in a rolled-back transaction) and
 * Create releases the draft (`releaseDraftAction`).
 */
export function NewJobWizard({
  options,
  canRelease,
  route = "template",
  initialDraft,
}: {
  options: IntakeOptions;
  canRelease: boolean;
  route?: "template" | "master";
  initialDraft?: { id: number; payload: Record<string, unknown>; sourceJobId: number | null };
}) {
  const router = useRouter();
  const [extraClients, setExtraClients] = useState<Array<{ id: number; name: string; code: string | null }>>([]);
  const [state, setState] = useState<WizardState>(() => {
    if (!initialDraft) return defaultState(options, route);
    const s = fromPayload(initialDraft.payload, options, route);
    const step = resumeStep(s, options.families);
    return { ...s, step, maxStep: step };
  });
  const [addClientOpen, setAddClientOpen] = useState(false);

  const clients = useMemo(() => [...options.clients, ...extraClients], [options.clients, extraClients]);
  const family = options.families.find((f) => f.id === state.familyId) ?? null;
  const version = family?.versions.find((v) => v.id === state.versionId) ?? null;
  const patch = useCallback((p: Partial<WizardState>) => setState((s) => ({ ...s, ...p })), []);

  // ── Routes and their processes ────────────────────────────────────────
  const [processes, setProcesses] = useState<ProcessesState>({ status: "loading" });
  const [processesNonce, setProcessesNonce] = useState(0);
  /** The version whose optional processes are left out by default, set when the person picks it (not when a draft is restored). */
  const defaultsFor = useRef<number | null>(null);
  useEffect(() => {
    const vid = state.versionId;
    if (vid == null) {
      setProcesses({ status: "ok", rows: [] });
      return;
    }
    let cancelled = false;
    setProcesses({ status: "loading" });
    loadTemplateProcessesAction(vid)
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) return void setProcesses({ status: "error", message: r.message });
        const rows = r.processes ?? [];
        setProcesses({ status: "ok", rows });
        if (defaultsFor.current === vid) {
          defaultsFor.current = null;
          setState((s) => (s.versionId === vid ? { ...s, excludedProcessCodes: rows.filter((p) => p.optional).map((p) => p.code) } : s));
        }
      })
      .catch(() => !cancelled && setProcesses({ status: "error", message: "The process list could not be loaded. Check your connection and try again." }));
    return () => {
      cancelled = true;
    };
  }, [state.versionId, processesNonce]);

  const selectFamily = (f: IntakeFamily) => {
    if (!f.schedulable || f.id === state.familyId) return;
    const v = f.versions[0] ?? null;
    defaultsFor.current = v?.id ?? null;
    setState((s) => ({
      ...s,
      familyId: f.id,
      versionId: v?.id ?? null,
      excludedProcessCodes: [],
      exclusionReason: "",
      qcpTemplateSourceId: null,
      equipments: s.familyId == null ? s.equipments : s.equipments.map((e) => ({ ...e, equipmentTypeId: null })),
    }));
  };
  const selectVersion = (id: number) => {
    defaultsFor.current = id;
    patch({ versionId: id, excludedProcessCodes: [], exclusionReason: "" });
  };

  // ── Autosave to the draft ─────────────────────────────────────────────
  const payloadKey = useMemo(() => JSON.stringify(toPayload(state)), [state]);
  const draftIdRef = useRef<number | null>(initialDraft?.id ?? null);
  const lastSaved = useRef<string>(payloadKey);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const [save, setSave] = useState<SaveState>(initialDraft ? { status: "saved" } : { status: "idle" });
  const [createdJob, setCreatedJob] = useState<CreateJobResult>();

  /** Saves `key` after any save already running; two saves never overlap, so the first one creates the draft and the rest update it. */
  const flushSave = useCallback((key: string): Promise<void> => {
    chain.current = chain.current.then(async () => {
      if (key === lastSaved.current) return;
      setSave((s) => ({ ...s, status: "saving" }));
      try {
        const r = await saveDraftAction(draftIdRef.current ?? undefined, JSON.parse(key));
        if (!r.ok) return void setSave({ status: "error", message: r.message });
        lastSaved.current = key;
        if (draftIdRef.current == null) {
          draftIdRef.current = r.draft!.id;
          // The draft id is the only thing the URL carries. A raw history write keeps the page mounted; no server round trip.
          window.history.replaceState(null, "", `/jobs/new?draft=${r.draft!.id}`);
        }
        setSave({ status: "saved", at: new Date() });
      } catch {
        setSave({ status: "error", message: "The draft could not be saved. Check your connection." });
      }
    });
    return chain.current;
  }, []);

  useEffect(() => {
    if (createdJob || payloadKey === lastSaved.current) return;
    const t = setTimeout(() => void flushSave(payloadKey), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [payloadKey, createdJob, flushSave]);

  const saveAndExit = async () => {
    await flushSave(payloadKey);
    if (lastSaved.current !== payloadKey) return toast.error("The draft could not be saved, so it was not closed.");
    router.push("/jobs/new");
  };

  // ── Live preview (steps 3 and 5) ──────────────────────────────────────
  const valid12 = stepBlockReason(1, state, options.families) === null && stepBlockReason(2, state, options.families) === null;
  const wantPreview = valid12 && (state.step === 3 || state.step === 5) && !createdJob;
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [previewNonce, setPreviewNonce] = useState(0);
  const previewed = useRef<string | null>(null);
  const previewSeq = useRef(0);
  const previewKey = `${payloadKey}#${previewNonce}`;
  useEffect(() => {
    if (!wantPreview || previewed.current === previewKey) return;
    const mine = ++previewSeq.current;
    const last = (p: PreviewState) => (p.status === "ok" ? p.data : p.status === "idle" ? undefined : p.last);
    setPreview((p) => ({ status: "loading", last: last(p) }));
    const t = setTimeout(async () => {
      try {
        const r = await previewJobAction(payloadToInput(JSON.parse(payloadKey)));
        if (mine !== previewSeq.current) return;
        if (r.ok) {
          previewed.current = previewKey;
          setPreview({ status: "ok", data: r.preview! });
        } else {
          setPreview((p) => ({ status: "error", message: r.message, detail: r.detail, last: last(p) }));
        }
      } catch {
        if (mine === previewSeq.current) {
          setPreview((p) => ({ status: "error", message: "The preview could not be loaded. Check your connection and try again.", last: last(p) }));
        }
      }
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(t);
  }, [wantPreview, previewKey, payloadKey]);
  const retryPreview = () => {
    previewed.current = null;
    setPreviewNonce((n) => n + 1);
  };

  // ── Navigation ────────────────────────────────────────────────────────
  const reason = stepBlockReason(state.step, state, options.families);
  const goToStep = (n: number) => {
    if (n > state.maxStep) return;
    for (let k = 1; k < n; k++) if (stepBlockReason(k, state, options.families)) return;
    patch({ step: n });
  };
  const next = () => {
    if (reason) return;
    const n = Math.min(LAST_STEP, state.step + 1);
    patch({ step: n, maxStep: Math.max(state.maxStep, n) });
  };
  const back = () => patch({ step: Math.max(1, state.step - 1) });

  // ── Create ────────────────────────────────────────────────────────────
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{ message: string; detail?: Record<string, unknown> } | null>(null);
  const [verdict, setVerdict] = useState<ScheduleVerdict | null>(null);

  const handleCreate = async () => {
    if (!allValid(state, options.families)) {
      toast.error("Some required fields are missing. Go back and complete every step first.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    await flushSave(payloadKey);
    if (lastSaved.current !== payloadKey || draftIdRef.current == null) {
      setCreateError({ message: "The draft could not be saved, so the job was not created. Check your connection and try again." });
      setCreating(false);
      return;
    }
    const res = await releaseDraftAction(draftIdRef.current);
    if (!res.ok) {
      setCreateError({ message: res.message, detail: res.detail });
      setCreating(false);
      return;
    }
    const job = res.job!;
    setCreatedJob(job);
    try {
      setVerdict(await scheduleNewJobAction(job.jobId, state.committedDeliveryDate ? new Date(state.committedDeliveryDate) : undefined));
    } catch {
      // The job exists; an unexpected scheduling failure must not leave "Open job" disabled.
      setVerdict({ kind: "FAILED", message: "The job was created, but its schedule could not be computed. Open the job and set the delivery date." });
    }
    setCreating(false);
  };

  return (
    <>
      <div className="page-h">
        <h1>New job{state.jobNumber.trim() ? `: ${state.jobNumber.trim()}` : ""}</h1>
        <span className="sub">Client order → work order in five steps</span>
        {!createdJob && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            <span className="emp-hint" role="status" aria-live="polite">
              {save.status === "saving" && "Saving the draft…"}
              {save.status === "saved" && (save.at ? `Draft saved ${clock(save.at)}` : "Draft saved")}
              {save.status === "error" && <span className="ws-err">Not saved: {save.message}</span>}
              {save.status === "idle" && "Saved as a draft once you start"}
            </span>
            {save.status === "error" && <button className="btn" onClick={() => void flushSave(payloadKey)}>Try again</button>}
            <button className="btn" onClick={saveAndExit} disabled={save.status === "saving"}>Save and exit</button>
          </div>
        )}
      </div>

      {!createdJob && (
        <div className="wiz-steps">
          {STEP_LABELS.map((label, i) => {
            const n = i + 1;
            const cls = n === state.step ? "on" : n < state.step ? "done" : "";
            return (
              <div key={label} className={`wiz-step ${cls}`}>
                <button type="button" className="wiz-step-btn" disabled={n > state.maxStep} onClick={() => goToStep(n)} aria-current={n === state.step ? "step" : undefined}>
                  <span className="wiz-step-n">{n < state.step ? "✓" : n}</span>
                  {label}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {state.step === 1 && !createdJob && (
        <StepOrder state={state} patch={patch} options={options} clients={clients} onAddClient={() => setAddClientOpen(true)} />
      )}
      {state.step === 2 && !createdJob && (
        <StepLines state={state} patch={patch} options={options} family={family} onSelectFamily={selectFamily} onSelectVersion={selectVersion} />
      )}
      {state.step === 3 && !createdJob && (
        <StepConfigure
          state={state}
          patch={patch}
          options={options}
          family={family}
          processes={processes}
          onReloadProcesses={() => setProcessesNonce((n) => n + 1)}
          preview={preview}
          onRetryPreview={retryPreview}
        />
      )}
      {state.step === 4 && !createdJob && <StepQcp state={state} patch={patch} options={options} />}
      {(state.step === 5 || createdJob) && (
        <StepRelease
          state={state}
          options={options}
          clients={clients}
          family={family}
          version={version}
          preview={preview}
          onRetryPreview={retryPreview}
          canRelease={canRelease}
          canCreate={allValid(state, options.families) && save.status !== "saving"}
          blockReason={[1, 2, 3].map((n) => stepBlockReason(n, state, options.families)).find(Boolean) ?? null}
          creating={creating}
          createError={createError}
          createdJob={createdJob}
          verdict={verdict}
          onCreate={handleCreate}
          onOpenJob={() => createdJob && router.push(`/jobs/${createdJob.jobId}`)}
        />
      )}

      {!createdJob && (
        <div className="sh-ft" style={{ border: "none", padding: "16px 0 0", justifyContent: "space-between" }}>
          <button className="btn" onClick={back} disabled={state.step === 1 || creating}>← Back</button>
          {state.step < LAST_STEP && reason && <span className="emp-hint" role="status">{reason}</span>}
          {state.step < LAST_STEP && (
            <button className="btn btn-accent" onClick={next} disabled={reason !== null}>Next →</button>
          )}
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
