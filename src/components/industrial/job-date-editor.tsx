"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateJobDatesAction } from "@/app/actions/job-intake";

function toInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function scheduleMessage(schedule: Awaited<ReturnType<typeof updateJobDatesAction>>["schedule"]): string {
  if (!schedule) return "Dispatch date saved.";
  switch (schedule.kind) {
    case "FEASIBLE":
      return `Dispatch date saved — schedule generated (${schedule.planCount} process plans).`;
    case "INFEASIBLE":
      return `Dispatch date saved — schedule is infeasible, ${schedule.shortfallDays}d short of the route's minimum.`;
    case "DATA_MISSING":
    case "FAILED":
      return `Dispatch date saved, but ${schedule.message}`;
  }
}

/**
 * Lets ADMIN/PRODUCTION_HEAD set or change a job's start date (orderDate) and
 * committed delivery date — the latter is the field scheduleNewJobAction
 * needs as requiredDeliveryDate to run the BACKWARD scheduler. targetDispatchDate
 * rides along unchanged so this save can't silently wipe it
 * (updateJobDatesSchema overwrites whatever it's given).
 */
export function JobDateEditor({
  jobId,
  orderDate,
  committedDeliveryDate,
  targetDispatchDate,
}: {
  jobId: number;
  orderDate: string | null;
  committedDeliveryDate: string | null;
  targetDispatchDate: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(toInputValue(orderDate));
  const [due, setDue] = useState(toInputValue(committedDeliveryDate));
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <button className="btn" style={{ marginLeft: 10 }} onClick={() => setEditing(true)}>
        {committedDeliveryDate ? "Edit dates" : "Set dates…"}
      </button>
    );
  }

  function save() {
    startTransition(async () => {
      const result = await updateJobDatesAction({
        jobId,
        orderDate: start ? new Date(start) : null,
        committedDeliveryDate: due ? new Date(due) : null,
        targetDispatchDate: targetDispatchDate ? new Date(targetDispatchDate) : null,
      });
      if (result.ok) {
        toast.success(scheduleMessage(result.schedule));
        setEditing(false);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <span style={{ marginLeft: 10, display: "inline-flex", gap: 6, alignItems: "center" }}>
      <label className="emp-hint">Start</label>
      <input
        className="ws-detail"
        type="date"
        value={start}
        disabled={pending}
        onChange={(e) => setStart(e.target.value)}
      />
      <label className="emp-hint">Due</label>
      <input
        className="ws-detail"
        type="date"
        value={due}
        disabled={pending}
        onChange={(e) => setDue(e.target.value)}
      />
      <button className="btn btn-accent" disabled={pending} onClick={save}>Save</button>
      <button className="btn" disabled={pending} onClick={() => setEditing(false)}>Cancel</button>
    </span>
  );
}
