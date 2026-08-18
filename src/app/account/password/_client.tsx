"use client";

import { useActionState } from "react";
import { changePassword, type ChangePasswordState } from "@/app/actions/account";
import { ThemeRoot } from "@/components/industrial/theme-root";
import type { ThemeState } from "@/lib/theme";

const initial: ChangePasswordState = {};

export function ChangePasswordForm({ forced, theme }: { forced: boolean; theme: ThemeState }) {
  const [state, formAction, pending] = useActionState(changePassword, initial);

  return (
    <ThemeRoot {...theme}>
      <main className="grid min-h-dvh place-items-center px-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <b className="text-[15px] tracking-[.5px]">
              {forced ? "Set your password" : "Change your password"}
            </b>
            <span className="mt-1 block text-[10.5px] uppercase tracking-[1px] text-[var(--muted)]">
              {forced ? "Required before you can continue" : "DESPL Production Tracker"}
            </span>
          </div>

          <form action={formAction} className="card p-5">
            <label className="block text-xs font-medium text-[var(--muted)]" htmlFor="current">
              Current password
            </label>
            <input
              id="current"
              name="current"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              className="ws-detail mt-1.5"
            />

            <label className="mt-4 block text-xs font-medium text-[var(--muted)]" htmlFor="next">
              New password
            </label>
            <input
              id="next"
              name="next"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              className="ws-detail mt-1.5"
            />
            <p className="mt-1 text-[10.5px] text-[var(--muted)]">At least 10 characters.</p>

            {state.error ? (
              <p
                role="alert"
                className="mt-4 rounded-[4px] border px-3 py-2 text-xs"
                style={{
                  borderColor: "var(--s-overdue)",
                  background: "color-mix(in srgb, var(--s-overdue) 12%, transparent)",
                  color: "var(--s-overdue)",
                }}
              >
                {state.error}
              </p>
            ) : null}

            <button type="submit" disabled={pending} className="btn btn-accent mt-5 w-full disabled:opacity-60">
              {pending ? "Changing password…" : "Change password"}
            </button>
          </form>
        </div>
      </main>
    </ThemeRoot>
  );
}
