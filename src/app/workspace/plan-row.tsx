"use client";
import { startAction, submitAction, holdAction, resumeAction, verifyAction } from "@/app/actions/process";
import { useActionError } from "./use-action-error";

type Props = { planId: number; state: string; canVerify?: boolean };

export function PlanRow({ planId, state, canVerify }: Props) {
  const { pending, error, run: call } = useActionError();

  const btn = "rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:bg-[var(--surface-sunken)] disabled:opacity-50";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {state === "READY" && <button disabled={pending} className={btn} onClick={() => call(() => startAction(planId))}>Start</button>}
        {state === "IN_PROGRESS" && <>
          <button disabled={pending} className={btn} onClick={() => call(() => submitAction(planId))}>Submit</button>
          {/* ponytail: fixed hold reason; add a prompt when the floor needs categorised holds */}
          <button disabled={pending} className={btn} onClick={() => call(() => holdAction(planId, "Held from workspace"))}>Hold</button>
        </>}
        {state === "ON_HOLD" && <button disabled={pending} className={btn} onClick={() => call(() => resumeAction(planId))}>Resume</button>}
        {state === "SUBMITTED" && canVerify && <button disabled={pending} className={btn} onClick={() => call(() => verifyAction(planId))}>Verify</button>}
      </div>
      {error && <p className="text-xs text-[var(--danger-fg,#b91c1c)]">{error}</p>}
    </div>
  );
}
