"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { filterPickerEntries, type PickerEntry } from "./bom-picker-entries";

const GROUPS: Array<{ kinds: PickerEntry["kind"][]; label: string }> = [
  { kinds: ["KIT", "TYPE"], label: "Equipment types" },
  { kinds: ["SOURCE"], label: "BOMs from earlier jobs" },
];

/**
 * One type-ahead list of the BOMs a line can start from. A native input with the ARIA combobox
 * pattern (no dependency): type to filter, Up/Down to move, Enter to choose, Escape to close.
 */
export function BomPicker({
  entries,
  summary,
  disabled,
  disabledHint,
  label,
  onPick,
  selectedKey,
}: {
  entries: PickerEntry[];
  /** What the closed field shows for the current choice. */
  summary: string;
  disabled?: boolean;
  disabledHint?: string;
  label: string;
  onPick: (entry: PickerEntry) => void;
  selectedKey?: string | null;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => filterPickerEntries(entries, q), [entries, q]);
  const activeIndex = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const choose = (e: PickerEntry) => {
    onPick(e);
    setOpen(false);
    setQ("");
  };
  const openList = () => {
    if (disabled) return;
    setOpen(true);
    setActive(Math.max(0, entries.findIndex((e) => e.key === selectedKey)));
  };
  const optionId = (e: PickerEntry) => `${id}-${e.key}`;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      if (shown.length > 0) setActive((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (shown[activeIndex]) choose(shown[activeIndex]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setQ("");
    } else if (e.key === "Tab") {
      setOpen(false);
      setQ("");
    }
  };

  const listId = `${id}-list`;
  const grouped = GROUPS.map((g) => ({ ...g, rows: shown.filter((s) => g.kinds.includes(s.kind)) })).filter((g) => g.rows.length > 0);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <input
        className="ws-detail"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[activeIndex] ? optionId(shown[activeIndex]) : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={disabled ? disabledHint : "Type a name, job, client or part code…"}
        value={open ? q : summary}
        onFocus={openList}
        onClick={openList}
        onChange={(e) => { setQ(e.target.value); setActive(0); if (!open) setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div id={listId} role="listbox" aria-label={label} className="drop" style={{ left: 0, right: "auto", top: "calc(100% + 4px)", minWidth: "100%" }}>
          {entries.length === 0 ? (
            <div className="d-row" style={{ color: "var(--muted)", cursor: "default" }}>No equipment types or earlier BOMs for this family yet.</div>
          ) : shown.length === 0 ? (
            <div className="d-row" style={{ color: "var(--muted)", cursor: "default" }}>Nothing matches &ldquo;{q}&rdquo;. Try a job number, a client or part of a name.</div>
          ) : (
            grouped.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <div className="emp-hint" style={{ padding: "8px 14px 2px" }}>{g.label}</div>
                {g.rows.map((e) => {
                  const isActive = shown[activeIndex]?.key === e.key;
                  return (
                    <div
                      key={e.key}
                      id={optionId(e)}
                      role="option"
                      aria-selected={e.key === selectedKey}
                      className="d-row"
                      style={isActive ? { background: "var(--surface-2)", boxShadow: "inset 2px 0 0 var(--accent)" } : undefined}
                      onMouseDown={(ev) => ev.preventDefault()}
                      onMouseEnter={() => setActive(shown.indexOf(e))}
                      onClick={() => choose(e)}
                    >
                      {e.title}
                      <small style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.sub}>{e.sub}</small>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
