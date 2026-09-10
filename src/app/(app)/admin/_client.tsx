"use client";

import { useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import {
  createDelayCategoryAction,
  toggleDelayCategoryAction,
  updateStandardDurationsAction,
  createEmployeeAction,
  generateResetPasswordAction,
  setUserActiveAction,
  updateUserRolesDeptsAction,
  bulkImportEmployeesAction,
} from "@/app/actions/admin";
import { ResponsiveTable } from "@/components/industrial/responsive-table";
import { useThemeClass } from "@/components/industrial/theme-root";
import type { AdminView, AdminUserRow } from "@/lib/services/admin.read";
import {
  parseEmployeeCsv,
  departmentsRequired,
  buildResultCsv,
  type ParsedEmployeeRow,
  type BulkImportRowReport,
} from "@/lib/admin/employee-csv";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  MANAGEMENT: "Management",
  PRODUCTION_HEAD: "Production Head",
  SUPERVISOR: "Supervisor",
  QC: "QC / QA",
  CLIENT_VIEWER: "Client",
};

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <R extends { ok: boolean; message?: string }>(
    fn: () => Promise<R>,
    ok: string | ((r: R) => string),
    after?: () => void,
  ) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(typeof ok === "function" ? ok(r) : ok);
        router.refresh();
        after?.();
      }
    });
  return { pending, run };
}

function toggleSet<T>(set: Set<T>, setSet: (s: Set<T>) => void, v: T) {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  setSet(next);
}

