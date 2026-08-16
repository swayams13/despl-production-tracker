"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/app/actions/auth";

const initial: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initial);

  return (
    <div className="theme-industrial">
      <main className="grid min-h-dvh place-items-center px-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <b className="text-[15px] tracking-[.5px]">DESPL Production Tracker</b>
            <span className="mt-1 block text-[10.5px] uppercase tracking-[1px] text-[var(--muted)]">
              Dhruv EPC Solutions Pvt. Ltd.
            </span>
          </div>

          <form action={formAction} className="card p-5">
            <label className="block text-xs font-medium text-[var(--muted)]" htmlFor="identifier">
              Username or email
            </label>
            <input
              id="identifier"
              name="identifier"
              type="text"
              autoComplete="username"
              required
              autoFocus
              className="ws-detail mt-1.5"
            />

            <label className="mt-4 block text-xs font-medium text-[var(--muted)]" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="ws-detail mt-1.5"
            />

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
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="mt-4 text-center text-[11px] text-[var(--muted)]">
            Accounts are created by an administrator. There is no self sign-up.
          </p>
        </div>
      </main>
    </div>
  );
}
