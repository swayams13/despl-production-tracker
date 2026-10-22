"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { copyJobToDraftAction, discardDraftAction } from "@/app/actions/job-draft";
import type { CopyableJob } from "@/lib/services/job-intake.read";
import { plural } from "@/lib/shared/plural";

/** What the page hands over: serialisable rows only. */
export interface StartDraft {
  id: number;
  label: string | null;
  updatedAt: string;
  sourceJobNumber: string | null;
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

const SHOWN = 8;

/** Frame 13A: the three ways to start, and the drafts already saved. */
export function StartScreen({
  drafts: initialDrafts,
  jobs,
  routeVersions,
  kitTypes,
  canRelease,
}: {
  drafts: StartDraft[];
  jobs: CopyableJob[];
  routeVersions: number;
  /** Equipment types with a non-empty standard kit. */
  kitTypes: number;
  canRelease: boolean;
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState(initialDrafts);
  const [q, setQ] = useState("");
  const [pending, startTransition] = useTransition();
  const [copying, setCopying] = useState<number | null>(null);

  const needle = q.trim().toLowerCase();
  const matches = jobs.filter((j) => !needle || `${j.jobNumber} ${j.clientName} ${j.product}`.toLowerCase().includes(needle));

  const copy = (jobId: number) => {
    setCopying(jobId);
    startTransition(async () => {
      const r = await copyJobToDraftAction(jobId);
      if (!r.ok) {
        toast.error(r.message);
        setCopying(null);
        return;
      }
      router.push(`/jobs/new?draft=${r.draft!.id}`);
    });
  };

  const discard = (id: number) => {
    startTransition(async () => {
      const r = await discardDraftAction(id);
      if (!r.ok) return void toast.error(r.message);
      setDrafts((d) => d.filter((x) => x.id !== id));
      toast.success("Draft discarded.");
    });
  };

  return (
    <>
      <div className="page-h">
        <h1>New job</h1>
        <span className="sub">How do you want to start? Every route gives you an editable draft. Nothing reaches the floor until it is created.</span>
      </div>

      {drafts.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }} aria-label="Saved drafts">
          <div className="hd"><h3>Saved drafts</h3></div>
          <table>
            <tbody>
              {drafts.map((d) => (
                <tr className="row" key={d.id}>
                  <td>
                    <b>{d.label ?? "Untitled draft"}</b>
                    {d.sourceJobNumber && <span className="emp-hint"> · copied from {d.sourceJobNumber}</span>}
                  </td>
                  <td style={{ color: "var(--muted)" }}>Saved {fmtWhen(d.updatedAt)}</td>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>
                    <Link className="btn btn-accent" href={`/jobs/new?draft=${d.id}`}>Resume</Link>{" "}
                    <button className="btn" disabled={pending} onClick={() => discard(d.id)}>Discard</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Copy a previous job</h3></div>
        <div style={{ padding: 16 }}>
          <p className="emp-hint" style={{ marginTop: 0 }}>
            Copies its answers, BOM, weld map and QC plan as an editable draft. Serials, dates and floor progress start fresh.
          </p>
          <input
            className="ws-detail"
            style={{ maxWidth: 460 }}
            placeholder="Search by job number, client or product"
            aria-label="Search previous jobs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {jobs.length === 0 ? (
          <p className="note" style={{ padding: "0 16px 16px", textAlign: "left" }}>No jobs yet. Start from a template instead.</p>
        ) : matches.length === 0 ? (
          <p className="note" style={{ padding: "0 16px 16px", textAlign: "left" }}>No job matches “{q}”. Clear the search to see them all.</p>
        ) : (
          <table>
            <thead><tr><th>Job</th><th>Client</th><th>Product</th><th>Date</th><th /></tr></thead>
            <tbody>
              {matches.slice(0, SHOWN).map((j) => (
                <tr className="row" key={j.id}>
                  <td className="mono">{j.jobNumber}</td>
                  <td>{j.clientName}</td>
                  <td style={{ color: "var(--muted)" }}>{j.product}</td>
                  <td className="mono">{j.date ?? "—"}</td>
                  <td className="num">
                    <button className="btn" disabled={pending} onClick={() => copy(j.id)} aria-label={`Copy ${j.jobNumber} as draft`}>
                      {copying === j.id ? "Copying…" : "Copy as draft"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {matches.length > SHOWN && <p className="emp-hint" style={{ padding: "0 16px 14px" }}>Showing {SHOWN} of {matches.length}. Search to narrow the list.</p>}
      </div>

      <div className="dept-grid">
        <div className="card">
          <div className="hd"><h3>Start from an equipment template</h3></div>
          <div style={{ padding: 16 }}>
            <p className="emp-hint" style={{ marginTop: 0 }}>
              Choose the process route and equipment for each line. Your answers to its questions decide which processes, weld steps and QC points the job gets.
            </p>
            <p className="emp-hint">{plural(routeVersions, "published route version")} available.</p>
            <Link className="btn btn-accent" href="/jobs/new?route=template">Start from a template</Link>
          </div>
        </div>
        <div className="card">
          <div className="hd"><h3>Build from master</h3></div>
          <div style={{ padding: 16 }}>
            <p className="emp-hint" style={{ marginTop: 0 }}>
              For an order with no template and no similar job. Pick the equipment type and its standard kit fills the BOM as a draft revision. Engineering checks and releases it.
            </p>
            {kitTypes > 0 ? (
              <>
                <p className="emp-hint">{plural(kitTypes, "equipment type")} with a standard kit.</p>
                <Link className="btn btn-accent" href="/jobs/new?route=master">Build from master</Link>
              </>
            ) : (
              <p className="note" style={{ textAlign: "left", margin: 0 }}>
                No equipment type has a standard kit yet. Add one under <Link href="/admin/equipment-types">Equipment types</Link> first.
              </p>
            )}
          </div>
        </div>
      </div>
      {!canRelease && <p className="emp-hint" style={{ marginTop: 12 }}>You can build and save drafts. The Production Head or an Admin creates the job from your draft.</p>}
    </>
  );
}
