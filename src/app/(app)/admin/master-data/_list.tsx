"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dropdown } from "@/components/industrial/filter-bar";
import { PageHeader } from "@/components/industrial/page-header";
import { ResponsiveTable } from "@/components/industrial/responsive-table";
import { StatusChip } from "@/components/industrial/status-chip";
import { reviewPartFamiliesAction } from "@/app/actions/master-data";
import type { PartFamilyFilters, PartFamilyList, PartFamilyListRow } from "@/lib/services/master-data.read";
import { partStatus, SCOPE_LABEL } from "./_labels";
import { toQueryString } from "./_filters";

function Variants({ row }: { row: PartFamilyListRow }) {
  if (row.variants.length === 0) return <span style={{ color: "var(--muted)" }}>No route</span>;
  return (
    <span className="mono">
      {row.variants.join(" ")}
      {row.draftVariants > 0 && <span style={{ color: "var(--muted)" }}> · {row.draftVariants} draft</span>}
    </span>
  );
}

function ToFix({ row }: { row: PartFamilyListRow }) {
  if (row.blockers === 0 && row.warnings === 0) return <span style={{ color: "var(--muted)" }}>—</span>;
  return (
    <span className="mono">
      {row.blockers > 0 && <span style={{ color: "var(--s-overdue)" }}>{row.blockers} to fix</span>}
      {row.blockers > 0 && row.warnings > 0 && " · "}
      {row.warnings > 0 && <span style={{ color: "var(--muted)" }}>{row.warnings} to check</span>}
    </span>
  );
}

