"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "@/components/industrial/theme-root";
import { StatusChip } from "@/components/industrial/status-chip";
import { cloneVersionAction } from "@/app/actions/template";
import type { FamilyRow, TemplateVersionRow } from "@/lib/services/template.read";

type FlatRow = TemplateVersionRow & { templateId: number; templateName: string };
type SourceOption = { versionId: number; label: string };
type FamilyOption = { id: number; name: string };

function flatten(family: FamilyRow): FlatRow[] {
  return family.templates.flatMap((t) => t.versions.map((v) => ({ ...v, templateId: t.id, templateName: t.name })));
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" });
}

/** Every version in the system, labelled with its own family — used as the
 * source picker for a family with no route of its own yet. */
function allVersionOptions(families: FamilyRow[], excludeFamilyId: number): SourceOption[] {
  return families
    .filter((f) => f.id !== excludeFamilyId)
    .flatMap((f) =>
      flatten(f).map((r) => ({
        versionId: r.id,
        label: `${f.name} — ${r.templateName} v${r.version} (${r.status === "PUBLISHED" ? "Published" : "Draft"})`,
      })),
    );
}

/** What a clone dialog needs to run — either the source or the target family
 * (never both) is fixed by whichever control opened it; the other is picked. */
type CloneRequest = {
  title: string;
  sourceVersionId: number | null;
  sourceOptions: SourceOption[];
  crossFamily: boolean;
  fixedTargetFamilyId: number | null;
  familyOptions: FamilyOption[];
  defaultName: string;
};

export function TemplateIndexClient({ families }: { families: FamilyRow[] }) {
  const [clone, setClone] = useState<CloneRequest | null>(null);

  return (
    <>
      <div className="page-h">
        <h1>Process routes</h1>
        <span className="sub">Route templates by product family — versions, status, jobs in use</span>
      </div>

      {families.map((family) => {
        const rows = flatten(family);
        const otherFamilies = families.filter((f) => f.id !== family.id).map((f) => ({ id: f.id, name: f.name }));
        const sourcesElsewhere = allVersionOptions(families, family.id);

        return (
          <div className="card" key={family.id} style={{ marginBottom: 14 }}>
            <div className="hd">
              <h3>{family.name}</h3>
            </div>

            {rows.length === 0 ? (
              <div style={{ padding: "0 16px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <p className="note" style={{ margin: 0, textAlign: "left" }}>
                  No process route defined for {family.name}.
                </p>
                {sourcesElsewhere.length > 0 && (
                  <button
                    className="btn"
                    onClick={() =>
                      setClone({
                        title: `Add a process route for ${family.name}`,
                        sourceVersionId: null,
                        sourceOptions: sourcesElsewhere,
                        crossFamily: true,
                        fixedTargetFamilyId: family.id,
                        familyOptions: [],
                        defaultName: "",
                      })
                    }
                  >
                    Clone one from another family
                  </button>
                )}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Template</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th className="num">Processes</th>
                    <th className="num">Jobs using</th>
                    <th>Published</th>
                    <th>By</th>
                    <th className="num">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr className="row" key={r.id}>
                      <td>{r.templateName}</td>
                      <td className="mono">v{r.version}</td>
                      <td>
                        <StatusChip
                          status={r.status === "PUBLISHED" ? "complete" : "idle"}
                          label={r.status === "PUBLISHED" ? "Published" : "Draft"}
                        />
                      </td>
                      <td className="num mono">{r.processCount}</td>
                      <td className="num mono" style={r.jobCount > 0 ? { color: "var(--accent)", fontWeight: 600 } : undefined}>
                        {r.jobCount}
                      </td>
                      <td className="mono" style={{ color: "var(--muted)" }}>{formatDate(r.publishedAt)}</td>
                      <td style={{ color: "var(--muted)" }}>{r.publishedByName ?? "—"}</td>
                      <td className="num">
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                          <Link className="btn" href={`/admin/templates/${r.id}`}>Open</Link>
                          <button
                            className="btn"
                            onClick={() =>
                              setClone({
                                title: `Clone ${r.templateName} v${r.version} to a new draft`,
                                sourceVersionId: r.id,
                                sourceOptions: [],
                                crossFamily: false,
                                fixedTargetFamilyId: null,
                                familyOptions: [],
                                defaultName: "",
                              })
                            }
                          >
                            Clone to new draft
                          </button>
                          {otherFamilies.length > 0 && (
                            <button
                              className="btn"
                              onClick={() =>
                                setClone({
                                  title: `Clone ${r.templateName} v${r.version} to another family`,
                                  sourceVersionId: r.id,
                                  sourceOptions: [],
                                  crossFamily: true,
                                  fixedTargetFamilyId: null,
                                  familyOptions: otherFamilies,
                                  defaultName: r.templateName,
                                })
                              }
                            >
                              Clone to another family
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      {clone && <CloneDialog request={clone} onClose={() => setClone(null)} />}
    </>
  );
}

function CloneDialog({ request, onClose }: { request: CloneRequest; onClose: () => void }) {
  const { title, sourceVersionId, sourceOptions, crossFamily, fixedTargetFamilyId, familyOptions, defaultName } = request;
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(sourceVersionId ?? sourceOptions[0]?.versionId ?? null);
  const [selectedTargetFamilyId, setSelectedTargetFamilyId] = useState<number | null>(
    fixedTargetFamilyId ?? familyOptions[0]?.id ?? null,
  );
  const [name, setName] = useState(defaultName);
  const [notes, setNotes] = useState("");

  const submit = () => {
    if (!selectedSourceId) return toast.error("Pick a source version.");
    if (crossFamily && !selectedTargetFamilyId) return toast.error("Pick a target family.");
    if (crossFamily && !name.trim()) return toast.error("A name is required.");
    if (!notes.trim()) return toast.error("Say why this version exists.");
    startTransition(async () => {
      const r = await cloneVersionAction({
        sourceVersionId: selectedSourceId,
        targetFamilyId: crossFamily ? selectedTargetFamilyId! : undefined,
        name: crossFamily ? name.trim() : undefined,
        notes: notes.trim(),
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("Draft created.");
      onClose();
      router.push(`/admin/templates/${r.versionId}`);
    });
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">✕</button>
            </Dialog.Close>
            <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            {sourceOptions.length > 0 && (
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Source version *</label>
                <select
                  className="ws-detail"
                  value={selectedSourceId ?? ""}
                  onChange={(e) => setSelectedSourceId(Number(e.target.value))}
                >
                  {sourceOptions.map((o) => (
                    <option key={o.versionId} value={o.versionId}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
            {crossFamily && familyOptions.length > 0 && (
              <div style={{ marginTop: sourceOptions.length ? 12 : 0 }}>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Target family *</label>
                <select
                  className="ws-detail"
                  value={selectedTargetFamilyId ?? ""}
                  onChange={(e) => setSelectedTargetFamilyId(Number(e.target.value))}
                >
                  {familyOptions.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            )}
            {crossFamily && (
              <div style={{ marginTop: 12 }}>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>New template name *</label>
                <input className="ws-detail" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Notes *</label>
              <input
                className="ws-detail"
                placeholder="Say why this version exists"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>Clone</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
