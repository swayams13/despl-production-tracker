"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createUserAction,
  resetPasswordAction,
  createDelayCategoryAction,
  toggleDelayCategoryAction,
  updateStandardDurationsAction,
} from "@/app/actions/admin";
import type { AdminView } from "@/lib/services/admin.read";

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
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, ok: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(ok);
        router.refresh();
        after?.();
      }
    });
  return { pending, run };
}

export function AdminClient({ view, canEdit }: { view: AdminView; canEdit: boolean }) {
  return (
    <>
      <div className="page-h">
        <h1>Admin</h1>
        <span className="sub">Users, delay reasons, standard durations{canEdit ? "" : " — read only"}</span>
      </div>

      <UsersSection view={view} canEdit={canEdit} />
      <DelayReasonsSection view={view} canEdit={canEdit} />
      <StandardDurationsSection view={view} canEdit={canEdit} />
    </>
  );
}

function UsersSection({ view, canEdit }: { view: AdminView; canEdit: boolean }) {
  const { pending, run } = useRun();
  const [creating, setCreating] = useState(false);
  const [resettingId, setResettingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleCodes, setRoleCodes] = useState<Set<string>>(new Set());
  const [departmentIds, setDepartmentIds] = useState<Set<number>>(new Set());
  const [resetPassword, setResetPassword] = useState("");

  const toggle = <T,>(set: Set<T>, setSet: (s: Set<T>) => void, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setSet(next);
  };

  const submitCreate = () => {
    if (!name.trim() || !email.trim() || roleCodes.size === 0 || password.length < 8) {
      toast.error("Name, email, at least one role, and an 8+ character password are required.");
      return;
    }
    run(
      () =>
        createUserAction({
          name: name.trim(),
          email: email.trim(),
          roleCodes: [...roleCodes] as never,
          departmentIds: [...departmentIds],
          password,
        }),
      "User created.",
      () => {
        setCreating(false);
        setName("");
        setEmail("");
        setPassword("");
        setRoleCodes(new Set());
        setDepartmentIds(new Set());
      },
    );
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="hd">
        <h3>Users</h3>
        {canEdit && (
          <button className="btn btn-accent" style={{ marginLeft: "auto" }} onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "Create user…"}
          </button>
        )}
      </div>

      {creating && canEdit && (
        <div style={{ padding: "0 16px 14px" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <input className="ws-detail" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 160 }} />
            <input className="ws-detail" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ minWidth: 200 }} />
            <input
              className="ws-detail"
              placeholder="Password (8+ chars)"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ minWidth: 160 }}
            />
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8, fontSize: 12, color: "var(--muted)" }}>
            {view.roles.map((r) => (
              <label key={r.code} style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <input type="checkbox" checked={roleCodes.has(r.code)} onChange={() => toggle(roleCodes, setRoleCodes, r.code)} />
                {ROLE_LABEL[r.code] ?? r.name}
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10, fontSize: 12, color: "var(--muted)" }}>
            {view.departments.map((d) => (
              <label key={d.id} style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <input type="checkbox" checked={departmentIds.has(d.id)} onChange={() => toggle(departmentIds, setDepartmentIds, d.id)} />
                {d.name}
              </label>
            ))}
          </div>
          <button className="btn btn-accent" disabled={pending} onClick={submitCreate}>Create user</button>
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Roles</th>
            <th>Departments</th>
            <th>Status</th>
            {canEdit && <th className="num">Action</th>}
          </tr>
        </thead>
        <tbody>
          {view.users.map((u) => (
            <tr className="row" key={u.id}>
              <td>{u.name}</td>
              <td className="mono" style={{ color: "var(--muted)" }}>{u.email}</td>
              <td>{u.roleCodes.map((c) => ROLE_LABEL[c] ?? c).join(", ")}</td>
              <td style={{ color: "var(--muted)" }}>{u.departmentNames.join(", ") || "—"}</td>
              <td>{u.active ? "Active" : "Inactive"}</td>
              {canEdit && (
                <td className="num">
                  {resettingId === u.id ? (
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <input
                        className="ws-detail"
                        type="password"
                        placeholder="New password"
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        style={{ width: 140 }}
                        autoFocus
                      />
                      <button
                        className="btn btn-accent"
                        disabled={pending}
                        onClick={() => {
                          if (resetPassword.length < 8) return toast.error("Password must be at least 8 characters.");
                          run(() => resetPasswordAction(u.id, resetPassword), "Password reset. They are signed out and must set a new one at next login.", () => {
                            setResettingId(null);
                            setResetPassword("");
                          });
                        }}
                      >
                        Save
                      </button>
                      <button className="btn" disabled={pending} onClick={() => setResettingId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button className="btn" onClick={() => setResettingId(u.id)}>Reset password</button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