function formatLastLogin(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

export function AdminClient({ view, canEdit, actorUserId }: { view: AdminView; canEdit: boolean; actorUserId: number }) {
  return (
    <>
      <div className="page-h">
        <h1>Admin</h1>
        <span className="sub">Employees, delay reasons, standard durations{canEdit ? "" : " — read only"}</span>
      </div>

      <EmployeesSection view={view} canEdit={canEdit} actorUserId={actorUserId} />
      <DelayReasonsSection view={view} canEdit={canEdit} />
      <StandardDurationsSection view={view} canEdit={canEdit} />
    </>
  );
}

function EmployeesSection({ view, canEdit, actorUserId }: { view: AdminView; canEdit: boolean; actorUserId: number }) {
  const { pending, run } = useRun();
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editRow, setEditRow] = useState<AdminUserRow | null>(null);
  const [deactivateRow, setDeactivateRow] = useState<AdminUserRow | null>(null);
  // Only ever set right after a create/reset action succeeds; cleared on
  // dialog close, never written anywhere else — SPEC §9 "shown once, never
  // persisted in plaintext" (no localStorage, no router cache, no re-fetch).
  const [credential, setCredential] = useState<{ username: string; tempPassword: string } | null>(null);

  const resetPasswordFor = (u: AdminUserRow) =>
    run(
      async () => {
        const r = await generateResetPasswordAction(u.id);
        // AUD-079: a QC/Admin target returns `pending` instead of a
        // password — a different admin must approve it before any
        // credential exists to show.
        if (r.ok && !r.pending) setCredential({ username: u.username, tempPassword: r.tempPassword! });
        return r;
      },
      (r) =>
        r.pending
          ? "Password reset requested — a different admin must approve it before it takes effect."
          : "Password reset. They are signed out and must set a new one at next login.",
    );

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="hd">
        <h3>Employees</h3>
        {canEdit && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => setBulkOpen(true)}>Bulk import…</button>
            <button className="btn btn-accent" onClick={() => setAddOpen(true)}>Add employee…</button>
          </div>
        )}
      </div>

      {view.users.length === 0 ? (
        <p className="note" style={{ padding: "0 16px 14px" }}>
          No employees yet.{canEdit ? " Add one to get started." : ""}
        </p>
      ) : (
        <ResponsiveTable
          table={
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Employee code</th>
                  <th>Roles</th>
                  <th>Departments</th>
                  <th>Status</th>
                  <th>Last login</th>
                  <th className="num">Open items</th>
                  {canEdit && <th className="num">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {view.users.map((u) => {
                  const isSelf = u.id === actorUserId;
                  return (
                    <tr className="row" key={u.id}>
                      <td>{u.name}</td>
                      <td className="mono" style={{ color: "var(--muted)" }}>{u.username}</td>
                      <td className="mono" style={{ color: "var(--muted)" }}>{u.employeeCode ?? "—"}</td>
                      <td>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {u.roleCodes.map((c) => (
                            <span className="tag" key={c}>{ROLE_LABEL[c] ?? c}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        {u.departmentNames.length ? (
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {u.departmentNames.map((n) => (
                              <span className="tag" key={n}>{n}</span>
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>
                      <td>
                        {u.active ? (
                          <span className="chip c-complete"><i />Active</span>
                        ) : (
                          <span className="chip c-idle"><i />Inactive</span>
                        )}
                      </td>
                      <td className="mono" style={{ color: "var(--muted)" }}>{formatLastLogin(u.lastLogin)}</td>
                      <td className="num mono">{u.openItemsCount}</td>
                      {canEdit && (
                        <td className="num">
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                            <button className="btn" onClick={() => setEditRow(u)}>Edit</button>
                            <button className="btn" disabled={pending} onClick={() => resetPasswordFor(u)}>Reset password</button>
                            {u.active ? (
                              <button
                                className="btn"
                                disabled={isSelf}
                                title={isSelf ? "You cannot deactivate your own account." : undefined}
                                onClick={() => setDeactivateRow(u)}
                              >
                                Deactivate
                              </button>
                            ) : (
                              <button className="btn" disabled={pending} onClick={() => run(() => setUserActiveAction(u.id, true), "Reactivated.")}>
                                Reactivate
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          }
          cards={view.users.map((u) => (
            <EmployeeCardView
              key={u.id}
              u={u}
              isSelf={u.id === actorUserId}
              canEdit={canEdit}
              pending={pending}
              onEdit={() => setEditRow(u)}
              onResetPassword={() => resetPasswordFor(u)}
              onDeactivate={() => setDeactivateRow(u)}
              onReactivate={() => run(() => setUserActiveAction(u.id, true), "Reactivated.")}
            />
          ))}
        />
      )}

      {addOpen && canEdit && (
        <AddEmployeeDialog view={view} onClose={() => setAddOpen(false)} onCreated={(c) => { setAddOpen(false); setCredential(c); }} />
      )}
      {bulkOpen && canEdit && <BulkImportDialog view={view} onClose={() => setBulkOpen(false)} />}
      {editRow && canEdit && (
        <EditEmployeeDialog
          view={view}
          row={editRow}
          isSelf={editRow.id === actorUserId}
          onClose={() => setEditRow(null)}
        />
      )}
      {deactivateRow && canEdit && (
        <ConfirmDeactivateDialog
          row={deactivateRow}
          pending={pending}
          onClose={() => setDeactivateRow(null)}
          onConfirm={() => run(() => setUserActiveAction(deactivateRow.id, false), "Deactivated.", () => setDeactivateRow(null))}
        />
      )}
      {credential && (
        <CredentialDialog username={credential.username} tempPassword={credential.tempPassword} onClose={() => setCredential(null)} />
      )}
    </div>
  );
}

// ── Employees card (<1024px) — same fields/actions as the table row, laid
// out per SPEC §4: name + status chip + role/department tags + the same
// action buttons. `AddEmployeeDialog` → full-screen form is explicitly out
// of scope for this task (see task-2-report.md). ──────────────────────────
function EmployeeCardView({
  u,
  isSelf,
  canEdit,
  pending,
  onEdit,
  onResetPassword,
  onDeactivate,
  onReactivate,
}: {
  u: AdminUserRow;
  isSelf: boolean;
  canEdit: boolean;
  pending: boolean;
  onEdit: () => void;
  onResetPassword: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  return (
    <div className="rt-card">
      <div className="rt-card-top">
        <b>{u.name}</b>
        {u.active ? (
          <span className="chip c-complete"><i />Active</span>
        ) : (
          <span className="chip c-idle"><i />Inactive</span>
        )}
      </div>
      <div className="rt-card-meta mono">{u.username}{u.employeeCode ? ` · ${u.employeeCode}` : ""}</div>
      <div className="rt-card-row">
        {u.roleCodes.map((c) => <span className="tag" key={c}>{ROLE_LABEL[c] ?? c}</span>)}
        {u.departmentNames.map((n) => <span className="tag" key={n}>{n}</span>)}
      </div>
      <div className="rt-card-row">
        Last login {formatLastLogin(u.lastLogin)} · {u.openItemsCount} open item{u.openItemsCount === 1 ? "" : "s"}
      </div>
      {canEdit && (
        <div className="rt-card-action">
          <button className="btn" onClick={onEdit}>Edit</button>
          <button className="btn" disabled={pending} onClick={onResetPassword}>Reset password</button>
          {u.active ? (
            <button
              className="btn"
              disabled={isSelf}
              title={isSelf ? "You cannot deactivate your own account." : undefined}
              onClick={onDeactivate}
            >
              Deactivate
            </button>
          ) : (
            <button className="btn" disabled={pending} onClick={onReactivate}>Reactivate</button>
          )}
        </div>
      )}
    </div>
  );
}

function AddEmployeeDialog({
  view,
  onClose,
  onCreated,
}: {
  view: AdminView;
  onClose: () => void;
  onCreated: (c: { username: string; tempPassword: string }) => void;
}) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [employeeCode, setEmployeeCode] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [departmentIds, setDepartmentIds] = useState<Set<number>>(new Set());

  const deptsRequired = departmentsRequired([...roles]);

  const submit = () => {
    if (!displayName.trim() || !username.trim()) return toast.error("Name and username are required.");
    if (roles.size === 0) return toast.error("At least one role is required.");
    if (deptsRequired && departmentIds.size === 0) {
      return toast.error("Departments are required unless the role is Management or Admin.");
    }
    if (password && password.length < 10) {
      return toast.error("Password must be at least 10 characters, or leave it empty to auto-generate.");
    }
    startTransition(async () => {
      const r = await createEmployeeAction({
        displayName: displayName.trim(),
        username: username.trim(),
        email: email.trim() || undefined,
        employeeCode: employeeCode.trim() || undefined,
        roles: [...roles] as never,
        departmentIds: [...departmentIds],
        password: password || undefined,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("Employee created.");
      router.refresh();
      onCreated({ username: r.username!, tempPassword: r.tempPassword! });
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
            <Dialog.Title asChild><h2>Add employee</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <div className="emp-grid">
              <input className="ws-detail" placeholder="Name *" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <div>
                <input className="ws-detail" placeholder="Username *" value={username} onChange={(e) => setUsername(e.target.value)} />
                <div className="emp-hint">Email address or employee code, e.g. SUP-FAB-03</div>
              </div>
              <input className="ws-detail" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input className="ws-detail" placeholder="Employee code (optional)" value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} />
            </div>
            <div className="sh-sec">Roles</div>
            <div className="emp-check-grid">
              {view.roles.map((r) => (
                <label key={r.code}>
                  <input type="checkbox" checked={roles.has(r.code)} onChange={() => toggleSet(roles, setRoles, r.code)} />
                  {ROLE_LABEL[r.code] ?? r.name}
                </label>
              ))}
            </div>
            <div className="sh-sec">Departments{deptsRequired ? " *" : " (optional for Management/Admin)"}</div>
            <div className="emp-check-grid">
              {view.departments.map((d) => (
                <label key={d.id}>
                  <input type="checkbox" checked={departmentIds.has(d.id)} onChange={() => toggleSet(departmentIds, setDepartmentIds, d.id)} />
                  {d.name}
                </label>
              ))}
            </div>
            <div className="sh-sec">Password</div>
            <input className="ws-detail" type="password" placeholder="Leave empty to auto-generate" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>Create employee</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EditEmployeeDialog({
  view,
  row,
  isSelf,
  onClose,
}: {
  view: AdminView;
  row: AdminUserRow;
  isSelf: boolean;
  onClose: () => void;
}) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [roles, setRoles] = useState<Set<string>>(new Set(row.roleCodes));
  const [departmentIds, setDepartmentIds] = useState<Set<number>>(new Set(row.departmentIds));

  const deptsRequired = departmentsRequired([...roles]);
  // SPEC §7.3 guard rail: cannot remove your own Admin role — pre-empted in
  // the UI (the checkbox is locked), not just caught as a server refusal.
  const lockOwnAdmin = isSelf && row.roleCodes.includes("ADMIN");

  const submit = () => {
    if (roles.size === 0) return toast.error("At least one role is required.");
    if (deptsRequired && departmentIds.size === 0) {
      return toast.error("Departments are required unless the role is Management or Admin.");
    }
    startTransition(async () => {
      const r = await updateUserRolesDeptsAction({ userId: row.id, roles: [...roles] as never, departmentIds: [...departmentIds] });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("Updated.");
      router.refresh();
      onClose();
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
            <Dialog.Title asChild><h2>Edit {row.name}</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <div className="sh-sec">Roles</div>
            <div className="emp-check-grid">
              {view.roles.map((r) => (
                <label key={r.code}>
                  <input
                    type="checkbox"
                    checked={roles.has(r.code)}
                    disabled={lockOwnAdmin && r.code === "ADMIN"}
                    onChange={() => toggleSet(roles, setRoles, r.code)}
                  />
                  {ROLE_LABEL[r.code] ?? r.name}
                </label>
              ))}
            </div>
            {lockOwnAdmin && <div className="emp-hint">You cannot remove your own Admin role.</div>}
            <div className="sh-sec">Departments{deptsRequired ? " *" : " (optional for Management/Admin)"}</div>
            <div className="emp-check-grid">
              {view.departments.map((d) => (
                <label key={d.id}>
                  <input type="checkbox" checked={departmentIds.has(d.id)} onChange={() => toggleSet(departmentIds, setDepartmentIds, d.id)} />
                  {d.name}
                </label>
              ))}
            </div>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>Save</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ConfirmDeactivateDialog({
  row,
  pending,
  onClose,
  onConfirm,
}: {
  row: AdminUserRow;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const themeClass = useThemeClass();
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined} style={{ width: 420 }}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">✕</button>
            </Dialog.Close>
            <Dialog.Title asChild><h2>Deactivate {row.name}?</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <p style={{ fontSize: 13, margin: 0 }}>
              {row.openItemsCount > 0
                ? `This person still has ${row.openItemsCount} open item${row.openItemsCount === 1 ? "" : "s"} assigned. Deactivating does not release them — a supervisor, Production Head, or admin can release each item from My Day's "Held by teammates" list.`
                : "This person has no open items assigned."}
            </p>
            <p className="note" style={{ textAlign: "left" }}>They will be signed out immediately and cannot log in until reactivated.</p>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={onConfirm}>Deactivate</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * SPEC §7.3: credential hand-off, shown once. `.cred-slip` (globals.css) is
 * hidden on screen and becomes the ONLY visible thing on the page during
 * print (A6). `username`/`tempPassword` live only in this component's props
 * and the parent's one `credential` state slot — both drop the moment this
 * dialog closes; nothing here writes to storage, cache, or a re-fetchable
 * source (SPEC §9).
 */
function CredentialDialog({ username, tempPassword, onClose }: { username: string; tempPassword: string; onClose: () => void }) {
  const themeClass = useThemeClass();
  const appUrl = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close" onClick={onClose}>✕</button>
            </Dialog.Close>
            <Dialog.Title asChild><h2>Employee credentials</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <p className="note" style={{ marginTop: 0, textAlign: "left" }}>
              Shown once. Print or hand this off now — it cannot be retrieved again after you close this window.
            </p>
            <dl className="sh-kv">
              <div style={{ display: "contents" }}><dt>Username</dt><dd className="mono">{username}</dd></div>
              <div style={{ display: "contents" }}><dt>Temp password</dt><dd className="mono">{tempPassword}</dd></div>
            </dl>
          </div>
          <div className="sh-ft">
            <button className="btn btn-accent" onClick={() => window.print()}>Print credential slip</button>
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      {/*
       * FIX (task review round 2): `.cred-slip` used to live nested inside
       * Dialog.Content, hidden with `visibility:hidden` on its siblings for
       * print. Verified (standalone Playwright/Chromium PDF check, see
       * task-4.2-report.md) that `visibility:hidden` does NOT remove an
       * element from pagination — it still gets its own (blank) printed
       * page, so that approach produced a blank Letter-sized page before the
       * A6 slip. Portaling `.cred-slip` directly to <body>, as a sibling of
       * the app root and of Dialog.Portal's own overlay/content rather than
       * a descendant of either, lets the print CSS `display: none` every
       * OTHER top-level body child (globals.css's
       * `body:has(.cred-slip) > :not(.cred-slip)`) — display:none actually
       * removes them from pagination, leaving exactly one page: the slip.
       */}
      {typeof document !== "undefined" &&
        createPortal(
          <div className="cred-slip">
            <h2>DESPL Production Tracker</h2>
            <div className="cs-label">Username</div>
            <div className="cs-value">{username}</div>
            <div className="cs-label">Temporary password</div>
            <div className="cs-value">{tempPassword}</div>
            <div className="cs-warn">You must change this password at first login.<br />{appUrl}</div>
          </div>,
          document.body,
        )}
    </Dialog.Root>
  );
}

function BulkImportDialog({ view, onClose }: { view: AdminView; onClose: () => void }) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<ParsedEmployeeRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<BulkImportRowReport[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = (file: File) => {
    setFileName(file.name);
    setReport(null);
    const reader = new FileReader();
    reader.onload = () => setRows(parseEmployeeCsv(String(reader.result ?? ""), view.departments));
    reader.readAsText(file);
  };

  const validRows = rows.filter((r) => r.errors.length === 0 && r.data);

  const submit = () => {
    if (validRows.length === 0) return toast.error("No valid rows to import.");
    startTransition(async () => {
      const payload = validRows.map((r) => ({
        displayName: r.data!.displayName,
        username: r.data!.username,
        email: r.data!.email,
        employeeCode: r.data!.employeeCode,
        roles: r.data!.roles,
        departmentIds: r.data!.departmentIds,
      }));
      const res = await bulkImportEmployeesAction(payload);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      const results = res.results!;
      // bulkImportEmployees (admin.service) pushes one result per input row
      // in a plain for-loop, in order — safe to zip back onto validRows by index.
      const created: BulkImportRowReport[] = validRows.map((r, i) => {
        const result = results[i];
        return result.ok
          ? { line: r.line, displayName: r.data!.displayName, username: result.username, ok: true, tempPassword: result.tempPassword, effectiveEmail: result.effectiveEmail }
          : { line: r.line, displayName: r.data!.displayName, username: r.data!.username, ok: false, error: result.error };
      });
      const skipped: BulkImportRowReport[] = rows
        .filter((r) => r.errors.length > 0)
        .map((r) => ({ line: r.line, displayName: r.raw.displayName, username: r.raw.username, ok: false, error: r.errors.join("; ") }));
      const full = [...created, ...skipped].sort((a, b) => a.line - b.line);
      setReport(full);
      const okCount = created.filter((r) => r.ok).length;
      toast.success(`Imported ${okCount} of ${validRows.length} valid row${validRows.length === 1 ? "" : "s"}.`);
      router.refresh();
    });
  };

  const downloadReport = () => {
    if (!report) return;
    const csv = buildResultCsv(report);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "employee-import-results.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog wide`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">✕</button>
            </Dialog.Close>
            <Dialog.Title asChild><h2>Bulk import employees</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <p className="emp-hint" style={{ marginBottom: 10 }}>
              CSV columns: displayName,username,email,employeeCode,roles,departments. For roles/departments, separate
              multiple values with |. Roles: {view.roles.map((r) => `${r.code} (${ROLE_LABEL[r.code] ?? r.name})`).join(", ")}.
            </p>
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            {fileName && (
              <div className="emp-hint">{fileName} — {rows.length} row{rows.length === 1 ? "" : "s"} parsed, {validRows.length} valid.</div>
            )}

            {rows.length > 0 && !report && (
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr><th>Line</th><th>Name</th><th>Username</th><th>Roles</th><th>Departments</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr className="row" key={r.line}>
                      <td className="mono">{r.line}</td>
                      <td>{r.raw.displayName || "—"}</td>
                      <td className="mono">{r.raw.username || "—"}</td>
                      <td>{r.raw.roles || "—"}</td>
                      <td>{r.raw.departments || "—"}</td>
                      <td>
                        {r.errors.length === 0 ? (
                          <span className="chip c-complete"><i />Ready</span>
                        ) : (
                          <span className="chip c-overdue"><i />{r.errors.join(" ")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {report && (
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr><th>Line</th><th>Name</th><th>Username</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {report.map((r) => (
                    <tr className="row" key={r.line}>
                      <td className="mono">{r.line}</td>
                      <td>{r.displayName}</td>
                      <td className="mono">{r.username}</td>
                      <td>
                        {r.ok ? <span className="chip c-complete"><i />Created</span> : <span className="chip c-overdue"><i />{r.error}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="sh-ft">
            {report ? (
              <>
                <button className="btn" onClick={onClose}>Close</button>
                <button className="btn btn-accent" onClick={downloadReport}>Download result CSV</button>
              </>
            ) : (
              <>
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn btn-accent" disabled={pending || validRows.length === 0} onClick={submit}>
                  Import {validRows.length} valid row{validRows.length === 1 ? "" : "s"}
                </button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DelayReasonsSection({ view, canEdit }: { view: AdminView; canEdit: boolean }) {
  const { pending, run } = useRun();
  const [name, setName] = useState("");

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="hd">
        <h3>Master delay-reason list</h3>
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 8, padding: "0 16px 14px" }}>
          <input className="ws-detail" placeholder="New delay reason" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, maxWidth: 320 }} />
          <button
            className="btn btn-accent"
            disabled={pending}
            onClick={() => {
              if (!name.trim()) return toast.error("A name is required.");
              run(() => createDelayCategoryAction(name.trim()), "Delay reason added.", () => setName(""));
            }}
          >
            Add
          </button>
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Status</th>
            {canEdit && <th className="num">Action</th>}
          </tr>
        </thead>
        <tbody>
          {view.delayCategories.map((c) => (
            <tr className="row" key={c.id}>
              <td className="mono" style={{ color: "var(--muted)" }}>{c.code}</td>
              <td>{c.name}</td>
              <td>{c.active ? "Active" : "Inactive"}</td>
              {canEdit && (
                <td className="num">
                  <button className="btn" disabled={pending} onClick={() => run(() => toggleDelayCategoryAction(c.id, !c.active), c.active ? "Deactivated." : "Reactivated.")}>
                    {c.active ? "Deactivate" : "Reactivate"}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StandardDurationsSection({ view, canEdit }: { view: AdminView; canEdit: boolean }) {
  const { pending, run } = useRun();
  const [edits, setEdits] = useState<Map<number, { min: string; max: string }>>(new Map());
  const [reason, setReason] = useState("");

  const setEdit = (id: number, field: "min" | "max", value: string) => {
    const next = new Map(edits);
    const row = view.standardDurations.find((r) => r.id === id)!;
    const current = next.get(id) ?? { min: String(row.durationMinDays ?? ""), max: String(row.durationMaxDays ?? "") };
    next.set(id, { ...current, [field]: value });
    setEdits(next);
  };

  const save = () => {
    if (!view.templateVersionId) return;
    const payload = [...edits.entries()]
      .map(([templateProcessId, v]) => ({ templateProcessId, durationMinDays: Number(v.min), durationMaxDays: Number(v.max) }))
      .filter((e) => Number.isInteger(e.durationMinDays) && e.durationMinDays > 0 && Number.isInteger(e.durationMaxDays) && e.durationMaxDays > 0);
    if (payload.length === 0) return toast.error("Change at least one min/max duration first.");
    if (!reason.trim()) return toast.error("A reason is required — this publishes a new template version.");
    run(
      () => updateStandardDurationsAction(view.templateVersionId!, payload, reason.trim()),
      `New template version published (v${(view.templateVersionNo ?? 0) + 1}).`,
      () => {
        setEdits(new Map());
        setReason("");
      },
    );
  };

  return (
    <div className="card">
      <div className="hd">
        <h3>Standard durations — Pressure Vessels (v{view.templateVersionNo ?? "—"})</h3>
      </div>
      {view.standardDurations.length === 0 ? (
        <p className="note" style={{ padding: "0 16px 14px" }}>No pressure-vessel template found.</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Seq</th>
                <th>Process</th>
                <th className="num">Min days</th>
                <th className="num">Max days</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {view.standardDurations.map((p) => {
                const edit = edits.get(p.id);
                return (
                  <tr className="row" key={p.id}>
                    <td className="mono">{p.seq}</td>
                    <td>{p.name}</td>
                    <td className="num">
                      {canEdit ? (
                        <input
                          className="ws-detail mono"
                          style={{ width: 60, textAlign: "right" }}
                          value={edit?.min ?? p.durationMinDays ?? ""}
                          onChange={(e) => setEdit(p.id, "min", e.target.value)}
                        />
                      ) : (
                        p.durationMinDays ?? "—"
                      )}
                    </td>
                    <td className="num">
                      {canEdit ? (
                        <input
                          className="ws-detail mono"
                          style={{ width: 60, textAlign: "right" }}
                          value={edit?.max ?? p.durationMaxDays ?? ""}
                          onChange={(e) => setEdit(p.id, "max", e.target.value)}
                        />
                      ) : (
                        p.durationMaxDays ?? "—"
                      )}
                    </td>
                    <td>
                      {p.provisional && (
                        <span className="chip c-hold">
                          <i />
                          Placeholder — unconfirmed
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {canEdit && (
            <div style={{ display: "flex", gap: 8, padding: "14px 16px", alignItems: "center" }}>
              <input className="ws-detail" placeholder="Reason for this change (recorded, publishes a new version)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, maxWidth: 420 }} />
              <button className="btn btn-accent" disabled={pending || edits.size === 0} onClick={save}>Publish new version</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
