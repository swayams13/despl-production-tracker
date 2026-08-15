"use client";
import { useEffect, useState, useTransition } from "react";
import type { ActionResult } from "@/app/actions/_action";

/**
 * Runs a workspace server action and surfaces its refusal message inline.
 * The message auto-dismisses after a few seconds so a since-resolved refusal
 * (e.g. REASON_REQUIRED once a sibling DelayForm files the reason, or
 * HOLD_POINT_OPEN once QcpClear accepts the hold) doesn't linger as stale
 * client state across the server revalidation the sibling action triggered.
 */
export function useActionError() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.message);
    });

  return { pending, error, run };
}
