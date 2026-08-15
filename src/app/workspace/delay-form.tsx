"use client";
import { useState } from "react";
import { fileDelayAction } from "@/app/actions/delay";
import { useActionError } from "./use-action-error";

export function DelayForm({ planId, categories }: { planId: number; categories: { id: number; name: string }[] }) {
  const { pending, error, run } = useActionError();
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? 0);
  const [detail, setDetail] = useState("");
  return (
    <form className="flex flex-wrap items-center gap-2"
      action={() => run(() => fileDelayAction(planId, categoryId, detail || undefined))}>
      <select className="rounded border border-[var(--hairline)] bg-[var(--surface)] px-2 py-1 text-xs" value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <input className="rounded border border-[var(--hairline)] bg-[var(--surface)] px-2 py-1 text-xs" placeholder="detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} />
      <button disabled={pending} className="rounded-lg border border-[var(--hairline)] px-2 py-1 text-xs">File reason</button>
      {error && <span className="text-xs text-[var(--danger-fg,#b91c1c)]">{error}</span>}
    </form>
  );
}