export function MasterDataList({ list, filters, sections }: { list: PartFamilyList; filters: PartFamilyFilters; sections?: ReactNode }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [reviewing, startReview] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const searchFirst = useRef(true);

  const go = (next: PartFamilyFilters) =>
    startTransition(() => router.replace(`/admin/master-data${toQueryString(next)}`, { scroll: false }));

  // Search is debounced; the other filters navigate immediately.
  useEffect(() => {
    if (searchFirst.current) {
      searchFirst.current = false;
      return;
    }
    const t = setTimeout(() => go({ ...filters, q: q.trim() || undefined }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const reviewable = useMemo(() => list.rows.filter((r) => r.canReview).map((r) => r.id), [list.rows]);
  const chosen = [...selected].filter((id) => reviewable.includes(id));
  const anyFilter = Boolean(filters.q || filters.scope || filters.status || filters.group || filters.hasBlockers);

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const markReviewed = () =>
    startReview(async () => {
      const r = await reviewPartFamiliesAction(chosen);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const skipped = r.refused.length;
      if (r.reviewed.length > 0) {
        toast.success(`${r.reviewed.length} marked reviewed${skipped ? `, ${skipped} skipped` : ""}.`);
      }
      if (skipped > 0) toast.error(r.refused.map((x) => x.message).filter((m, i, a) => a.indexOf(m) === i).join(" "));
      setSelected(new Set());
      router.refresh();
    });

  const totals = list.totals;
  // A filter strip, not navigation: pressed-state buttons, so it cannot be mistaken
  // for the Parts / Materials / Import section tabs above it.
  const tab = (label: string, count: number, active: boolean, next: PartFamilyFilters) => (
    <button
      type="button"
      className={active ? "btn btn-outline-accent" : "btn"}
      aria-pressed={active}
      onClick={() => go(next)}
    >
      {label} <span className="mono">{count}</span>
    </button>
  );
  const base = { q: filters.q, scope: filters.scope, group: filters.group };

  return (
    <>
      <PageHeader
        title="Master data"
        subtitle="Part families, their routes and approval"
        actions={
          list.canEdit && chosen.length > 0 ? (
            <button type="button" className="btn btn-accent" disabled={reviewing} onClick={markReviewed}>
              {reviewing ? "Marking…" : `Mark reviewed (${chosen.length})`}
            </button>
          ) : undefined
        }
      />

      {sections}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {tab("All", totals.all, !filters.status && !filters.hasBlockers, base)}
        {tab("Draft", totals.draft, filters.status === "DRAFT", { ...base, status: "DRAFT" })}
        {tab("Reviewed", totals.reviewed, filters.status === "REVIEWED", { ...base, status: "REVIEWED" })}
        {tab("Approved", totals.approved, filters.status === "APPROVED", { ...base, status: "APPROVED" })}
        {tab("Need fixes", totals.withBlockers, Boolean(filters.hasBlockers), { ...base, hasBlockers: true })}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <Dropdown
          label="Equipment"
          value={filters.scope ?? null}
          options={[{ value: "PV", label: "PV" }, { value: "HE", label: "HE" }, { value: "BOTH", label: "PV + HE" }]}
          onChange={(v) => go({ ...filters, scope: (v as PartFamilyFilters["scope"]) ?? undefined })}
        />
        <Dropdown
          label="Assembly group"
          value={filters.group ?? null}
          options={list.groups.map((g) => ({ value: g, label: g }))}
          onChange={(v) => go({ ...filters, group: v ?? undefined })}
        />
        <input
          className="ws-detail"
          style={{ marginLeft: "auto", width: 280, maxWidth: "100%" }}
          type="search"
          placeholder="Search code or name"
          aria-label="Search code or name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {list.rows.length === 0 ? (
        <div className="card" style={{ padding: 16 }}>
          <p style={{ margin: "0 0 12px", fontSize: 13 }}>
            {anyFilter
              ? "No parts match these filters."
              : "No part families have been loaded yet. Engineering loads them from the Standard Parts Master workbook."}
          </p>
          {anyFilter && (
            <button type="button" className="btn" onClick={() => { setQ(""); go({}); }}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="card">
          <ResponsiveTable
            table={
              <table>
                <thead>
                  <tr>
                    {list.canEdit && (
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          aria-label="Select every part you can mark reviewed"
                          disabled={reviewable.length === 0}
                          checked={reviewable.length > 0 && chosen.length === reviewable.length}
                          onChange={(e) => setSelected(e.target.checked ? new Set(reviewable) : new Set())}
                        />
                      </th>
                    )}
                    <th>Code</th>
                    <th>Name</th>
                    <th>Equipment</th>
                    <th>Status</th>
                    <th>Variants</th>
                    <th className="num">Steps</th>
                    <th>To fix</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => {
                    const st = partStatus(r.status);
                    return (
                      <tr className="row" key={r.id}>
                        {list.canEdit && (
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Select ${r.code}`}
                              disabled={!r.canReview}
                              checked={selected.has(r.id) && r.canReview}
                              onChange={() => toggle(r.id)}
                            />
                          </td>
                        )}
                        <td className="mono">
                          <Link href={`/admin/master-data/${r.id}`}>{r.code}</Link>
                        </td>
                        <td>{r.name}</td>
                        <td>{SCOPE_LABEL[r.scope]}</td>
                        <td>
                          <StatusChip status={st.status} label={st.label} />
                        </td>
                        <td><Variants row={r} /></td>
                        <td className="num mono">{r.steps}</td>
                        <td><ToFix row={r} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            }
            cards={
              <div style={{ display: "grid", gap: 8, padding: 12 }}>
                {list.rows.map((r) => {
                  const st = partStatus(r.status);
                  return (
                    <Link key={r.id} href={`/admin/master-data/${r.id}`} className="card" style={{ padding: 12, display: "block" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span className="mono">{r.code}</span>
                        <StatusChip status={st.status} label={st.label} />
                      </div>
                      <div style={{ margin: "4px 0" }}>{r.name}</div>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>
                        {SCOPE_LABEL[r.scope]} · <Variants row={r} /> · {r.steps} steps · <ToFix row={r} />
                      </div>
                    </Link>
                  );
                })}
              </div>
            }
          />
        </div>
      )}
    </>
  );
}
